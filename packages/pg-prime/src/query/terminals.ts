/**
 * The terminal operations every builder shares (design/09 WS6).
 *
 * `execute` / `executeTakeFirst` / `stream` / `explain` / `toSQL` / `prepare` mean the same thing
 * on a select, a set operation and the three write builders, and five copies of each would be
 * five places for them to drift. So the builders keep one-line methods and the behaviour lives
 * here, one level above {@link Runner} — which is the only thing that differs between `db` and
 * `tx`.
 */

import type { Compiled, CompiledMeta } from '../compile/contract.js'
import type { PgParam } from '../driver/index.js'
import { BuilderError } from '../sql/errors.js'
import type { BuilderCtx, Runner } from './builder-state.js'
import type { ExplainOptions, ExplainResult, RunOptions, StreamOptions } from './executor.js'
import { bindsToParams, explainOn, makeResult, needsRollbackRail, streamOn } from './executor.js'

/** An unfilled `.prepare()` hole, as `toSQL()` reports it. */
export interface PlaceholderRef {
  readonly placeholder: string
}

/**
 * What `toSQL()` returns: everything a human or another tool needs, and nothing that can throw.
 *
 * `params` carries the **encoded** wire values, because that is the honest artifact — the security
 * claim of `03` §3.4 is about what is in the bind slot, not about what the caller typed. An
 * unfilled placeholder reads as `{ placeholder: 'email' }` rather than throwing, because `toSQL()`
 * is what you reach for *while* debugging a prepared query, and a debugging tool that refuses to
 * print an incomplete statement is the one that is useless.
 */
export interface SqlSnapshot {
  readonly sql: string
  readonly params: readonly (PgParam | PlaceholderRef)[]
  readonly placeholders: readonly string[]
  readonly meta: CompiledMeta
}

export function toSQLOf(
  compiled: Compiled<unknown>,
  values?: Readonly<Record<string, unknown>>,
): SqlSnapshot {
  const params: (PgParam | PlaceholderRef)[] = compiled.binds.map((b) => {
    if (b.k === 'value') return b.encoded
    if (values !== undefined && Object.hasOwn(values, b.name)) {
      const v = values[b.name]
      return v === null || v === undefined ? null : b.codec.encode(v as never)
    }
    return { placeholder: b.name }
  })
  return Object.freeze({
    sql: compiled.sql,
    params: Object.freeze(params),
    placeholders: compiled.meta.placeholders,
    meta: compiled.meta,
  })
}

/**
 * `rows[0]`, and deliberately **not** `maxRows: 1`.
 *
 * The portal-level cap is the tempting implementation, and design/09 WS6 assumed it was dangerous
 * because `02`'s own docblock said a cap *stops* a row-returning DML statement. **It does not** —
 * measured on PG 17.11 (`test/driver/cursor.test.ts`): `INSERT … RETURNING` over five rows with
 * `maxRows: 1` inserts all five. So the reason to refuse it is not the one that was written down,
 * and it is worth stating the three that survive:
 *
 *  1. **It would report the wrong count.** `CommandComplete` says `INSERT 0 1` for five inserted
 *     rows. Nothing in this library surfaces `rowCount` yet, and a decision that becomes wrong the
 *     day it does is not a decision.
 *  2. **A chunked bulk insert compiles to N statements** (`03` §2.6). "Cap the first one" runs a
 *     fraction of the batch; `executeTakeFirst` has to mean *exactly* what `execute()` means, and
 *     then take a row.
 *  3. **The wire message would differ from `execute()`'s** for the same builder, so the golden and
 *     the thing it describes would drift apart for no gain: the queries this is used on are the
 *     ones a `WHERE` on a unique key already limits to one row.
 */
export function takeFirst<Row>(rows: readonly Row[]): Row | undefined {
  return rows[0]
}

export function runnerOf(ctx: BuilderCtx): Runner {
  if (ctx.runner === undefined) {
    throw new BuilderError(
      'pg-prime: this query has no executor, so it can be compiled but not executed. Build it from ' +
        '`pgPrime({ driver, schema })` rather than from `compileOnly(schema)`.',
    )
  }
  return ctx.runner
}

/**
 * A transaction-scoped stream (`07` §6.3).
 *
 * `Runner.scope` owns the connection and the transaction for exactly as long as the iteration
 * lasts — including when the consumer `break`s, which calls the iterator's `return()` and runs
 * `scope`'s `finally`. That is the leak every hand-rolled cursor wrapper has.
 */
export function streamWith<Row>(
  ctx: BuilderCtx,
  compiled: Compiled<Row>,
  opts?: (StreamOptions & RunOptions) | undefined,
): AsyncIterable<Row> {
  const runner = runnerOf(ctx)
  return runner.scope((conn) => streamOn(conn, compiled, runner.env, opts))
}

/**
 * `EXPLAIN`, with `07` §7.5's safety rail.
 *
 * `EXPLAIN ANALYZE UPDATE …` performs the update, so a mutating statement under `analyze` is
 * wrapped and rolled back unless the caller writes `rollback: false`. Inside a transaction the
 * wrapper is a **savepoint**, not a nested `BEGIN`: rolling the caller's whole transaction back
 * because they asked for a plan would be the cure being worse than the disease.
 */
export async function explainWith(
  ctx: BuilderCtx,
  compiled: Compiled<unknown>,
  opts?: ExplainOptions | undefined,
  run?: RunOptions | undefined,
): Promise<ExplainResult> {
  const runner = runnerOf(ctx)
  if (!needsRollbackRail(compiled, opts)) {
    return runner.use((conn) => explainOn(conn, compiled, runner.env, opts, run))
  }
  return runner.use(async (conn) => {
    const inTx = runner.inTransaction
    const open = inTx ? 'savepoint pgprime_explain' : 'begin'
    const undo = inTx ? 'rollback to savepoint pgprime_explain' : 'rollback'
    await conn.execute({ text: open, params: [], mode: 'simple' })
    try {
      const r = await explainOn(conn, compiled, runner.env, opts, run)
      await conn.execute({ text: undo, params: [], mode: 'simple' })
      if (inTx)
        await conn.execute({
          text: 'release savepoint pgprime_explain',
          params: [],
          mode: 'simple',
        })
      return makeResult(r.plan, r.text, r.executed, true, r.planningTimeMs, r.executionTimeMs)
    } catch (e) {
      await conn.execute({ text: undo, params: [], mode: 'simple' }).catch(() => {})
      throw e
    }
  })
}

/** Bind values for a run, so a caller can see what `execute()` would send. Used by tests and hooks. */
export function paramsOf(
  compiled: Compiled<unknown>,
  values?: Readonly<Record<string, unknown>>,
): readonly PgParam[] {
  return bindsToParams(compiled.binds, values)
}
