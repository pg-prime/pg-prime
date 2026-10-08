import { UsageError } from 'pg-prime'
import type { Queryable, Tx } from 'pg-prime'
import type { QueueDef } from '../define.js'
import { LeaseLostError } from '../errors.js'
import type { Core } from '../mq.js'
import { MAX_PROGRESS, toJson } from '../payload.js'
import { deps } from '../sql/read.js'
import type { MessageState, MsgRow } from '../sql/read.js'
import type { Move } from '../sql/settle.js'
import { progress } from '../sql/settle.js'
import { spawn } from './flow.js'
import type { ChildSendOptions, MessageRef } from './flow.js'
import { completeMessage } from './settle.js'

export interface Message<T, R = unknown> {
  readonly id: bigint
  readonly queue: string
  readonly state: MessageState
  readonly payload: T
  readonly key: string | null
  readonly priority: number
  readonly group: string | null
  readonly attempts: number
  readonly claims: number
  readonly progress: unknown
  readonly result: R | undefined
  readonly error: string | null
  /** The claim's token; null unless the message is active. */
  readonly token: string | null
  readonly createdAt: Date
  readonly startedAt: Date | null
  readonly finishedAt: Date | null
  readonly runAt: Date | null
}

export function message<T, R>(r: MsgRow, payload: T): Message<T, R> {
  return {
    id: r.id,
    queue: r.queue,
    state: r.state,
    payload,
    key: r.key,
    priority: r.priority,
    group: r.group,
    attempts: r.attempts,
    claims: r.claims,
    progress: r.progress,
    result: (r.result ?? undefined) as R | undefined,
    error: r.error,
    token: r.token,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    runAt: r.runAt,
  }
}

/** Returned by a handler to move its message without counting an attempt. */
export interface Deferral {
  readonly deferral: Move
}

const deferrals = new WeakSet<object>()
const deferral = (m: Move): Deferral => {
  const d = Object.freeze({ deferral: m })
  deferrals.add(d)
  return d
}
export const isDeferral = (v: unknown): v is Deferral =>
  typeof v === 'object' && v !== null && deferrals.has(v)

export type ChildStatus = 'pending' | 'completed' | 'failed' | 'ignored'

export interface WorkContext<_T, R> {
  readonly signal: AbortSignal
  readonly token: string
  /** 1-based: this run's attempt number. */
  readonly attempt: number
  progress(value: unknown): Promise<void>
  /** Inserts a child (and its `deps` row) while this message is active; then `waitForChildren()`. */
  spawn<C>(queue: QueueDef<C, any>, payload: C, opts?: ChildSendOptions): Promise<MessageRef>
  /** Keyed `'<queue>:<id>'`. */
  childResults(): Promise<Record<string, { status: ChildStatus; value?: unknown }>>
  /**
   * Completes the message inside your transaction: your writes and the completion commit together.
   * Must be the transaction's last statement; refused on queues with a global `concurrency`.
   */
  complete(result: R, opts: { tx: Queryable<any> }): Promise<void>
  /** `db.transaction(fn)` with `complete` as its last statement. */
  transaction<V extends R>(fn: (tx: Tx) => Promise<V>): Promise<V>
  /** Back to `delayed`, no attempt counted. */
  defer(at: { delayMs: number } | { until: Date }): Deferral
  /** Back to `ready`, no attempt counted; the queue takes no claims for `ms`. */
  rateLimit(ms: number): Deferral
  /** Blocks until every child has resolved, then runs the handler again. */
  waitForChildren(): Deferral
}

/** What the worker tracks per message; `inTx` turns the automatic settle into a check. */
export interface Running {
  readonly row: MsgRow
  readonly token: string
  readonly abort: AbortController
  inTx: boolean
}

/** Refuses a transactional settle on a queue with a global `concurrency` (§5.7). */
export function assertTxSettle(def: QueueDef<any, any>): void {
  if (def.concurrency !== undefined) {
    throw new UsageError(
      `@pg-prime/mq: queue ${def.name} has a global concurrency, so its completion cannot run in ` +
        `your transaction: the counter update would hold the queue row every claim waits on.`,
    )
  }
}

export function workContext<T, R>(
  core: Core,
  def: QueueDef<T, R>,
  run: Running,
): WorkContext<T, R> {
  const { row, token } = run
  const lost = (): LeaseLostError =>
    new LeaseLostError(
      `@pg-prime/mq: message ${def.name}:${row.id} is no longer held by this worker.`,
    )
  const ctx: WorkContext<T, R> = {
    signal: run.abort.signal,
    token,
    attempt: row.attempts + 1,
    async progress(value) {
      if (
        !(await progress(core.db, core.t, row.id, token, toJson(value, MAX_PROGRESS, 'progress')))
      ) {
        throw lost()
      }
    },
    spawn: (queue, payload, opts) => spawn(core, { id: row.id, token }, queue, payload, opts),
    async childResults() {
      const rows = await deps(core.db, core.t, row.id)
      return Object.fromEntries(
        rows.map((d) => [
          `${d.queue}:${d.child}`,
          d.value === undefined ? { status: d.status } : { status: d.status, value: d.value },
        ]),
      )
    },
    async complete(result, { tx }) {
      assertTxSettle(def)
      run.inTx = true
      if ((await completeMessage(core, def, { ...row, token }, result, tx)) === undefined)
        throw lost()
    },
    transaction: <V extends R>(fn: (tx: Tx) => Promise<V>) =>
      core.db.transaction(async (tx) => {
        const v = await fn(tx)
        await ctx.complete(v, { tx })
        return v
      }) as Promise<V>,
    defer: (at) =>
      deferral({
        kind: 'defer',
        ...('until' in at ? { until: at.until } : { delayMs: at.delayMs }),
      }),
    rateLimit: (ms) => deferral({ kind: 'release', limitMs: ms }),
    waitForChildren: () => deferral({ kind: 'wait' }),
  }
  return ctx
}
