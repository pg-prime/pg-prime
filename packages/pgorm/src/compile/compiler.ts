/**
 * The single-pass SQL emitter (03 §1.1, D1).
 *
 * One recursive descent over the (already hoisted) node tree, appending to a `string[]` that
 * is `join('')`ed once, with a `Bind[]` threaded through. No intermediate SQL strings, no
 * optimizer, no normalization pass — PostgreSQL has a planner; a second one in TypeScript is
 * pure latency.
 *
 * **The injection audit surface for this whole library is three call sites in this file**:
 * `emitIdentPart` (splices a pre-quoted identifier), `emitUnsafeRaw` (splices caller text,
 * by explicit request), and `quoteStringLiteral` for compiler-generated JSON keys. Every
 * other route from a value into the output goes through `bindValue`, which emits `$n` and
 * pushes the encoded value into `binds`.
 */

import type { Codec } from '../sql/codec.js'
import { TooManyParametersError, UnsupportedNodeError } from '../sql/errors.js'
import { quoteIdentPart, quoteStringLiteral } from '../sql/ident.js'
import type {
  AggNode,
  Expr,
  FromItem,
  InsertNode,
  JoinNode,
  OrderItem,
  ProjectionItem,
  QualifiedName,
  RawNode,
  SelectNode,
  Statement,
} from './ast.js'
import type { Bind, Compiled, FieldPlan, ResultShape } from './contract.js'
import { planReturning, planSelect } from './hoist.js'

/** The PostgreSQL wire protocol caps parameters at 65535 (int16). */
const MAX_PARAMS = 65535

class Emitter {
  readonly chunks: string[] = []
  readonly binds: Bind[] = []
  readonly reads: QualifiedName[] = []
  readonly writes: QualifiedName[] = []
  readonly placeholders: string[] = []
  usedUnsafeRaw = false
  /** INSERT/UPDATE/DELETE RETURNING lists reference the target table implicitly. */
  qualifyColumns = true
  private indent = 0

  push(s: string): void {
    this.chunks.push(s)
  }

  /** Newline + current indentation. */
  nl(): void {
    this.chunks.push(this.indent === 0 ? '\n' : `\n${' '.repeat(this.indent)}`)
  }

  block(f: () => void): void {
    this.indent += 2
    this.nl()
    f()
    this.indent -= 2
    this.nl()
  }

  /** The ONLY way a caller-supplied value reaches the output. */
  bindValue(value: unknown, codec: Codec): void {
    this.binds.push({ k: 'value', encoded: codec.encode(value as never) })
    this.chunks.push(`$${this.binds.length}`)
  }

  bindSlot(name: string, codec: Codec): void {
    this.binds.push({ k: 'slot', name, codec })
    this.placeholders.push(name)
    this.chunks.push(`$${this.binds.length}`)
  }

  sql(): string {
    return this.chunks.join('')
  }
}

// ─────────────────────────── expressions ───────────────────────────

/**
 * A `sql` fragment's internal precedence is *unknowable* to the compiler — the chunks are
 * opaque text. `sql`a or b`` used as an operand of `and` would otherwise emit
 * `a or b and c`, which PostgreSQL parses as `a or (b and c)`: a silent semantics change.
 * So a raw node is parenthesized in every operand position. This is the one place where the
 * compiler is deliberately more conservative than a hand-written query would be.
 */
function isOpaque(e: Expr): boolean {
  return e.k === 'raw'
}

function needsParens(e: Expr): boolean {
  // A `bool` node emits its OWN parentheses whenever it has ≥2 arguments, so wrapping it
  // again would produce `not ((a and b))`. With exactly one argument it collapses to that
  // argument and therefore inherits its obligations; with zero it is a bare `true`/`false`.
  if (e.k === 'bool') {
    return e.args.length === 1 && needsParens(e.args[0] as Expr)
  }
  return e.k === 'bin' || e.k === 'is' || e.k === 'in' || e.k === 'between' || isOpaque(e)
}

