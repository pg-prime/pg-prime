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

import type { AnyCodec } from '../codec/index.js'
import {
  BuilderError,
  InvalidFragmentError,
  TooManyParametersError,
  UnsupportedNodeError,
} from '../sql/errors.js'
import { quoteIdentPart, quoteStringLiteral } from '../sql/ident.js'
import type {
  AggNode,
  CteNode,
  DeleteNode,
  Expr,
  FrameBound,
  FromItem,
  InsertNode,
  JoinNode,
  OnConflictNode,
  OrderItem,
  OverNode,
  ProjectionItem,
  QualifiedName,
  RawNode,
  SelectNode,
  SetItem,
  SetOpNode,
  Statement,
  UpdateNode,
  WindowDef,
} from './ast.js'
import type { Bind, Compiled, FieldOrigin, FieldPlan, ResultShape } from './contract.js'
import { comparesWholeRows, exprDigest, planReturning, planSelect } from './hoist.js'

/** The PostgreSQL wire protocol caps parameters at 65535 (int16). */
const MAX_PARAMS = 65535

/**
 * Memo for `quoteIdentPart` on the one identifier the emitter quotes on the hot path: a
 * projection alias, which is re-validated on every compile of every query that uses it.
 * Validation is four scans plus a `replaceAll` allocation; a schema has a bounded set of column
 * names, so a bounded cache turns that into one `Map.get`.
 *
 * The cap exists because an alias can also be caller-generated (`select … as "sum_${n}"`), and an
 * unbounded module-level cache keyed by caller data is a memory leak. Clearing wholesale is the
 * cheapest eviction there is and costs one re-validation per entry afterwards. Failures are not
 * cached: `quoteIdentPart` throws before anything is written.
 */
const ALIAS_CACHE = new Map<string, string>()
const ALIAS_CACHE_MAX = 4096

function quoteAlias(key: string): string {
  const hit = ALIAS_CACHE.get(key)
  if (hit !== undefined) return hit
  const quoted = quoteIdentPart(key)
  if (ALIAS_CACHE.size >= ALIAS_CACHE_MAX) ALIAS_CACHE.clear()
  ALIAS_CACHE.set(key, quoted)
  return quoted
}

/**
 * `'\n'` plus `n` spaces, built once per depth.
 *
 * A statement of design/03 §1.1's size emits ~40 newlines, and `` `\n${' '.repeat(n)}` `` was two
 * string allocations for each of them, for text that has at most a handful of distinct values.
 * Measured (design/09 §3.7 follow-up): **408 B per compile**, 1.3 % of the total and 4.3 % of the
 * emitter's own allocation, with the emitter's p50 unchanged at 4.06 µs — a small win, kept
 * because it is a table lookup and not because it was decisive. The table is capped so that a
 * pathologically nested query grows the *chunk* list, which it was going to grow anyway, rather
 * than this array.
 */
const NEWLINES: string[] = ['\n']
const MAX_CACHED_INDENT = 64

function newlineAt(indent: number): string {
  if (indent > MAX_CACHED_INDENT) return `\n${' '.repeat(indent)}`
  let s = NEWLINES[indent]
  if (s === undefined) {
    s = `\n${' '.repeat(indent)}`
    NEWLINES[indent] = s
  }
  return s
}

class Emitter {
  readonly chunks: string[] = []
  readonly binds: Bind[] = []
  readonly reads: QualifiedName[] = []
  readonly writes: QualifiedName[] = []
  readonly placeholders: string[] = []
  usedUnsafeRaw = false
  /**
   * The alias whose columns are emitted *unqualified*, or `undefined` for "qualify everything".
   *
   * Set only for an INSERT/UPDATE/DELETE RETURNING list, which references the statement's target
   * table implicitly. It is an alias rather than a flag because `update … from (values …) as "v"`
   * has other items in scope: unqualifying `"v"."price"` there produces `42702 ambiguous column`
   * whenever the target has a column of the same name — which, for a bulk update-by-key, it
   * always does.
   */
  unqualified: string | undefined = undefined
  private indent = 0

  push(s: string): void {
    this.chunks.push(s)
  }

  /** Newline + current indentation. */
  nl(): void {
    this.chunks.push(newlineAt(this.indent))
  }

  block(f: () => void): void {
    this.indent += 2
    this.nl()
    f()
    this.indent -= 2
    this.nl()
  }

