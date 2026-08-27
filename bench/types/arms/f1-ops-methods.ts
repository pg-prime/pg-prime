/**
 * WS0 fork **F1, arm B** — the PG operator vocabulary as **methods on refs**, gated by the
 * column's type class (design/03 §2.9). Arm A (free functions, design/04 §2.2) is in
 * `../ops-free.ts`; the two files hold the same vocabulary, so their emitted `.d.ts` byte counts
 * are an apples-to-apples measurement of what this fork costs the published surface.
 *
 * The claim under test, pre-registered in design/09 §3 WS0: *a non-generic method on a concrete
 * `Ref` instantiates nothing per call; the intersection is paid once per table at declaration.*
 */

import type { OUT } from '../../../packages/pgorm/src/schema/index.js'
import type { ColMeta, Projectable, Ref } from '../../../packages/pgorm/src/schema/index.js'
import type { AnyQuery, Expr, ExprOf, Operand } from '../../../packages/pgorm/src/query/types.js'

/** Type-class dispatch is a single indexed access, which keeps the type cost flat (03 §2.9). */
type ClassOf<M extends ColMeta> = M['pg'] extends `${string}[]`
  ? 'array'
  : M['pg'] extends 'jsonb' | 'json'
    ? 'json'
    : M['pg'] extends 'text' | 'varchar' | 'citext' | 'bpchar' | 'name' | 'uuid'
      ? 'text'
      : M['pg'] extends 'int2' | 'int4' | 'int8' | 'float4' | 'float8' | 'numeric' | 'money'
        ? 'numeric'
        : 'base'

type Elem<M extends ColMeta> = M['t'] extends readonly (infer E)[] ? E : never

interface BaseOps<M extends ColMeta> {
  eq(b: Operand<M['t']>): Expr<boolean>
  neq(b: Operand<M['t']>): Expr<boolean>
  lt(b: Operand<M['t']>): Expr<boolean>
  lte(b: Operand<M['t']>): Expr<boolean>
  gt(b: Operand<M['t']>): Expr<boolean>
  gte(b: Operand<M['t']>): Expr<boolean>
  isNull(): Expr<boolean>
  isNotNull(): Expr<boolean>
  in(xs: readonly M['t'][]): Expr<boolean>
  inQuery(q: AnyQuery): Expr<boolean>
  between(lo: Operand<M['t']>, hi: Operand<M['t']>): Expr<boolean>
  isDistinctFrom(b: Operand<M['t']>): Expr<boolean>
  coalesce(b: Operand<NonNullable<M['t']>>): Expr<NonNullable<M['t']>>
  cast<T>(): Expr<T>
  asc(): Projectable
  desc(): Projectable
}

interface TextOps {
  like(p: Operand<string>): Expr<boolean>
  ilike(p: Operand<string>): Expr<boolean>
  notLike(p: Operand<string>): Expr<boolean>
  notILike(p: Operand<string>): Expr<boolean>
  startsWith(p: Operand<string>): Expr<boolean>
  regex(p: Operand<string>): Expr<boolean>
  iregex(p: Operand<string>): Expr<boolean>
  notRegex(p: Operand<string>): Expr<boolean>
  similarTo(p: Operand<string>): Expr<boolean>
  matches(q: ExprOf<unknown>): Expr<boolean>
  rank(q: ExprOf<unknown>): Expr<number>
  rankCd(q: ExprOf<unknown>): Expr<number>
}

interface ArrayOps<M extends ColMeta> {
  overlaps(b: Operand<M['t']>): Expr<boolean>
  contains(b: Operand<M['t']>): Expr<boolean>
  containedBy(b: Operand<M['t']>): Expr<boolean>
  has(b: Operand<Elem<M>>): Expr<boolean>
  hasAll(b: Operand<M['t']>): Expr<boolean>
  length(): Expr<number>
  concat(b: Operand<M['t']>): Expr<M['t']>
  any(): ExprOf<Elem<M>>
  all(): ExprOf<Elem<M>>
}

interface JsonOps<M extends ColMeta> {
  get(k: Operand<string | number>): Expr<unknown>
  getText(k: Operand<string | number>): Expr<string>
  path(p: readonly string[]): Expr<unknown>
  pathText(p: readonly string[]): Expr<string>
  contains(b: Operand<unknown>): Expr<boolean>
  containedBy(b: Operand<unknown>): Expr<boolean>
  hasKey(k: Operand<string>): Expr<boolean>
  hasAnyKey(k: readonly string[]): Expr<boolean>
  hasAllKeys(k: readonly string[]): Expr<boolean>
  jsonPathExists(jp: string): Expr<boolean>
  jsonPathMatch(jp: string): Expr<boolean>
  concat(b: Operand<M['t']>): Expr<M['t']>
  delete(k: Operand<string>): Expr<M['t']>
}

interface NumericOps<M extends ColMeta> {
  add(b: Operand<M['t']>): Expr<M['t']>
  sub(b: Operand<M['t']>): Expr<M['t']>
  mul(b: Operand<M['t']>): Expr<M['t']>
  div(b: Operand<M['t']>): Expr<M['t']>
  mod(b: Operand<M['t']>): Expr<M['t']>
  abs(): Expr<M['t']>
}

/** No extra methods; `base` still gets everything in {@link BaseOps}. */
interface NoOps {
  readonly _base?: never
}

interface OpsByClass<M extends ColMeta> {
  base: NoOps
  text: TextOps
  numeric: NumericOps<M>
  array: ArrayOps<M>
  json: JsonOps<M>
}

/** `Ref<C> = BaseOps<C> & OpsByClass<C>[TypeClassOf<C>]` — design/03 §2.9, verbatim. */
export type MRef<A extends string, K extends string, M extends ColMeta> = Ref<A, K, M> &
  BaseOps<M> &
  OpsByClass<M>[ClassOf<M>]

