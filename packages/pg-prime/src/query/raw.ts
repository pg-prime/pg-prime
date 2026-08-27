/**
 * `db.sql\`…\`` — the fragment-only statement (design/09 WS6; `03` §1.4c, `07` §2.3).
 *
 * It exists because the description cache needs an entry point. `03` §1.4c scopes that cache to
 * "`sql`-tag queries with no declared codecs", and until now there was no way to *run* one:
 * every path into the executor went through a builder, whose codecs are known statically and
 * which therefore never touches the cache.
 *
 * It is deliberately the smallest thing that is honest, and what it lacks is as designed:
 *
 *  - **the row type is `Record<string, unknown>`.** Not `sql<T>` — `03` §3.2 is that a type
 *    parameter without a codec is a lie, and one codec on the whole fragment cannot describe a
 *    row of five columns. Values are decoded *by OID* through the registry, so they are correct
 *    (`bigint`, `Date`, precision-exact `numeric` string) even though the type says `unknown`.
 *  - **rows are keyed by field name**, which is the one place in this library that is not
 *    positional. A raw `select u.id, p.id` therefore loses one of them, exactly as `pg`'s object
 *    mode does — the builder's whole reason for `rowMode: 'array'` (`03` §1.3). Alias your columns.
 *  - **no placeholders, no `nest`, no relations, no chunking.** Those are the builder's, and a
 *    second half-builder here would be a second thing to keep honest.
 */

import type { CodecRegistry } from '../codec/index.js'
import type { Compiled } from '../compile/contract.js'
import { compileExpr } from '../compile/compiler.js'
import { paramTypesOf } from '../compile/contract.js'
import type { PgConnection, PgResultChunk } from '../driver/index.js'
import type { Fragment } from '../sql/index.js'
import { sql as sqlTag, toNode } from '../sql/index.js'
import type { BuilderCtx } from './builder-state.js'
import type { ExecEnv, ExplainOptions, ExplainResult, StreamOptions } from './executor.js'
import { dynamicRowDecoder } from './executor.js'
import { explainWith, runnerOf, takeFirst, toSQLOf } from './terminals.js'
import type { SqlSnapshot } from './terminals.js'

export type RawRow = Record<string, unknown>

export interface RawQuery {
  readonly sql: string
  execute(): Promise<RawRow[]>
  executeTakeFirst(): Promise<RawRow | undefined>
  stream(opts?: StreamOptions): AsyncIterable<RawRow>
  explain(opts?: ExplainOptions): Promise<ExplainResult>
  toSQL(): SqlSnapshot
}

/**
 * A synthetic `Compiled` so `EXPLAIN` and `toSQL()` need no second implementation.
 *
 * `shape: 'void'` is the truthful answer: this statement has **no static decode plan**, which is
 * the entire reason it is here. Decoding goes through {@link dynamicRowDecoder} instead, and
 * `assertShape` skips it for free because there is nothing declared to compare.
 */
function compiledOf(f: Fragment<unknown>): Compiled<unknown> {
  const { sql, binds, placeholders, usedUnsafeRaw } = compileExpr(toNode(f))
  return Object.freeze({
    sql,
    binds: Object.freeze([...binds]),
    shape: { k: 'void' } as const,
    meta: Object.freeze({
      kind: 'select' as const,
      reads: Object.freeze([]),
      writes: Object.freeze([]),
      placeholders,
      usedUnsafeRaw,
    }),
  })
}

class RawQueryImpl implements RawQuery {
  readonly #ctx: BuilderCtx
  readonly #compiled: Compiled<unknown>

  constructor(ctx: BuilderCtx, f: Fragment<unknown>) {
    this.#ctx = ctx
    this.#compiled = compiledOf(f)
  }

  get sql(): string {
    return this.#compiled.sql
  }

  toSQL(): SqlSnapshot {
    return toSQLOf(this.#compiled)
  }

  async execute(): Promise<RawRow[]> {
    const runner = runnerOf(this.#ctx)
    const c = this.#compiled
    return runner.use(async (conn) => {
      const result = await conn.execute({
        text: c.sql,
        params: c.binds.map((b) => (b.k === 'value' ? b.encoded : null)),
        paramTypes: paramTypesOf(c.binds),
      })
      return dynamicRowDecoder(c.sql, result.fields, runner.env.registry)(result.rows)
    })
  }

  async executeTakeFirst(): Promise<RawRow | undefined> {
    return takeFirst(await this.execute())
  }

  stream(opts?: StreamOptions): AsyncIterable<RawRow> {
    const runner = runnerOf(this.#ctx)
    const c = this.#compiled
    return runner.scope((conn) => rawStream(conn, c, runner.env, opts))
  }

  explain(opts?: ExplainOptions): Promise<ExplainResult> {
    return explainWith(this.#ctx, this.#compiled, opts)
  }
}

async function* rawStream(
  conn: PgConnection,
  c: Compiled<unknown>,
  env: ExecEnv,
  opts: StreamOptions | undefined,
): AsyncIterable<RawRow> {
  let decode: ((rows: readonly (readonly (string | null)[])[]) => RawRow[]) | undefined
  const chunks: AsyncIterable<PgResultChunk> = conn.stream(
    {
      text: c.sql,
      params: c.binds.map((b) => (b.k === 'value' ? b.encoded : null)),
      paramTypes: paramTypesOf(c.binds),
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    },
    opts?.batchSize ?? 1000,
  )
  for await (const chunk of chunks) {
    decode ??= dynamicRowDecoder(c.sql, chunk.fields, env.registry) as never
    for (const row of (decode as (r: never) => RawRow[])(chunk.rows as never)) yield row
  }
}

/** `db.sql\`select now()\`` — the tag, bound to an executor. */
export function makeRaw(
  ctx: BuilderCtx,
  strings: TemplateStringsArray,
  values: readonly unknown[],
): RawQuery {
  return new RawQueryImpl(ctx, sqlTag(strings, ...values))
}

/** Exposed so a test can name the registry a raw statement decoded against. */
export function registryOf(ctx: BuilderCtx): CodecRegistry {
  return ctx.registry
}
