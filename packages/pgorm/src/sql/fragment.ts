/**
 * The `sql` tagged template (03 §3).
 *
 * Four primitives, three safe and one loudly named:
 *
 * | Primitive              | Position   | Safety                                          |
 * |------------------------|------------|-------------------------------------------------|
 * | `` sql`…${value}…` ``  | value      | **Always parameterized.** Never interpolated.   |
 * | `sql.ident(...parts)`  | identifier | Sanitized + always quoted (`ident.ts`).         |
 * | `sql.lit(v)`           | literal    | **Non-strings only.**                           |
 * | `sql.unsafeRaw(text)`  | anything   | Interpolates verbatim. Greppable and lintable.  |
 *
 * ## Fragment representation: a handle plus a WeakMap
 *
 * A `Fragment` is an opaque frozen handle whose only own property is `.as()`. The AST it
 * stands for lives in a module-private `WeakMap` keyed by the handle. Three consequences,
 * all of them the point:
 *
 * 1. **A fragment cannot be forged from data.** `JSON.parse(body)` can produce an object
 *    that looks exactly like a fragment, but it cannot produce an object that is already a
 *    key in this WeakMap. So the tag's "SQL or data?" decision is nominal, and untrusted
 *    input is *always* data, i.e. always `$n`.
 * 2. **Fragments carry no positional state**, so they are reusable across queries and across
 *    positions within one query — `$n` numbering is assigned once, by the compiler, in a
 *    single left-to-right pass. (MikroORM v6's single-use fragments were a known wart; v7
 *    fixed it with exactly this WeakMap shape — research/mikroorm.md §ADAPT.)
 * 3. **Fragments are garbage-collectable**, because the WeakMap holds no strong reference.
 *
 * ## R3: the tag takes no type parameter
 *
 * `SqlTag`'s call signature declares zero type parameters, so `` sql<number>`…` `` fails
 * with "Expected 0 type arguments, but got 1". Result typing requires `.as(codec)`, which
 * supplies both the TypeScript type and the decoder. Drizzle documents that its `sql<T>`
 * "cannot perform any type casts based on the provided type generic"; since we own decoding,
 * a cast here would be not merely unsafe but unnecessary.
 */

import type { Expr, IdentPart, RawNode, RawPart, RawSpliceNode } from '../compile/ast.js'
import { isAstNode, mkNode, param, raw, lit as litNode } from '../compile/nodes.js'
import type { Codec } from './codec.js'
import { InvalidFragmentError, UnsafeLiteralError } from './errors.js'
import { quoteIdentPath } from './ident.js'

/**
 * An opaque, reusable piece of SQL. `T` is the decoded type, and is `unknown` until a codec
 * is attached with `.as()`.
 */
export interface Fragment<T = unknown> {
  /**
   * Attach a codec. This is the *only* way to give a fragment a result type; a bare cast is
   * a compile error by construction (R3).
   */
  as<U>(codec: Codec<U>): Fragment<U>
  /**
   * Phantom. Never present at runtime.
   *
   * Deliberately **covariant** in `T` (`readonly __out?: T`, not `(t: T) => T`). D10's
   * invariance rule is about *builders*, whose output type accumulates across chained calls —
   * there, covariance silently drops columns (kysely.md §1.8 pattern 3). A fragment's `T` is
   * set exactly once, by `.as()`, and never accumulates; making it invariant would instead
   * break §3.3's central promise, because `Fragment<string>` would not be accepted by
   * `sql.join`, `toNode`, or a template hole — i.e. calling `.as(codec)` would make a
   * fragment *uncomposable*, which is the opposite of the design. Widening to
   * `Fragment<unknown>` loses no safety: the enclosing fragment's own `.as()` governs the
   * result type, and `Fragment<unknown>` is still not assignable to `Fragment<string>`.
   */
  readonly __out?: T
}

/** Any fragment, whatever its result type. The parameter position for composition helpers. */
export type AnyFragment = Fragment<unknown>

const FRAGMENT_NODES = new WeakMap<object, RawNode>()

