/**
 * DELETE, with `USING` and `RETURNING` (design/09 WS4; `03` §2.5, §2.7).
 *
 * The smallest of the four statement builders, and the one that carries the writable-CTE pattern:
 * `with "moved" as (delete from … returning …) insert into … select * from "moved"` is `03` §2.7's
 * archive-and-move, and it works here because a `DeleteBuilder` is an ordinary `RowSource` — its
 * `toAst()` is a `Statement`, which is exactly what a `CteNode` holds.
 *
 * Bulk delete is `deleteFrom(t).where(t => inList(t.id, ids))`, which compiles to `= any($1)` and
 * not to an `IN (…)` list: one parameter, one plan-cache entry, no dependence on the list's
 * length (03 §2.6). That behaviour lives in `ops.ts`; it is named here because this is where a
 * reader looks for it.
 */

import type { CteNode, DeleteNode, FromItem, ProjectionItem } from '../compile/ast.js'
import { compile as compileAst } from '../compile/compiler.js'
import type { Compiled } from '../compile/contract.js'
import { and as andNode, del as deleteNode, table as tableFrom } from '../compile/nodes.js'
import { BuilderError } from '../sql/errors.js'
import type { BuilderCtx, DeleteState } from './builder-state.js'
import { metaOf } from './meta.js'
import type { RefScope } from './ref.js'
import { registerBuilder } from './nominal.js'
import { allOf, compileProjection, NO_LEFT_JOINS, sourceOf, toExprNode } from './scope.js'
import { checkAlias, rebuildScope } from './select.js'

type Lambda<R> = (t: never) => R

function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
  return o
}

function call<R>(f: Lambda<R>, scope: unknown): R {
  return (f as unknown as (t: unknown) => R)(scope)
}

export class DeleteBuilder {
  readonly s: DeleteState
  #ast: DeleteNode | undefined
  #compiled: Compiled<unknown> | undefined

  constructor(s: DeleteState) {
    this.s = Object.freeze(s)
    registerBuilder(this)
  }

  #next(patch: Partial<DeleteState>): DeleteBuilder {
    return new DeleteBuilder({ ...this.s, ...patch })
  }

  where(f: Lambda<unknown>): DeleteBuilder {
    const pred = toExprNode(call(f, this.s.scope), 'where()')
    return this.#next({ where: this.s.where === undefined ? pred : andNode(this.s.where, pred) })
  }

  /** `delete from t using other where …` — the join form. */
  using(h: object, alias?: string): DeleteBuilder {
    const source = sourceOf(h)
    const name = checkAlias(alias ?? source.name)
    if (this.s.scope[name] !== undefined) {
      // Overwriting the entry left the *scope* naming the USING item while the SQL still had two
      // relations under one name: `"posts"."id"` then meant whichever PostgreSQL resolved, and
      // the delete's own target became unreachable from the callback.
      throw new BuilderError(
        `pg-prime: alias "${name}" is already in scope. Give the USING item a name — ` +
          `.using(t, 'other').`,
      )
    }
    const item: FromItem = source.fromItem(name, false)
    const sources = Object.freeze({ ...this.s.sources, [name]: h })
    return this.#next({
      using: [...this.s.using, item],
      sources,
      scope: rebuildScope(sources, this.s.ctx),
    })
  }

  /**
   * "Yes, every row." — the opt-in that `.where()` otherwise supplies. See `UpdateBuilder`'s.
   */
  allRows(): DeleteBuilder {
    return this.#next({ allRows: true })
  }

  returning(f: Lambda<Record<string, unknown>>): DeleteBuilder {
    return this.#next({ returning: compileProjection(call(f, this.s.scope), NO_LEFT_JOINS) })
  }

  returningAll(): DeleteBuilder {
    return this.#next({
      returning: compileProjection(allOf(this.s.scope[this.s.from.alias] as RefScope), NO_LEFT_JOINS),
    })
  }

  toAst(): DeleteNode {
    if (this.s.where === undefined && !this.s.allRows) {
      throw new BuilderError(
        `pg-prime: deleteFrom("${this.s.from.table.name}") has no .where(), so it would delete ` +
          `every row. If that is the intent, say so with .allRows(); otherwise add the predicate ` +
          `(a .$if(...) that did not fire is the usual cause).`,
      )
    }
    this.#ast ??= deleteNode(
      compact({
        with: this.s.ctes.length > 0 ? this.s.ctes : undefined,
        from: this.s.from,
        using: this.s.using.length > 0 ? this.s.using : undefined,
        where: this.s.where,
        returning: this.s.returning,
      }) as Omit<DeleteNode, 'k'>,
    )
    return this.#ast
  }

  compile(): Compiled<unknown> {
    this.#compiled ??= compileAst(this.toAst())
    return this.#compiled
  }

  async execute(): Promise<unknown[]> {
    if (this.s.ctx.runner === undefined) {
      throw new BuilderError('pg-prime: this statement has no executor; it can be compiled, not executed.')
    }
    return this.s.ctx.runner.run(this.compile())
  }
}

export function makeDelete(
  ctx: BuilderCtx,
  ctes: readonly CteNode[],
  h: object,
  alias: string | undefined,
): DeleteBuilder {
  const source = sourceOf(h)
  if (source.kind !== 'table') {
    throw new BuilderError('pg-prime: deleteFrom() takes a table handle, not a CTE or derived table.')
  }
  const name = checkAlias(alias ?? source.name)
  const meta = metaOf(h as never, ctx.registry)
  const sources = Object.freeze({ [name]: h })
  return new DeleteBuilder({
    ctx,
    ctes,
    from: tableFrom(meta.table, name),
    using: [],
    where: undefined,
    returning: undefined,
    sources,
    scope: rebuildScope(sources, ctx),
    allRows: false,
  })
}

export type { ProjectionItem }