function emitParenthesized(em: Emitter, e: Expr): void {
  if (needsParens(e)) {
    em.push('(')
    emitExpr(em, e)
    em.push(')')
  } else {
    emitExpr(em, e)
  }
}

function emitLiteralValue(v: number | bigint | boolean | null): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'bigint') return v.toString()
  if (!Number.isFinite(v)) {
    throw new UnsupportedNodeError('lit', `${String(v)} has no SQL literal form; use a parameter`)
  }
  return String(v)
}

function emitExpr(em: Emitter, e: Expr): void {
  switch (e.k) {
    case 'col':
      em.push(em.qualifyColumns ? e.q : e.qn)
      return

    case 'param':
      em.bindValue(e.value, e.codec)
      return

    case 'ph':
      em.bindSlot(e.name, e.codec)
      return

    case 'lit':
      em.push(emitLiteralValue(e.value))
      return

    case 'bin': {
      // Both operands go through `emitParenthesized` unconditionally. `needsParens` is false
      // for the overwhelmingly common leaf operands (columns, params, literals, function
      // calls), so this costs nothing in the normal case; where it fires — a nested `bin`
      // under a comparison, e.g. `("meta" #>> $1) = $2` — the parentheses are exactly what
      // design/03 Appendix A pins, and they make operator precedence explicit instead of
      // inherited from whatever PostgreSQL's grammar happens to say this release.
      emitParenthesized(em, e.l)
      em.push(` ${e.op} `)
      emitParenthesized(em, e.r)
      return
    }

    case 'bool': {
      if (e.args.length === 0) {
        em.push(e.op === 'and' ? 'true' : 'false')
        return
      }
      if (e.args.length === 1) {
        // `and(x)` collapses to `x`, so it must keep `x`'s parenthesisation obligations:
        // otherwise `and(and(sql`a or b`), y)` would leak `a or b and y`.
        const only = e.args[0] as Expr
        if (isOpaque(only)) {
          em.push('(')
          emitExpr(em, only)
          em.push(')')
        } else {
          emitExpr(em, only)
        }
        return
      }
      em.push('(')
      for (let i = 0; i < e.args.length; i++) {
        if (i > 0) em.push(` ${e.op} `)
        const arg = e.args[i] as Expr
        // `bin`/`is`/`in`/`between` all bind tighter than `and`/`or` in the PostgreSQL
        // grammar, so they need no parens; only opaque raw text does.
        if (isOpaque(arg)) {
          em.push('(')
          emitExpr(em, arg)
          em.push(')')
        } else {
          emitExpr(em, arg)
        }
      }
      em.push(')')
      return
    }

    case 'un':
      if (e.op === 'not') {
        em.push('not ')
        emitParenthesized(em, e.e)
      } else {
        em.push(e.op)
        emitParenthesized(em, e.e)
      }
      return

    case 'is':
      emitParenthesized(em, e.e)
      em.push(` is ${e.test}`)
      if (e.r !== undefined) {
        em.push(' ')
        emitExpr(em, e.r)
      }
      return

    case 'in': {
      const set = e.set
      if (set.k === 'list') {
        // `in ([])` compiles to a constant, by construction (03 §2.1). Kysely ships a plugin
        // for this; it should not need a plugin.
        if (set.items.length === 0) {
          em.push(e.not ? 'true' : 'false')
          return
        }
        emitParenthesized(em, e.e)
        em.push(e.not ? ' not in (' : ' in (')
        for (let i = 0; i < set.items.length; i++) {
          if (i > 0) em.push(', ')
          emitExpr(em, set.items[i] as Expr)
        }
        em.push(')')
        return
      }
      if (set.k === 'any') {
        // One parameter, no plan-cache pollution from varying list lengths (03 §2.6).
        emitParenthesized(em, e.e)
        em.push(e.not ? ' <> all(' : ' = any(')
        emitExpr(em, set.array)
        em.push(')')
        return
      }
      emitParenthesized(em, e.e)
      em.push(e.not ? ' not in (' : ' in (')
      em.block(() => emitStatement(em, set.query))
      em.push(')')
      return
    }

    case 'between':
      emitParenthesized(em, e.e)
      em.push(e.not ? ' not between ' : ' between ')
      if (e.symmetric) em.push('symmetric ')
      emitExpr(em, e.lo)
      em.push(' and ')
      emitExpr(em, e.hi)
      return

    case 'fn':
      em.push(`${e.name}(`)
      for (let i = 0; i < e.args.length; i++) {
        if (i > 0) em.push(', ')
        emitExpr(em, e.args[i] as Expr)
      }
      em.push(')')
      return

    case 'agg':
      emitAgg(em, e)
      return

    case 'cast':
      emitParenthesized(em, e.e)
      em.push(`::${e.to}`)
      return

    case 'sq':
      em.push('(')
      em.block(() => emitStatement(em, e.query))
      em.push(')')
      return

    case 'exists':
      em.push(e.not ? 'not exists (' : 'exists (')
      em.block(() => emitSelectBody(em, planSelect(e.query).node))
      em.push(')')
      return

    case 'jsonBuild': {
      em.push(e.variant === 'jsonb' ? 'jsonb_build_object(' : 'json_build_object(')
      for (let i = 0; i < e.entries.length; i++) {
        const entry = e.entries[i] as readonly [string, Expr]
        if (i > 0) em.push(', ')
        // Compiler-generated key from a compile-time object literal, never caller data.
        em.push(quoteStringLiteral(entry[0]))
        em.push(', ')
        emitExpr(em, entry[1])
      }
      em.push(')')
      return
    }

    case 'jsonAgg': {
      const aggName = e.variant === 'jsonb' ? 'jsonb_agg' : 'json_agg'
      const empty = e.variant === 'jsonb' ? "'[]'::jsonb" : "'[]'::json"
      if (e.emptyAs !== undefined) em.push('coalesce(')
      em.push(`${aggName}(`)
      emitExpr(em, e.e)
      if (e.orderBy !== undefined && e.orderBy.length > 0) {
        em.push(' order by ')
        emitOrderItems(em, e.orderBy)
      }
      em.push(')')
      if (e.emptyAs !== undefined) em.push(`, ${empty})`)
      return
    }

    case 'raw':
      emitRaw(em, e)
      return

    default:
      throw new UnsupportedNodeError((e as { k: string }).k, 'expression')
  }
}

