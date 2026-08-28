/**
 * The session layer's vocabulary (design/07 §1, §3, §6).
 *
 * This file is types only — no runtime, no imports beyond types — because `src/query/types.ts`
 * imports it to declare `Db` / `Tx` / `Session` / `Queryable`, and `src/query/types.ts` is the
 * type layer's hot file. A value import here would put the whole session runtime in the graph of
 * anything that names a handle type.
 */

import type { Compiled } from '../compile/contract.js'
import type { ExplainOptions, ExplainResult, StatementMode, StreamOptions } from '../query/executor.js'

/**
 * `Symbol.asyncDispose`, declared so that a consumer **without** `lib: esnext.disposable` still
 * compiles.
 *
 * `07` §1.3 puts `[Symbol.asyncDispose]()` on `Db`, on `Subscription` and on `AdvisoryLock` so that
 * `await using db = pgPrime(...)` works. Writing the computed key directly makes the emitted
 * `.d.ts` fail with TS2550 on any consumer whose `lib` predates the disposable declarations —
 * measured by `tools/check-dts.mjs`, which type-checks every shipped `.d.ts` on the 5.9.3 floor
 * with no `@types/node` at all, and which is exactly the consumer we must not break.
 *
 * So the key is *inferred* from the ambient `SymbolConstructor`. Where the consumer's lib declares
 * `asyncDispose` this is that symbol and `await using` works; where it does not, the key resolves
 * to `never`, the mapped type contributes no member, and the declaration still compiles. The
 * runtime is unaffected either way — `end()` is always there and is the same function.
 */
export type AsyncDisposeKey = typeof Symbol extends { readonly asyncDispose: infer S extends symbol }
  ? S
  : never

/** `{ [Symbol.asyncDispose](): Promise<void> }`, or `{}` on a lib that has no such symbol. */
export type AsyncDisposable_ = { readonly [K in AsyncDisposeKey]: () => Promise<void> }

// ─────────────────────────────────────────────────────────────────────────────
// §3.1 — transactions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `read uncommitted` is deliberately **not offered**: PostgreSQL accepts the keyword and silently
 * gives you `read committed`. Being PG-only is the licence not to ship a no-op option.
 */
export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable'
export type AccessMode = 'read write' | 'read only'

/** A PostgreSQL interval-ish duration, as a GUC accepts it: `'30s'`, `'5min'`, `250` (ms). */
export type Duration = string | number

export interface RetryPolicy {
  /** Default `['40001']` at repeatable read / serializable; `[]` at read committed. */
  readonly on?: readonly string[]
  /** Default 5, i.e. up to four retries. */
  readonly maxAttempts?: number
  /** Default 25. */
  readonly baseDelayMs?: number
  /** Default 1 000. */
  readonly maxDelayMs?: number
  /**
   * `'full'` (default) = `sleep(random(0, min(maxDelay, base * 2 ** (attempt - 1))))`.
   *
   * Full jitter rather than plain exponential because serialization failures are *inherently
   * correlated* — the conflicting transactions failed at the same instant and would otherwise
   * retry in lockstep, reproducing the conflict.
   */
  readonly jitter?: 'full' | 'equal' | 'none'
  /** The last word. Return `false` to stop retrying. Sees the typed error and the attempt number. */
  readonly shouldRetry?: (err: unknown, attempt: number) => boolean
  readonly onRetry?: (info: {
    readonly err: unknown
    readonly attempt: number
    readonly delayMs: number
    readonly label?: string
  }) => void
}

export interface TxOptionsBase {
  readonly retry?: RetryPolicy | boolean
  /** `SET LOCAL statement_timeout` for the whole transaction. */
  readonly timeoutMs?: number
  /** `SET LOCAL lock_timeout`. */
  readonly lockTimeoutMs?: number
  /** Transaction-local GUCs, applied immediately after `BEGIN`, in one round trip (§3.5). */
  readonly localSettings?: Readonly<Record<string, string | number | boolean>>
  readonly signal?: AbortSignal
  /** Free-form label; appears in hooks, spans, slow-query logs and retry warnings. */
  readonly label?: string
}

