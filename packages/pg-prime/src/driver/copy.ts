/**
 * COPY over pg's Submittable protocol — design/02 §2.2's `copyIn` / `copyOut`, filled in
 * (design/07 §6.6, decision 9 of design/12 §1).
 *
 * `07` §6.6 planned to reach COPY through `pg-copy-streams` as an optional peer. It is not needed,
 * and the reason is worth stating: what `pg-copy-streams` *is* is exactly this file — a Submittable
 * that issues the `COPY` statement, then answers `CopyInResponse` by writing `CopyData` frames on
 * `connection.sendCopyData` and finishing with `sendCopyDone`, or collects `CopyData` on the way
 * out. That API is pg's own, it has been stable since pg 6, and it is already in this repo's
 * structural declaration of `pg` (`./pg-like.ts`). One fewer dependency, one fewer version to
 * track, and the same bytes on the wire.
 *
 * Two details that are easy to get wrong and are the reason this is not shorter:
 *
 *  1. **The COPY statement goes out through the SIMPLE query protocol.** `connection.query(text)`
 *     is what `pg-copy-streams` uses. COPY takes no bind parameters — there is nowhere to put one
 *     — so the extended protocol buys nothing and costs an interaction with pg's `activeQuery`
 *     bookkeeping that the simple path does not have.
 *  2. **Backpressure is the socket's.** `sendCopyData` writes straight through, so a 100 000-row
 *     source with no drain handling buffers the whole load in the process. We wait on `'drain'`
 *     whenever the stream says it needs one.
 */

import type { PgLikeClient, PgLikeConnection, PgLikeField, PgLikeSubmittable } from './pg-like.js'
import type { PgCopyResult, PgNoticeData } from './types.js'

/** pg's CommandComplete tag grammar, the COPY case: `COPY 12345`. */
const COPY_TAG = /^COPY (\d+)/

const bufferFrom = (globalThis as unknown as {
  Buffer?: { from(b: ArrayBufferLike, byteOffset?: number, length?: number): Uint8Array }
}).Buffer

/**
 * pg-protocol's `sendCopyData` writes the value as-is, and a plain `Uint8Array` that is not a
 * Node `Buffer` is written through the string path — the same trap `submittable.ts` documents for
 * bind parameters.
 */
function toWire(chunk: Uint8Array): Uint8Array {
  if (bufferFrom === undefined) return chunk
  return bufferFrom.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
}

interface Drainable {
  writableNeedDrain?: boolean
  once?(event: string, listener: () => void): unknown
}

async function drain(connection: PgLikeConnection): Promise<void> {
  const stream = connection.stream as unknown as Drainable
  if (stream.writableNeedDrain !== true || typeof stream.once !== 'function') return
  await new Promise<void>((resolve) => {
    stream.once?.('drain', resolve)
  })
}

class CopyInSubmittable implements PgLikeSubmittable {
  readonly text: string
  readonly name = ''
  callback?: (err: unknown, result?: unknown) => void

  readonly #source: AsyncIterable<Uint8Array>
  readonly #signal: AbortSignal | undefined
  #rowCount = 0
  #settled = false
  #sourceError: unknown
  #resolve!: (r: { rowCount: number }) => void
  #reject!: (e: unknown) => void
  readonly promise: Promise<{ rowCount: number }>

  constructor(text: string, source: AsyncIterable<Uint8Array>, signal: AbortSignal | undefined) {
    this.text = text
    this.#source = source
    this.#signal = signal
    this.promise = new Promise((res, rej) => {
      this.#resolve = res
      this.#reject = rej
    })
  }

  submit(connection: PgLikeConnection): Error | null {
    const q = (connection as unknown as { query?: (text: string) => void }).query
    if (typeof q !== 'function') {
      return new Error(
        'this pg-like connection does not expose connection.query(text), which COPY needs to issue ' +
          'the statement over the simple query protocol',
      )
    }
    try {
      q.call(connection, this.text)
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
    return null
  }

  /** The backend is now in copy-in mode and will accept nothing but CopyData/CopyDone/CopyFail. */
  handleCopyInResponse(connection: PgLikeConnection): void {
    void this.#pump(connection)
  }

  async #pump(connection: PgLikeConnection): Promise<void> {
    try {
      for await (const chunk of this.#source) {
        if (this.#signal?.aborted === true) {
          connection.sendCopyFail('aborted by the caller')
          return
        }
        if (chunk.byteLength === 0) continue
        connection.sendCopyData(toWire(chunk))
        await drain(connection)
      }
      connection.sendCopyDone()
    } catch (e) {
      // `CopyFail` is the protocol's own way to abort a COPY: the backend answers with an
      // ErrorResponse (57014-family), which `handleError` turns into the rejection. Throwing here
      // instead would leave the connection stuck in copy-in mode forever.
      this.#sourceError = e
      try {
        connection.sendCopyFail(e instanceof Error ? e.message : String(e))
      } catch {
        this.#fail(e)
      }
    }
  }

