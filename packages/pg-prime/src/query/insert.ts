/**
 * INSERT, upsert and the bulk strategies (design/09 WS4; `03` §2.5–2.6).
 *
 * ## Column order is the table's, not the object literal's
 *
 * `values({ role, email })` and `values({ email, role })` compile to the *same* statement, because
 * the column list is taken in table-declaration order and filtered to the keys present. Two
 * reasons, and the second is the important one: the `03` §2.5 golden is stable regardless of how a
 * caller spelled the literal, and PostgreSQL's plan cache is keyed on SQL text — a builder whose
 * column order followed `Object.keys` would mint a different prepared statement per key ordering.
 *
 * ## Two strategies, one automatic switch (`03` §2.6)
 *
 *   `values` — one multi-row `VALUES`, `::type` casts on the first row only. `rows × columns`
 *              parameters, so it hits the 65535 wire ceiling at ~5 000 rows of 12 columns.
 *   `unnest` — ONE parameter per column, whatever the row count. PG-only; sidesteps the ceiling
 *              entirely and collapses the parse cost of a huge batch.
 *
 * `auto` (the default) picks `unnest` above 30 000 cells and `values` below. Above `chunkSize`
 * rows (5 000) the batch is split, and the chunks run inside one transaction unless the caller is
 * already in one — a half-applied batch is the failure mode that makes bulk inserts untrustworthy.
 *
 * ## `castFirstRow`
 *
 * On for a multi-row `VALUES` and off for a single row. PostgreSQL infers rows 2..n from row 1, so
 * the casts cost one row's worth of tokens; without them a `numeric` column fed from a string
 * parameter resolves as `text` and the whole statement fails with 42804. The single-row form needs
 * none because `paramTypes` in `Parse` already declares each `$n` (`02` §2.3).
 */

import type { AnyCodec, CodecRegistry } from '../codec/index.js'
import { arrayCodecOf } from '../codec/index.js'
import type {
  ColumnMeta,
  CteNode,
  Expr as Node,
  InsertNode,
  InsertSource,
  OnConflictNode,
  ProjectionItem,
  SelectNode,
  SetItem,
  SetOpNode,
} from '../compile/ast.js'
import type { Compiled } from '../compile/contract.js'
import { compile as compileAst } from '../compile/compiler.js'
import {
  cast,
  insert as insertNode,
  param,
  select as selectNode,
  setItem,
  table as tableFrom,
} from '../compile/nodes.js'
import { isAstNode } from '../compile/nodes.js'
import { isFragment, toNode } from '../sql/fragment.js'
import { BuilderError } from '../sql/errors.js'
import type { BulkOpts, BuilderCtx, InsertState } from './builder-state.js'
import type { ExplainOptions, ExplainResult } from './executor.js'
import type { PrepareOptions, PreparedQueryImpl } from './prepared.js'
import { prepareFrom } from './prepared.js'
import type { SqlSnapshot } from './terminals.js'
import { explainWith, runnerOf, takeFirst, toSQLOf } from './terminals.js'
import { metaOf } from './meta.js'
import type { TableCodecMeta } from './meta.js'
import type { RefScope } from './ref.js'
import { refsOf } from './ref.js'
import { registerBuilder } from './nominal.js'
import { queryAstOf } from './nominal.js'
import { isGroup, isNested } from './projection.js'
import {
  allOf,
  assertSafeKey,
  compileProjection,
  NO_LEFT_JOINS,
  scopeFor,
  sourceOf,
  toExprList,
  toExprNode,
} from './scope.js'

/** `rows × columns` above which `auto` switches to `unnest` (03 §2.6). */
export const UNNEST_CELLS = 30_000
/** Rows per chunk once a batch is split. */
export const CHUNK_ROWS = 5_000

type Lambda<R> = (t: never) => R
type Scope = Readonly<Record<string, RefScope>>

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

function call<R>(f: Lambda<R>, ...args: readonly unknown[]): R {
  return (f as unknown as (...a: readonly unknown[]) => R)(...args)
}

