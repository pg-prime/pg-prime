/**
 * The executor surface: `from` / `with` / `insertInto` / `update` / `deleteFrom` (design/09 WS4;
 * `03` §2.7).
 *
 * ## A CTE is a table handle over a synthetic one-table schema
 *
 * That is `03` §2.7's amendment held at the value level as well as the type level. `.with(name, f)`
 * runs the callback, takes the resulting statement's *result shape* — which is our own
 * `ResultShape`, carrying real codecs — and registers a handle whose refs are built from it. So
 * `recent.amount` reads `string` for a `numeric` and `bigint` for an `int8`, and `RefsAt`,
 * `ScopeOf`, `innerJoin` and all ~90 operators work on it with **no** "is this alias a CTE?"
 * branch anywhere. Kysely cannot do this because it re-parses a column list out of a string.
 *
 * Writable CTEs fall out for free: `CteNode.query` is a `Statement`, and an insert/update/delete
 * builder's `toAst()` is one. The columns of a writable CTE are its `RETURNING` list.
 *
 * ## The executor is immutable too
 *
 * `.with()` returns a *new* executor carrying one more CTE and one more handle. The CTE list is
 * then copied into whatever statement builder the chain ends in, which is why `.with(...)` before
 * `.insertInto(...)` and `.with(...)` before `.from(...)` need no separate machinery.
 */

import type { AnyCodec, CodecRegistry } from '../codec/index.js'
import type { CteNode, RawFromNode, SelectNode, SetOpNode, Statement } from '../compile/ast.js'
import {
  cte as cteNode,
  del as deleteNode,
  insert as insertNode,
  rawFrom,
  select as selectNode,
  setop as setopNode,
  update as updateNode,
} from '../compile/nodes.js'
import { isFragment, toNode } from '../sql/index.js'
import { planReturning, planSelect } from '../compile/hoist.js'
import { jsonCodecJson } from '../codec/index.js'
import type { FieldPlan } from '../compile/contract.js'
import { NAME } from '../schema/index.js'
import { BuilderError } from '../sql/errors.js'
import type { BuilderCtx } from './builder-state.js'
import { makeDelete } from './delete.js'
import type { RawQuery } from './raw.js'
import { makeRaw } from './raw.js'
import { makeInsert } from './insert.js'
import { queryAstOf, statementAstOf } from './nominal.js'
import type { DerivedField } from './scope.js'
import { assertSafeKey, registerCte, registerRawFrom } from './scope.js'
import { checkAlias, derivedRuntime, makeSelect } from './select.js'
import { makeUpdate } from './update.js'

export interface WithOpts {
  /**
   * `materialized` forces an optimization fence, `not materialized` forbids one; absent lets the
   * planner decide (PG 12+ default: inline a CTE referenced once). A PG-only planner lever that
   * costs us one token and that no TS builder exposes ergonomically (03 §2.7).
   */
  readonly materialized?: boolean
}

export interface RecursiveOpts extends WithOpts {
  /** `UNION ALL` (default) or `UNION` when `false` — `12` decision 17. */
  readonly unionAll?: boolean
}

export interface FromRawOpts {
  readonly alias?: string
  readonly columnTypes?: boolean
}

/** The columns a CTE exposes: a select's projection, or a write statement's RETURNING list. */
function fieldsOfStatement(n: Statement): readonly DerivedField[] {
  const fields: readonly FieldPlan[] =
    n.k === 'select'
      ? planSelect(n).fields
      : n.k === 'setop'
        ? planSelect(leftmost(n)).fields
        : planReturning(n.returning ?? []).fields
  const out: DerivedField[] = []
  for (const f of fields) {
    if (f.k === 'col') out.push({ key: f.key, codec: f.codec })
    else if (f.k === 'json') out.push({ key: f.key, codec: jsonCodecJson })
  }
  return Object.freeze(out)
}

function leftmost(n: Extract<Statement, { k: 'setop' }>): Extract<Statement, { k: 'select' }> {
  let cur: Statement = n
  while (cur.k === 'setop') cur = cur.left
  return cur as Extract<Statement, { k: 'select' }>
}

/**
 * Drop from a statement's own `WITH` every CTE the *enclosing* executor already declares.
 *
 * `.with('a', …).with('b', d => …)` hands the second callback an executor that carries `a`, which
 * is the point — `d.cte.a` has to be reachable. But the statement the callback builds copies that
 * list into its own `WITH`, so `b`'s body re-declared `a` inside itself: duplicated text and binds
 * in the easy case, and `0A000 WITH clause containing a data-modifying statement must be at the
 * top level` when `a` was a writable CTE.
 *
 * The comparison is node identity, so a CTE the callback declared *itself* (a genuinely nested
 * `d.with(...)`) stays where it is.
 */
