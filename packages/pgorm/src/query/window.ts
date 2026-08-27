/**
 * Window functions (design/03 §2.8, WS4).
 *
 * ## `over(expr, …)` is a free function, not a method on the expression
 *
 * `03` §2.8 spells it `fn.sum(p.amount).over('byAuthor')` — a **method on an expression**. Fork F1
 * (09 §3.0) already decided that question by measurement for the operator vocabulary: methods hung
 * off expressions cost +105 instantiations per table (+3.0 % per program) where the free function
 * costs exactly zero. The same reasoning applies here, and more cheaply still — an `Expr` at
 * runtime *is* a frozen AST node, so giving it `.over()` would mean either a wrapper object per
 * aggregate (an allocation and a second hidden class on the hot path) or a method on every node
 * the compiler emits.
 *
 * So: `over(fn.sum(p.amount), 'byAuthor')` and `over(fn.rowNumber(), w => w.partitionBy(…))`.
 * Recorded as a deviation in 09 §3.4 and amended into 03 §2.8.
 *
 * ## Named windows
 *
 * `.window('byAuthor', t => w => …)` reaches the same builder from the select stage. PostgreSQL
 * evaluates a named window once and lets four projection items share it, which is the entire
 * reason `03` §2.8 asks for the named form.
 */

import { int4Codec } from '../codec/index.js'
import type { AggNode, Expr as Node, FrameBound, FuncCallNode, WindowDef } from '../compile/ast.js'
import { lit, over as overNode } from '../compile/nodes.js'
import type { Projectable } from '../schema/index.js'
import { BuilderError } from '../sql/errors.js'
import type { OrderBy } from './ops.types.js'
import { toExprList, toOrderItems } from './scope.js'
import type { Expr } from './types.js'

/** A frame endpoint. An offset is emitted as a literal — see {@link litOffset}. */
export type Bound =
  | 'unbounded preceding'
  | 'current row'
  | 'unbounded following'
  | { readonly preceding: number }
  | { readonly following: number }

export interface FrameOpts {
  readonly from: Bound
  readonly to?: Bound
  readonly exclude?: 'current row' | 'group' | 'ties' | 'no others'
}

/**
 * The window-definition builder. Immutable like every other builder here: each method returns a
 * new spec, so a partially-built window can be shared between call sites.
 */
export interface WindowSpec {
  partitionBy(...xs: readonly Projectable[]): WindowSpec
  orderBy(o: OrderBy): WindowSpec
  rows(f: FrameOpts): WindowSpec
  range(f: FrameOpts): WindowSpec
  groups(f: FrameOpts): WindowSpec
}

export type WindowFn = (w: WindowSpec) => WindowSpec

/**
 * The object form `03` §2.8 uses for a *named* window:
 * `.window('byAuthor', ({posts: p}) => ({ partitionBy: [p.authorId], orderBy: [desc(p.amount)] }))`.
 * Both forms produce the same `WindowDef`; the builder form exists for frames, which read badly
 * as a literal.
 */
export interface WindowLiteral {
  readonly partitionBy?: readonly Projectable[]
  readonly orderBy?: OrderBy
  readonly frame?: FrameOpts & { readonly mode: 'rows' | 'range' | 'groups' }
}

/**
 * A frame offset is a **literal**, not a parameter.
 *
 * PostgreSQL accepts `rows between $1 preceding and current row`, but the offset is part of the
 * plan's shape: parameterising it means one prepared statement whose plan is re-costed for every
 * distinct window size, which is the opposite of what parameterising is for. It is also always a
 * small integer the caller wrote inline, so nothing user-supplied is at stake.
 */
function litOffset(n: number): Node {
  // `Number.isInteger(1e21)` is true — it is an integer-valued float — and `lit` would then emit
  // `1e+21`, which PostgreSQL does not accept as an `int4` frame offset. The bound has to be a
  // safe integer, not merely an integral number.
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new BuilderError(
      `pgorm: a window frame offset must be a non-negative safe integer (got ${String(n)})`,
    )
  }
  return lit(n, int4Codec)
}

/**
 * Every keyword below reaches the SQL text verbatim, so every one is checked against its closed
 * set at the boundary. `frame({ from: 'unbounded preceding; drop table users --' })` used to
 * execute exactly as written: the TS union is a compile-time claim, and a window spec assembled
 * from configuration is a runtime value.
 */
const FRAME_MODES = ['rows', 'range', 'groups'] as const
const BOUND_KEYWORDS = ['unbounded preceding', 'current row', 'unbounded following'] as const
const EXCLUSIONS = ['current row', 'group', 'ties', 'no others'] as const

/**
 * A keyword that will be spliced into the SQL text, checked against its closed set.
 *
 * Shared with the locking clause in `./select.ts`: each of those options is a TS union the emitter
 * writes out verbatim, and a union is a compile-time claim about a value that may well have
 * arrived at runtime from JSON.
 */