/**
 * A user-supplied insert value → an expression.
 *
 * The classification is a chain of nominal tests and never a `try`/`catch`: constructing a
 * `BuilderError` captures a stack, and a 5 000-row insert with one `Date` per row paid for 5 000
 * of them. Worse, catching also swallowed the *markers* — `nest({...})` and a relation projection
 * are neither expressions nor data, and re-parameterising one silently bound its plan object as
 * JSON. They rethrow; everything else that is not SQL is data.
 */
function valueExpr(v: unknown, codec: AnyCodec, where: string): Node {
  if (isAstNode(v)) return v
  if (isFragment(v)) return toNode(v)
  if (isNested(v)) {
    throw new BuilderError(
      `pg-prime: ${where} is a relation projection, which is only valid in a projection or a ` +
        `RETURNING list — not as a value to write.`,
    )
  }
  if (isGroup(v)) {
    throw new BuilderError(
      `pg-prime: ${where} is a nest({...}) group, which is a result-shaping marker and not a ` +
        `value to write. Write the columns individually.`,
    )
  }
  return param(v, codec)
}

export class InsertBuilder {
  readonly s: InsertState
  #ast: InsertNode | undefined
  #compiled: Compiled<unknown> | undefined
  #all: readonly Compiled<unknown>[] | undefined

  constructor(s: InsertState) {
    this.s = Object.freeze(s)
    registerBuilder(this)
  }