function mkFragment<T>(node: RawNode): Fragment<T> {
  const handle: Fragment<T> = Object.freeze({
    as<U>(codec: Codec<U>): Fragment<U> {
      return mkFragment<U>(raw(node.chunks, node.parts, codec as Codec))
    },
  })
  FRAGMENT_NODES.set(handle, node)
  return handle
}

/** Nominal check. See the module docblock for why this is not a structural test. */
export function isFragment(v: unknown): v is Fragment<unknown> {
  return typeof v === 'object' && v !== null && FRAGMENT_NODES.has(v)
}

/** Unwrap a fragment to its AST node. Throws if `f` is not a fragment we created. */
export function toNode(f: Fragment<unknown>): RawNode {
  const node = FRAGMENT_NODES.get(f as object)
  if (node === undefined) {
    throw new InvalidFragmentError(
      'value is not a pgorm Fragment. Fragments can only be produced by the `sql` tag and ' +
        'its helpers; a structurally identical object (e.g. from JSON.parse) is data, not SQL.',
    )
  }
  return node
}

/** Accept either a fragment handle or a bare AST node wherever an expression is wanted. */
export function asExpr(v: Fragment<unknown> | Expr): Expr {
  if (isFragment(v)) return toNode(v)
  if (isAstNode(v)) return v
  throw new InvalidFragmentError('expected a Fragment or an AST expression node')
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Defence in depth against `sql(attackerArray, ...)` — i.e. calling the tag as a plain
 * function with a forged "template". Per the ECMAScript spec, a real template object and
 * its `.raw` are frozen and interned per call site; an array from `JSON.parse` is not.
 * This does not make forgery impossible, but it removes the drive-by case and turns it into
 * a loud error instead of a silent `unsafeRaw`.
 */
function assertTemplateObject(strings: TemplateStringsArray, valueCount: number): void {
  const rawStrings: unknown = (strings as { raw?: unknown }).raw
  if (
    !Array.isArray(strings) ||
    !Array.isArray(rawStrings) ||
    !Object.isFrozen(strings) ||
    !Object.isFrozen(rawStrings) ||
    strings.length !== valueCount + 1
  ) {
    throw new InvalidFragmentError(
      '`sql` was called with something that is not a template object. Use it as a tagged ' +
        'template (sql`select 1`); to interpolate caller-controlled SQL text you must say ' +
        'sql.unsafeRaw(text) explicitly.',
    )
  }
}

function tag(strings: TemplateStringsArray, ...values: readonly unknown[]): Fragment<unknown> {
  assertTemplateObject(strings, values.length)

  const parts: RawPart[] = []
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (isFragment(v)) {
      // Nested fragment: its node becomes a part. The compiler splices chunks and renumbers
      // parameters — no string round-trip, and no positional state on the fragment.
      parts.push(toNode(v))
    } else if (isAstNode(v)) {
      // A ref / expression built by the query layer.
      parts.push(v)
    } else {
      // Everything else is DATA. This is the branch that must never grow a special case.
      parts.push(param(v))
    }
  }
  return mkFragment(raw([...strings], parts, null))
}

// ─────────────────────────── sql.ident ───────────────────────────

function ident(...args: readonly unknown[]): Fragment<unknown> {
  // Two accepted call shapes, neither of which splits a string on '.':
  //   ident('public', 'users')   ident(['public', 'users'])
  // There is deliberately NO shape that turns one string into several identifiers.
  const parts: readonly unknown[] =
    args.length === 1 && Array.isArray(args[0]) ? (args[0] as readonly unknown[]) : args
  // Validates every part and throws InvalidIdentifierError on rejection, at the call site.
  const quoted = quoteIdentPath(parts)
  const node: IdentPart = mkNode({
    k: 'ident' as const,
    parts: Object.freeze(parts as readonly string[]),
    quoted,
  })
  return mkFragment(raw(['', ''], [node], null))
}

// ─────────────────────────── sql.lit ───────────────────────────

/**
 * Literal for non-strings only (D7). This deletes GHSA-8cpq-38p9-67gx structurally: there
 * is no string-literal quoter in the query path to get wrong. String literals in a query
 * position are always parameters. (DDL genuinely needs string literals; that lives in the
 * DDL emitter with its own reviewed quoter, out of scope here.)
 */