  /**
   * The ONLY way a caller-supplied value reaches the output.
   *
   * `null` is short-circuited here rather than in each codec, exactly as the registry
   * short-circuits it on the way back (`Registry.planFor`). Both halves of the seam then get to
   * declare non-nullable signatures — `encode(v: TIn)`, `decodeText(raw: string)` — and there is
   * one place, not fifty, that knows SQL NULL is not a value of any type.
   *
   * Found in WS3: without this, `isDistinctFrom(x, null)` and every nullable insert value threw
   * `PgEncodeError` from whichever codec happened to be attached, because `Codec.encode`'s
   * contract lists `null` as a legal *return* and no built-in accepts it as an argument.
   * The declared parameter type is still the codec's, so PostgreSQL sees a typed NULL.
   */
  bindValue(value: unknown, codec: AnyCodec): void {
    const encoded = value === null ? null : codec.encode(value as never)
    this.binds.push({ k: 'value', encoded, oid: codec.paramOid })
    this.chunks.push(`$${this.binds.length}`)
  }

  bindSlot(name: string, codec: AnyCodec): void {
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
  // `un` is here for the *operand* positions only — `bool` parenthesises with `isOpaque`, so
  // `not a and b` stays as written (`not` binds tighter than `and`/`or`). Everywhere else a
  // bare unary changes the parse: `not a = b` is `not (a = b)` to PostgreSQL, and `-a::text`
  // is `-(a::text)`. Confirmed against PG 17.
  return (
    e.k === 'bin' ||
    e.k === 'is' ||
    e.k === 'in' ||
    e.k === 'between' ||
    e.k === 'un' ||
    isOpaque(e)
  )
}

/**
 * A negative numeric literal, which *fuses with a preceding operator character*.
 *
 * `un('-', lit(-1))` would emit `--1` — a line comment, so the rest of the statement is
 * silently dropped — and `cast(lit(-2147483648), 'int4')` would emit `-2147483648::int4`,
 * which PostgreSQL parses as `-(2147483648::int4)` and rejects with 22003. Wrapping the literal
 * is the only fix that keeps the value intact.
 */
function isNegativeLit(e: Expr): boolean {
  return (
    e.k === 'lit' &&
    (typeof e.value === 'number' || typeof e.value === 'bigint') &&
    e.value < 0
  )
}

/**
 * An operand that is glued to a preceding operator character: the operand of a symbolic prefix
 * operator (`-x`, `+x`, `~x`) and the operand of a `::` cast.
 */
function emitGluedOperand(em: Emitter, e: Expr): void {
  if (isNegativeLit(e)) {
    em.push('(')
    emitExpr(em, e)
    em.push(')')
    return
  }
  emitParenthesized(em, e)
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

/**
 * ── The option-string whitelist (03 §1.1(5)) ─────────────────────────────────────────────────
 *
 * `emitIdentPart`, `emitUnsafeRaw` and `quoteStringLiteral` are supposed to be the *whole* audit
 * surface, but an AST option slot is a string too: `` locking: { strength: evil } `` would have
 * been concatenated into `for <evil>` verbatim. These switches make every option position emit a
 * **compile-time constant**, so a value that is not one of the documented options cannot reach
 * the output at all — it throws. The builder validates the same options a layer earlier; this is
 * the layer that makes the guarantee structural.
 */
function orderDir(v: OrderItem['dir']): string {
  switch (v) {
    case 'asc':
      return ' asc'
    case 'desc':
      return ' desc'
    default:
      throw new UnsupportedNodeError('order.dir', `expected 'asc' or 'desc', got ${show(v)}`)
  }
}

function nullsKeyword(v: OrderItem['nulls']): string {
  switch (v) {
    case 'first':
      return ' nulls first'
    case 'last':
      return ' nulls last'
    default:
      throw new UnsupportedNodeError('order.nulls', `expected 'first' or 'last', got ${show(v)}`)
  }
}

function lockStrength(v: string): string {
  switch (v) {
    case 'update':
      return 'for update'
    case 'no key update':
      return 'for no key update'
    case 'share':
      return 'for share'
    case 'key share':
      return 'for key share'
    default:
      throw new UnsupportedNodeError('locking.strength', `not a lock strength: ${show(v)}`)
  }
}

function lockWait(v: string): string {
  switch (v) {
    case 'block':
      return ''
    case 'nowait':
      return ' nowait'
    case 'skip locked':
      return ' skip locked'
    default:
      throw new UnsupportedNodeError('locking.wait', `not a lock wait mode: ${show(v)}`)
  }
}

function frameMode(v: string): string {
  switch (v) {
    case 'rows':
      return 'rows '
    case 'range':
      return 'range '
    case 'groups':
      return 'groups '
    default:
      throw new UnsupportedNodeError('frame.mode', `not a frame mode: ${show(v)}`)
  }
}

function frameExclude(v: string): string {
  switch (v) {
    case 'current row':
      return ' exclude current row'
    case 'group':
      return ' exclude group'
    case 'ties':
      return ' exclude ties'
    case 'no others':
      return ' exclude no others'
    default:
      throw new UnsupportedNodeError('frame.exclude', `not a frame exclusion: ${show(v)}`)
  }
}

function frameBoundKeyword(k: string): string {
  switch (k) {
    case 'unbounded preceding':
      return 'unbounded preceding'
    case 'current row':
      return 'current row'
    case 'unbounded following':
      return 'unbounded following'
    case 'preceding':
      return ' preceding'
    case 'following':
      return ' following'
    default:
      throw new UnsupportedNodeError('frame.bound', `not a frame bound: ${show(k)}`)
  }
}

/** Quote an offending option for an error message. It never reaches the SQL. */
function show(v: unknown): string {
  return typeof v === 'string' ? JSON.stringify(v) : String(v)
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
      em.push(e.alias === em.unqualified ? e.qn : e.q)
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
        emitGluedOperand(em, e.e)
      }
      return

    case 'is':
      emitParenthesized(em, e.e)
      em.push(` is ${e.test}`)
      if (e.r !== undefined) {
        em.push(' ')
        // `is distinct from` binds looser than every operator, so an opaque fragment here
        // (`sql`b or true``) would swallow the comparison: `a is distinct from b or true`
        // evaluates as `(a is distinct from b) or true`. The docblock on `isOpaque` promises
        // "every operand position"; this is one of them.
        emitParenthesized(em, e.r)
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
          // A list item is comma-delimited, but an opaque fragment can itself contain a comma
          // (`sql`a, b``) and would turn one item into two.
          emitParenthesized(em, set.items[i] as Expr)
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
      // `and` inside a BETWEEN is the clause's own separator, so an opaque `lo` containing one
      // (`sql`a and b``) re-parses the whole clause.
      emitParenthesized(em, e.lo)
      em.push(' and ')
      emitParenthesized(em, e.hi)
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

    case 'over':
      emitOver(em, e)
      return

    case 'cast':
      emitGluedOperand(em, e.e)
      em.push(`::${e.to}`)
      return

    // `case` / `row` / `array` were understood by `codecOf`, the CSE digest and the rewriter but
    // rejected here, so a tree containing one planned fine and then failed at emission. All three
    // are self-delimiting (`… end`, `(…)`, `[…]`), so none of them needs parentheses anywhere.
    case 'case': {
      if (e.whens.length === 0) {
        throw new UnsupportedNodeError('case', 'a CASE expression needs at least one WHEN branch')
      }
      em.push('case')
      if (e.operand !== undefined) {
        em.push(' ')
        emitExpr(em, e.operand)
      }
      for (const w of e.whens) {
        em.push(' when ')
        emitExpr(em, w.when)
        em.push(' then ')
        emitExpr(em, w.then)
      }
      if (e.else !== undefined) {
        em.push(' else ')
        emitExpr(em, e.else)
      }
      em.push(' end')
      return
    }

    case 'row': {
      em.push('row(')
      for (let i = 0; i < e.items.length; i++) {
        if (i > 0) em.push(', ')
        emitExpr(em, e.items[i] as Expr)
      }
      em.push(')')
      return
    }

    case 'array': {
      em.push('array[')
      for (let i = 0; i < e.items.length; i++) {
        if (i > 0) em.push(', ')
        emitExpr(em, e.items[i] as Expr)
      }
      em.push(']')
      // An empty `array[]` has no element type, and PostgreSQL says so (42P18). The cast is not
      // decoration: `array[]::int4[]` is the only spelling that parses.
      if (e.items.length === 0) em.push(`::${e.elemCodec.sqlName}[]`)
      return
    }

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
 * `fn(...) over (...)` or `fn(...) over "name"`.
 *
 * The inline and the named form are the same node with a different `window`; PostgreSQL treats
 * them identically, and `03` §2.8 offers both because a window repeated across four projection
 * items should be written once.
 */
function emitOver(em: Emitter, e: OverNode): void {
  emitExpr(em, e.fn)
  em.push(' over ')
  if ('ref' in e.window) {
    em.push(quoteIdentPart(e.window.ref))
    return
  }
  emitWindowDef(em, e.window)
}

function emitWindowDef(em: Emitter, w: WindowDef): void {
  em.push('(')
  let first = true
  const sep = (): void => {
    if (!first) em.push(' ')
    first = false
  }
  if (w.partitionBy !== undefined && w.partitionBy.length > 0) {
    sep()
    em.push('partition by ')
    for (let i = 0; i < w.partitionBy.length; i++) {
      if (i > 0) em.push(', ')
      emitExpr(em, w.partitionBy[i] as Expr)
    }
  }
  if (w.orderBy !== undefined && w.orderBy.length > 0) {
    sep()
    em.push('order by ')
    emitOrderItems(em, w.orderBy)
  }
  if (w.frame !== undefined) {
    sep()
    em.push(frameMode(w.frame.mode))
    if (w.frame.end !== undefined) {
      em.push('between ')
      emitFrameBound(em, w.frame.start)
      em.push(' and ')
      emitFrameBound(em, w.frame.end)
    } else {
      emitFrameBound(em, w.frame.start)
    }
    if (w.frame.exclude !== undefined) em.push(frameExclude(w.frame.exclude))
  }
  em.push(')')
}

function emitFrameBound(em: Emitter, b: FrameBound): void {
  if (b.k === 'preceding' || b.k === 'following') {
    emitExpr(em, b.n)
    em.push(frameBoundKeyword(b.k))
    return
  }
  em.push(frameBoundKeyword(b.k))
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
    if (part === undefined) {
      // A sparse or short `parts` array can only come from a hand-built node (`raw()` copies and
      // checks the interleave invariant). Skipping it silently dropped the *following* chunk
      // too, i.e. deleted a piece of the caller's SQL.
      throw new InvalidFragmentError(
        `sql fragment: part ${i} of ${node.parts.length} is missing; chunks and parts must ` +
          'interleave exactly.',
      )
    }
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
    em.push(orderDir(it.dir))
    if (it.nulls !== undefined) em.push(nullsKeyword(it.nulls))
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
    em.push(` as ${quoteAlias(item.key)}`)
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
    case 'values': {
      // `(values ($1::int8, $2::numeric), ($3, $4)) as "v"("id", "price")` — casts on the first
      // row only, exactly as a bulk INSERT does (03 §2.6): PostgreSQL infers the rest from row 1,
      // and without them a `values` join source is `text` and every comparison is a 42883.
      em.push('(values ')
      for (let r = 0; r < item.rows.length; r++) {
        if (r > 0) em.push(', ')
        em.push('(')
        const row = item.rows[r] as readonly Expr[]
        for (let c = 0; c < row.length; c++) {
          if (c > 0) em.push(', ')
          emitExpr(em, row[c] as Expr)
          const cast = r === 0 ? item.casts[c] : null
          if (cast !== null && cast !== undefined) em.push(`::${cast}`)
        }
        em.push(')')
      }
      em.push(`) as ${item.qAlias}(`)
      em.push(item.columns.map((c) => quoteIdentPart(c)).join(', '))
      em.push(')')
      return
    }
    case 'func': {
      if (item.lateral) em.push('lateral ')
      em.push(`${item.fn}(`)
      for (let i = 0; i < item.args.length; i++) {
        if (i > 0) em.push(', ')
        emitExpr(em, item.args[i] as Expr)
      }
      em.push(')')
      if (item.ordinality) em.push(' with ordinality')
      em.push(` as ${item.qAlias}`)
      if (item.columns !== undefined && item.columns.length > 0) {
        em.push(`(${item.columns.map((c) => quoteIdentPart(c)).join(', ')})`)
      }
      return
    }
    default:
      throw new UnsupportedNodeError((item as { k: string }).k, 'from item')
  }
}

function emitJoin(em: Emitter, j: JoinNode): void {
  em.push(`${j.type} join `)
  emitFromItem(em, j.item)
  if (j.type === 'cross') {
    // Dropping the predicate would turn a filtered join into a full cartesian product — the one
    // silent mistake in this file that multiplies rows instead of losing them.
    if (j.on !== undefined) {
      throw new UnsupportedNodeError(
        'join',
        'a cross join takes no ON clause; use an inner join for a predicate',
      )
    }
    return
  }
  if (j.on === undefined) {
    // A hoisted lateral projection: ON TRUE.
    em.push(' on true')
  } else {
    em.push(' on ')
    emitExpr(em, j.on)
  }
}

// ─────────────────────────── statements ───────────────────────────

/**
 * `with [recursive] "a" as [materialized] (…), "b" as (…)`.
 *
 * Emitted first, so a CTE's parameters get the LOWEST `$n` — which is what makes `$n` numbering a
 * single left-to-right textual pass (03 §1.1) even though the CTE is logically evaluated first.
 *
 * `recursive` is a property of the WITH clause, not of one CTE: PostgreSQL takes the keyword once
 * and applies it to the whole list, so one recursive member marks the clause.
 */
function emitWith(em: Emitter, ctes: readonly CteNode[]): void {
  if (ctes.length === 0) return
  em.push(ctes.some((c) => c.recursive) ? 'with recursive ' : 'with ')
  for (let i = 0; i < ctes.length; i++) {
    const cte = ctes[i] as CteNode
    if (i > 0) em.push(', ')
    em.push(quoteIdentPart(cte.name))
    if (cte.columns !== undefined && cte.columns.length > 0) {
      em.push(`(${cte.columns.map((c) => quoteIdentPart(c)).join(', ')})`)
    }
    em.push(' as ')
    // A PG-only planner lever no other TS builder exposes ergonomically (03 §2.7): `materialized`
    // forces an optimization fence, `not materialized` forbids one. Absent = the planner decides.
    if (cte.materialized === true) em.push('materialized ')
    else if (cte.materialized === false) em.push('not materialized ')
    em.push('(')
    em.block(() => emitStatement(em, cte.query))
    em.push(')')
  }
  em.nl()
}

/**
 * A SELECT always qualifies its column references, even one nested inside a clause that does not.
 *
 * `emitReturning` turns qualification off, because RETURNING's columns implicitly belong to the
 * statement's target. A correlated subquery *inside* that RETURNING list has its own FROM clause,
 * so the same rule there is not a style choice but a wrong answer: found in WS5, where a
 * `posts.comments.count()` in a RETURNING list emitted
 * `where "post_id" = "id"` — two columns of `comments`, silently comparing a row to itself —
 * instead of `where "comments"."post_id" = "posts"."id"`.
 */
function emitSelectBody(em: Emitter, n: SelectNode): void {
  const prev = em.unqualified
  em.unqualified = undefined
  try {
    emitSelectBodyIn(em, n)
  } finally {
    em.unqualified = prev
  }
}

/**
 * One line of the offending expression, for a D9 sentence: its own SQL, whitespace collapsed and
 * clipped. The emitter is the right renderer because it is the text the caller will see in the
 * statement — a paraphrase would be a second spelling of the same expression to keep in step.
 */
function describeExpr(e: Expr): string {
  let text: string
  try {
    const em = new Emitter()
    emitExpr(em, e)
    text = em.sql().replace(/\s+/g, ' ').trim()
  } catch {
    return `a ${e.k} expression`
  }
  return text.length > 64 ? `${text.slice(0, 63)}…` : text
}

/**
 * `select distinct` requires every `ORDER BY` expression to appear in the select list
 * (`42P10 for SELECT DISTINCT, ORDER BY expressions must appear in select list`), and the builder
 * has both lists in hand — found by the WS7 builder fuzzer at seed 2310382765.
 *
 * It **refuses** rather than reconciling, which is the opposite of the `DISTINCT ON` rule two
 * clauses above, and deliberately: widening the projection to satisfy the ordering would change
 * the row shape the caller declared, and — because `distinct` is a *set* operation — would also
 * change which rows come back. There is no repair that is not a different query, so the answer is
 * a sentence at compile time instead of a `42P10` at execute time.
 *
 * Both lists are post-`planSelect`, so a `nest({...})` has already expanded into its leaf columns
 * and a shared relation aggregate is the same `"_r0"."v"` reference on both sides.
 *
 * An expression the digest cannot describe (a `sql` fragment, a volatile function) is **allowed
 * through**: `null` means unknown, and a false rejection here would refuse a query PostgreSQL
 * accepts. The permissive direction is the same one `03` §2.3's GROUP BY guard chose.
 */
function checkDistinctOrder(
  projection: readonly ProjectionItem[],
  orderBy: readonly OrderItem[],
): void {
  const selected = new Set<string>()
  for (const item of projection) {
    const d = exprDigest(item.expr)
    if (d !== null) selected.add(d)
  }
  for (const o of orderBy) {
    const d = exprDigest(o.e)
    if (d === null || selected.has(d)) continue
    throw new BuilderError(
      `pg-prime: .distinct() cannot order by ${describeExpr(o.e)} — PostgreSQL requires every ` +
        'ORDER BY expression of a SELECT DISTINCT to appear in the select list (42P10). Order by ' +
        'a selected column, or add it to select().',
    )
  }
}

function emitSelectBodyIn(em: Emitter, n: SelectNode): void {
  if (n.with !== undefined) emitWith(em, n.with)
  // Guarded so the digest pass costs nothing on the hot path: only a `select distinct` (not
  // `distinct on`, whose rule is the initial-match one `planSelect` already satisfied) that also
  // carries an ORDER BY can be wrong this way, and that is a rounding error of all compiles.
  if (n.orderBy !== undefined && n.orderBy.length > 0 && comparesWholeRows(n)) {
    checkDistinctOrder(n.projection, n.orderBy)
  }
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
  if (n.windows !== undefined && n.windows.length > 0) {
    em.nl()
    em.push('window ')
    for (let i = 0; i < n.windows.length; i++) {
      const w = n.windows[i] as { name: string; def: WindowDef }
      if (i > 0) em.push(', ')
      em.push(`${quoteIdentPart(w.name)} as `)
      emitWindowDef(em, w.def)
    }
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
    em.push(lockStrength(n.locking.strength))
    if (n.locking.of !== undefined && n.locking.of.length > 0) {
      em.push(` of ${n.locking.of.map((a) => quoteIdentPart(a)).join(', ')}`)
    }
    em.push(lockWait(n.locking.wait))
  }
}

function emitInsertBody(em: Emitter, n: InsertNode): void {
  if (n.with !== undefined) emitWith(em, n.with)
  em.writes.push({ schema: n.into.table.schema, name: n.into.table.name })
  em.push(`insert into ${n.into.table.qualified}`)
  // Only when it differs: `insert into "public"."users" (...)` is the 03 §2.5 golden, and an
  // alias that repeats the table name would break it for no gain.
  if (n.into.alias !== n.into.table.name) em.push(` as ${n.into.qAlias}`)
  em.push(' (')
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
            if (meta !== undefined) em.push(`::${meta.codec.sqlName}`)
          }
        }
        em.push(')')
      }
      return
    }
    case 'unnest': {
      // ONE parameter per column regardless of row count (03 §2.6) — the PG-only trick that
      // sidesteps the 65535-param ceiling and collapses the parse cost of a huge batch.
      em.nl()
      em.push('select * from unnest(')
      for (let i = 0; i < src.arrays.length; i++) {
        if (i > 0) em.push(', ')
        emitExpr(em, src.arrays[i] as Expr)
      }
      em.push(')')
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
      throw new UnsupportedNodeError((src as { k: string }).k, 'insert source')
  }
}