  #next(patch: Partial<InsertState>): InsertBuilder {
    return new InsertBuilder({ ...this.s, ...patch })
  }

  get #meta(): TableCodecMeta {
    return metaOf(this.s.handle as never, this.s.ctx.registry)
  }

  // ── sources ───────────────────────────────────────────────────────────────

  values(row: Record<string, unknown>): InsertBuilder {
    return this.#withRows([row], undefined, false)
  }

  /** The bulk form. Strategy and chunking are decided here, at call time (03 §2.6). */
  valuesMany(rows: readonly Record<string, unknown>[], opts?: BulkOpts): InsertBuilder {
    if (rows.length === 0) {
      throw new BuilderError('pg-prime: valuesMany([]) has no columns to insert; nothing to do.')
    }
    if (opts !== undefined) checkBulkOpts(opts)
    return this.#withRows(rows, opts, true)
  }

  #withRows(
    rows: readonly Record<string, unknown>[],
    bulk: BulkOpts | undefined,
    castFirstRow: boolean,
  ): InsertBuilder {
    const columns = this.#columnsFor(rows)
    return this.#next({
      columns,
      rows,
      bulk,
      castFirstRow: castFirstRow && rows.length > 1,
      source: undefined,
    })
  }

  /** `insert into … default values`. */
  defaultValues(): InsertBuilder {
    return this.#next({ columns: [], rows: undefined, source: { k: 'defaults' } })
  }

  /**
   * `insert into … select …` — the writable-CTE pattern (03 §2.7).
   *
   * The sub-select's own `WITH` is **hoisted onto the insert** rather than left in place. Both
   * come from the same executor, so leaving it would emit the CTE list twice: legal SQL (the
   * inner one shadows) but twice the text, and a reader cannot tell which copy is the one that
   * runs. Hoisting also makes `$n` numbering the single left-to-right pass it is everywhere else.
   */
  fromSelect(q: unknown): InsertBuilder {
    const resolved = typeof q === 'function' ? (q as (d: unknown) => unknown)(this.s.owner) : q
    const split = splitWith(queryAstOf(resolved, 'fromSelect()'))
    return this.#next({
      ctes: mergeCtes(this.s.ctes, split.ctes),
      columns: this.#columnsInOrder(keysOfQuery(split.node), 'fromSelect()'),
      rows: undefined,
      source: { k: 'select', query: split.node },
    })
  }

  // ── ON CONFLICT (03 §2.5) ─────────────────────────────────────────────────

  onConflict(f: (c: ConflictSpec) => ConflictSpec): InsertBuilder {
    const meta = this.#meta
    const target = this.s.scope[this.s.into.alias] as RefScope
    // `excluded` is the target table's own columns under PostgreSQL's pseudo-table alias, so the
    // ordinary ref machinery produces it — with the real codecs, which a synthetic runtime could
    // not have.
    const excluded = refsOf(this.s.handle as never, 'excluded', this.s.ctx.registry)
    const out = f(
      new ConflictSpec(
        { target: undefined, action: { k: 'nothing' } },
        meta,
        target,
        excluded,
        this.s.into.alias,
      ),
    )
    if (!(out instanceof ConflictSpec)) {
      throw new BuilderError('pg-prime: the onConflict callback must return the spec it was given.')
    }
    return this.#next({ onConflict: out.node })
  }

  // ── RETURNING (03 §2.5) ───────────────────────────────────────────────────

  returning(f: Lambda<Record<string, unknown>>): InsertBuilder {
    return this.#next({ returning: compileProjection(call(f, this.s.scope), NO_LEFT_JOINS) })
  }

  returningAll(): InsertBuilder {
    return this.#next({
      returning: compileProjection(
        allOf(this.s.scope[this.s.into.alias] as RefScope),
        NO_LEFT_JOINS,
      ),
    })
  }

  // ── terminals ─────────────────────────────────────────────────────────────

  toAst(): InsertNode {
    if (this.#ast === undefined) {
      const statements = this.#statements()
      if (statements.length > 1) {
        throw new BuilderError(
          `pg-prime: this bulk insert is ${statements.length} statements (chunked at ` +
            `${this.#chunkSize()} rows). Use .compileAll() or .execute(); one AST cannot ` +
            `describe a chunked batch.`,
        )
      }
      this.#ast = statements[0] as InsertNode
    }
    return this.#ast
  }

  compile(): Compiled<unknown> {
    this.#compiled ??= compileAst(this.toAst())
    return this.#compiled
  }

  /** Every statement this builder will run — one per chunk. */
  compileAll(): readonly Compiled<unknown>[] {
    this.#all ??= Object.freeze(this.#statements().map((n) => compileAst(n)))
    return this.#all
  }

  async execute(): Promise<unknown[]> {
    const all = this.compileAll()
    const runner = runnerOf(this.s.ctx)
    return all.length === 1 ? runner.run(all[0] as Compiled<unknown>) : runner.runChunked(all)
  }

  /**
   * `rows[0]` of the RETURNING list, over **every** statement `execute()` would run.
   *
   * The tempting alternative — `maxRows: 1` on the first compiled statement — is wrong for two
   * measured reasons, and `terminals.ts` has the rest: a chunked batch compiles to N statements
   * and running only the first inserts a fraction of the rows, and `maxRows` makes PostgreSQL
   * report `rowCount: 1` for an `INSERT … RETURNING` that inserted five (measured on PG 17.11 —
   * design/09 §3.6 M5).
   */
  async executeTakeFirst(): Promise<unknown> {
    return takeFirst(await this.execute())
  }

  /**
   * One prepared artifact means one statement, so a batch that chunked has none — the same rule
   * `toAst()` states, with the same suggestion.
   */
  prepare(name?: string, opts?: PrepareOptions): PreparedQueryImpl<unknown> {
    const all = this.compileAll()
    if (all.length !== 1) {
      throw new BuilderError(
        `pg-prime: .prepare() describes ONE statement and this insert compiles to ${all.length} ` +
          `(the batch was chunked at ${this.#chunkSize()} rows). Use .compileAll(), or lower the ` +
          `row count.`,
      )
    }
    return prepareFrom(this.s.ctx, all[0] as Compiled<unknown>, name, opts)
  }

  /** `analyze: true` wraps and rolls back by default — `EXPLAIN ANALYZE INSERT` inserts (07 §7.5). */
  explain(opts?: ExplainOptions): Promise<ExplainResult> {
    return explainWith(this.s.ctx, this.compile(), opts)
  }

  toSQL(): SqlSnapshot {
    return toSQLOf(this.compile())
  }

  // ── statement assembly ────────────────────────────────────────────────────

  #chunkSize(): number {
    return this.s.bulk?.chunkSize ?? CHUNK_ROWS
  }

  /**
   * `values` or `unnest`, decided here rather than at `.valuesMany()` time so that the column set
   * (which `#withRows` has already resolved) can veto `unnest`.
   *
   * **An array-typed column cannot go through `unnest`.** The strategy passes one array per
   * column, so a `text[]` column would need a `text[][]` parameter — and PostgreSQL has no
   * two-dimensional array *type* (`text[]` and `text[][]` are both OID 1009), so the codec built
   * for it wraps the `text[]` codec as its own element and the leaf encoder is handed an array
   * where it expects a string. Even if it encoded, `unnest` flattens every dimension, so row
   * boundaries would be lost. `auto` therefore falls back to `values`, and an explicit
   * `strategy: 'unnest'` is a named error rather than a `PgEncodeError` from three layers down.
   */
  #strategy(rows: readonly Record<string, unknown>[]): 'values' | 'unnest' {
    const declared = this.s.bulk?.strategy ?? 'auto'
    const arrayColumn = this.s.columns.find((c) => isArrayCodec(c.codec))
    if (arrayColumn !== undefined) {
      if (declared === 'unnest') {
        throw new BuilderError(
          `pg-prime: the 'unnest' bulk strategy cannot insert the array column ` +
            `"${arrayColumn.name}" — it would need a two-dimensional array parameter, which ` +
            `PostgreSQL has no type for, and unnest() would flatten it anyway. Use ` +
            `strategy: 'values' (which is what 'auto' picks here).`,
        )
      }
      return 'values'
    }
    if (declared !== 'auto') return declared
    return rows.length * this.s.columns.length > UNNEST_CELLS ? 'unnest' : 'values'
  }

  #statements(): readonly InsertNode[] {
    const base = (source: InsertSource): InsertNode =>
      insertNode(
        compact({
          with: this.s.ctes.length > 0 ? this.s.ctes : undefined,
          into: this.s.into,
          columns: this.s.columns,
          source,
          castFirstRow: this.s.castFirstRow ? true : undefined,
          onConflict: this.s.onConflict,
          returning: this.s.returning,
        }) as Omit<InsertNode, 'k'>,
      )

    if (this.s.source !== undefined) return [base(this.s.source)]
    const rows = this.s.rows
    if (rows === undefined) {
      throw new BuilderError(
        'pg-prime: insertInto(...) needs .values(...), .valuesMany(...), .fromSelect(...) or ' +
          '.defaultValues().',
      )
    }

    const size = this.#chunkSize()
    const strategy = this.#strategy(rows)
    const out: InsertNode[] = []
    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size)
      out.push(base(strategy === 'unnest' ? this.#unnestSource(chunk) : this.#valuesSource(chunk)))
    }
    return out
  }

  #valuesSource(rows: readonly Record<string, unknown>[]): InsertSource {
    const keys = this.#keys()
    return {
      k: 'values',
      rows: rows.map((row, r) =>
        this.s.columns.map((c, i) => {
          const key = keys[i] as string
          if (!Object.hasOwn(row, key)) throw missingKey(key, r)
          return valueExpr(row[key], c.codec, `values() column "${key}"`)
        }),
      ),
    }
  }

  #unnestSource(rows: readonly Record<string, unknown>[]): InsertSource {
    const keys = this.#keys()
    const registry: CodecRegistry = this.s.ctx.registry
    const arrays = this.s.columns.map((c, i) => {
      const key = keys[i] as string
      const values = rows.map((row, r) => {
        if (!Object.hasOwn(row, key)) throw missingKey(key, r)
        return row[key]
      })
      const arrayCodec = arrayCodecOf(c.codec, registry)
      // The `::type[]` is not decoration: `unnest($1)` on an untyped parameter is 42P18, and the
      // array's element type is what gives every inserted column its type.
      return cast(param(values, arrayCodec), `${c.codec.sqlName}[]`, arrayCodec)
    })
    return { k: 'unnest', arrays }
  }

  /** TS keys parallel to `this.s.columns`. */
  #keys(): readonly string[] {
    const meta = this.#meta
    const byName = new Map(meta.columns.map((c, i) => [c.name, meta.keys[i] as string]))
    return this.s.columns.map((c) => byName.get(c.name) as string)
  }

  /**
   * The columns to insert: table-declaration order, filtered to the keys the first row supplies,
   * and every other row must supply exactly the same set.
   *
   * A row missing a key is rejected rather than filled with NULL. PostgreSQL's `DEFAULT` keyword
   * would be the other answer, but "this row said nothing about `created_at`" and "this row wants
   * the column default" are different intentions, and quietly picking one is how a bulk insert
   * writes NULLs over a `defaultNow()`.
   */
  #columnsFor(rows: readonly Record<string, unknown>[]): readonly ColumnMeta[] {
    const first = rows[0] as Record<string, unknown>
    const keys = Object.keys(first)
    for (const k of keys) assertSafeKey(k, 'insert value')
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] as Record<string, unknown>
      const rowKeys = Object.keys(row)
      // `hasOwn`, not `in`: `'toString' in first` is true for every object, so the `in` form
      // accepted a row that set `toString` and no such column exists.
      if (rowKeys.length !== keys.length || rowKeys.some((k) => !Object.hasOwn(first, k))) {
        throw new BuilderError(
          `pg-prime: every row of a bulk insert must set the same columns. Row ${r} sets ` +
            `[${rowKeys.join(', ')}]; row 0 sets [${keys.join(', ')}].`,
        )
      }
    }
    return this.#columnsByKey(keys, 'values()')
  }

  /**
   * The columns to insert, in the **order the keys were given** — which is what `fromSelect` needs.
   *
   * `insert into t (a, b, c) select …` is positional: the sub-select's first output column goes
   * into `a` whatever it is called. So the column list has to follow the *projection*, not the
   * table's declaration order, or a projection that happens to be spelled in a different order
   * writes every value into the wrong column and PostgreSQL cannot object because the types
   * usually still line up.
   */
  #columnsInOrder(keys: readonly string[], where: string): readonly ColumnMeta[] {
    const meta = this.#meta
    const out: ColumnMeta[] = []
    const missing: string[] = []
    for (const key of keys) {
      assertSafeKey(key, 'insert column')
      const column = Object.hasOwn(meta.byKey, key) ? meta.byKey[key] : undefined
      if (column === undefined) missing.push(key)
      else out.push(column)
    }
    if (missing.length > 0) throw unknownColumns(where, missing, this.s.into.table.name)
    return Object.freeze(out)
  }

  #columnsByKey(keys: readonly string[], where: string): readonly ColumnMeta[] {
    const meta = this.#meta
    const wanted = new Set(keys)
    const out: ColumnMeta[] = []
    for (let i = 0; i < meta.keys.length; i++) {
      const key = meta.keys[i] as string
      if (wanted.delete(key)) out.push(meta.columns[i] as ColumnMeta)
    }
    if (wanted.size > 0) throw unknownColumns(where, [...wanted], this.s.into.table.name)
    return Object.freeze(out)
  }
}