/**
 * `DEFERRABLE` is only meaningful with `SERIALIZABLE` + `READ ONLY`, and the **type** is what
 * enforces that — PostgreSQL accepts and silently ignores it otherwise, which is worse than an
 * error.
 */
export type TxOptions =
  | (TxOptionsBase & {
      readonly isolation?: 'read committed' | 'repeatable read'
      readonly accessMode?: AccessMode
      readonly deferrable?: never
    })
  | (TxOptionsBase & {
      readonly isolation: 'serializable'
      readonly accessMode?: 'read write'
      readonly deferrable?: never
    })
  | (TxOptionsBase & {
      readonly isolation: 'serializable'
      readonly accessMode: 'read only'
      readonly deferrable?: boolean
    })

/**
 * `07` §3.3 — `isolation` / `accessMode` / `deferrable` / `retry` are **absent by construction**.
 *
 * PostgreSQL cannot change the first three mid-transaction, and Drizzle/MikroORM both accept them
 * on nested calls where they are silently ignored. `retry` is absent because a `40001` aborts the
 * *whole* transaction: retrying at savepoint level is meaningless and dangerous.
 */
export interface SavepointOptions {
  readonly timeoutMs?: number
  readonly lockTimeoutMs?: number
  readonly localSettings?: Readonly<Record<string, string | number | boolean>>
  readonly label?: string
  readonly signal?: AbortSignal
}

/** `pgPrime({ transaction })` — the per-db defaults every `transaction()` starts from. */
export interface TransactionDefaults {
  readonly isolation?: IsolationLevel
  readonly accessMode?: AccessMode
  readonly retry?: RetryPolicy | boolean
  readonly timeoutMs?: number
  readonly lockTimeoutMs?: number
  readonly label?: string
}

/**
 * `07` §1.5 layer 2(c) — a handle cannot escape its scope through the return value.
 *
 * One conditional, no recursion. Deliberately **shallow**: a deep walk would cost instantiations
 * on every `transaction()` call site, which is risk #1 in `research/SUMMARY.md`. It catches
 * `return tx`, which is the mistake people actually make.
 */
export type NoHandleEscape<T> = T extends { readonly kind: 'tx' | 'session' }
  ? ['Error: a Tx/Session handle escaped its callback. It is closed and unusable.', never]
  : T

// ─────────────────────────────────────────────────────────────────────────────
// §1.2 — pool policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `07` §1.2. Two of `pg-pool`'s defaults are actively hostile in production and we override them:
 * `connectionTimeoutMillis` (pg: 0 = wait forever, which turns pool exhaustion into an unbounded
 * hang with no error and no metric) and `maxLifetimeSeconds` (pg: 0 = off, so connections survive
 * DNS changes and failovers by not noticing them).
 *
 * These apply only when **we** build the pool — i.e. for `connection:`. A user-supplied `pool:`
 * keeps whatever it was constructed with, because reaching into it would be a surprise.
 */
export interface PoolOptions {
  /** Default 10 — the ecosystem default, kept on purpose. See §1.2's multiplication warning. */
  readonly max?: number
  /** Default 0. A warm pool costs real connections in every idle replica. */
  readonly min?: number
  readonly idleTimeoutMillis?: number
  /** Default 10 000. **We change pg's default of 0 = wait forever.** */
  readonly connectionTimeoutMillis?: number
  /** Default 1 800. **We change pg's default of 0 = off**, so the fleet self-heals after a failover. */
  readonly maxLifetimeSeconds?: number
  readonly maxUses?: number
  readonly allowExitOnIdle?: boolean
}

