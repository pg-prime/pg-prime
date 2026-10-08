import { UsageError } from 'pg-prime'
import type { Queryable } from 'pg-prime'
import { checkRetry } from '../define.js'
import type { QueueDef, RetryOptions } from '../define.js'
import { LeaseLostError } from '../errors.js'
import type { Core } from '../mq.js'
import { encodePayload } from '../payload.js'
import { dedupOwners, insert } from '../sql/send.js'
import type { NewRow, OnFail } from '../sql/send.js'

export type { OnFail }

export interface SendOptions {
  tx?: Queryable<any>
  delayMs?: number
  /** Compared on the database clock. */
  runAt?: Date
  /** Lower runs first; default 0. */
  priority?: number
  lifo?: boolean
  /** The idempotency key; with `dedup`, also the dedup key. */
  key?: string
  dedup?: 'until-done' | { windowMs: number; extend?: boolean }
  /** FIFO within a group; groups are served round-robin. */
  group?: string
  retry?: Omit<RetryOptions, 'shouldRetry'>
}

export interface MessageRef {
  readonly queue: string
  readonly id: bigint
  /** True when an earlier message holds the dedup key; `id` is that message. */
  readonly deduplicated: boolean
}

export type ChildSendOptions = Omit<SendOptions, 'tx' | 'key' | 'dedup'> & { onFail?: OnFail }

export interface FlowChild<T = unknown> {
  queue: QueueDef<T, any>
  payload: T
  opts?: ChildSendOptions
  children?: readonly FlowChild<any>[]
}

/** Dedup is accepted on the root only. */
export interface FlowRoot<T = unknown> {
  queue: QueueDef<T, any>
  payload: T
  opts?: Omit<SendOptions, 'tx'>
  children?: readonly FlowChild<any>[]
}

export interface FlowRef extends MessageRef {
  readonly children: readonly FlowRef[]
}

/** One message as an S1 row; validates the options. */
export async function newRow(
  def: QueueDef<any, any>,
  payload: unknown,
  o: (Omit<SendOptions, 'tx'> & { onFail?: OnFail }) | undefined,
  n: number,
  parentN: number | null = null,
  kids = 0,
): Promise<NewRow> {
  const opts = o ?? {}
  if (opts.group !== undefined && (typeof opts.group !== 'string' || opts.group === '')) {
    throw new UsageError('@pg-prime/mq: a group key must be a non-empty string.')
  }
  if (opts.dedup !== undefined && opts.key === undefined) {
    throw new UsageError('@pg-prime/mq: dedup needs a key: send(payload, { key, dedup }).')
  }
  const retry = { ...def.retry, ...opts.retry }
  checkRetry(retry, `queue ${def.name}`)
  const window = typeof opts.dedup === 'object' ? opts.dedup : undefined
  return {
    n,
    queue: def.name,
    parentN,
    kids,
    onFail: opts.onFail ?? 'wait',
    payload: await encodePayload(def.payload, payload),
    key: opts.key ?? null,
    priority: opts.priority ?? 0,
    lifo: opts.lifo === true,
    delayMs: opts.delayMs ?? null,
    runAt: opts.runAt ?? null,
    group: opts.group ?? null,
    retry,
    dedup: opts.dedup === undefined ? null : (opts.key as string),
    dedupMs: window?.windowMs ?? null,
  }
}

const refuseDedup = (o: object | undefined, where: string): void => {
  if (o !== undefined && ('dedup' in o || 'key' in o)) {
    throw new UsageError(
      `@pg-prime/mq: ${where} cannot take key or dedup; dedup is on a flow's root only.`,
    )
  }
}

interface Node {
  readonly n: number
  readonly queue: string
  readonly kids: Node[]
}

/** F1: a whole tree in one statement; a deduplicated root inserts nothing. */
export async function flow(core: Core, root: FlowRoot<any>, tx?: Queryable<any>): Promise<FlowRef> {
  const rows: NewRow[] = []
  const defs = new Set<QueueDef<any, any>>()
  const walk = async (
    node: FlowChild<any> | FlowRoot<any>,
    parentN: number | null,
  ): Promise<Node> => {
    if (parentN !== null) refuseDedup(node.opts, 'a flow child')
    const kids = node.children ?? []
    const me: Node = { n: rows.length + 1, queue: node.queue.name, kids: [] }
    defs.add(node.queue)
    rows.push(await newRow(node.queue, node.payload, node.opts, me.n, parentN, kids.length))
    for (const k of kids) me.kids.push(await walk(k, me.n))
    return me
  }
  const tree = await walk(root, null)
  if (tx === undefined) for (const d of defs) await core.ready(d)
  else core.assertStarted('flow')
  const q = tx ?? core.db
  const extend = typeof root.opts?.dedup === 'object' && root.opts.dedup.extend === true
  const out = await insert(q, core.t, rows, { extend, flow: true })
  const head = out[0] as (typeof out)[number]
  if (head.id === null) {
    const key = rows[0]?.dedup as string
    const id = head.existing ?? (await dedupOwners(q, core.t, root.queue.name, [key])).get(key)
    return { queue: root.queue.name, id: id ?? 0n, deduplicated: true, children: [] }
  }
  const ids = new Map(out.map((r) => [r.n, r.id as bigint]))
  const ref = (x: Node): FlowRef => ({
    queue: x.queue,
    id: ids.get(x.n) as bigint,
    deduplicated: false,
    children: x.kids.map(ref),
  })
  core.hooks.emit('onSend', {
    queue: root.queue.name,
    ids: [...ids.values()],
    inTx: tx !== undefined,
  })
  return ref(tree)
}

/** `ctx.spawn`: a child of the active parent, inserted with its `deps` row, token-guarded. */
export async function spawn(
  core: Core,
  parent: { readonly id: bigint; readonly token: string },
  def: QueueDef<any, any>,
  payload: unknown,
  opts?: ChildSendOptions,
): Promise<MessageRef> {
  refuseDedup(opts, 'ctx.spawn')
  await core.ready(def)
  const [r] = await insert(core.db, core.t, [await newRow(def, payload, opts, 1)], {
    extend: false,
    flow: false,
    parent,
  })
  if (r?.id == null) {
    throw new LeaseLostError(
      `@pg-prime/mq: message ${parent.id} is no longer held; nothing was spawned.`,
    )
  }
  core.hooks.emit('onSend', { queue: def.name, ids: [r.id], inTx: false })
  return { queue: def.name, id: r.id, deduplicated: false }
}