/**
 * `on conflict <target> do nothing | do update set … where …` (03 §2.5).
 *
 * The `where` on the *target* is the partial-index predicate — it selects which unique index the
 * arbiter is, and without it an upsert against a partial index raises 42P10. The `where` on the
 * *action* is `DO UPDATE … WHERE`, which decides per row whether to write at all. Two different
 * clauses that both spell `where`; conflating them is the classic upsert bug.
 */
function emitOnConflict(em: Emitter, n: OnConflictNode): void {
  em.nl()
  em.push('on conflict')
  const t = n.target
  if (t !== undefined) {
    if (t.k === 'constraint') {
      em.push(` on constraint ${quoteIdentPart(t.name)}`)
    } else if (t.k === 'columns') {
      em.push(' (')
      em.push(t.columns.map((c) => c.quoted).join(', '))
      em.push(')')
      if (t.where !== undefined) {
        em.push(' where ')
        emitExpr(em, t.where)
      }
    } else {
      em.push(' (')
      for (let i = 0; i < t.exprs.length; i++) {
        if (i > 0) em.push(', ')
        emitExpr(em, t.exprs[i] as Expr)
      }
      em.push(')')
      if (t.where !== undefined) {
        em.push(' where ')
        emitExpr(em, t.where)
      }
    }
  }
  em.nl()
  if (n.action.k === 'nothing') {
    em.push('do nothing')
    return
  }
  em.push('do update set ')
  emitSetItems(em, n.action.set)
  if (n.action.where !== undefined) {
    em.nl()
    em.push('where ')
    emitExpr(em, n.action.where)
  }
}

