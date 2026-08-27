/**
 * The minimum executor WS4 needs (design/09 WS4; WS6 owns the rest).
 *
 * `09` §0 assigns `execute` / `prepare` / `stream` / `explain` / `toSQL` / `assertShape` to WS6.
 * But WS4's exit gate is "every `03` §2 example **executes** with the promised values", so the
 * builder needs a way to reach a database now. This file is that way and no more than that:
 * compile → `PgQuery` → `buildDecoder`. What is deliberately absent — prepared statements, server
 * cursors, `EXPLAIN`, the dev-mode `assertShape` OID check, savepoints, retry on `40001` — is
 * absent rather than stubbed, so WS6 has nothing to unpick.
 *
 * Two things here are load-bearing beyond convenience:
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
import { paramTypesOf } from '../compile/contract.js'
import { buildDecoder } from '../compile/decode.js'
import type { PgConnection, PgDriver, PgParam } from '../driver/index.js'
import type { AnySchema, RelsRecord, Tables } from '../schema/index.js'
import { BuilderError } from '../sql/errors.js'
import type { BuilderCtx, Runner } from './builder-state.js'
import { makeExecutor } from './cte.js'
import type { Db, SchemaExecutor } from './types.js'

function paramsOf(compiled: Compiled<unknown>): readonly PgParam[] {
  return compiled.binds.map((b) => {
    if (b.k === 'slot') {
      throw new BuilderError(
        `pgorm: bind slot "${b.name}" was never filled. Named holes belong to .prepare(), which ` +
          `is design/09 WS6; a builder query has no unfilled parameters.`,
      )
    }
    return b.encoded
  })
}

/**
 * The decode plan, memoised per `Compiled`.
 *
 * `.compile()` is already memoised on the builder instance (`03` §1.4a), but `buildDecoder` walked
 * the whole `ResultShape` and closed over a codec per field on *every* execute — so a query run in
 * a loop rebuilt the same closure tree per round trip. The `Compiled` object is frozen and unique
 * per statement, which makes it the right key.
 *
 * The memo is one entry deep and revalidated rather than a cache: a decoder is only reusable for
 * the same registry, the same registry *generation* (an enum's OID appears there after
 * `resolveDynamic`) and the same session parameters (`TimeZone`, `DateStyle` — per connection, and
 * that is why the context comes from the connection and not from a default).
 */
interface DecoderMemo {
  readonly registry: CodecRegistry
  readonly generation: number
  readonly serverParameters: Readonly<Record<string, string>>
  readonly decode: (rows: readonly (readonly (string | null)[])[]) => unknown[]
}

const DECODERS = new WeakMap<object, DecoderMemo>()

function decoderFor<Row>(
  compiled: Compiled<Row>,
  registry: CodecRegistry,
  serverParameters: Readonly<Record<string, string>>,
): (rows: readonly (readonly (string | null)[])[]) => Row[] {
  const hit = DECODERS.get(compiled)
  if (
    hit !== undefined &&
    hit.registry === registry &&
    hit.generation === registry.generation &&
    hit.serverParameters === serverParameters
  ) {
    return hit.decode as unknown as (rows: readonly (readonly (string | null)[])[]) => Row[]
  }
  const decode = buildDecoder<Row>(compiled.shape, { typmod: -1, registry, serverParameters })
  DECODERS.set(compiled, {
    registry,
    generation: registry.generation,
    serverParameters,
    decode: decode as unknown as DecoderMemo['decode'],
  })
  return decode as unknown as (rows: readonly (readonly (string | null)[])[]) => Row[]
}

async function runOn<Row>(
  conn: PgConnection,
  compiled: Compiled<Row>,
  registry: CodecRegistry,
): Promise<Row[]> {
  const result = await conn.execute({
    text: compiled.sql,
    params: paramsOf(compiled as Compiled<unknown>),
    paramTypes: paramTypesOf(compiled.binds),
  })
  return decoderFor(compiled, registry, conn.serverParameters)(result.rows as never)
}

/** One statement, one pooled connection. */
class PoolRunner implements Runner {
  readonly inTransaction = false
  readonly #driver: PgDriver
  readonly #registry: CodecRegistry

  constructor(driver: PgDriver, registry: CodecRegistry) {
    this.#driver = driver
    this.#registry = registry
  }

  async run<Row>(compiled: Compiled<Row>): Promise<Row[]> {
    const conn = await this.#driver.acquire()
    try {
      return await runOn(conn, compiled, this.#registry)
    } finally {
      await this.#driver.release(conn)
    }
  }

  /**
   * Chunks of one logical batch, on ONE connection, inside ONE transaction.
   *
   * A half-applied bulk insert is the failure mode that makes chunking untrustworthy, and it is
   * invisible: the caller sees a rejected promise and 40 000 of 50 000 rows committed.
   */
  async runChunked<Row>(all: readonly Compiled<Row>[]): Promise<Row[]> {
    const conn = await this.#driver.acquire()
    try {
      await conn.execute({ text: 'begin', params: [], mode: 'simple' })
      const out: Row[] = []
      try {
        for (const c of all) out.push(...(await runOn(conn, c, this.#registry)))
      } catch (e) {
        await conn.execute({ text: 'rollback', params: [], mode: 'simple' }).catch(() => {})
        throw e
      }
      await conn.execute({ text: 'commit', params: [], mode: 'simple' })
      return out
    } finally {
      await this.#driver.release(conn)
    }
  }
}

/** Every statement on the caller's connection, already inside their transaction. */
class ConnRunner implements Runner {
  readonly inTransaction = true
  readonly #conn: PgConnection
  readonly #registry: CodecRegistry

  constructor(conn: PgConnection, registry: CodecRegistry) {
    this.#conn = conn
    this.#registry = registry
  }

  run<Row>(compiled: Compiled<Row>): Promise<Row[]> {
    return runOn(this.#conn, compiled, this.#registry)
  }

  /** Already atomic — opening a nested `BEGIN` would emit a 25001 warning and commit nothing. */
  async runChunked<Row>(all: readonly Compiled<Row>[]): Promise<Row[]> {
    const out: Row[] = []
    for (const c of all) out.push(...(await runOn(this.#conn, c, this.#registry)))
    return out
  }
}

export interface PgOrmOptions<Sc extends AnySchema> {
  readonly driver: PgDriver
  readonly schema: Sc
  readonly registry?: CodecRegistry
}

function handlesOf(schema: AnySchema): Readonly<Record<string, object>> {
  const h = (schema as { h?: Record<string, object> }).h
  if (h === undefined) {
    throw new BuilderError('pgorm: pgOrm({ schema }) needs a schema from `defineSchema(...)`.')
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
export function pgOrm<Sc extends AnySchema>(opts: PgOrmOptions<Sc>): Db<Sc> {
  // A **fresh** registry per `pgOrm(...)`, not the process-wide default.
  //
  // A registry is per physical database (`02` §4.6): `resolveDynamic` writes this database's enum
  // and domain OIDs into it, and those OIDs are not stable across databases. Defaulting to the
  // shared one meant two `pgOrm()` calls against dev and prod raced to fill the same map, and the
  // second one's rows decoded against the first one's catalogue. `registry.ts`'s own docblock
  // calls that a bug; this is where it was.
  const registry = opts.registry ?? new Registry()
  const ctx: BuilderCtx = {
    registry,
    runner: new PoolRunner(opts.driver, registry),
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
          { ...ctx, runner: new ConnRunner(conn, registry) },
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