export function oneOf<T extends string>(v: unknown, legal: readonly T[], where: string): T {
  if (typeof v === 'string' && (legal as readonly string[]).includes(v)) return v as T
  throw new BuilderError(
    `pgorm: ${where} must be one of ${legal.map((x) => `'${x}'`).join(', ')} (got ` +
      `${JSON.stringify(v)}). PostgreSQL keywords are emitted as written, so pgorm will not ` +
      `pass an unrecognised one through.`,
  )
}

function bound(b: Bound, where: string): FrameBound {
  if (typeof b !== 'object' || b === null) return { k: oneOf(b, BOUND_KEYWORDS, where) }
  if ('preceding' in b) return { k: 'preceding', n: litOffset(b.preceding) }
  if ('following' in b) return { k: 'following', n: litOffset(b.following) }
  throw new BuilderError(
    `pgorm: ${where} takes ${BOUND_KEYWORDS.map((x) => `'${x}'`).join(', ')}, ` +
      `{ preceding: n } or { following: n }.`,
  )
}

function frame(mode: unknown, f: FrameOpts): NonNullable<WindowDef['frame']> {
  return {
    mode: oneOf(mode, FRAME_MODES, 'a window frame mode'),
    start: bound(f.from, 'a window frame start'),
    end: f.to === undefined ? undefined : bound(f.to, 'a window frame end'),
    exclude: f.exclude === undefined ? undefined : oneOf(f.exclude, EXCLUSIONS, 'frame({ exclude })'),
  }
}

class Spec implements WindowSpec {
  readonly def: WindowDef
  constructor(def: WindowDef) {
    this.def = def
  }
  #next(patch: Partial<WindowDef>): Spec {
    return new Spec(Object.freeze({ ...this.def, ...patch }))
  }
  partitionBy(...xs: readonly Projectable[]): WindowSpec {
    return this.#next({ partitionBy: toExprList(xs, 'partitionBy()') })
  }
  orderBy(o: OrderBy): WindowSpec {
    return this.#next({ orderBy: toOrderItems(o) })
  }
  rows(f: FrameOpts): WindowSpec {
    return this.#next({ frame: frame('rows', f) })
  }
  range(f: FrameOpts): WindowSpec {
    return this.#next({ frame: frame('range', f) })
  }
  groups(f: FrameOpts): WindowSpec {
    return this.#next({ frame: frame('groups', f) })
  }
}

/** Run a window callback and return the definition it built. Invoked once, at call time. */
export function buildWindow(f: WindowFn): WindowDef {
  const out = f(new Spec({}))
  if (!(out instanceof Spec)) {
    throw new BuilderError(
      'pgorm: a window callback must return the spec it was given — `w => w.partitionBy(x)`.',
    )
  }
  return out.def
}

/**
 * Normalise every spelling of a window definition.
 *
 * Three are legal and all three are documented: a {@link Spec} the caller built, a
 * {@link WindowFn} — which is what the module docblock and `.window('w', t => w => …)` both show
 * — and the {@link WindowLiteral} object. The callback used to fall through to the literal branch,
 * where a function has no `partitionBy`/`orderBy`/`frame`, and emitted `window "w" as ()`: legal
 * SQL, an empty frame, and a silently wrong answer for every ranking function using it.
 */
export function toWindowDef(v: WindowSpec | WindowLiteral | WindowFn): WindowDef {
  if (v instanceof Spec) return v.def
  if (typeof v === 'function') return buildWindow(v as WindowFn)
  if (typeof v !== 'object' || v === null) {
    throw new BuilderError(
      'pgorm: a window definition is `w => w.partitionBy(...)` or ' +
        '`{ partitionBy: [...], orderBy: [...] }`.',
    )
  }
  const lit = v as WindowLiteral
  const def: WindowDef = {
    partitionBy: lit.partitionBy === undefined ? undefined : toExprList(lit.partitionBy, 'partitionBy'),
    orderBy: lit.orderBy === undefined ? undefined : toOrderItems(lit.orderBy),
    frame: lit.frame === undefined ? undefined : frame(lit.frame.mode, lit.frame),
  }
  if (def.partitionBy === undefined && def.orderBy === undefined && def.frame === undefined) {
    // `window "w" as ()` is a whole-partition window over every row. Nobody spells that on
    // purpose through this API; it is what an empty object or a misspelled key produces.
    throw new BuilderError(
      'pgorm: this window definition is empty. Give it a partitionBy, an orderBy or a frame — ' +
        '`over(fn.rowNumber(), w => w.partitionBy(x))`.',
    )
  }
  return def
}

/** `agg(...) over (...)` / `agg(...) over "name"` (03 §2.8). */
export function over<T, P extends string>(e: Expr<T, P>, w: WindowFn | string): Expr<T, P> {
  const node = e as unknown as Node
  if (node.k !== 'agg' && node.k !== 'fn') {
    throw new BuilderError(
      'pgorm: over() takes an aggregate or a window function — `over(fn.sum(x), w)`, ' +
        '`over(fn.rowNumber(), w)`. PostgreSQL has no OVER on a plain expression.',
    )
  }
  const window = typeof w === 'string' ? { ref: w } : buildWindow(w)
  return overNode(node as AggNode | FuncCallNode, window) as unknown as Expr<T, P>
}