/**
 * `"price" = "v"."price", "updated_at" = now()`.
 *
 * The **target** is always unqualified — `set "users"."name" = …` is a syntax error in PostgreSQL,
 * because the target of a SET is a column of the statement's one target table by definition. The
 * **value** is qualified, because it may name `excluded`, a FROM item, or the target row itself.
 */
function emitSetItems(em: Emitter, items: readonly SetItem[]): void {
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as SetItem
    if (i > 0) em.push(', ')
    em.push(`${it.column.quoted} = `)
    emitExpr(em, it.value)
  }
}

function emitUpdateBody(em: Emitter, n: UpdateNode): void {
  if (n.with !== undefined) emitWith(em, n.with)
  em.writes.push({ schema: n.target.table.schema, name: n.target.table.name })
  em.push(`update ${n.target.table.qualified} as ${n.target.qAlias}`)
  em.nl()
  em.push('set ')
  emitSetItems(em, n.set)
  if (n.from !== undefined && n.from.length > 0) {
    em.nl()
    em.push('from ')
    for (let i = 0; i < n.from.length; i++) {
      if (i > 0) em.push(', ')
      emitFromItem(em, n.from[i] as FromItem)
    }
  }
  if (n.where !== undefined) {
    em.nl()
    em.push('where ')
    emitExpr(em, n.where)
  }
}

