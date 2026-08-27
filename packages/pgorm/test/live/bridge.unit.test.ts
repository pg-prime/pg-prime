/**
 * The harness's own tier-0 test: `_pglite-bridge.ts` must speak the protocol PostgreSQL speaks.
 *
 * The oracle here is the protocol specification, not our implementation (R1): PostgreSQL sends
 * `ReadyForQuery` **only** for `Sync`, a simple `Query` or a `FunctionCall`. Everything else —
 * `Parse`, `Bind`, `Describe`, `Execute`, `Close`, `Flush` — is answered without one, *including
 * when it errors*, because after an error the backend discards messages until `Sync`.
 *
 * This lives in the `unit` project, with no database, on purpose. The end-to-end suite cannot be
 * relied on to catch a regression here: with the responses to one batch written in a single
 * `socket.write`, `pg` happens to tolerate a stray `ReadyForQuery` — until the writes are split,
 * at which point every SQLSTATE assertion in the suite becomes a coin flip. Verified 2026-08-25.
 */

import { describe, expect, it } from 'vitest'
import { spuriousReadyForQuery } from './_pglite-bridge.js'

const PARSE = 'P'.charCodeAt(0)
const BIND = 'B'.charCodeAt(0)
const EXECUTE = 'E'.charCodeAt(0)
const CLOSE = 'C'.charCodeAt(0)
const FLUSH = 'H'.charCodeAt(0)
const SYNC = 'S'.charCodeAt(0)
const QUERY = 'Q'.charCodeAt(0)
const STARTUP = 0

/** One backend message: type byte, int32 length (self-inclusive, type byte excluded), payload. */
function msg(type: string, payload: Uint8Array | string = new Uint8Array(0)): Uint8Array {
  const body = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
  const out = new Uint8Array(5 + body.length)
  out[0] = type.charCodeAt(0)
  new DataView(out.buffer).setInt32(1, 4 + body.length)
  out.set(body, 5)
  return out
}

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const readyForQuery = (status = 'I'): Uint8Array => msg('Z', status)
const parseComplete = (): Uint8Array => msg('1')
const bindComplete = (): Uint8Array => msg('2')
const commandComplete = (tag: string): Uint8Array => msg('C', `${tag}\0`)
const errorResponse = (): Uint8Array => msg('E', 'SERROR\0C42703\0Mcolumn "nope" does not exist\0\0')
const dataRow = (value: Uint8Array): Uint8Array => {
  const body = new Uint8Array(2 + 4 + value.length)
  const view = new DataView(body.buffer)
  view.setInt16(0, 1)
  view.setInt32(2, value.length)
  body.set(value, 6)
  return msg('D', body)
}

describe('spuriousReadyForQuery — what PostgreSQL would never have sent', () => {
  it('strips the ReadyForQuery PGlite appends to a failed extended-protocol message', () => {
    // This is the exact byte pattern observed from pglite 0.5.7 on `Parse`/`Bind` errors.
    const observed = cat(errorResponse(), readyForQuery('I'))
    expect(spuriousReadyForQuery(PARSE, observed)).toBe(true)
    expect(spuriousReadyForQuery(BIND, observed)).toBe(true)
    expect(spuriousReadyForQuery(EXECUTE, observed)).toBe(true)
    expect(spuriousReadyForQuery(CLOSE, observed)).toBe(true)
    expect(spuriousReadyForQuery(FLUSH, observed)).toBe(true)
  })

  it('keeps the one Sync is entitled to — that is the whole query cycle', () => {
    expect(spuriousReadyForQuery(SYNC, readyForQuery('E'))).toBe(false)
    expect(spuriousReadyForQuery(SYNC, cat(msg('S', 'x\0y\0'), readyForQuery('T')))).toBe(false)
  })

  it('keeps the one a simple Query and the StartupMessage are entitled to', () => {
    expect(spuriousReadyForQuery(QUERY, cat(commandComplete('SELECT 1'), readyForQuery()))).toBe(false)
    expect(spuriousReadyForQuery(STARTUP, cat(msg('R', '\0\0\0\0'), readyForQuery()))).toBe(false)
  })

  it('does nothing when there is no ReadyForQuery to strip', () => {
    expect(spuriousReadyForQuery(PARSE, parseComplete())).toBe(false)
    expect(spuriousReadyForQuery(BIND, bindComplete())).toBe(false)
    expect(spuriousReadyForQuery(EXECUTE, cat(dataRow(new Uint8Array([0x31])), commandComplete('SELECT 1')))).toBe(false)
    expect(spuriousReadyForQuery(PARSE, new Uint8Array(0))).toBe(false)
  })

  it('NEGATIVE CONTROL — a DataRow that CONTAINS those six bytes is not a ReadyForQuery', () => {
    // `select E'Z\000\000\000\005I'` is an ordinary string, and its DataRow ends with exactly the
    // bytes of a ReadyForQuery. Looking at the last six bytes instead of walking the frames
    // would truncate a legitimate row and desynchronise the client.
    const payload = new Uint8Array([0x5a, 0x00, 0x00, 0x00, 0x05, 0x49])
    const row = cat(dataRow(payload), commandComplete('SELECT 1'))
    expect(spuriousReadyForQuery(EXECUTE, row)).toBe(false)
    expect(spuriousReadyForQuery(EXECUTE, dataRow(payload))).toBe(false)
  })
})