function lit(v: number | bigint | boolean | null): Fragment<unknown> {
  if (typeof v === 'string') {
    throw new UnsafeLiteralError(
      'sql.lit refuses strings. A string in a query position is always a bind parameter — ' +
        'write sql`${value}` instead. (Escaping string literals in-band is the root cause of ' +
        'GHSA-8cpq-38p9-67gx; there is deliberately no string-literal quoter on this path.)',
    )
  }
  if (
    v !== null &&
    typeof v !== 'number' &&
    typeof v !== 'bigint' &&
    typeof v !== 'boolean'
  ) {
    throw new UnsafeLiteralError(
      `sql.lit accepts number | bigint | boolean | null; received ${typeof v}. ` +
        'Use sql`${value}` to pass it as a parameter.',
    )
  }
  if (typeof v === 'number' && !Number.isFinite(v)) {
    throw new UnsafeLiteralError(
      `sql.lit received ${String(v)}, which has no SQL literal form. Use a parameter.`,
    )
  }
  return mkFragment(raw(['', ''], [litNode(v)], null))
}

// ─────────────────────────── sql.unsafeRaw ───────────────────────────

/**
 * `process` is referenced through `globalThis` rather than imported: `pgorm` ships with zero
 * dependencies *and* zero `@types` dependencies, so the package must not require
 * `@types/node` to typecheck, and must not throw in a browser/worker runtime.
 */
const IS_PRODUCTION =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    'NODE_ENV'
  ] === 'production'

function captureOrigin(): string | undefined {
  if (IS_PRODUCTION) return undefined
  const stack = new Error('unsafeRaw').stack
  if (stack === undefined) return undefined
  // Skip "Error: unsafeRaw", captureOrigin, unsafeRaw -> the caller is line 3.
  return stack.split('\n')[3]?.trim()
}

function unsafeRaw(text: string): Fragment<unknown> {
  if (typeof text !== 'string') {
    throw new InvalidFragmentError(`sql.unsafeRaw expects a string; received ${typeof text}`)
  }
  const node: RawSpliceNode = mkNode({
    k: 'unsafeRaw' as const,
    text,
    origin: captureOrigin(),
  })
  return mkFragment(raw(['', ''], [node], null))
}

// ─────────────────────────── composition ───────────────────────────

const EMPTY = mkFragment(raw([''], [], null))

function join(
  fragments: readonly Fragment<unknown>[],
  separator: Fragment<unknown> = mkFragment(raw([', '], [], null)),
): Fragment<unknown> {
  if (fragments.length === 0) return EMPTY
  const parts: RawPart[] = []
  const chunks: string[] = ['']
  const sepNode = toNode(separator)
  for (let i = 0; i < fragments.length; i++) {
    if (i > 0) {
      parts.push(sepNode)
      chunks.push('')
    }
    parts.push(toNode(fragments[i] as Fragment<unknown>))
    chunks.push('')
  }
  return mkFragment(raw(chunks, parts, null))
}

// ─────────────────────────── the tag object ───────────────────────────

export interface SqlTag {
  /** No type parameter. Result typing requires `.as(codec)` (R3). */
  (strings: TemplateStringsArray, ...values: readonly unknown[]): Fragment<unknown>

  /** Parts, never a dotted string. `ident('a.b')` is ONE identifier containing a dot. */
  ident(parts: readonly [string, ...string[]]): Fragment<unknown>
  ident(...parts: [string, ...string[]]): Fragment<unknown>

  /** Non-strings only — a string here is a compile error and a runtime error. */
  lit(v: number | bigint | boolean | null): Fragment<unknown>

  /** The only primitive in the library that interpolates caller text verbatim. */
  unsafeRaw(text: string): Fragment<unknown>

  join(
    fragments: readonly Fragment<unknown>[],
    separator?: Fragment<unknown>,
  ): Fragment<unknown>

  readonly empty: Fragment<unknown>
}

export const sql: SqlTag = Object.freeze(
  Object.assign(tag, {
    ident: ident as SqlTag['ident'],
    lit,
    unsafeRaw,
    join,
    empty: EMPTY,
  }),
)