function emitDeleteBody(em: Emitter, n: DeleteNode): void {
  if (n.with !== undefined) emitWith(em, n.with)
  em.writes.push({ schema: n.from.table.schema, name: n.from.table.name })
  em.push(`delete from ${n.from.table.qualified} as ${n.from.qAlias}`)
  if (n.using !== undefined && n.using.length > 0) {
    em.nl()
    em.push('using ')
    for (let i = 0; i < n.using.length; i++) {
      if (i > 0) em.push(', ')
      emitFromItem(em, n.using[i] as FromItem)
    }
  }
  if (n.where !== undefined) {
    em.nl()
    em.push('where ')
    emitExpr(em, n.where)
  }
}

/**
 * `a union all b`, with `order by` / `limit` / `offset` applying to the WHOLE result.
 *
 * A branch is parenthesized exactly when it carries clauses PostgreSQL would otherwise bind to the
 * set operation instead: its own `order by`/`limit`/`offset`, or a nested set operation whose
 * precedence differs (`intersect` binds tighter than `union`). The common case — two plain selects
 * — emits no parentheses at all, which is what a hand-written query looks like.
 */
function branchNeedsParens(n: SelectNode | SetOpNode): boolean {
  if (n.k === 'setop') return true
  return (
    // `… union with "c" as (…) select …` is 42601: WITH may only start a *parenthesised*
    // branch. PostgreSQL accepts `(with x as (…) select …) union …`.
    (n.with !== undefined && n.with.length > 0) ||
    (n.orderBy !== undefined && n.orderBy.length > 0) ||
    n.limit !== undefined ||
    n.offset !== undefined ||
    n.locking !== undefined
  )
}

