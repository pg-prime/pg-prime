/**
 * WS0 fork **F3, arm B** — relation accessors on the **table scope**, next to the columns
 * (design/03 §2.3). Arm A (a second lambda parameter, design/04 §2.4) is `./base-04.ts`.
 *
 * ── Why this file exists, added in WS1 ───────────────────────────────────────────────────────
 *
 * WS0 measured F3 by comparing `base04` against the *shipped* surface, because at that moment the
 * shipped surface was exactly `base04 + F3` and nothing else. WS1 then added left-join
 * nullability, the `GROUP BY` guard, CTE handles, set operations and `$if` to that same file — so
 * re-running the fork bench started reporting the shipped arm at **+1.8 % whole-program against
 * `base04` instead of −2.0 %**, which reads like F3 regressing and is nothing of the sort: it is
 * five WS1 features being charged to a WS0 fork.
 *
 * A fork arm has to be a *minimal delta over the baseline, frozen*. This file is that: `base-04.ts`
 * verbatim, with the relation namespace moved from the second lambda parameter onto the scope, and
 * with nothing else changed. It is the arm design/09 §3.0's F3 row is measured from, and it must
 * not grow. The live surface's own cost is gated separately, by `run.mjs`, against
 * `budget.json`'s three per-query lines.
 */

import type { AnyHandle, Projectable } from '../../../packages/pgorm/src/schema/index.js'
import type { NAME } from '../../../packages/pgorm/src/schema/index.js'
import type {
  Expr,
  Project,
  Projection,
  RefsAt,
  RelPickers,
  SelectAt,
  Sources,
} from '../../../packages/pgorm/src/query/types.js'
import type { INV, ROW } from '../../../packages/pgorm/src/query/symbols.js'

/** The one line that differs from `base-04.ts`: columns and relations in one object per alias. */
type Scope3<S extends Sources> = { [A in keyof S]: RefsAt<S[A]> & RelPickers<S[A]> }

export interface Query3<S extends Sources, O> {
  readonly [INV]: (o: O) => O
  readonly [ROW]: O

  select<P extends Projection>(f: (t: Scope3<S>) => P): Query3<S, Project<P>>
  selectAll<A extends keyof S>(a: A): Query3<S, SelectAt<S[A]>>

  where(f: (t: Scope3<S>) => Expr<boolean>): Query3<S, O>
  groupBy(f: (t: Scope3<S>) => Projectable | readonly Projectable[]): Query3<S, O>
  orderBy(f: (t: Scope3<S>) => Projectable | readonly Projectable[]): Query3<S, O>
  limit(n: number): Query3<S, O>
  offset(n: number): Query3<S, O>

  innerJoin<H2 extends AnyHandle, A extends string>(
    t: H2,
    alias: A,
    on: (t: Scope3<S> & Record<A, RefsAt<H2>>) => Expr<boolean>,
  ): Query3<S & Record<A, H2>, O>

  leftJoin<H2 extends AnyHandle, A extends string>(
    t: H2,
    alias: A,
    on: (t: Scope3<S> & Record<A, RefsAt<H2>>) => Expr<boolean>,
  ): Query3<S & Record<A, H2>, O>

  $call<O2>(f: (q: this) => Query3<S, O2>): Query3<S, O2>

  execute(): Promise<O[]>
}

export interface Executor3 {
  from<H extends AnyHandle, A extends string>(t: H, alias: A): Query3<Record<A, H>, unknown>
  from<H extends AnyHandle>(t: H): Query3<Record<H[typeof NAME] & string, H>, unknown>
}
