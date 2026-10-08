import type { AsyncDisposable_, Db, Queryable } from 'pg-prime'

export type RunState =
  | 'pending'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'missed'
  | 'enqueued'
  | 'cancelled'

/** A 5- or 6-field cron pattern in `tz` (default `'UTC'`), a fixed interval, or one time. */
export type ScheduleWhen = { cron: string; tz?: string } | { everyMs: number } | { at: Date }

export interface ScheduleOptions<P> {
  startAt?: Date
  endAt?: Date
  /** Ticks to claim, whatever each claim decides; manual triggers do not count. */
  limit?: number
  overlap?: 'skip' | 'allow'
  misfire?: 'skip' | 'once'
  misfireGraceMs?: number
  payload?: P | ((tick: { tickAt: Date | null; manual: boolean }) => P)
  timeoutMs?: number
  retry?: {
    maxAttempts?: number
    baseDelayMs?: number
    maxDelayMs?: number
    jitter?: 'full' | 'equal' | 'none'
  }
  history?: { keep?: number; ageMs?: number }
}

export interface RunContext<P> {
  readonly schedule: string
  readonly tickAt: Date | null
  readonly manual: boolean
  readonly payload: P
  readonly attempt: number
  readonly missed: number
  readonly signal: AbortSignal
}

export type ScheduleTarget<P> =
  | { handler: (run: RunContext<P>) => Promise<unknown> }
  | { queue: { readonly name: string } }

export interface ScheduleDef<P = unknown> {
  readonly name: string
  readonly when: ScheduleWhen
  readonly target: ScheduleTarget<P>
  readonly options: ScheduleOptions<P>
}

/** Structurally satisfied by `@pg-prime/mq`'s `pgMq(...)`. */
export interface CronEnqueuer {
  queue(def: { readonly name: string }): {
    start?(): Promise<void>
    send(
      payload: any,
      opts: { tx: Queryable<any>; key: string; dedup?: 'until-done' },
    ): Promise<{ id: bigint; deduplicated: boolean }>
  }
}

export interface CronHooks {
  onTick?(e: {
    schedule: string
    tickAt: Date
    decision: RunState
    missed: number
    lateMs: number
  }): void
  onRunStart?(e: { schedule: string; runId: bigint; manual: boolean }): void
  onRunEnd?(e: {
    schedule: string
    runId: bigint
    state: RunState
    durationMs: number
    error?: unknown
  }): void
  onMisfire?(e: { schedule: string; policy: 'skip' | 'once'; missed: number }): void
  onInternal?(e: {
    kind:
      | 'listen-unavailable'
      | 'heartbeat-failed'
      | 'pending-unclaimed'
      | 'hook-failed'
      | 'loop-failed'
    message: string
    cause?: unknown
  }): void
}

export interface CronConfig {
  db: Db
  schema?: string
  autoMigrate?: boolean
  schedules?: readonly ScheduleDef<any>[]
  enqueuer?: CronEnqueuer
  instance?: string
  pollMs?: number
  leaseMs?: number
  maintenanceMs?: number
  maxConcurrent?: number
  graceMs?: number
  signal?: AbortSignal
  hooks?: CronHooks
}

export interface ScheduleInfo {
  readonly name: string
  readonly when: ScheduleWhen
  readonly target: 'handler' | 'queue'
  readonly queue: string | null
  readonly startAt: Date | null
  readonly endAt: Date | null
  readonly limit: number | null
  readonly overlap: 'skip' | 'allow'
  readonly misfire: 'skip' | 'once'
  readonly misfireGraceMs: number
  readonly payload: unknown
  readonly timeoutMs: number | null
  readonly enabled: boolean
  readonly paused: boolean
  /** `null` once disabled or ended. */
  readonly nextAt: Date | null
  readonly runs: number
  readonly running: number
  readonly source: 'code' | 'api'
  readonly updatedAt: Date
}

export interface RunInfo {
  readonly id: bigint
  readonly schedule: string
  readonly tickAt: Date | null
  readonly manual: boolean
  readonly state: RunState
  readonly attempts: number
  readonly missed: number
  readonly instance: string | null
  readonly messageId: bigint | null
  readonly payload: unknown
  readonly startedAt: Date | null
  readonly finishedAt: Date | null
  readonly error: string | null
  readonly result: unknown
  readonly createdAt: Date
}

export interface Cron extends AsyncDisposable_ {
  start(): Promise<void>
  close(): Promise<void>
  create<P>(def: ScheduleDef<P>): Promise<void>
  update(
    name: string,
    patch: Partial<{ when: ScheduleWhen } & ScheduleOptions<unknown>>,
  ): Promise<void>
  remove(name: string, opts?: { force?: boolean }): Promise<boolean>
  pause(name: string): Promise<void>
  resume(name: string): Promise<void>
  enable(name: string): Promise<void>
  disable(name: string): Promise<void>
  trigger(name: string, opts?: { payload?: unknown }): Promise<{ runId: bigint; state: RunState }>
  cancel(runId: bigint): Promise<boolean>
  get(name: string): Promise<ScheduleInfo | undefined>
  list(): Promise<ScheduleInfo[]>
  runs(name: string, opts?: { limit?: number; before?: bigint }): Promise<RunInfo[]>
  preview(when: ScheduleWhen, opts?: { count?: number; from?: Date }): Promise<Date[]>
  prune(keep: readonly string[]): Promise<string[]>
}