/**
 * `union` / `intersect` / `except` deduplicate, and deduplicating means comparing whole rows;
 * their `… all` spellings do not. This is the flag `planSelect(node, rowEquality)` needs, and it
 * **inherits downwards**: the branches of `a union all b` are compared when that union is itself
 * a branch of an `except`, so the rows `a` produces have to be comparable too.
 */
function isDistinctOp(op: SetOpNode['op']): boolean {
  return !op.endsWith(' all')
}

function emitSetOpBranch(em: Emitter, n: SelectNode | SetOpNode, rowEquality: boolean): void {
  if (branchNeedsParens(n)) {
    em.push('(')
    em.block(() => emitStatement(em, n, rowEquality))
    em.push(')')
    return
  }
  emitStatement(em, n, rowEquality)
}

function emitSetOpBody(em: Emitter, n: SetOpNode, rowEquality = false): void {
  const eq = rowEquality || isDistinctOp(n.op)
  emitSetOpBranch(em, n.left, eq)
  em.nl()
  em.push(n.op)
  em.nl()
  emitSetOpBranch(em, n.right, eq)
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
}

/**
 * `target` is the alias whose columns may drop their prefix, or `undefined` for "qualify
 * everything".
 *
 * `undefined` is what an `UPDATE … FROM` / `DELETE … USING` gets, and it is not a style choice:
 * PostgreSQL resolves a bare RETURNING column against the target **and** every FROM item, so with
 * `from (values …) as "v"("id", "price")` a bare `id` is 42702 even though it is the target's own
 * column. Qualifying is always legal there; unqualifying is legal only when nothing else is in
 * scope, which is also the case the 03 §2.5 goldens pin.
 */
