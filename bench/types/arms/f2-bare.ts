/**
 * WS0 fork **F2, arm B** — bare nested object literals in a projection are grouping
 * (design/03 §2.2: `{ author: { id, name } }`). Arm A (`nest({...})` required, design/04 §2.1) is
 * in `../types.ts`.
 *
 * The cost under test: allowing bare literals forces `Project` to become **conditional and
 * recursive** on the single hottest type in the library. design/04 §2.1 asserts that is not
 * affordable and that requiring `nest()` "costs the user 6 characters"; this arm puts a number
 * on the claim.
 */

import type {
  AnyHandle,
  Defer,
  Projectable,
  Simplify,
} from '../../../packages/pg-prime/src/schema/index.js'
import type { NAME } from '../../../packages/pg-prime/src/schema/index.js'
import type {
  Expr,
  ExprOf,
  RefsAt,
  RefsOf,
  RelsNs,
  SelectAt,
  Sources,
} from '../../../packages/pg-prime/src/query/types.js'
import type { INV, ROW } from '../../../packages/pg-prime/src/query/symbols.js'

/** A projection whose values may themselves be projections, to any depth. */
export type BareProjection = { readonly [k: string]: Projectable | BareProjection }

/**
 * The recursive counterpart of `Project<P>`: one `infer` conditional per output key, plus
 * recursion whenever a key holds a nested literal rather than an expression.
 */
export type ProjectBare<P> = Defer<
  Simplify<{ [K in keyof P]: P[K] extends ExprOf<infer T> ? T : ProjectBare<P[K]> }>
>

export interface QueryBare<S extends Sources, O> {
  readonly [INV]: (o: O) => O
  readonly [ROW]: O

  select<P extends BareProjection>(
    f: (t: RefsOf<S>, r: RelsNs<S>) => P,
  ): QueryBare<S, ProjectBare<P>>
  selectAll<A extends keyof S>(a: A): QueryBare<S, SelectAt<S[A]>>

  where(f: (t: RefsOf<S>) => Expr<boolean>): QueryBare<S, O>
  groupBy(f: (t: RefsOf<S>) => Projectable | readonly Projectable[]): QueryBare<S, O>
  orderBy(f: (t: RefsOf<S>) => Projectable | readonly Projectable[]): QueryBare<S, O>
  limit(n: number): QueryBare<S, O>
  offset(n: number): QueryBare<S, O>

  innerJoin<H2 extends AnyHandle, A extends string>(
    t: H2,
    alias: A,
    on: (t: RefsOf<S> & Record<A, RefsAt<H2>>) => Expr<boolean>,
  ): QueryBare<S & Record<A, H2>, O>

  leftJoin<H2 extends AnyHandle, A extends string>(
    t: H2,
    alias: A,
    on: (t: RefsOf<S> & Record<A, RefsAt<H2>>) => Expr<boolean>,
  ): QueryBare<S & Record<A, H2>, O>

  $call<O2>(f: (q: this) => QueryBare<S, O2>): QueryBare<S, O2>

  execute(): Promise<O[]>
}

export interface ExecutorBare {
  from<H extends AnyHandle, A extends string>(t: H, alias: A): QueryBare<Record<A, H>, unknown>
  from<H extends AnyHandle>(t: H): QueryBare<Record<H[typeof NAME] & string, H>, unknown>
}
