/**
 * WS0 fork **F1, arm A** — the PG operator vocabulary as **free functions** (design/04 §2.2).
 * Arm B (methods on refs, design/03 §2.9) is in `./forks/f1-ops-methods.ts`.
 *
 * The vocabulary is design/03 §2.9's table, in full, so the two arms are compared at equal
 * coverage — and so the `.d.ts` byte count of this file against its counterpart's is an
 * apples-to-apples measurement of what the fork costs the published surface.
 *
 * Note what free functions cost in *naming*: `contains` exists for arrays, jsonb and ranges with
 * three different operand types, so the free form must spell them apart (`arrayContains` /
 * `jsonContains` / `rangeContains`). That is a DX input to the decision, not a perf one.
 */

import type { AnyCodec, CodecOut } from '../../../packages/pgorm/src/codec/index.js'
import type { META, OUT } from '../../../packages/pgorm/src/schema/index.js'
import type { Projectable } from '../../../packages/pgorm/src/schema/index.js'
import type { AnyQuery, Expr, ExprOf, Operand } from '../../../packages/pgorm/src/query/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Type-class gates
//
// design/04 §2.2 says the operand for a class-specific operator "is selected from `M['pg']` via a
// small per-operator table". These interfaces are that table: a free function takes an operand
// that is not merely *shaped* right but *declared* as the right PG type class, so `hasKey` on a
// `text` column is a compile error rather than a 42883 at runtime.
//
// Without them the free-function arm is measurably laxer than the method arm — verified: of seven
// nonsense operator/column pairings, four compiled. Both arms must keep the same promise for the
// comparison in `bench/types/forks.mjs` to be about cost rather than about safety.
//
// Both arms share one limitation: the gate reads `[META]`, which only a `Ref` carries, so a
// `sql`…`.as(codec)` fragment cannot be a class-specific operand. A method arm has exactly the
// same hole (an `Expr` has no methods). WS3 closes it for whichever arm wins.
// ─────────────────────────────────────────────────────────────────────────────

type TextPg = 'text' | 'varchar' | 'citext' | 'bpchar' | 'name'
type NumPg = 'int2' | 'int4' | 'int8' | 'float4' | 'float8' | 'numeric' | 'money'

interface TextRef {
  readonly [OUT]: string | null
  readonly [META]: { readonly pg: TextPg }
}
interface ArrayRef<E> {
  readonly [OUT]: E[]
  readonly [META]: { readonly pg: `${string}[]` }
}
interface JsonRef {
  readonly [OUT]: unknown
  readonly [META]: { readonly pg: 'json' | 'jsonb' }
}
interface NumRef<T> {
  readonly [OUT]: T
  readonly [META]: { readonly pg: NumPg }
}
interface TsvectorRef {
  readonly [OUT]: unknown
  readonly [META]: { readonly pg: 'tsvector' }
}
interface RangeRef<R> {
  readonly [OUT]: R
  readonly [META]: { readonly pg: `${string}range` }
}
interface NetRef<N> {
  readonly [OUT]: N
  readonly [META]: { readonly pg: 'inet' | 'cidr' }
}
interface VectorRef {
  readonly [OUT]: number[]
  readonly [META]: { readonly pg: 'vector' }
}

/** Operand types come from the *operator*, not the column, wherever PG says so (04 §2.2). */
export declare function eq<A extends Projectable>(a: A, b: Operand<A[typeof OUT]>): Expr<boolean>
export declare function neq<A extends Projectable>(a: A, b: Operand<A[typeof OUT]>): Expr<boolean>
export declare function lt<A extends Projectable>(a: A, b: Operand<A[typeof OUT]>): Expr<boolean>
export declare function lte<A extends Projectable>(a: A, b: Operand<A[typeof OUT]>): Expr<boolean>
export declare function gt<A extends Projectable>(a: A, b: Operand<A[typeof OUT]>): Expr<boolean>
export declare function gte<A extends Projectable>(a: A, b: Operand<A[typeof OUT]>): Expr<boolean>
export declare function isDistinctFrom<A extends Projectable>(
  a: A,
  b: Operand<A[typeof OUT]>,
): Expr<boolean>
export declare function between<A extends Projectable>(
  a: A,
  lo: Operand<A[typeof OUT]>,
  hi: Operand<A[typeof OUT]>,
): Expr<boolean>
export declare function isNull(a: Projectable): Expr<boolean>
export declare function isNotNull(a: Projectable): Expr<boolean>
/** `in([])` compiles to `false`, by construction (03 §2.1). */
export declare function inList<A extends Projectable>(
  a: A,
  xs: readonly A[typeof OUT][],
): Expr<boolean>
export declare function inQuery<A extends Projectable>(a: A, q: AnyQuery): Expr<boolean>
export declare function coalesce<A extends Projectable>(
  a: A,
  b: Operand<NonNullable<A[typeof OUT]>>,
): Expr<NonNullable<A[typeof OUT]>>
export declare function cast<C extends AnyCodec>(a: Projectable, c: C): Expr<CodecOut<C>>
export declare function asc(a: Projectable): Projectable
export declare function desc(a: Projectable): Projectable

