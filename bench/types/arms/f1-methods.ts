/**
 * WS0 fork **F1, arm B**, scaffolding — the query surface over method-carrying refs.
 *
 * The fork itself is the ref type in `./f1-ops-methods.ts`. Everything here is `../types.ts`
 * copied unchanged except that the lambdas hand out `MRef`s, so the bench differences exactly
 * the fork and nothing else. In a real implementation this file would not exist: the winning arm
 * replaces the core rather than sitting beside it, which is why the `.d.ts` comparison in
 * `bench/types/forks.mjs` prices `ops-free.d.ts` against `f1-ops-methods.d.ts` and not this.
 */

import type { COLS, NAME, SCHEMA } from '../../../packages/pg-prime/src/schema/index.js'
import type {
  AnyHandle,
  AnySchema,
  Projectable,
  Ref,
  RelMeta,
  RelOut,
  TableOf,
} from '../../../packages/pg-prime/src/schema/index.js'
import type {
  Expr,
  Project,
  Projection,
  RelsAtH,
  SelectAt,
  Sources,
  TableAt,
} from '../../../packages/pg-prime/src/query/types.js'
import type { MRef } from './f1-ops-methods.js'
import type { INV, PRJ, ROW } from '../../../packages/pg-prime/src/query/symbols.js'

type ColsAt<H extends AnyHandle> = TableAt<H>[typeof COLS & keyof TableAt<H>]

/**
 * The method-carrying ref record for one table. Like the schema's own `[REFS]` slot this is
 * instantiated at most once per table per program (the instantiation cache keys on the type
 * arguments), so the intersection is a **declaration** cost, not a per-query one — that is the
 * claim the bench either confirms or refutes.
 */
export type MRefsAt<H extends AnyHandle> = {
  readonly [K in keyof ColsAt<H>]: MRef<H[typeof NAME] & string, K & string, ColsAt<H>[K]>
}

export type MRefsOf<S extends Sources> = { [A in keyof S]: MRefsAt<S[A]> }

/**
 * Measurement control (R4) — the same mapped-type reconstruction as {@link MRefsAt} but *without*
 * the operator intersection. Differencing the two isolates what the methods cost from what
 * rebuilding the ref record costs, which matters because a real arm-B implementation would bake
 * the methods straight into `pgTable`'s `[REFS]` slot and pay only the former. Bench-only.
 */
export type PlainRefsAt<H extends AnyHandle> = {
  readonly [K in keyof ColsAt<H>]: Ref<H[typeof NAME] & string, K & string, ColsAt<H>[K]>
}

// ─────────────────────────────────────────────────────────────────────────────
// The same query surface, over method-carrying refs
// ─────────────────────────────────────────────────────────────────────────────

export interface QueryM<S extends Sources, O> {
  readonly [INV]: (o: O) => O
  readonly [ROW]: O

  select<P extends Projection>(f: (t: MRefsOf<S>, r: RelsNsM<S>) => P): QueryM<S, Project<P>>
  selectAll<A extends keyof S>(a: A): QueryM<S, SelectAt<S[A]>>

  where(f: (t: MRefsOf<S>) => Expr<boolean>): QueryM<S, O>
  groupBy(f: (t: MRefsOf<S>) => Projectable | readonly Projectable[]): QueryM<S, O>
  orderBy(f: (t: MRefsOf<S>) => Projectable | readonly Projectable[]): QueryM<S, O>
  limit(n: number): QueryM<S, O>
  offset(n: number): QueryM<S, O>

  innerJoin<H2 extends AnyHandle, A extends string>(
    t: H2,
    alias: A,
    on: (t: MRefsOf<S> & Record<A, MRefsAt<H2>>) => Expr<boolean>,
  ): QueryM<S & Record<A, H2>, O>

  leftJoin<H2 extends AnyHandle, A extends string>(
    t: H2,
    alias: A,
    on: (t: MRefsOf<S> & Record<A, MRefsAt<H2>>) => Expr<boolean>,
  ): QueryM<S & Record<A, H2>, O>

  $call<O2>(f: (q: this) => QueryM<S, O2>): QueryM<S, O2>

  execute(): Promise<O[]>
}

export interface ExecutorM {
  from<H extends AnyHandle, A extends string>(t: H, alias: A): QueryM<Record<A, H>, unknown>
  from<H extends AnyHandle>(t: H): QueryM<Record<H[typeof NAME] & string, H>, unknown>
}

/** Sub-queries hand out method refs too, so a relation projection is measured on the same arm. */
export interface SubQueryM<Sc extends AnySchema, N extends string, P extends Projection = MRefsIn<Sc, N>> {
  readonly [PRJ]: P
  where(f: (t: MRefsIn<Sc, N>) => Expr<boolean>): SubQueryM<Sc, N, P>
  orderBy(f: (t: MRefsIn<Sc, N>) => Projectable | readonly Projectable[]): SubQueryM<Sc, N, P>
  limit(n: number): SubQueryM<Sc, N, P>
  offset(n: number): SubQueryM<Sc, N, P>
  select<P2 extends Projection>(f: (t: MRefsIn<Sc, N>) => P2): SubQueryM<Sc, N, P2>
}

/** The relation namespace, unchanged from arm A except that it hands out method-carrying refs. */
export type RelsNsM<S extends Sources> = { [A in keyof S]: RelPickersM<S[A]> }

export type RelPickersM<H extends AnyHandle> = {
  [K in keyof RelsAtH<H>]: RelPickerM<H[typeof SCHEMA], RelsAtH<H>[K]>
}

interface RelPickerM<Sc extends AnySchema, M extends RelMeta> {
  many<P extends Projection>(
    f: (q: SubQueryM<Sc, M['to']>) => SubQueryM<Sc, M['to'], P>,
  ): Expr<RelOut<M, Project<P>>>
}

type ColsIn<Sc extends AnySchema, N extends string> = TableOf<Sc, N>[typeof COLS &
  keyof TableOf<Sc, N>]

export type MRefsIn<Sc extends AnySchema, N extends string> = {
  readonly [K in keyof ColsIn<Sc, N>]: MRef<N, K & string, ColsIn<Sc, N>[K]>
}
