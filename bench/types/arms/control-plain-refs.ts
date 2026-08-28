/**
 * WS0 **measurement control**, not an arm.
 *
 * `f1-methods.ts` reaches a table's columns through a mapped type over `[COLS]` rather than
 * through the table's pre-computed `[REFS]` slot, because a prototype cannot change what
 * `pgTable` bakes in. A real arm-B implementation *would* bake the operator methods into `[REFS]`
 * and pay only for the methods. So a straight `f1 − base` comparison charges arm B twice: once
 * for the methods, and once for rebuilding a record the baseline gets for free.
 *
 * This module is `f1-methods.ts` with the operator intersection removed and nothing else changed.
 * Differencing against it cancels the rebuild on both sides:
 *
 *   whole-f1 − whole-plain  = what the METHODS cost, which is the fork
 *   whole-plain − whole-base = the rebuild artifact, which is not
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
import type { INV, PRJ, ROW } from '../../../packages/pg-prime/src/query/symbols.js'

type ColsAt<H extends AnyHandle> = TableAt<H>[typeof COLS & keyof TableAt<H>]

export type PRefsAt<H extends AnyHandle> = {
  readonly [K in keyof ColsAt<H>]: Ref<H[typeof NAME] & string, K & string, ColsAt<H>[K]>
}

export type PRefsOf<S extends Sources> = { [A in keyof S]: PRefsAt<S[A]> }

type ColsIn<Sc extends AnySchema, N extends string> = TableOf<Sc, N>[typeof COLS &
  keyof TableOf<Sc, N>]

export type PRefsIn<Sc extends AnySchema, N extends string> = {
  readonly [K in keyof ColsIn<Sc, N>]: Ref<N, K & string, ColsIn<Sc, N>[K]>
}

export interface SubQueryP<
  Sc extends AnySchema,
  N extends string,
  P extends Projection = PRefsIn<Sc, N>,
> {
  readonly [PRJ]: P
  where(f: (t: PRefsIn<Sc, N>) => Expr<boolean>): SubQueryP<Sc, N, P>
  orderBy(f: (t: PRefsIn<Sc, N>) => Projectable | readonly Projectable[]): SubQueryP<Sc, N, P>
  limit(n: number): SubQueryP<Sc, N, P>
  offset(n: number): SubQueryP<Sc, N, P>
  select<P2 extends Projection>(f: (t: PRefsIn<Sc, N>) => P2): SubQueryP<Sc, N, P2>
}

export type RelsNsP<S extends Sources> = { [A in keyof S]: RelPickersP<S[A]> }

export type RelPickersP<H extends AnyHandle> = {
  [K in keyof RelsAtH<H>]: RelPickerP<H[typeof SCHEMA], RelsAtH<H>[K]>
}

interface RelPickerP<Sc extends AnySchema, M extends RelMeta> {
  many<P extends Projection>(
    f: (q: SubQueryP<Sc, M['to']>) => SubQueryP<Sc, M['to'], P>,
  ): Expr<RelOut<M, Project<P>>>
}

export interface QueryP<S extends Sources, O> {
  readonly [INV]: (o: O) => O
  readonly [ROW]: O

  select<P extends Projection>(f: (t: PRefsOf<S>, r: RelsNsP<S>) => P): QueryP<S, Project<P>>
  selectAll<A extends keyof S>(a: A): QueryP<S, SelectAt<S[A]>>

  where(f: (t: PRefsOf<S>) => Expr<boolean>): QueryP<S, O>
  groupBy(f: (t: PRefsOf<S>) => Projectable | readonly Projectable[]): QueryP<S, O>
  orderBy(f: (t: PRefsOf<S>) => Projectable | readonly Projectable[]): QueryP<S, O>
  limit(n: number): QueryP<S, O>
  offset(n: number): QueryP<S, O>

  innerJoin<H2 extends AnyHandle, A extends string>(
    t: H2,
    alias: A,
    on: (t: PRefsOf<S> & Record<A, PRefsAt<H2>>) => Expr<boolean>,
  ): QueryP<S & Record<A, H2>, O>

  leftJoin<H2 extends AnyHandle, A extends string>(
    t: H2,
    alias: A,
    on: (t: PRefsOf<S> & Record<A, PRefsAt<H2>>) => Expr<boolean>,
  ): QueryP<S & Record<A, H2>, O>

  $call<O2>(f: (q: this) => QueryP<S, O2>): QueryP<S, O2>

  execute(): Promise<O[]>
}

export interface ExecutorPlain {
  from<H extends AnyHandle, A extends string>(t: H, alias: A): QueryP<Record<A, H>, unknown>
  from<H extends AnyHandle>(t: H): QueryP<Record<H[typeof NAME] & string, H>, unknown>
}
