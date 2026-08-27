/**
 * A PostgreSQL wire-protocol socket in front of PGlite, so the **real `pg` driver** talks to the
 * embedded server over the **real protocol** (design/08 F7). It exists rather than
 * `@electric-sql/pglite-socket` because of the first note below, which that package shares and
 * cannot be patched from outside.
 *
 * Three things it does that a naive bridge does not:
 *
 * 1. **Strips the spurious `ReadyForQuery` after an extended-protocol error.** Verified on
 *    pglite 0.5.7 (2026-08-25): a `Parse`/`Bind`/`Execute` that fails answers `ErrorResponse` +
 *    `ReadyForQuery`, and then `Sync` answers with a second `ReadyForQuery`. Real PostgreSQL
 *    sends `ErrorResponse`, silently discards messages until `Sync`, and sends exactly one
 *    `ReadyForQuery` — for the `Sync`. The extra one makes `pg` believe the *next* query already
 *    finished, so that query's own rows arrive as `Received unexpected rowDescription message
 *    from backend` and the connection is dead. It reproduces on ~50% of erroring parameterised
 *    queries, i.e. on most SQLSTATE assertions in the suite.
 *
 * 2. **Serialises every message through one chain.** PGlite is one backend; two sockets running
 *    queries at once interleave at the protocol level.
 *
 * 3. **Refuses to let a second socket work inside another socket's transaction.** That is the
 *    design/08 F8 lie — on PGlite a "second session" is the same session — and silently allowing
 *    it is how a broken `skip locked` or advisory lock tests green. It fails loudly instead, and
 *    points at `requiresConcurrency()`.
 */

import { appendFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import type { PGlite } from '@electric-sql/pglite'

/**
 * `PG_PRIME_BRIDGE_TRACE=<file>` appends every message type in and out to that file — how the
 * `ReadyForQuery` bug above was found. A file, not stderr: vitest discards worker output that is
 * not raised inside a running task, which is where most of this happens.
 */
const TRACE = process.env['PG_PRIME_BRIDGE_TRACE']

const SSL_REQUEST = 80877103
const GSS_REQUEST = 80877104
const CANCEL_REQUEST = 80877102

const READY_FOR_QUERY = 0x5a // 'Z'
/** `Z` + int32 length (5) + one status byte. */
const READY_FOR_QUERY_BYTES = 6
const SYNC = 0x53 // 'S'
const TERMINATE = 0x58 // 'X'
const FUNCTION_CALL = 0x46 // 'F'
const SIMPLE_QUERY = 0x51 // 'Q'
/** The StartupMessage has no type byte; the bridge reports it as 0. */
const STARTUP = 0

/** `Q` + length + `rollback\0`, to unwind a transaction whose owner walked away. */
const ROLLBACK = (() => {
  const body = Buffer.from('rollback\0', 'utf8')
  const msg = Buffer.alloc(5 + body.length)
  msg.writeUInt8(SIMPLE_QUERY, 0)
  msg.writeInt32BE(4 + body.length, 1)
  body.copy(msg, 5)
  return new Uint8Array(msg)
})()

const EMPTY = new Uint8Array(0)

export interface PgliteBridge {
  readonly port: number
  close(): Promise<void>
}

export function serve(db: PGlite, host = '127.0.0.1'): Promise<PgliteBridge> {
  let port = 0
  /** One chain for the whole bridge: one backend, one message in flight, ever. */
  let chain: Promise<void> = Promise.resolve()
  let txOwner: Socket | undefined
  const sockets = new Set<Socket>()

  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.setNoDelay(true)
    socket.on('error', () => {}) // a client that hangs up mid-query is not our problem
    socket.on('close', () => {
      sockets.delete(socket)
      if (txOwner === socket) {
        txOwner = undefined
        chain = chain.then(async () => {
          if (db.isInTransaction()) await db.execProtocolRaw(ROLLBACK)
        })
      }
    })

    // `Buffer<ArrayBufferLike>`, because `subarray()` widens the backing-store type parameter.
    let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let started = false
    /** Responses to one pipelined batch, flushed together — see `flush` below. */
    let pending: Uint8Array[] = []
    let outstanding = 0

    const flush = (): void => {
      if (pending.length === 0) return
      const body = pending.length === 1 ? pending[0]! : Buffer.concat(pending)
      pending = []
      if (socket.writable) socket.write(body)
    }

    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (malformed(buf, started)) {
          // A length that cannot be a length would leave the loop below unable to make progress,
          // and a hung worker with no output is the worst failure mode a harness can have.
          console.error('[live] PGlite bridge got a malformed message header; connection dropped.')
          socket.destroy()
          return
        }
        const framed = frame(buf, started)
        if (!framed) break
        const [message, rest] = framed
        buf = rest

        const isStartup = !started
        if (isStartup) {
          const code = message.length >= 8 ? message.readInt32BE(4) : 0
          // No TLS and no cancellation: 'N' declines SSL, a CancelRequest has nothing to cancel.
          if (code === SSL_REQUEST || code === GSS_REQUEST) {
            socket.write(Buffer.from('N'))
            continue
          }
          if (code === CANCEL_REQUEST) continue
          started = true // this one is the StartupMessage; everything after it is typed
        }

        const type = isStartup ? STARTUP : message.readUInt8(0)
        outstanding += 1
        chain = chain
          .then(async () => {
            const out = await run(socket, message, type)
            // Copied, not referenced: `execProtocolRaw` hands back a view into WASM memory.
            if (out.length > 0) pending.push(new Uint8Array(out))
          })
          .catch((e: unknown) => {
            // Without this the chain stays rejected and every later message is dropped in silence.
            console.error(`[live] PGlite bridge failed on message '${String.fromCharCode(type)}':`, e)
            socket.destroy()
          })
          .finally(() => {
            outstanding -= 1
            // One write per *batch*, the way a real backend buffers its output until it has
            // nothing left to read. Writing per message is observably different: `pg` resolves a
            // failed query on `ErrorResponse` alone, so a separately-written `ReadyForQuery`
            // arrives after the test has already read `transactionStatus` — 'T' where PostgreSQL
            // says 'E'. `outstanding === 0` also means this can never deadlock a client that
            // pipelines without Sync.
            if (outstanding === 0) flush()
          })
      }
    })
  })

  async function run(
    socket: Socket,
    message: Buffer<ArrayBufferLike>,
    type: number,
  ): Promise<Uint8Array> {
    if (crossesTransaction(socket, type)) {
      console.error(
        `[live] PGlite is ONE backend: this connection tried to run a message while another ` +
          `connection holds an open transaction, so it would have run *inside* that transaction ` +
          `(design/08 F8). Mark the test requiresConcurrency() and run it on tier 2 ` +
          `(\`pnpm test:pg\`). Connection dropped.`,
      )
      socket.destroy()
      return EMPTY
    }
    const out = await db.execProtocolRaw(new Uint8Array(message))
    txOwner = db.isInTransaction() ? socket : undefined
    const strip = spuriousReadyForQuery(type, out)
    if (TRACE) {
      appendFileSync(
        TRACE,
        `[bridge:${port}] in '${String.fromCharCode(type)}'${message.length} → out [${describe(out)}]` +
          `${strip ? ' (stripped trailing ReadyForQuery)' : ''}\n`,
      )
    }
    return strip ? out.subarray(0, out.length - READY_FOR_QUERY_BYTES) : out
  }

  function crossesTransaction(socket: Socket, type: number): boolean {
    if (type === TERMINATE || type === SYNC) return false
    return db.isInTransaction() && txOwner !== undefined && txOwner !== socket
  }

  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const address = server.address()
      port = typeof address === 'object' && address ? address.port : 0
      resolve({
        port,
        close: async () => {
          for (const s of sockets) s.destroy()
          await new Promise<void>((done) => server.close(() => done()))
        },
      })
    })
  })
}