function unknownColumns(where: string, keys: readonly string[], table: string): BuilderError {
  return new BuilderError(
    `pg-prime: ${where} names column(s) [${keys.join(', ')}] that "${table}" does not have.`,
  )
}

/** An array codec — the one thing the `unnest` strategy cannot carry. See `#strategy`. */
function isArrayCodec(c: AnyCodec): boolean {
  return c.arrayOf !== undefined
}

/** `03` §2.6's two knobs, checked at the boundary rather than trusted from the type layer. */
function checkBulkOpts(opts: BulkOpts): void {
  const strategy = opts.strategy
  if (
    strategy !== undefined &&
    strategy !== 'auto' &&
    strategy !== 'values' &&
    strategy !== 'unnest'
  ) {
    throw new BuilderError(
      `pg-prime: unknown bulk strategy ${JSON.stringify(strategy)} — it is 'auto' (the default), ` +
        `'values' or 'unnest'.`,
    )
  }
  const size = opts.chunkSize
  if (size !== undefined && (!Number.isInteger(size) || size < 1)) {
    // A chunk of 0 rows is not a degenerate batch, it is a `for (i += 0)` that never terminates:
    // the loop hangs the process synchronously, before anything reaches a database.
    throw new BuilderError(`pg-prime: chunkSize must be a positive integer (got ${String(size)}).`)
  }
}