function emitAgg(em: Emitter, e: AggNode): void {
  em.push(`${e.name}(`)
  if (e.star === true) {
    em.push('*')
  } else {
    if (e.distinct) em.push('distinct ')
    for (let i = 0; i < e.args.length; i++) {
      if (i > 0) em.push(', ')
      emitExpr(em, e.args[i] as Expr)
    }
  }
  if (e.orderBy !== undefined && e.orderBy.length > 0) {
    em.push(' order by ')
    emitOrderItems(em, e.orderBy)
  }
  em.push(')')
  if (e.filter !== undefined) {
    em.push(' filter (where ')
    emitExpr(em, e.filter)
    em.push(')')
  }
}

/**
 * `chunks` and `parts` interleave. `chunks` are compile-time constants from a
 * `TemplateStringsArray`; every `part` is dispatched here and only two branches can put
 * non-`$n` text into the output.
 */
function emitRaw(em: Emitter, node: RawNode): void {
  em.push(node.chunks[0] as string)
  for (let i = 0; i < node.parts.length; i++) {
    const part = node.parts[i]
    if (part === undefined) continue
    switch (part.k) {
      case 'ident':
        // AUDIT SURFACE 1: pre-quoted + validated at sql.ident() call time (03 §3.4).
        em.push(part.quoted)
        break
      case 'unsafeRaw':
        // AUDIT SURFACE 2: verbatim, by explicit request (03 §3.5).
        em.usedUnsafeRaw = true
        em.push(part.text)
        break
      default:
        emitExpr(em, part)
    }
    em.push(node.chunks[i + 1] as string)
  }
}

// ─────────────────────────── clauses ───────────────────────────