/** A declared length below the length field's own 4 bytes is not a message. */
function malformed(buf: Buffer<ArrayBufferLike>, started: boolean): boolean {
  const header = started ? 1 : 0
  return buf.length >= header + 4 && buf.readInt32BE(header) < 4
}

/** Take one whole protocol message off the front of `buf`, or `undefined` if it is not all there. */
function frame(
  buf: Buffer<ArrayBufferLike>,
  started: boolean,
): [Buffer<ArrayBufferLike>, Buffer<ArrayBufferLike>] | undefined {
  // Startup/SSL/Cancel carry no type byte: [int32 length][int32 code][…].
  const header = started ? 1 : 0
  if (buf.length < header + 4) return undefined
  const length = header + buf.readInt32BE(header)
  if (buf.length < length) return undefined
  return [buf.subarray(0, length), buf.subarray(length)]
}

/**
 * Does this response end with a `ReadyForQuery` that PostgreSQL would not have sent?
 *
 * The protocol rule (PostgreSQL "Message Flow", extended query): the backend sends
 * `ReadyForQuery` only in response to `Sync`, a simple `Query`, or a `FunctionCall` — never to
 * `Parse`, `Bind`, `Describe`, `Execute`, `Close` or `Flush`, *including when they fail*. After
 * an error it discards messages until `Sync` and answers that one. PGlite answers each message
 * on its own and appends a `ReadyForQuery` to the error, so the client sees two for one query.
 *
 * Exported for `bridge.unit.test.ts`, which is where this rule is actually asserted: the effect
 * of getting it wrong is only visible when the responses are also written separately, so the
 * end-to-end suite cannot be trusted to catch it.
 */
export function spuriousReadyForQuery(type: number, out: Uint8Array): boolean {
  if (type === SYNC || type === SIMPLE_QUERY || type === FUNCTION_CALL || type === STARTUP) {
    return false
  }
  return lastMessageIsReadyForQuery(out)
}

/**
 * Walks the frames rather than looking at the last six bytes, because a `DataRow` can *contain*
 * those six bytes: `select E'Z\\000\\000\\000\\005I'` is a perfectly ordinary string.
 */
function lastMessageIsReadyForQuery(out: Uint8Array): boolean {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  let last = -1
  for (let i = 0; i + 5 <= out.length; ) {
    const length = view.getInt32(i + 1)
    if (length < 4) return false // not framing we understand; strip nothing
    last = i
    i += 1 + length
  }
  return (
    last >= 0 &&
    last + READY_FOR_QUERY_BYTES === out.length &&
    out[last] === READY_FOR_QUERY &&
    view.getInt32(last + 1) === READY_FOR_QUERY_BYTES - 1
  )
}

/** `T33 D11 C13 Z5` — message types and lengths, for `PG_PRIME_BRIDGE_TRACE`. */
function describe(out: Uint8Array): string {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const parts: string[] = []
  for (let i = 0; i + 5 <= out.length; ) {
    const length = view.getInt32(i + 1)
    if (length < 4) return `${parts.join(' ')} <unframed +${out.length - i}B>`
    const type = String.fromCharCode(out[i]!)
    parts.push(
      type === 'Z' ? `Z(${String.fromCharCode(out[i + 5]!)})` : `${type}${length + 1}`,
    )
    i += 1 + length
  }
  return parts.join(' ')
}


