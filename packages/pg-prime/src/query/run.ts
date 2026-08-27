/**
 * `pgPrime(...)` and the two runners — where a statement meets a connection (design/09 WS4, WS6).
 *
 * WS4 shipped this file as "the minimum executor WS4 needs"; WS6 moved the execution *policy* —
 * `assertShape`, dynamic-OID decode, named statements, self-heal, the decode-plan memo, cursors,
 * `EXPLAIN` — into `./executor.ts`, and what is left here is the thing that was always this
 * file's: **connection lifetime**. `PoolRunner` checks one out per operation; `ConnRunner` reuses
 * the one `db.transaction()` holds. Every terminal in the builder is written against the
 * `Runner` seam, so neither of them appears anywhere else.
 *
 * Two things here remain load-bearing beyond convenience:
 *
 *  - **`paramTypes` is always sent.** PostgreSQL resolves an operator against a *typed* parameter;
 *    `where "amount" > $1` with an untyped `$1` is where `42P18 indeterminate_datatype` comes from
 *    (`02` §2.3). `paramTypesOf` reads each bind's `paramOid` and sends `0` — the wire spelling of
 *    "infer from context" — for the codecs that claim none.
 *  - **The decoder is built with the *connection's* codec context**, not a default one, so a codec
 *    that reads `DateStyle` or `TimeZone` sees the session it actually decoded from.
 */

import type { CodecRegistry } from '../codec/index.js'
import { Registry, defaultRegistry } from '../codec/index.js'
import type { Compiled } from '../compile/contract.js'
import type { PgConnection, PgDriver } from '../driver/index.js'
import type { AnySchema, RelsRecord, Tables } from '../schema/index.js'
import { BuilderError } from '../sql/errors.js'
import type { BuilderCtx, Runner } from './builder-state.js'
import { ExecutorImpl, makeExecutor } from './cte.js'
import type { ExecEnv, ExecOptions, RunOptions } from './executor.js'
import { makeEnv, runOn } from './executor.js'
import type { Db, Executor, SchemaExecutor } from './types.js'

/** One statement, one pooled connection. */
class PoolRunner implements Runner {
  readonly inTransaction = false
  readonly env: ExecEnv
  readonly #driver: PgDriver

  constructor(driver: PgDriver, env: ExecEnv) {
    this.#driver = driver
    this.env = env
  }

  async use<T>(f: (conn: PgConnection) => Promise<T>): Promise<T> {
    const conn = await this.#driver.acquire()
    try {
      return await f(conn)
    } finally {
      await this.#driver.release(conn)
    }
  }

  /**
   * A stream at the root owns a connection **and** a transaction for the whole iteration
   * (`07` §6.3), and gives both back on *every* exit: normal completion, `break` (which calls the
   * iterator's `return()` and therefore runs this `finally`), `throw`, and abort.
   *
   * `commit` only on the completed path. A consumer that broke out has read part of a snapshot
   * and asked for no more; `rollback` says exactly that and costs the same.
   */
  async *scope<T>(f: (conn: PgConnection) => AsyncIterable<T>): AsyncIterable<T> {
    const conn = await this.#driver.acquire()
    let done = false
    try {
      await conn.execute({ text: 'begin', params: [], mode: 'simple' })
      yield* f(conn)
      done = true
    } finally {
      await conn
        .execute({ text: done ? 'commit' : 'rollback', params: [], mode: 'simple' })
        .catch(() => {})
      await this.#driver.release(conn)
    }
  }

  run<Row>(compiled: Compiled<Row>, opts?: RunOptions): Promise<Row[]> {
    return this.use((conn) => runOn(conn, compiled, this.env, opts))
  }

  /**
   * Chunks of one logical batch, on ONE connection, inside ONE transaction.
   *
   * A half-applied bulk insert is the failure mode that makes chunking untrustworthy, and it is
   * invisible: the caller sees a rejected promise and 40 000 of 50 000 rows committed.
   */
  async runChunked<Row>(all: readonly Compiled<Row>[]): Promise<Row[]> {
    return this.use(async (conn) => {
      await conn.execute({ text: 'begin', params: [], mode: 'simple' })
      const out: Row[] = []
      try {
        for (const c of all) out.push(...(await runOn(conn, c, this.env)))
      } catch (e) {
        await conn.execute({ text: 'rollback', params: [], mode: 'simple' }).catch(() => {})
        throw e
      }
      await conn.execute({ text: 'commit', params: [], mode: 'simple' })
      return out
    })
  }
}

/** Every statement on the caller's connection, already inside their transaction. */
class ConnRunner implements Runner {
  readonly inTransaction = true
  readonly env: ExecEnv
  readonly #conn: PgConnection

  constructor(conn: PgConnection, env: ExecEnv) {
    this.#conn = conn
    this.env = env
  }