// text / citext
export declare function like(a: TextRef, p: Operand<string>): Expr<boolean>
export declare function ilike(a: TextRef, p: Operand<string>): Expr<boolean>
export declare function notLike(a: TextRef, p: Operand<string>): Expr<boolean>
export declare function notILike(a: TextRef, p: Operand<string>): Expr<boolean>
export declare function startsWith(a: TextRef, p: Operand<string>): Expr<boolean>
export declare function regex(a: TextRef, p: Operand<string>): Expr<boolean>
export declare function iregex(a: TextRef, p: Operand<string>): Expr<boolean>
export declare function notRegex(a: TextRef, p: Operand<string>): Expr<boolean>
export declare function similarTo(a: TextRef, p: Operand<string>): Expr<boolean>

// array
export declare function overlaps<E>(a: ArrayRef<E>, b: Operand<E[]>): Expr<boolean>
export declare function arrayContains<E>(a: ArrayRef<E>, b: Operand<E[]>): Expr<boolean>
export declare function arrayContainedBy<E>(a: ArrayRef<E>, b: Operand<E[]>): Expr<boolean>
export declare function has<E>(a: ArrayRef<E>, b: Operand<E>): Expr<boolean>
export declare function hasAll<E>(a: ArrayRef<E>, b: Operand<E[]>): Expr<boolean>
export declare function arrayLength(a: ArrayRef<unknown>): Expr<number>
export declare function arrayConcat<E>(a: ArrayRef<E>, b: Operand<E[]>): Expr<E[]>
export declare function anyOf<E>(a: ArrayRef<E>): ExprOf<E>
export declare function allOf<E>(a: ArrayRef<E>): ExprOf<E>

// jsonb
export declare function jsonGet(a: JsonRef, k: Operand<string | number>): Expr<unknown>
export declare function jsonGetText(a: JsonRef, k: Operand<string | number>): Expr<string>
export declare function jsonPath(a: JsonRef, p: readonly string[]): Expr<unknown>
export declare function jsonPathText(a: JsonRef, p: readonly string[]): Expr<string>
export declare function jsonContains(a: JsonRef, b: Operand<unknown>): Expr<boolean>
export declare function jsonContainedBy(a: JsonRef, b: Operand<unknown>): Expr<boolean>
export declare function hasKey(a: JsonRef, k: Operand<string>): Expr<boolean>
export declare function hasAnyKey(a: JsonRef, k: readonly string[]): Expr<boolean>
export declare function hasAllKeys(a: JsonRef, k: readonly string[]): Expr<boolean>
export declare function jsonPathExists(a: JsonRef, jp: string): Expr<boolean>
export declare function jsonPathMatch(a: JsonRef, jp: string): Expr<boolean>
export declare function jsonConcat(a: JsonRef, b: Operand<unknown>): Expr<unknown>
export declare function jsonDelete(a: JsonRef, k: Operand<string>): Expr<unknown>

// numeric / int — result codec preserved
export declare function add<T>(a: NumRef<T>, b: Operand<T>): Expr<T>
export declare function sub<T>(a: NumRef<T>, b: Operand<T>): Expr<T>
export declare function mul<T>(a: NumRef<T>, b: Operand<T>): Expr<T>
export declare function div<T>(a: NumRef<T>, b: Operand<T>): Expr<T>
export declare function mod<T>(a: NumRef<T>, b: Operand<T>): Expr<T>
export declare function abs<T>(a: NumRef<T>): Expr<T>

// tsvector / range / net / vector — the remaining 03 §2.9 rows
export declare function matches(a: TsvectorRef, q: ExprOf<unknown>): Expr<boolean>
export declare function tsRank(a: TsvectorRef, q: ExprOf<unknown>): Expr<number>
export declare function tsRankCd(a: TsvectorRef, q: ExprOf<unknown>): Expr<number>
export declare function rangeOverlaps<R>(a: RangeRef<R>, b: Operand<R>): Expr<boolean>
export declare function rangeContains<R, T>(a: RangeRef<R>, b: Operand<R | T>): Expr<boolean>
export declare function rangeContainedBy<R>(a: RangeRef<R>, b: Operand<R>): Expr<boolean>
export declare function strictlyLeft<R>(a: RangeRef<R>, b: Operand<R>): Expr<boolean>
export declare function strictlyRight<R>(a: RangeRef<R>, b: Operand<R>): Expr<boolean>
export declare function adjacent<R>(a: RangeRef<R>, b: Operand<R>): Expr<boolean>
export declare function containsNet<N>(a: NetRef<N>, b: Operand<N>): Expr<boolean>
export declare function containedByNet<N>(a: NetRef<N>, b: Operand<N>): Expr<boolean>
export declare function l2(a: VectorRef, b: Operand<number[]>): Expr<number>
export declare function cosine(a: VectorRef, b: Operand<number[]>): Expr<number>
export declare function innerProduct(a: VectorRef, b: Operand<number[]>): Expr<number>