function withoutDeclared(n: Statement, declared: readonly CteNode[]): Statement {
  if (declared.length === 0) return n
  if (n.k === 'setop') {
    const left = withoutDeclared(n.left, declared) as SelectNode | SetOpNode
    if (left === n.left) return n
    return setopNode(compact({ ...omitK(n), left }) as Omit<SetOpNode, 'k'>)
  }
  const own = n.with
  if (own === undefined || own.length === 0) return n
  const kept = own.filter((c) => !declared.includes(c))
  if (kept.length === own.length) return n
  const rest = compact({ ...omitK(n), with: kept.length > 0 ? kept : undefined })
  switch (n.k) {
    case 'select':
      return selectNode(rest as Omit<SelectNode, 'k'>)
    case 'insert':
      return insertNode(rest as never)
    case 'update':
      return updateNode(rest as never)
    default:
      return deleteNode(rest as never)
  }
}

function omitK<T extends { k: string }>(n: T): Omit<T, 'k'> {
  const out = { ...n } as Record<string, unknown>
  delete out['k']
  return out as Omit<T, 'k'>
}

/** Drop `undefined`-valued keys so a rebuilt node is `toStrictEqual` to a hand-built one. */
function compact<T extends Record<string, unknown>>(o: T): T {
  // A copy rather than `delete`, which would put the object into dictionary mode — see the note
  // on the same function in `./select.ts`.
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(o)) {
    const v = o[k]
    if (v !== undefined) out[k] = v
  }
  return out as T
}

export class ExecutorImpl {
  readonly ctx: BuilderCtx
  readonly ctes: readonly CteNode[]
  /** The declared CTEs, as table handles (03 §2.7's amendment: `d.cte.recent`). */
  readonly cte: Readonly<Record<string, object>>
  /** The schema's table handles, so `db.from(db.h.users)` needs no separate import. */
  readonly h: Readonly<Record<string, object>>

  constructor(
    ctx: BuilderCtx,
    ctes: readonly CteNode[],
    cteHandles: Readonly<Record<string, object>>,
    handles: Readonly<Record<string, object>>,
  ) {
    this.ctx = ctx
    this.ctes = ctes
    this.cte = cteHandles
    this.h = handles
  }

  get registry(): CodecRegistry {
    return this.ctx.registry
  }

  from(t: object, alias?: string): unknown {
    return makeSelect(this.ctx, this.ctes, t, alias)
  }

  /**
   * `db.fromRaw(sql`…`, { id: int8Codec })` — a hand-written FROM item with an explicit
   * column→codec map (`03` §5's v1 workaround for set-returning functions).
   *
   * The shape does three jobs at once and that is the whole design: it names the emitted column
   * alias list, it names the row's keys, and each codec decodes its own column. So the result is
   * as exactly typed and as fully decoded as a table's, and there is no second place for the
   * column names to be written and drift.
   */
  fromRaw(frag: unknown, shape: Record<string, AnyCodec>, opts: FromRawOpts = {}): unknown {
    const keys = Object.keys(shape)
    if (keys.length === 0) {
      throw new BuilderError(
        'pg-prime: fromRaw(sql`…`, shape) needs at least one column in `shape` — it is what names ' +
          'the columns and decodes them; an empty shape describes no row.',
      )
    }
    if (!isFragment(frag)) {
      throw new BuilderError(
        'pg-prime: fromRaw() takes a `sql` fragment as its first argument — ' +
          'db.fromRaw(sql`jsonb_to_recordset(${doc})`, { id: int8Codec }, { columnTypes: true }).',
      )
    }
    const alias = checkAlias(opts.alias ?? 'raw')
    const fields: DerivedField[] = []
    const columnTypes: string[] = []
    for (const key of keys) {
      const codec = shape[key] as AnyCodec
      assertSafeKey(key, 'fromRaw() shape')
      fields.push({ key, codec })
      columnTypes.push(codec.sqlName)
    }
    const item = rawFrom(
      compact({
        sql: toNode(frag),
        alias,
        columns: Object.freeze(keys),
        columnTypes: opts.columnTypes === true ? Object.freeze(columnTypes) : undefined,
      }) as Omit<RawFromNode, 'k' | 'qAlias'>,
    )
    const handle = { [NAME]: alias, $: derivedRuntime(alias) }
    registerRawFrom(handle, alias, item, Object.freeze(fields))
    return makeSelect(this.ctx, this.ctes, handle, alias)
  }