  use<T>(f: (conn: PgConnection) => Promise<T>): Promise<T> {
    return f(this.#conn)
  }

  /** Joins the caller's transaction; the adapter sees `transactionStatus === 'T'` and does too. */
  scope<T>(f: (conn: PgConnection) => AsyncIterable<T>): AsyncIterable<T> {
    return f(this.#conn)
  }

  run<Row>(compiled: Compiled<Row>, opts?: RunOptions): Promise<Row[]> {
    return runOn(this.#conn, compiled, this.env, opts)
  }

  /** Already atomic — opening a nested `BEGIN` would emit a 25001 warning and commit nothing. */
  async runChunked<Row>(all: readonly Compiled<Row>[]): Promise<Row[]> {
    const out: Row[] = []
    for (const c of all) out.push(...(await runOn(this.#conn, c, this.env)))
    return out
  }
}

export interface PgPrimeOptions<Sc extends AnySchema> extends ExecOptions {
  readonly driver: PgDriver
  readonly schema: Sc
  readonly registry?: CodecRegistry
}

function handlesOf(schema: AnySchema): Readonly<Record<string, object>> {
  const h = (schema as { h?: Record<string, object> }).h
  if (h === undefined) {
    throw new BuilderError('pg-prime: pgPrime({ schema }) needs a schema from `defineSchema(...)`.')
  }
  return h
}

function relsOf(schema: AnySchema): RelsRecord<Tables> | undefined {
  return (schema as { rels?: RelsRecord<Tables> }).rels
}

function tablesOf(schema: AnySchema): Tables | undefined {
  return (schema as { tables?: Tables }).tables
}

/** The database handle: an executor plus `transaction`. */
export function pgPrime<Sc extends AnySchema>(opts: PgPrimeOptions<Sc>): Db<Sc> {
  // A **fresh** registry per `pgPrime(...)`, not the process-wide default.
  //
  // A registry is per physical database (`02` §4.6): `resolveDynamic` writes this database's enum
  // and domain OIDs into it, and those OIDs are not stable across databases. Defaulting to the
  // shared one meant two `pgPrime()` calls against dev and prod raced to fill the same map, and the
  // second one's rows decoded against the first one's catalogue. `registry.ts`'s own docblock
  // calls that a bug; this is where it was.
  const registry = opts.registry ?? new Registry()
  // One env per db, shared by `db` and every `tx` it opens: the prepared-statement downgrade is a
  // property of the *pool* (`07` §2.4 policy 4), so a transaction must not get a fresh counter.
  const env = makeEnv(registry, opts)
  const ctx: BuilderCtx = {
    registry,
    runner: new PoolRunner(opts.driver, env),
    tables: tablesOf(opts.schema),
    rels: relsOf(opts.schema),
  }
  const base = makeExecutor(ctx, handlesOf(opts.schema))
  const db = base as unknown as Db<Sc>
  Object.defineProperty(db, 'transaction', {
    value: async <T>(f: (tx: SchemaExecutor<Sc>) => Promise<T>): Promise<T> => {
      const conn = await opts.driver.acquire()
      try {
        await conn.execute({ text: 'begin', params: [], mode: 'simple' })
        const tx = makeExecutor(
          { ...ctx, runner: new ConnRunner(conn, env) },
          handlesOf(opts.schema),
        ) as unknown as SchemaExecutor<Sc>
        try {
          const out = await f(tx)
          await conn.execute({ text: 'commit', params: [], mode: 'simple' })
          return out
        } catch (e) {
          await conn.execute({ text: 'rollback', params: [], mode: 'simple' }).catch(() => {})
          throw e
        }
      } finally {
        await opts.driver.release(conn)
      }
    },
    enumerable: false,
  })
  return db
}

/**
 * Executor-level counters, for diagnostics and for the tier-2 pin (`07` §2.4 policy 4).
 *
 * A slice of `07` §5.4's `db.diagnose()`, shipped now because the prepared-statement policy makes
 * two claims a test cannot otherwise check: that a pooler which tracks named statements produces
 * **no** self-heals, and that repeated self-healing downgrades the pool permanently. Both are
 * counters, and a counter nobody can read is a claim nobody can falsify.
 */
export interface StatementStats {
  readonly statement: 'unnamed' | 'named'
  /** Consecutive self-heal events since the last successful named execution (`07` §2.4). */
  readonly selfHeals: number
  /** True once the pool has permanently fallen back to unnamed. A one-way door. */
  readonly downgraded: boolean
  readonly assertShape: boolean
}

export function statementStats(db: Executor | Db<AnySchema>): StatementStats {
  const env = (db as unknown as ExecutorImpl).ctx?.runner?.env
  if (env === undefined) {
    throw new BuilderError(
      'pg-prime: statementStats() needs a db built by pgPrime({ driver, schema }); a compileOnly() ' +
        'executor has no runner and therefore no statistics.',
    )
  }
  return {
    statement: env.statement,
    selfHeals: env.named.selfHeals,
    downgraded: env.named.downgraded,
    assertShape: env.assertShape,
  }
}

/**
 * A builder with no database: `.compile()` works, `.execute()` throws with a sentence saying why.
 *
 * This is what the tier-0 suites use, and it is a real product surface — `.toSQL()` for a
 * migration tool, a lint rule, or a test that wants the SQL and nothing else.
 */
export function compileOnly<Sc extends AnySchema>(
  schema: Sc,
  registry?: CodecRegistry,
): SchemaExecutor<Sc> {
  return makeExecutor(
    {
      registry: registry ?? defaultRegistry(),
      runner: undefined,
      tables: tablesOf(schema),
      rels: relsOf(schema),
    },
    handlesOf(schema),
  ) as unknown as SchemaExecutor<Sc>
}