  handleRowDescription(): void {}
  handleDataRow(): void {}
  handleCommandComplete(msg: { text?: string; command?: string }): void {
    const m = COPY_TAG.exec(msg.text ?? msg.command ?? '')
    if (m?.[1] !== undefined) this.#rowCount = Number.parseInt(m[1], 10)
  }
  handleEmptyQuery(): void {}
  handlePortalSuspended(): void {}
  handleCopyData(): void {}

  handleError(err: unknown): void {
    this.#fail(this.#sourceError ?? err)
  }

  #fail(err: unknown): void {
    if (this.#settled) return
    this.#settled = true
    this.callback?.(err)
    this.#reject(err)
  }

  handleReadyForQuery(): void {
    if (this.#settled) return
    if (this.#sourceError !== undefined) {
      this.#fail(this.#sourceError)
      return
    }
    this.#settled = true
    this.callback?.(null, undefined)
    this.#resolve({ rowCount: this.#rowCount })
  }
}

export async function copyInViaSubmittable(
  client: PgLikeClient,
  text: string,
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal | undefined,
  notices: readonly PgNoticeData[],
): Promise<PgCopyResult> {
  const sub = new CopyInSubmittable(text, source, signal)
  client.query(sub)
  const { rowCount } = await sub.promise
  return { rowCount, notices }
}

/**
 * COPY TO STDOUT.
 *
 * A queue with one waiter rather than a stream: the consumer is a `for await`, so exactly one
 * reader is ever pending, and the backend pushes `CopyData` at whatever rate it likes. Real
 * backpressure on the *out* direction would need to pause pg's socket, which pg does not expose;
 * the frames are already in memory by the time we see them, so buffering them in an array costs
 * the same as buffering them in a stream's internal queue and is honest about it.
 */
class CopyOutSubmittable implements PgLikeSubmittable {
  readonly text: string
  readonly name = ''
  callback?: (err: unknown, result?: unknown) => void

  readonly #queue: Uint8Array[] = []
  #done = false
  #error: unknown
  #wake: (() => void) | undefined

  constructor(text: string) {
    this.text = text
  }

  submit(connection: PgLikeConnection): Error | null {
    const q = (connection as unknown as { query?: (text: string) => void }).query
    if (typeof q !== 'function') {
      return new Error('this pg-like connection does not expose connection.query(text)')
    }
    try {
      q.call(connection, this.text)
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
    return null
  }

  handleRowDescription(_msg: { fields: readonly PgLikeField[] }): void {}
  handleDataRow(): void {}
  handleCommandComplete(): void {}
  handleEmptyQuery(): void {}
  handlePortalSuspended(): void {}
  handleCopyInResponse(): void {}

  handleCopyData(msg: { chunk: Uint8Array }): void {
    this.#queue.push(msg.chunk)
    this.#wake?.()
  }

  handleError(err: unknown): void {
    this.#error = err
    this.#done = true
    this.callback?.(err)
    this.#wake?.()
  }

  handleReadyForQuery(): void {
    this.#done = true
    this.callback?.(null, undefined)
    this.#wake?.()
  }

  async *chunks(signal: AbortSignal | undefined): AsyncIterable<Uint8Array> {
    for (;;) {
      while (this.#queue.length > 0) {
        if (signal?.aborted === true) return
        yield this.#queue.shift() as Uint8Array
      }
      if (this.#error !== undefined) throw this.#error
      if (this.#done) return
      await new Promise<void>((resolve) => {
        this.#wake = resolve
      })
      this.#wake = undefined
    }
  }
}

export function copyOutViaSubmittable(
  client: PgLikeClient,
  text: string,
  signal: AbortSignal | undefined,
): AsyncIterable<Uint8Array> {
  const sub = new CopyOutSubmittable(text)
  client.query(sub)
  return sub.chunks(signal)
}