  fromCte(name: string, alias?: string): unknown {
    const handle = this.cte[name]
    if (handle === undefined) {
      throw new BuilderError(
        `pg-prime: no CTE named "${name}" (have: ${Object.keys(this.cte).join(', ') || 'none'}).`,
      )
    }
    return makeSelect(this.ctx, this.ctes, handle, alias ?? name)
  }

  with(name: string, f: (d: ExecutorImpl) => unknown, opts: WithOpts = {}): ExecutorImpl {
    // `hasOwn`, not `in`: `'toString' in this.cte` is true for every object, so `.with('toString')`
    // was refused as a duplicate of a CTE nobody declared.
    if (Object.hasOwn(this.cte, name)) {
      throw new BuilderError(`pg-prime: a CTE named "${name}" is already declared in this query.`)
    }
    const query = withoutDeclared(
      statementAstOf(
        f(this),
        'a .with() callback must return a query builder — `d => d.from(...).select(...)`; it',
      ),
      this.ctes,
    )
    const node = cteNode({
      name,
      columns: undefined,
      recursive: false,
      materialized: opts.materialized,
      query,
    })
    const handle = { [NAME]: name, $: derivedRuntime(name) }
    registerCte(handle, name, fieldsOfStatement(query))
    return new ExecutorImpl(
      this.ctx,
      [...this.ctes, node],
      Object.freeze({ ...this.cte, [name]: handle }),
      this.h,
    )
  }

  /**
   * `with recursive "name" as (base union all step)` — `12` decision 17.
   *
   * The order below is the whole implementation: run `base`, read its **result shape**, register
   * the handle from it, and only then run `step` with that handle in hand. The row type is
   * therefore fixed by the base term, which is what makes this a plain two-callback method rather
   * than the self-referential row inference `03` §5 punts to v2.
   */
  withRecursive(
    name: string,
    base: (d: ExecutorImpl) => unknown,
    step: (d: ExecutorImpl, self: object) => unknown,
    opts: RecursiveOpts = {},
  ): ExecutorImpl {
    if (Object.hasOwn(this.cte, name)) {
      throw new BuilderError(`pg-prime: a CTE named "${name}" is already declared in this query.`)
    }
    const left = withoutDeclared(
      queryAstOf(
        base(this),
        'a .withRecursive() base callback must return a SELECT — `d => d.from(...).select(...)`; it',
      ),
      this.ctes,
    ) as SelectNode | SetOpNode
    const handle = { [NAME]: name, $: derivedRuntime(name) }
    registerCte(handle, name, fieldsOfStatement(left))
    const right = withoutDeclared(
      queryAstOf(
        step(this, handle),
        'a .withRecursive() step callback must return a SELECT — ' +
          '`(d, self) => d.from(self).innerJoin(...).select(...)`; it',
      ),
      this.ctes,
    ) as SelectNode | SetOpNode
    const node = cteNode({
      name,
      columns: undefined,
      recursive: true,
      materialized: opts.materialized,
      query: setopNode({ op: opts.unionAll === false ? 'union' : 'union all', left, right }),
    })
    return new ExecutorImpl(
      this.ctx,
      [...this.ctes, node],
      Object.freeze({ ...this.cte, [name]: handle }),
      this.h,
    )
  }

  insertInto(t: object, alias?: string): unknown {
    return makeInsert(this.ctx, this.ctes, t, alias, this)
  }

  update(t: object, alias?: string): unknown {
    return makeUpdate(this.ctx, this.ctes, t, alias)
  }

  deleteFrom(t: object, alias?: string): unknown {
    return makeDelete(this.ctx, this.ctes, t, alias)
  }

  /**
   * `db.sql\`select now()\`` — the fragment-only statement (`03` §1.4c, `07` §2.3).
   *
   * The declared CTEs are deliberately NOT spliced in: a raw statement is raw, and quietly
   * prefixing someone's hand-written SQL with a `WITH` they did not write is the kind of help
   * that produces a `42601` nobody can locate.
   */
  sql(strings: TemplateStringsArray, ...values: readonly unknown[]): RawQuery {
    return makeRaw(this.ctx, strings, values)
  }
}

export function makeExecutor(
  ctx: BuilderCtx,
  handles: Readonly<Record<string, object>>,
): ExecutorImpl {
  return new ExecutorImpl(ctx, [], Object.freeze({}), handles)
}
