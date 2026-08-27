/**
 * WS0 fork **F3, arm A** — relation accessors reached through a **second lambda parameter**,
 * `(t, r) => r.u.posts(…)` (design/04 §2.4). Arm B (accessors on the table scope, design/03 §2.3)
 * won the measurement and is now the shipped surface in
 * `packages/pg-prime/src/query/types.ts`; this file preserves the arm it beat so the numbers in
 * design/09 §3.0 stay reproducible.
 *
 * design/04 §2.4's stated reason for the second parameter was "specifically to avoid an
 * intersection". Measured, that reason does not survive: the intersection is instantiated once
 * per (alias, table) and cached, while the two-parameter lambda forces `RelsNs<S>` to be
 * instantiated on **every** `select`, including the ones that project no relation at all.
 *
 * Apart from where the relations live, this is the shipped `Query` verbatim.
 */

import type { AnyHandle, Projectable } from '../../../packages/pg-prime/src/schema/index.js'
import type { NAME } from '../../../packages/pg-prime/src/schema/index.js'
import type {
  Expr,
  Project,
  Projection,
  RefsAt,
  RefsOf,
  RelsNs,
  SelectAt,
  Sources,
} from '../../../packages/pg-prime/src/query/types.js'
import type { INV, ROW } from '../../../packages/pg-prime/src/query/symbols.js'

export interface Query04<S extends Sources, O> {
  readonly [INV]: (o: O) => O
  readonly [ROW]: O

  select<P extends Projection>(f: (t: RefsOf<S>, r: RelsNs<S>) => P): Query04<S, Project<P>>
  selectAll<A extends keyof S>(a: A): Query04<S, SelectAt<S[A]>>

  where(f: (t: RefsOf<S>) => Expr<boolean>): Query04<S, O>
  groupBy(f: (t: RefsOf<S>) => Projectable | readonly Projectable[]): Query04<S, O>
  orderBy(f: (t: RefsOf<S>) => Projectable | readonly Projectable[]): Query04<S, O>
  limit(n: number): Query04<S, O>
  offset(n: number): Query04<S, O>

  innerJoin<H2 extends AnyHandle, A extends string>(
    t: H2,
    alias: A,
    on: (t: RefsOf<S> & Record<A, RefsAt<H2>>) => Expr<boolean>,
  ): Query04<S & Record<A, H2>, O>

  leftJoin<H2 extends AnyHandle, A extends string>(
    t: H2,
    alias: A,
    on: (t: RefsOf<S> & Record<A, RefsAt<H2>>) => Expr<boolean>,
  ): Query04<S & Record<A, H2>, O>

  $call<O2>(f: (q: this) => Query04<S, O2>): Query04<S, O2>

  execute(): Promise<O[]>
}

export interface Executor04 {
  from<H extends AnyHandle, A extends string>(t: H, alias: A): Query04<Record<A, H>, unknown>
  from<H extends AnyHandle>(t: H): Query04<Record<H[typeof NAME] & string, H>, unknown>
}