function emitReturning(
  em: Emitter,
  items: readonly ProjectionItem[],
  target: string | undefined,
): void {
  em.nl()
  em.push('returning ')
  const prev = em.unqualified
  em.unqualified = target
  emitProjection(em, items)
  em.unqualified = prev
}

/** The RETURNING scope of an UPDATE: `undefined` as soon as a FROM item shares it. */
function updateReturningScope(n: UpdateNode): string | undefined {
  return n.from !== undefined && n.from.length > 0 ? undefined : n.target.alias
}

/** Same for a DELETE and its USING list. */
function deleteReturningScope(n: DeleteNode): string | undefined {
  return n.using !== undefined && n.using.length > 0 ? undefined : n.from.alias
}

function emitStatement(em: Emitter, n: Statement, rowEquality = false): void {
  switch (n.k) {
    case 'select':
      // planSelect is a pure AST→AST transform that assigns no parameter numbers, so running
      // it here (for selects reached as subqueries) cannot perturb `$n` ordering.
      emitSelectBody(em, planSelect(n, rowEquality).node)
      return
    case 'insert':
      emitInsertBody(em, n)
      if (n.onConflict !== undefined) emitOnConflict(em, n.onConflict)
      if (n.returning !== undefined) {
        emitReturning(em, planReturning(n.returning).items, n.into.alias)
      }
      return
    case 'update':
      emitUpdateBody(em, n)
      if (n.returning !== undefined) {
        emitReturning(em, planReturning(n.returning).items, updateReturningScope(n))
      }
      return
    case 'delete':
      emitDeleteBody(em, n)
      if (n.returning !== undefined) {
        emitReturning(em, planReturning(n.returning).items, deleteReturningScope(n))
      }
      return
    case 'setop':
      emitSetOpBody(em, n, rowEquality)
      return
    default:
      throw new UnsupportedNodeError((n as { k: string }).k, 'statement')
  }
}

