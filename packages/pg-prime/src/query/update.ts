/**
 * UPDATE, including the bulk `UPDATE … FROM (VALUES …)` form (design/09 WS4; `03` §2.5–2.6).
 *
 * ## `set` targets are unqualified, `set` values are not
 *
 * `set "price" = "v"."price"` — PostgreSQL rejects `set "products"."price" = …`, because the
 * target of a SET is a column of the statement's one target table by definition. The *value* is
 * qualified, because it may name a FROM item, the target row itself (`views = views + 1`), or a
 * CTE. `emitSetItems` in the compiler is where that asymmetry lives; this file only has to hand it
 * the right column metas, in table order.
 *
 * ## `fromValues` — one statement for N different patches
 *
 * `03` §2.6's bulk update by key. The alternative is N round trips or a `CASE` expression per
 * column, and both are worse: the `VALUES` join is one plan, one parse, and PostgreSQL joins it
 * against the target on whatever key the caller names. The per-column `::type` casts on the first
 * row are load-bearing for exactly the reason they are in a bulk INSERT — an uncast `VALUES` list
 * is `text`, and `"products"."id" = "v"."id"` is then 42883.
 */

import { arrayCodecOf } from '../codec/index.js'
import type { AnyCodec } from '../codec/index.js'
import type {
  ColumnMeta,
  CteNode,
  Expr as Node,
  FromItem,
  ProjectionItem,
  SetItem,
  UpdateNode,
} from '../compile/ast.js'
import { compile as compileAst } from '../compile/compiler.js'
import type { Compiled } from '../compile/contract.js'
import {
  and as andNode,
  cast,
  funcFrom,
  param,
  table as tableFrom,
  update as updateNode,
  valuesFrom,
} from '../compile/nodes.js'
import { BuilderError } from '../sql/errors.js'
import type { BuilderCtx, UpdateState } from './builder-state.js'
import { setItemsOf } from './insert.js'
import { metaOf } from './meta.js'
import type { TableCodecMeta } from './meta.js'
import type { RefScope } from './ref.js'
import { registerBuilder } from './nominal.js'
import { allOf, compileProjection, NO_LEFT_JOINS, sourceOf, toExprNode } from './scope.js'
import { checkAlias, derivedRuntime, rebuildScope } from './select.js'
import { oneOf } from './window.js'
import { NAME } from '../schema/index.js'
import { registerDerived } from './scope.js'

type Lambda<R> = (...a: never[]) => R

function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
  return o
}

function call<R>(f: Lambda<R>, ...args: readonly unknown[]): R {
  return (f as unknown as (...a: readonly unknown[]) => R)(...args)
}

function runnerOf(ctx: BuilderCtx): NonNullable<BuilderCtx['runner']> {
  if (ctx.runner === undefined) {
    throw new BuilderError('pg-prime: this statement has no executor; it can be compiled, not executed.')
  }
  return ctx.runner
}

/** Codecs for a `fromValues` source, by patch key. */
export type ValueCodecs = Readonly<Record<string, AnyCodec>>

export interface FromValuesOpts {
  readonly alias?: string
  readonly strategy?: 'values' | 'unnest'
}

const VALUE_STRATEGIES = ['values', 'unnest'] as const

export class UpdateBuilder {
  readonly s: UpdateState
  #ast: UpdateNode | undefined
  #compiled: Compiled<unknown> | undefined

  constructor(s: UpdateState) {
    this.s = Object.freeze(s)
    registerBuilder(this)
  }