function emitOrderItems(em: Emitter, items: readonly OrderItem[]): void {
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as OrderItem
    if (i > 0) em.push(', ')
    emitExpr(em, it.e)
    em.push(` ${it.dir}`)
    if (it.nulls !== undefined) em.push(` nulls ${it.nulls}`)
  }
}

function emitProjection(em: Emitter, items: readonly ProjectionItem[]): void {
  if (items.length === 0) {
    em.push('*')
    return
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as ProjectionItem
    if (i > 0) em.push(', ')
    emitExpr(em, item.expr)
    // Result aliases are identifiers, so they go through the same fuzzed sanitizer.
    em.push(` as ${quoteIdentPart(item.key)}`)
  }
}

function emitFromItem(em: Emitter, item: FromItem): void {
  switch (item.k) {
    case 'table':
      em.reads.push({ schema: item.table.schema, name: item.table.name })
      em.push(`${item.table.qualified} as ${item.qAlias}`)
      return
    case 'subquery':
      if (item.lateral) em.push('lateral ')
      em.push('(')
      em.block(() => emitStatement(em, item.query))
      em.push(`) as ${item.qAlias}`)
      return
    case 'cteRef':
      em.push(`${quoteIdentPart(item.name)} as ${item.qAlias}`)
      return
    default:
      throw new UnsupportedNodeError(item.k, 'from item')
  }
}

function emitJoin(em: Emitter, j: JoinNode): void {
  em.push(`${j.type} join `)
  emitFromItem(em, j.item)
  if (j.type === 'cross') return
  if (j.on === undefined) {
    // A hoisted lateral projection: ON TRUE.
    em.push(' on true')
  } else {
    em.push(' on ')
    emitExpr(em, j.on)
  }
}

// ─────────────────────────── statements ───────────────────────────

function emitSelectBody(em: Emitter, n: SelectNode): void {
  em.push('select ')
  if (n.distinct !== undefined) {
    em.push('distinct ')
    if (n.distinct.on !== undefined && n.distinct.on.length > 0) {
      em.push('on (')
      for (let i = 0; i < n.distinct.on.length; i++) {
        if (i > 0) em.push(', ')
        emitExpr(em, n.distinct.on[i] as Expr)
      }
      em.push(') ')
    }
  }
  emitProjection(em, n.projection)

  if (n.from !== undefined) {
    em.nl()
    em.push('from ')
    emitFromItem(em, n.from)
  }
  if (n.joins !== undefined) {
    for (const j of n.joins) {
      em.nl()
      emitJoin(em, j)
    }
  }
  if (n.where !== undefined) {
    em.nl()
    em.push('where ')
    emitExpr(em, n.where)
  }
  if (n.groupBy !== undefined && n.groupBy.length > 0) {
    em.nl()
    em.push('group by ')
    for (let i = 0; i < n.groupBy.length; i++) {
      if (i > 0) em.push(', ')
      emitExpr(em, n.groupBy[i] as Expr)
    }
  }
  if (n.having !== undefined) {
    em.nl()
    em.push('having ')
    emitExpr(em, n.having)
  }
  if (n.orderBy !== undefined && n.orderBy.length > 0) {
    em.nl()
    em.push('order by ')
    emitOrderItems(em, n.orderBy)
  }
  if (n.limit !== undefined) {
    em.nl()
    em.push('limit ')
    emitExpr(em, n.limit)
  }
  if (n.offset !== undefined) {
    em.nl()
    em.push('offset ')
    emitExpr(em, n.offset)
  }
  if (n.locking !== undefined) {
    em.nl()
    em.push(`for ${n.locking.strength}`)
    if (n.locking.of !== undefined && n.locking.of.length > 0) {
      em.push(` of ${n.locking.of.map((a) => quoteIdentPart(a)).join(', ')}`)
    }
    if (n.locking.wait !== 'block') em.push(` ${n.locking.wait}`)
  }
}