// ─────────────────────────── entry point ───────────────────────────

function shapeOf(fields: readonly FieldPlan[]): ResultShape {
  return fields.length === 0 ? { k: 'void' } : { k: 'row', fields }
}

/** RETURNING at the top level, where the decode plan is kept rather than discarded. */
function emitTopReturning(
  em: Emitter,
  returning: readonly ProjectionItem[] | undefined,
  target: string | undefined,
): { fields: FieldPlan[]; origins: (FieldOrigin | undefined)[] } {
  if (returning === undefined) return { fields: [], origins: [] }
  const planned = planReturning(returning)
  emitReturning(em, planned.items, target)
  return { fields: planned.fields, origins: planned.origins }
}

/**
 * The branch whose column names and types PostgreSQL takes for the whole set operation, **and
 * whether anything on the way down to it compares rows**.
 *
 * The second half matters because the decode plan has to be the one the emitter will produce:
 * planning the leftmost branch with a different `rowEquality` than {@link emitSetOpBody} passes it
 * would plan the same node twice and — the day a variant ever reaches a `FieldPlan` — describe a
 * statement that was not emitted.
 */
function leftmost(n: SetOpNode): { node: SelectNode; rowEquality: boolean } {
  let cur: SelectNode | SetOpNode = n
  let rowEquality = false
  while (cur.k === 'setop') {
    rowEquality ||= isDistinctOp(cur.op)
    cur = cur.left
  }
  return { node: cur, rowEquality }
}

/**
 * Compile an AST to `{ sql, binds, shape, meta }`. Pure: no database, no I/O, no globals.
 */
export function compile<Row = unknown>(stmt: Statement): Compiled<Row> {
  const em = new Emitter()
  let fields: FieldPlan[]
  let origins: (FieldOrigin | undefined)[]
  let kind: Compiled['meta']['kind']

  switch (stmt.k) {
    case 'select': {
      kind = 'select'
      const planned = planSelect(stmt)
      fields = planned.fields
      origins = planned.origins
      emitSelectBody(em, planned.node)
      break
    }
    case 'insert': {
      kind = 'insert'
      emitInsertBody(em, stmt)
      if (stmt.onConflict !== undefined) emitOnConflict(em, stmt.onConflict)
      ;({ fields, origins } = emitTopReturning(em, stmt.returning, stmt.into.alias))
      break
    }
    case 'update': {
      kind = 'update'
      emitUpdateBody(em, stmt)
      ;({ fields, origins } = emitTopReturning(em, stmt.returning, updateReturningScope(stmt)))
      break
    }
    case 'delete': {
      kind = 'delete'
      emitDeleteBody(em, stmt)
      ;({ fields, origins } = emitTopReturning(em, stmt.returning, deleteReturningScope(stmt)))
      break
    }
    case 'setop': {
      kind = 'setop'
      // The result shape of a set operation is the LEFT-most branch's: PostgreSQL takes the
      // column names and types from there and requires every other branch to be union-compatible,
      // which `SetMismatch` in `src/query/types.ts` checks at compile time.
      {
        const lm = leftmost(stmt)
        const planned = planSelect(lm.node, lm.rowEquality)
        fields = planned.fields
        origins = planned.origins
      }
      emitSetOpBody(em, stmt)
      break
    }
    default:
      throw new UnsupportedNodeError((stmt as { k: string }).k, 'compile entry point')
  }

  if (em.binds.length > MAX_PARAMS) throw new TooManyParametersError(em.binds.length, kind)

  return Object.freeze({
    sql: em.sql(),
    binds: Object.freeze(em.binds),
    shape: shapeOf(fields),
    origins: Object.freeze(origins),
    meta: Object.freeze({
      kind,
      reads: Object.freeze(em.reads),
      writes: Object.freeze(em.writes),
      placeholders: Object.freeze(em.placeholders),
      usedUnsafeRaw: em.usedUnsafeRaw,
    }),
  }) as Compiled<Row>
}

/**
 * Convenience for tests and `db.sql\`…\``: compile just an expression, e.g. a `sql` fragment.
 *
 * `placeholders` / `usedUnsafeRaw` come out too, because the raw-SQL surface (`./raw.ts`) has to
 * report the same `meta` a compiled statement does and inventing `usedUnsafeRaw: false` there
 * would quietly break the lint rule and the audit that read it.
 */
export function compileExpr(e: Expr): {
  sql: string
  binds: readonly Bind[]
  placeholders: readonly string[]
  usedUnsafeRaw: boolean
} {
  const em = new Emitter()
  emitExpr(em, e)
  return {
    sql: em.sql(),
    binds: em.binds,
    placeholders: Object.freeze(em.placeholders),
    usedUnsafeRaw: em.usedUnsafeRaw,
  }
}