  #next(patch: Partial<UpdateState>): UpdateBuilder {
    return new UpdateBuilder({ ...this.s, ...patch })
  }

  get #meta(): TableCodecMeta {
    return metaOf(this.s.handle as never, this.s.ctx.registry)
  }

  /** `.set(({posts: p}) => ({ views: add(p.views, 1) }))`, and `(t, v)` after `fromValues`. */
  set(f: Lambda<Record<string, unknown>>): UpdateBuilder {
    const patch = call(f, this.s.scope, this.s.scope[this.s.valuesAlias ?? ''])
    const added = setItemsOf(this.#meta, patch, 'set()')
    // Two `.set()` calls merge, but PostgreSQL rejects two assignments to one column (42701) and
    // appending blindly produced exactly that from a `$if(...)` that overlapped an earlier patch.
    const already = new Set(this.s.set.map((i) => i.column.name))
    for (const item of added) {
      if (already.has(item.column.name)) {
        throw new BuilderError(
          `pg-prime: "${item.column.name}" is already assigned by an earlier .set() — PostgreSQL ` +
            `allows one assignment per column per UPDATE. Set it once.`,
        )
      }
    }
    return this.#next({ set: [...this.s.set, ...added] })
  }

  /**
   * "Yes, every row." — the opt-in that `.where()` otherwise supplies.
   *
   * `03` §2.5 has no example of an unconditional UPDATE, and an `UPDATE` that reaches the server
   * with no `WHERE` is indistinguishable from one whose predicate was `$if`'d away. Requiring the
   * caller to say so costs one method call and removes a whole class of incident.
   */
  allRows(): UpdateBuilder {
    return this.#next({ allRows: true })
  }

  where(f: Lambda<unknown>): UpdateBuilder {
    const pred = toExprNode(
      call(f, this.s.scope, this.s.scope[this.s.valuesAlias ?? '']),
      'where()',
    )
    return this.#next({ where: this.s.where === undefined ? pred : andNode(this.s.where, pred) })
  }

  /** `update … from (values …) as "v"("id","price")` (03 §2.6). */
  fromValues(
    rows: readonly Record<string, unknown>[],
    codecs: ValueCodecs,
    opts: FromValuesOpts = {},
  ): UpdateBuilder {
    if (rows.length === 0) {
      throw new BuilderError('pg-prime: fromValues([]) would match no rows; nothing to update.')
    }
    const alias = checkAlias(opts.alias ?? 'v')
    if (this.s.scope[alias] !== undefined) {
      throw new BuilderError(
        `pg-prime: alias "${alias}" is already in scope — the fromValues() relation would shadow ` +
          `it and every reference through it would silently mean the other one. Pass ` +
          `{ alias: 'other' }.`,
      )
    }
    const keys = Object.keys(codecs)
    const strategy = oneOf(opts.strategy ?? 'values', VALUE_STRATEGIES, 'fromValues({ strategy })')
    if (strategy === 'unnest') {
      const arrayKey = keys.find((k) => (codecs[k] as AnyCodec).arrayOf !== undefined)
      if (arrayKey !== undefined) {
        // Same reason as the bulk insert's: one array per column means a `T[][]` parameter, and
        // PostgreSQL has no two-dimensional array type for the codec to be built from.
        throw new BuilderError(
          `pg-prime: fromValues({ strategy: 'unnest' }) cannot carry the array column ` +
            `"${arrayKey}" — that needs a two-dimensional array parameter, which PostgreSQL has ` +
            `no type for. Use the default 'values' strategy.`,
        )
      }
    }
    const item =
      strategy === 'unnest'
        ? unnestValues(alias, keys, codecs, rows, this.s.ctx)
        : literalValues(alias, keys, codecs, rows)
    const handle = { [NAME]: alias, $: derivedRuntime(alias) }
    registerDerived(handle, alias, EMPTY_QUERY, keys.map((k) => ({ key: k, codec: codecs[k] as AnyCodec })))
    const sources = Object.freeze({ ...this.s.sources, [alias]: handle })
    return this.#next({
      from: [...this.s.from, item],
      valuesAlias: alias,
      sources,
      scope: rebuildScope(sources, this.s.ctx),
    })
  }

  returning(f: Lambda<Record<string, unknown>>): UpdateBuilder {
    return this.#next({ returning: compileProjection(call(f, this.s.scope), NO_LEFT_JOINS) })
  }

  returningAll(): UpdateBuilder {
    return this.#next({
      returning: compileProjection(allOf(this.s.scope[this.s.target.alias] as RefScope), NO_LEFT_JOINS),
    })
  }

  toAst(): UpdateNode {
    if (this.s.set.length === 0) {
      throw new BuilderError('pg-prime: update(...) needs a .set({...}).')
    }
    if (this.s.where === undefined && !this.s.allRows) {
      throw new BuilderError(
        `pg-prime: update("${this.s.target.table.name}") has no .where(), so it would rewrite every ` +
          `row. If that is the intent, say so with .allRows(); otherwise add the predicate ` +
          `(a .$if(...) that did not fire is the usual cause).`,
      )
    }
    this.#ast ??= updateNode(
      compact({
        with: this.s.ctes.length > 0 ? this.s.ctes : undefined,
        target: this.s.target,
        set: this.s.set,
        from: this.s.from.length > 0 ? this.s.from : undefined,
        where: this.s.where,
        returning: this.s.returning,
      }) as Omit<UpdateNode, 'k'>,
    )
    return this.#ast
  }

  compile(): Compiled<unknown> {
    this.#compiled ??= compileAst(this.toAst())
    return this.#compiled
  }

  async execute(): Promise<unknown[]> {
    return runnerOf(this.s.ctx).run(this.compile())
  }
}