function missingKey(key: string, row: number): BuilderError {
  return new BuilderError(`pg-prime: row ${row} of this insert does not set "${key}".`)
}

/** Peel a sub-select's `WITH` off so the enclosing statement can own it. */
function splitWith(n: SelectNode | SetOpNode): {
  node: SelectNode | SetOpNode
  ctes: readonly CteNode[]
} {
  if (n.k !== 'select' || n.with === undefined) return { node: n, ctes: [] }
  const { with: ctes, ...rest } = n
  return { node: selectNode(rest as Omit<SelectNode, 'k'>), ctes }
}

/**
 * Concatenate two CTE lists, merging by **node identity**.
 *
 * Both lists usually come from the same executor, so the same `CteNode` object appears in both and
 * the second copy is dropped: one declaration, one set of binds, one left-to-right `$n` pass. Two
 * *different* nodes under one name is a different situation entirely — one of them would silently
 * win and the reader could not tell which — so that is an error, not a merge. Name equality alone
 * is not enough to dedupe, which is what the previous `Set(outer.map(c => c.name))` assumed.
 */
function mergeCtes(outer: readonly CteNode[], inner: readonly CteNode[]): readonly CteNode[] {
  if (inner.length === 0) return outer
  if (outer.length === 0) return inner
  const byName = new Map(outer.map((c) => [c.name, c]))
  const out = [...outer]
  for (const c of inner) {
    const existing = byName.get(c.name)
    if (existing === c) continue
    if (existing !== undefined) {
      throw new BuilderError(
        `pg-prime: two different CTEs are named "${c.name}" in one statement. Rename one — a ` +
          `single WITH list cannot declare a name twice, and picking a winner silently would ` +
          `change which query runs.`,
      )
    }
    byName.set(c.name, c)
    out.push(c)
  }
  return Object.freeze(out)
}