function emitInsertBody(em: Emitter, n: InsertNode): void {
  em.writes.push({ schema: n.into.table.schema, name: n.into.table.name })
  em.push(`insert into ${n.into.table.qualified} (`)
  for (let i = 0; i < n.columns.length; i++) {
    if (i > 0) em.push(', ')
    em.push((n.columns[i] as { quoted: string }).quoted)
  }
  em.push(')')

  const src = n.source
  switch (src.k) {
    case 'values': {
      em.push(' values ')
      for (let r = 0; r < src.rows.length; r++) {
        if (r > 0) em.push(', ')
        em.push('(')
        const row = src.rows[r] as readonly Expr[]
        for (let c = 0; c < row.length; c++) {
          if (c > 0) em.push(', ')
          emitExpr(em, row[c] as Expr)
          // Casts on the first row only; PostgreSQL infers the rest (03 §2.6).
          if (r === 0 && n.castFirstRow === true) {
            const meta = n.columns[c]
            if (meta !== undefined) em.push(`::${meta.codec.pgType}`)
          }
        }
        em.push(')')
      }
      return
    }
    case 'defaults':
      em.push(' default values')
      return
    case 'select':
      em.nl()
      emitStatement(em, src.query)
      return
    default:
      throw new UnsupportedNodeError(src.k, 'insert source')
  }
}

function emitReturning(em: Emitter, items: readonly ProjectionItem[]): void {
  em.nl()
  em.push('returning ')
  const prev = em.qualifyColumns
  // RETURNING implicitly references the target table, so columns are emitted unqualified.
  em.qualifyColumns = false
  emitProjection(em, items)
  em.qualifyColumns = prev
}

function emitStatement(em: Emitter, n: Statement): void {
  switch (n.k) {
    case 'select':
      // planSelect is a pure AST→AST transform that assigns no parameter numbers, so running
      // it here (for selects reached as subqueries) cannot perturb `$n` ordering.
      emitSelectBody(em, planSelect(n).node)
      return
    case 'insert':
      emitInsertBody(em, n)
      if (n.returning !== undefined) emitReturning(em, n.returning)
      return
    default:
      throw new UnsupportedNodeError(n.k, 'statement')
  }
}

// ─────────────────────────── entry point ───────────────────────────

function shapeOf(fields: readonly FieldPlan[]): ResultShape {
  return fields.length === 0 ? { k: 'void' } : { k: 'row', fields }
}

/**
 * Compile an AST to `{ sql, binds, shape, meta }`. Pure: no database, no I/O, no globals.
 */
export function compile<Row = unknown>(stmt: Statement): Compiled<Row> {
  const em = new Emitter()
  let fields: FieldPlan[]
  let kind: Compiled['meta']['kind']

  switch (stmt.k) {
    case 'select': {
      kind = 'select'
      const planned = planSelect(stmt)
      fields = planned.fields
      emitSelectBody(em, planned.node)
      break
    }
    case 'insert': {
      kind = 'insert'
      emitInsertBody(em, stmt)
      if (stmt.returning !== undefined) {
        const planned = planReturning(stmt.returning)
        fields = planned.fields
        emitReturning(em, planned.items)
      } else {
        fields = []
      }
      break
    }
    default:
      throw new UnsupportedNodeError(stmt.k, 'compile entry point')
  }

  if (em.binds.length > MAX_PARAMS) throw new TooManyParametersError(em.binds.length)

  return Object.freeze({
    sql: em.sql(),
    binds: Object.freeze(em.binds),
    shape: shapeOf(fields),
    meta: Object.freeze({
      kind,
      reads: Object.freeze(em.reads),
      writes: Object.freeze(em.writes),
      placeholders: Object.freeze(em.placeholders),
      usedUnsafeRaw: em.usedUnsafeRaw,
    }),
  }) as Compiled<Row>
}

/** Convenience for tests and `.toSQL()`: compile just an expression, e.g. a `sql` fragment. */
export function compileExpr(e: Expr): { sql: string; binds: readonly Bind[] } {
  const em = new Emitter()
  emitExpr(em, e)
  return { sql: em.sql(), binds: em.binds }
}