/** A placeholder query for a `values` source, which has no sub-select to describe it. */
const EMPTY_QUERY = { k: 'select', projection: [] } as never

function literalValues(
  alias: string,
  keys: readonly string[],
  codecs: ValueCodecs,
  rows: readonly Record<string, unknown>[],
): FromItem {
  return valuesFrom({
    alias,
    columns: keys,
    casts: keys.map((k) => (codecs[k] as AnyCodec).sqlName),
    rows: rows.map((row, r) =>
      keys.map((k) => {
        if (!(k in row)) throw new BuilderError(`pg-prime: row ${r} of fromValues() does not set "${k}".`)
        return param(row[k], codecs[k] as AnyCodec) as Node
      }),
    ),
  })
}

function unnestValues(
  alias: string,
  keys: readonly string[],
  codecs: ValueCodecs,
  rows: readonly Record<string, unknown>[],
  ctx: BuilderCtx,
): FromItem {
  return funcFrom({
    fn: 'unnest',
    alias,
    columns: keys,
    lateral: false,
    ordinality: false,
    args: keys.map((k) => {
      const codec = codecs[k] as AnyCodec
      const arrayCodec = arrayCodecOf(codec, ctx.registry)
      const values = rows.map((row, r) => {
        if (!(k in row)) throw new BuilderError(`pg-prime: row ${r} of fromValues() does not set "${k}".`)
        return row[k]
      })
      return cast(param(values, arrayCodec), `${codec.sqlName}[]`, arrayCodec)
    }),
  })
}

export function makeUpdate(
  ctx: BuilderCtx,
  ctes: readonly CteNode[],
  h: object,
  alias: string | undefined,
): UpdateBuilder {
  const source = sourceOf(h)
  if (source.kind !== 'table') {
    throw new BuilderError('pg-prime: update() takes a table handle, not a CTE or derived table.')
  }
  const name = checkAlias(alias ?? source.name)
  const meta = metaOf(h as never, ctx.registry)
  const sources = Object.freeze({ [name]: h })
  return new UpdateBuilder({
    ctx,
    ctes,
    handle: h,
    target: tableFrom(meta.table, name),
    set: [],
    from: [],
    where: undefined,
    returning: undefined,
    valuesAlias: undefined,
    sources,
    scope: rebuildScope(sources, ctx),
    allRows: false,
  })
}

export type { ColumnMeta, ProjectionItem, SetItem }