function keysOfQuery(n: SelectNode | SetOpNode): readonly string[] {
  let cur: SelectNode | SetOpNode = n
  while (cur.k === 'setop') cur = cur.left
  return cur.projection.map((p) => p.key)
}

// ─────────────────────────────────────────────────────────────────────────────
// ON CONFLICT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The upsert spec. `excluded` is handed to `doUpdate` as a second scope — the runtime-object
 * analogue of Kysely's `OnConflictDatabase` virtual table (kysely.md §2.4), which is the right
 * idea expressed in the right form here: `excluded.name` is an ordinary ref, so every operator
 * works on it.
 */
export class ConflictSpec {
  readonly node: OnConflictNode
  readonly #meta: TableCodecMeta
  readonly #target: RefScope
  readonly #excluded: RefScope
  readonly #alias: string

  constructor(
    node: OnConflictNode,
    meta: TableCodecMeta,
    target: RefScope,
    excluded: RefScope,
    alias: string,
  ) {
    this.node = node
    this.#meta = meta
    this.#target = target
    this.#excluded = excluded
    this.#alias = alias
  }

  #next(node: OnConflictNode): ConflictSpec {
    return new ConflictSpec(node, this.#meta, this.#target, this.#excluded, this.#alias)
  }

  /**
   * The arbiter index's columns.
   *
   * Every ref must be one of the **target's own**, checked by identity against the target scope
   * and not by DB column name: `on conflict ("id")` names an index on this table, so a ref that
   * happens to be called `id` but belongs to a joined table is a different column and resolving
   * it by name would arbitrate on an index that does not exist.
   */
  columns(f: Lambda<unknown>): ConflictSpec {
    const refs = toExprList(call(f, this.#target), 'onConflict().columns()')
    const columns = refs.map((r) => {
      if (r.k !== 'col') {
        throw new BuilderError('pg-prime: onConflict().columns() takes column references.')
      }
      const key = keyOfColumn(this.#meta, r.name)
      if (this.#target[key] !== r) {
        throw new BuilderError(
          `pg-prime: onConflict().columns() takes columns of "${this.#meta.table.name}" itself; ` +
            `"${r.alias}"."${r.name}" belongs to another source. The arbiter is an index on the ` +
            `insert target, so name it through the "${this.#alias}" scope.`,
        )
      }
      return this.#meta.byKey[key] as ColumnMeta
    })
    return this.#next({
      ...this.node,
      target: { k: 'columns', columns, where: whereOf(this.node) },
    })
  }

  /** An expression index: `on conflict (lower(email))`. */
  expressions(f: Lambda<unknown>): ConflictSpec {
    const exprs = toExprList(call(f, this.#target), 'onConflict().expressions()')
    return this.#next({
      ...this.node,
      target: { k: 'expressions', exprs, where: whereOf(this.node) },
    })
  }

  constraint(name: string): ConflictSpec {
    return this.#next({ ...this.node, target: { k: 'constraint', name } })
  }

  /**
   * The **index predicate** — which partial unique index is the arbiter. Not `DO UPDATE … WHERE`;
   * that is {@link whereUpdate}. Conflating the two is the classic upsert bug, so they are two
   * methods with two names.
   */
  where(f: Lambda<unknown>): ConflictSpec {
    const target = this.node.target
    if (target === undefined || target.k === 'constraint') {
      throw new BuilderError(
        'pg-prime: onConflict().where() is the partial-index predicate, so it needs .columns(...) ' +
          'or .expressions(...) first. A named constraint has no predicate.',
      )
    }
    const pred = toExprNode(call(f, this.#target), 'onConflict().where()')
    return this.#next({ ...this.node, target: { ...target, where: pred } })
  }

  doNothing(): ConflictSpec {
    return this.#next({ ...this.node, action: { k: 'nothing' } })
  }

  doUpdate(f: (set: RefScope, excluded: RefScope) => Record<string, unknown>): ConflictSpec {
    const patch = f(this.#target, this.#excluded)
    const set = setItemsOf(this.#meta, patch, 'doUpdate()')
    return this.#next({ ...this.node, action: { k: 'update', set, where: updateWhere(this.node) } })
  }

  /** `DO UPDATE … WHERE` — decides, per row, whether to write at all. */
  whereUpdate(f: (t: RefScope, excluded: RefScope) => unknown): ConflictSpec {
    const action = this.node.action
    if (action.k !== 'update') {
      throw new BuilderError('pg-prime: onConflict().whereUpdate() needs .doUpdate(...) first.')
    }
    const pred = toExprNode(f(this.#target, this.#excluded), 'onConflict().whereUpdate()')
    return this.#next({ ...this.node, action: { ...action, where: pred } })
  }
}

function whereOf(n: OnConflictNode): Node | undefined {
  const t = n.target
  return t !== undefined && t.k !== 'constraint' ? t.where : undefined
}

function updateWhere(n: OnConflictNode): Node | undefined {
  return n.action.k === 'update' ? n.action.where : undefined
}

function keyOfColumn(meta: TableCodecMeta, name: string): string {
  const i = meta.columns.findIndex((c) => c.name === name)
  if (i < 0) throw new BuilderError(`pg-prime: no column "${name}" on "${meta.table.name}".`)
  return meta.keys[i] as string
}

/** `{ name: excluded.name, views: add(t.views, 1) }` → `SetItem[]`, in table order. */
export function setItemsOf(
  meta: TableCodecMeta,
  patch: Record<string, unknown>,
  where: string,
): readonly SetItem[] {
  for (const k of Object.keys(patch)) assertSafeKey(k, 'set')
  const out: SetItem[] = []
  for (let i = 0; i < meta.keys.length; i++) {
    const key = meta.keys[i] as string
    if (!Object.hasOwn(patch, key)) continue
    const column = meta.columns[i] as ColumnMeta
    out.push(setItem(column, valueExpr(patch[key], column.codec, `${where} column "${key}"`)))
  }
  const unknownKeys = Object.keys(patch).filter((k) => !meta.keys.includes(k))
  if (unknownKeys.length > 0) {
    throw new BuilderError(
      `pg-prime: ${where} names column(s) [${unknownKeys.join(', ')}] that "${meta.table.name}" ` +
        `does not have.`,
    )
  }
  return Object.freeze(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────

export function makeInsert(
  ctx: BuilderCtx,
  ctes: readonly CteNode[],
  h: object,
  alias: string | undefined,
  owner: unknown,
): InsertBuilder {
  const source = sourceOf(h)
  if (source.kind !== 'table') {
    throw new BuilderError(
      'pg-prime: insertInto() takes a table handle, not a CTE or derived table.',
    )
  }
  const name = alias ?? source.name
  const meta = metaOf(h as never, ctx.registry)
  return new InsertBuilder({
    ctx,
    ctes,
    handle: h,
    into: tableFrom(meta.table, name),
    columns: [],
    source: undefined,
    castFirstRow: false,
    onConflict: undefined,
    returning: undefined,
    scope: Object.freeze({ [name]: scopeFor(h, name, ctx) }),
    rows: undefined,
    bulk: undefined,
    owner,
  })
}

export type { ProjectionItem, Scope }
