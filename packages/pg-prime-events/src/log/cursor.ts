import { UsageError } from 'pg-prime'

/**
 * Position `(xid, id)` plus `pending`: transactions below the position that were still running
 * when a read stepped over them, each mapped to the last id delivered from it (0: none).
 */
export interface Cursor {
  readonly xid: bigint
  readonly id: bigint
  readonly pending: ReadonlyMap<bigint, bigint>
}

/**
 * What a read saw: the last unfiltered `next` row, the last unfiltered `late` row when `late`
 * filled the read limit (more may follow), and the snapshot's running xids.
 */
export interface ReadView {
  readonly pos: { readonly xid: bigint; readonly id: bigint } | null
  readonly late: { readonly xid: bigint; readonly id: bigint } | null
  readonly running: readonly bigint[]
}

export const BEGINNING: Cursor = { xid: 0n, id: 0n, pending: new Map() }

/** `from: 'now'`: everything that commits after the snapshot `(xmax, xip)`. */
export function seed(xmax: bigint, xip: readonly bigint[]): Cursor {
  return { xid: xmax, id: 0n, pending: new Map(xip.map((x) => [x, 0n])) }
}

/** The cursor right after acknowledging `e`, one entry of `read`. */
export function advance(c: Cursor, read: ReadView, e: { xid: bigint; id: bigint }): Cursor {
  const pending = new Map(c.pending)
  if (pending.has(e.xid)) {
    pending.set(e.xid, e.id)
    return { xid: c.xid, id: c.id, pending }
  }
  addRunning(pending, read.running, e.xid)
  return { xid: e.xid, id: e.id, pending }
}

/** The cursor once everything `read` delivered is acknowledged, even when it delivered nothing. */
export function advanceTo(c: Cursor, read: ReadView): Cursor {
  const pending = new Map(c.pending)
  if (read.pos !== null) addRunning(pending, read.running, read.pos.xid)
  const running = new Set(read.running)
  // A finished transaction's entries are all visible, and `late` reads them in (xid, id) order.
  for (const x of pending.keys()) {
    if (running.has(x) || (read.late !== null && x > read.late.xid)) continue
    if (x === read.late?.xid) pending.set(x, read.late.id)
    else pending.delete(x)
  }
  return read.pos === null
    ? { xid: c.xid, id: c.id, pending }
    : { xid: read.pos.xid, id: read.pos.id, pending }
}

function addRunning(pending: Map<bigint, bigint>, running: readonly bigint[], below: bigint): void {
  for (const x of running) if (x < below && !pending.has(x)) pending.set(x, 0n)
}

export function encodeCursor(c: Cursor): string {
  const p = [...c.pending].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([x, a]) => `${x}:${a}`)
  return `${c.xid}.${c.id}${p.length === 0 ? '' : `.${p.join(',')}`}`
}

const CURSOR = /^(\d+)\.(\d+)(?:\.(\d+:\d+(?:,\d+:\d+)*))?$/

export function decodeCursor(s: string): Cursor {
  const m = CURSOR.exec(s)
  if (m === null) {
    throw new UsageError(`@pg-prime/events: ${JSON.stringify(s)} is not an Entry.cursor.`)
  }
  const pending = new Map<bigint, bigint>()
  for (const pair of m[3]?.split(',') ?? []) {
    const [x, a] = pair.split(':') as [string, string]
    pending.set(BigInt(x), BigInt(a))
  }
  return { xid: BigInt(m[1] as string), id: BigInt(m[2] as string), pending }
}