/** Discrete connection parameters, for people who do not want a URL. */
export interface ConnectionParams {
  readonly host?: string
  readonly port?: number
  readonly database?: string
  readonly user?: string
  readonly password?: string | (() => string | Promise<string>)
  readonly ssl?: boolean | Record<string, unknown>
  readonly applicationName?: string
  /** Anything else `pg.Pool` accepts, passed through untouched. */
  readonly [key: string]: unknown
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.6 — session GUCs
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionDefaults {
  /** Default `'pg-prime'`. Free, and the difference between a readable and unreadable `pg_stat_activity`. */
  readonly applicationName?: string
  /** Default `'30s'`. Explicitly *not* Prisma's 5 s. `null` disables. */
  readonly statementTimeout?: Duration | null
  /** Default `null`. A default here breaks legitimate queuing, and PG's own default is unset. */
  readonly lockTimeout?: Duration | null
  /** Default `'60s'`. Bounds the classic "await an HTTP call inside a transaction" leak. */
  readonly idleInTransactionSessionTimeout?: Duration | null
  readonly searchPath?: readonly string[]
  /** Default `'UTC'`. `DateStyle` is likewise pinned to `ISO, MDY`. */
  readonly timeZone?: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 — cancellation, timeouts, LISTEN, COPY
// ─────────────────────────────────────────────────────────────────────────────

/** What every handle-level call accepts. `07` §6.1's "composes downward". */
export interface CallOptions {
  readonly signal?: AbortSignal | undefined
  /**
   * Per-statement timeout (§6.2). Inside a transaction this is `SET LOCAL statement_timeout`;
   * outside it is a client-side timer plus a `CancelRequest`, unless
   * `timeoutStrategy: 'transaction'` asks for the server-side guarantee.
   */
  readonly timeoutMs?: number | undefined
  readonly timeoutStrategy?: 'auto' | 'transaction' | 'client' | undefined
  readonly label?: string | undefined
  readonly statement?: StatementMode | undefined
  /** `07` §1.5 layer 3's per-call opt-out from the dev guard. */
  readonly outsideTransaction?: boolean | undefined
}

export interface RunCallOptions extends CallOptions {
  readonly params?: Readonly<Record<string, unknown>> | undefined
}

/**
 * `07` §6.3, extended with the per-stream statement timeout §3.6 promises streams are exempt from.
 *
 * Written out rather than `extends StreamOptions, CallOptions`: under `exactOptionalPropertyTypes`
 * the two declare `signal` as `AbortSignal` and `AbortSignal | undefined`, which are not identical
 * property types, so the intersection is illegal. Restating three fields is cheaper than widening
 * an interface the query layer owns.
 */
export interface StreamCallOptions extends CallOptions {
  /** Rows per `FETCH`. Default 1 000. */
  readonly batchSize?: number | undefined
  /** Default `null` — a long stream must not trip the 30 s session default. */
  readonly statementTimeoutMs?: number | null | undefined
}

/** Anything `run` / `explain` / `stream` accepts: a builder, a prepared query, or a raw `Compiled`. */
export interface Compilable<O> {
  compile(): Compiled<O>
}
export type Runnable<O> = Compilable<O> | Compiled<O>

export type NotificationHandler = (
  payload: string,
  ctx: { readonly channel: string; readonly processId: number },
) => void

export interface Subscription extends AsyncDisposable_ {
  readonly channel: string
  close(): Promise<void>
  on(event: 'reconnect', h: (info: { attempt: number; downMs: number }) => void): () => void
  /** Fires after a reconnect. Notifications during the gap are **LOST** — reconcile here. */
  on(event: 'gap', h: (info: { downMs: number }) => void): () => void
  on(event: 'error', h: (e: unknown) => void): () => void
}

export interface ListenOptions {
  readonly signal?: AbortSignal
}

export interface CopyOptions {
  readonly signal?: AbortSignal
  /** `'text'` (default) or `'csv'`. Binary COPY is not a v1 format — see `src/session/copy.ts`. */
  readonly format?: 'text' | 'csv'
  /** Columns to write, in order. Defaults to every column the schema declares as insertable. */
  readonly columns?: readonly string[]
  /** Bytes buffered before backpressure is applied to the source. Default 64 KiB. */
  readonly highWaterMark?: number
}

export interface CopyResult {
  readonly rowCount: number
}

/** `07` §3.7 — a session-level advisory lock, which only a `Session` can hold. */
export interface AdvisoryLock extends AsyncDisposable_ {
  readonly key: bigint
  readonly shared: boolean
  unlock(): Promise<boolean>
}

export interface AdvisoryLockOptions {
  readonly try?: boolean
  readonly shared?: boolean
}

/** Re-exported so a handle signature needs one import. */
export type { ExplainOptions, ExplainResult, StreamOptions }
