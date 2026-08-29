/**
 * The `Query<S, O>` type engine — design/04 §2 on the real `src/schema` types, with the three
 * WS0 forks resolved (design/09 §3.0):
 *
 *   F1 operators      → free functions, type-class gated (`./ops-free.ts`)   [04 §2.2]
 *   F2 nested literal → `nest({...})` required                              [04 §2.1]
 *   F3 relations      → accessors on the table scope, next to the columns    [03 §2.3]
 *
 * **WS4 supplied the runtime.** `Query`, `GroupedQuery`, `SetQuery`, `Executor`, `nest` and the
 * write builders are implemented in `./{select,insert,update,delete,cte,scope,window,run}.ts` and
 * re-exported at the bottom of this file. The only member still declared without one is the
 * relation picker (`RelPickers`), which is WS5 — calling one throws a `BuilderError` naming the
 * workstream rather than failing as `undefined is not a function`.
 *
 * ── The four cost rules everything below obeys (design/04 §1.3, §1.5, §3.3) ───────────────────
 *
 *  1. The schema is reached by **indexed access only** — `TableOf`, `RefsAt`, `RelsAt`. Never a
 *     conditional, never a distributed union, never a template-literal parse of an alias. This is
 *     what makes cost linear in *query* size and flat in schema size, which is the one property
 *     `kysely.md` §1.9 shows Kysely does not have.
 *  2. Row shapes and the ref record are **properties of an instantiated interface**, so they are
 *     computed at most once per table per program and then cached.
 *  3. Anything conditional lives on a **rare** path and behind its own stage interface, so the
 *     common path never instantiates it. That is why `groupBy` returns `GroupedQuery` rather than
 *     putting its guard on `Query.select`, and why left-join nullability costs one conditional per
 *     *scope* (`[N] extends [never]`) rather than one per alias.
 *  4. Public constraints are the short `Any*` interfaces, so the *expected* half of a type error
 *     prints as a short name (design/04 §4.3).
 */

import type { AnyCodec, CodecIn, CodecOut, CodecPg } from '../codec/index.js'
import type {
  COLS,
  META,
  NAME,
  OUT,
  REFS,
  RELS,
  SCHEMA,
  SEL,
  SRC,
  TABLES,
} from '../schema/index.js'
import type { DeleteNode, InsertNode, SelectNode, SetOpNode, UpdateNode } from '../compile/ast.js'
import type { Compiled } from '../compile/contract.js'
import type { AnyTable, Handle } from '../schema/index.js'
import type { WindowFn, WindowLiteral, WindowSpec } from './window.js'
import type {
  AnyHandle,
  AnySchema,
  Defer,
  Projectable,
  Ref,
  RefRuntime,
  RelMeta,
  RelOut,
  RelsAt,
  SelAt,
  Simplify,
  TableOf,
  TableRuntime,
} from '../schema/index.js'
import type { OrmTypeError } from '../schema/index.js'
import type {
  AnyOperand,
  AvgOut,
  AvgPg,
  NumOperand,
  NumPg,
  OrderBy,
  SumOut,
  SumPg,
} from './ops.types.js'
import type {
  CteNameTakenMsg,
  ExecuteNeedsProjectionMsg,
  GroupByNeedsParentKeyMsg,
  HeterogeneousBulkMsg,
  IfDropsColumnMsg,
  SetOpColumnTypeMismatchMsg,
  SetOpExtraColumnMsg,
  SetOpMissingColumnMsg,
  SetOpNeedsProjectionMsg,
  SetOpNeedsSelectMsg,
} from './errors.js'
import type { AnyFragment } from '../sql/index.js'
import type { INV, PRJ, ROW } from './symbols.js'
import type { ExplainOptions, ExplainResult, StatementMode, StreamOptions } from './executor.js'
import type { PrepareOptions, PreparedQuery } from './prepared.js'
import type { RawQuery } from './raw.js'
import type { SqlSnapshot } from './terminals.js'

// ─────────────────────────────────────────────────────────────────────────────
// Reaching the schema — two indexed accesses, never a conditional (04 §1.5)
// ─────────────────────────────────────────────────────────────────────────────

/** The `Table` behind a handle. */
/**
 * The session layer's vocabulary (`07` §1, §3, §6). Types only, from `src/session/types.ts`, so
 * naming a handle costs no runtime import.
 */
import type {
  AccessMode,
  AdvisoryLock,
  AdvisoryLockOptions,
  AsyncDisposable_,
  CallOptions,
  IsolationLevel,
  ListenOptions,
  NoHandleEscape,
  NotificationHandler,
  RunCallOptions,
  Runnable,
  SavepointOptions,
  StreamCallOptions,
  Subscription,
  TxOptions,
} from '../session/types.js'
import type { CopyFromApi, CopyToApi } from '../session/handles.js'
import type { PoolStats } from '../errors/index.js'
import type { QueryHooks } from '../observe/index.js'
import type { DbDiagnosis, DiagnosePoolerOptions, PoolerDiagnosis } from '../pooler/index.js'

export type TableAt<H extends AnyHandle> = TableOf<H[typeof SCHEMA], H[typeof NAME]>

/**
 * The table's **pre-computed** `[REFS]` slot — computed at most once per table per program,
 * no matter how many queries touch it (04 §1.3, the load-bearing perf decision).
 */
export type RefsAt<H extends AnyHandle> = TableAt<H>[typeof REFS & keyof TableAt<H>]

/** The table's pre-flattened select row. */
export type SelectAt<H extends AnyHandle> = TableAt<H>[typeof SEL & keyof TableAt<H>]

/** The table's column-meta record — read by the `GROUP BY` guard, nothing else. */
export type ColsAtH<H extends AnyHandle> = TableAt<H>[typeof COLS & keyof TableAt<H>]

/**
 * The relation record declared for a handle's table.
 *
 * Relations live on the **schema** (`defineSchema(tables, rels)`), not on the `Table` — a
 * `pgTable(...)` is always `Table<N, C, {}>`. Reading them off the table would silently yield
 * `{}` and make every relation projection compile to nothing, so this goes through the registry.
 */
export type RelsAtH<H extends AnyHandle> = RelsAt<H[typeof SCHEMA], H[typeof NAME]>

/** Refs of a table named `N` inside schema `Sc` — the sub-query form of {@link RefsAt}. */
type RefsIn<Sc extends AnySchema, N extends PropertyKey> = TableOf<Sc, N>[typeof REFS &
  keyof TableOf<Sc, N>]

/** Relations of a table named `N` inside schema `Sc`. */
type RelsIn<Sc extends AnySchema, N extends PropertyKey> = RelsAt<Sc, N>

// ─────────────────────────────────────────────────────────────────────────────
// Expressions (04 §2.1–2.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Anything with a known output type and a place in the SQL tree.
 *
 * `P` is the PostgreSQL type name the expression *is*, so an operator's result can go straight
 * back into a class-gated operator: `ilike(jsonPathText(u.meta, ['a']), 'x%')` typechecks because
 * `jsonPathText` returns `Expr<string, 'text'>`. It defaults to `string`, which is the honest
 * answer for anything whose PG type we do not track (a `nest(...)` literal, an `asUnsafe`
 * fragment) and which no gate accepts.
 */
export interface Expr<T, P extends string = string> extends Projectable {
  readonly [OUT]: T
  readonly [SRC]: string
  readonly [META]: { readonly pg: P }
}

/** Structural operand: "something that yields a `T`", without claiming to be an `Expr`. */
export interface ExprOf<T> {
  readonly [OUT]: T
}

/** A value or anything that yields one — the right-hand side of every binary operator. */
export type Operand<T> = T | ExprOf<T>

/**
 * The real `sql` tag (`src/sql/fragment.ts`), re-exported so a query file imports one name.
 *
 * A bare `` sql`…` `` is **not** `Projectable`: you physically cannot put it in a projection
 * without choosing a codec. This is "`sql<T>` must carry a real codec, not a bare cast",
 * enforced structurally rather than by convention (04 §2.2). `.as(codec)` returns a
 * `TypedFragment`, which is `Projectable`, is an `Expr`, and — since WS3 — carries the codec's
 * name in the `pg` slot the operator gates read, so a fragment can be a class-specific operand.
 *
 * WS1 shipped a `declare`d stub here because `src/sql` and `src/query` had not met yet. They have.
 */
export { sql } from '../sql/index.js'
export type { AnyFragment, Fragment, SqlTag, TypedFragment } from '../sql/index.js'

// ─────────────────────────────────────────────────────────────────────────────
// The projection algebra — one mapped type, no conditionals (04 §2.1)
// ─────────────────────────────────────────────────────────────────────────────

/** A projection record. */
export type Projection = Record<string, Projectable>

/**
 * THE result-narrowing type: one indexed access per output key. Deliberately **not conditional
 * and not recursive** — affordable only because grouping goes through {@link nest} rather than
 * through bare nested object literals (fork F2, decided in design/09 §3.0).
 */
export type Project<P extends Projection> = Defer<Simplify<{ [K in keyof P]: P[K][typeof OUT] }>>

/**
 * `nest` / `nestNullable` — fork F2's grouping (04 §2.1, 03 §2.2).
 *
 * Declared in `./scope.ts`, which owns the runtime; re-exported at the bottom of this file so a
 * query still imports one name. The two things worth knowing here:
 *
 *  - Grouping is **pure**: `author: nest({ id: u.id })` compiles to the same columns as
 *    `authorId: u.id` would, and the object is assembled by the positional decoder. Zero SQL cost.
 *  - {@link nestNullable} nulls the **whole object**, not each field — `author: {...} | null`, not
 *    `author: { id: T | null }`. That is 03 §2.2's PORT of the one thing Drizzle gets right, and
 *    {@link ProjectPreJoin} below is how the type recovers each column's pre-join type exactly
 *    once. The runtime witnesses are the group's NOT NULL members whose alias was LEFT JOINed
 *    (`GroupPlan.witnesses`, chosen in `./projection.ts` — the type layer cannot see joins).
 *
 * **The `| null` is unconditional, the runtime is not** (T2, audit 2026-08-26). `nestNullable`
 * receives only the projection record, so its type cannot tell whether any member's alias was
 * actually left-joined; it always widens to `| null`. The runtime now can, and a group with no
 * left-joined member is never null at all. The two disagree only in the safe direction — a
 * caller writing `nestNullable` over columns nobody outer-joined gets a null check it will never
 * need, never a null it failed to check — so the gap is documented rather than closed: closing
 * it would mean threading per-alias join nullability into a fourth `Query` type parameter, the
 * cost design/04 §1.3 rule 3 forbids on the hot path. Use {@link nest} when nothing is
 * outer-joined and the `| null` is unwanted.
 */

/** {@link Project}, reading each key's pre-left-join type. Only ever instantiated by `nestNullable`. */
export type ProjectPreJoin<P extends Projection> = Defer<
  Simplify<{ [K in keyof P]: PreJoin<P[K]> }>
>

type PreJoin<X> = X extends { readonly [META]: { readonly t: infer T } }
  ? T
  : X[typeof OUT & keyof X]

// ─────────────────────────────────────────────────────────────────────────────
// Query scope (04 §2.3, 03 §2.3)
// ─────────────────────────────────────────────────────────────────────────────

/** Only the tables **in scope**. No `DB` parameter, no `keyof DB` on the hot path. */
export type Sources = Record<string, AnyHandle>

/** Maps over 1–4 entries. Column legality is ordinary property access. */
export type RefsOf<S extends Sources> = { [A in keyof S]: RefsAt<S[A]> }

/**
 * A column of a **left-joined** alias: same source, same key, same PG type class, but the read
 * type gains `| null` (03 §2.2).
 *
 * Written with guarded indexed accesses rather than `R extends Ref<infer A, infer K, infer M>`
 * so it stays a plain (non-conditional) type, and instantiated through {@link NullRefsAt}, which
 * depends only on the handle — so the whole nullable ref record for a table is computed once per
 * program and cached, exactly like the non-null one.
 */
export interface NullRef<R> {
  readonly [SRC]: R[typeof SRC & keyof R]
  readonly [NAME]: R[typeof NAME & keyof R]
  readonly [OUT]: R[typeof OUT & keyof R] | null
  readonly [META]: R[typeof META & keyof R]
  readonly $: RefRuntime
}

/** {@link RefsAt}, with every column nullable. */
export type NullRefsAt<H extends AnyHandle> = { [K in keyof RefsAt<H>]: NullRef<RefsAt<H>[K]> }

/** A whole row shape, with every column nullable. */
export type NullRow<T> = Defer<Simplify<{ [K in keyof T]: T[K] | null }>>

/**
 * Columns and relations in one object per alias, so `t.u.posts(…)` sits next to `t.u.email`
 * (design/03 §2.3). Merging the namespaces makes a relation named like a column a collision;
 * design/03 §4.1 already requires `defineSchema` to fail loudly on one (owed by WS5).
 *
 * `N` is the set of aliases that were **left-joined**. The `[N] extends [never]` split is the
 * whole cost of left-join nullability on a query that has no left join: one conditional per
 * scope instantiation, and the taken branch is byte-identical to the pre-WS1 `ScopeOf<S>`, so it
 * hits the same instantiation-cache entry.
 */
export type ScopeOf<S extends Sources, N = never> = [N] extends [never]
  ? { [A in keyof S]: RefsAt<S[A]> & AllRefs<RefsAt<S[A]>> & RelPickers<S[A]> }
  : {
      [A in keyof S]: ([A] extends [N]
        ? NullRefsAt<S[A]> & AllRefs<NullRefsAt<S[A]>>
        : RefsAt<S[A]> & AllRefs<RefsAt<S[A]>>) &
        RelPickers<S[A]>
    }

/**
 * `$all` — every column of one alias as a plain record of refs (`03` §2.1, §4.2 form (b)).
 *
 * `{ ...u.$all }` is `SELECT *` with an exact type, and `{ ...omit(u.$all, 'passwordHash') }` is
 * Prisma's `omit` for free, because the value is an ordinary frozen object and the type is an
 * ordinary record. Three properties are load-bearing:
 *
 *  - **A spread, not a group.** `03` §2.2's whole-object nullability is `nest`/`nestNullable`'s
 *    rule; a spread produces one output column per member, so a left-joined alias's `$all` is a
 *    record of `T | null` columns — `AllRefs<NullRefsAt<H>>` above — and never a `| null` object.
 *  - **One property, one instantiation.** `R` is always a record the scope already computed
 *    ({@link RefsAt} or {@link NullRefsAt}, both cached per table per program), so `$all` adds a
 *    third intersection member pointing at an existing instantiation rather than a new mapped
 *    type. Measured in `12 B`'s RESULT: 0 instantiations on all five per-query shapes.
 *  - **It is not a column.** A table whose TS keys include `$all` is rejected when its scope is
 *    built, because one of the two would silently hide the other.
 */
export interface AllRefs<R> {
  readonly $all: R
}

/**
 * The design/04 §2.4 spelling — relations as a *separate* callback parameter. Kept because
 * `bench/types/arms/base-04.ts` measures against it; the shipped `Query` uses {@link ScopeOf}.
 */
export type RelsNs<S extends Sources> = { [A in keyof S]: RelPickers<S[A]> }
// Exported only because `bench/types/arms/base-04.ts` imports it; nothing in `src` does. Deleting
// it would silently drop the F3 measurement's baseline arm, so it stays, documented as dead.

/**
 * The relation accessors of one handle — fork F3's half of the scope object.
 *
 * One conditional per *declared relation*, and only inside a scope that is actually instantiated:
 * a query that projects no relation never asks for these members, and TypeScript computes an
 * instantiated interface's property types lazily. That is the same lever `04` §1.3 pulls for
 * `Table[SEL]`, and it is why a nine-method accessor costs a query that ignores it nothing.
 */
export type RelPickers<H extends AnyHandle> = {
  [K in keyof RelsAtH<H>]: RelAccessor<H[typeof SCHEMA], RelsAtH<H>[K]>
}

/**
 * A to-many relation offers `.many()` and a to-one offers `.one()`, and neither offers the other.
 *
 * Splitting on `kind` rather than shipping both on one interface is what makes the *result* type
 * honest: `RelOut` already says a `many` is an array and an optional `one` is `T | null`, and an
 * accessor that offered `.one()` on a to-many would have to invent an answer for "which one".
 */
export type RelAccessor<Sc extends AnySchema, M extends RelMeta> = M['kind'] extends 'many'
  ? ManyRel<Sc, M>
  : OneRel<Sc, M>

/** `{ variant, strategy }` — `03` §2.3 points 1 and 5, chosen per relation projection. */
export interface RelOpts {
  /** `json` (default, order-preserving and cheaper) or `jsonb` (reorders keys, dedupes). */
  readonly variant?: 'json' | 'jsonb'
  /** `lateral` (default) or the correlated-subquery form, which is what a RETURNING list needs. */
  readonly strategy?: 'lateral' | 'subquery'
}

/**
 * The scalar half of a relation, available on **both** kinds and — unlike `.many()`/`.one()` —
 * never blocked by the `GROUP BY` guard, because a correlated aggregate needs no identifiable
 * parent row, only the grouping key it correlates on.
 */
export interface RelAggs<Sc extends AnySchema, M extends RelMeta> {
  /** `count(*)` over the related rows. `int8`, hence `bigint`, hence exact past 2^53. */
  count(): Expr<bigint, 'int8'>
  /**
   * `coalesce(sum(f), 0)` — never null, because an empty relation sums to zero rather than to
   * "no answer". The PG result type is PostgreSQL's, not the operand's: `sum(int4)` is `int8`,
   * `sum(int8)` and `sum(numeric)` are `numeric`.
   */
  sum<T, P extends NumPg>(
    f: (t: SubScope<Sc, M['to']>) => NumOperand<T, P>,
  ): Expr<SumOut<P>, SumPg<P>>
  /**
   * `avg(f)` over the related rows — **nullable**, unlike {@link RelAggs.sum}.
   *
   * `sum` coalesces to zero because an empty relation sums to zero; the average of no rows is not
   * zero, it is no answer, so the honest type is `| null`. The PG result type is PostgreSQL's:
   * `numeric` for every exact operand and `float8` for the two inexact ones (`fn.avg`'s table,
   * imported rather than restated).
   */
  avg<T, P extends NumPg>(
    f: (t: SubScope<Sc, M['to']>) => NumOperand<T, P>,
  ): Expr<AvgOut<P> | null, AvgPg<P>>
  /** `min(f)` over the related rows. The operand's own type, `| null` on an empty relation. */
  min<A extends AnyOperand>(f: (t: SubScope<Sc, M['to']>) => A): Expr<A[typeof OUT] | null>
  /** `max(f)` over the related rows. The operand's own type, `| null` on an empty relation. */
  max<A extends AnyOperand>(f: (t: SubScope<Sc, M['to']>) => A): Expr<A[typeof OUT] | null>
  /** `exists (select 1 from … where <correlation>)`. */
  exists(): Expr<boolean, 'bool'>
  /** MikroORM's `$some`: at least one related row satisfies the predicate. */
  some(f?: (t: SubScope<Sc, M['to']>) => Expr<boolean>): Expr<boolean, 'bool'>
  /** `$none`: no related row satisfies it. */
  none(f?: (t: SubScope<Sc, M['to']>) => Expr<boolean>): Expr<boolean, 'bool'>
  /**
   * `$every`, null-safely: `not exists (… and (p) is not true)`.
   *
   * The `is not true` is the whole difference from `not exists (… and not p)` — a predicate that
   * is NULL is neither true nor false, and only this spelling counts "unknown" as a failure.
   * Vacuously true on a parent with no related rows, which is what `NOT EXISTS` gives.
   */
  every(f: (t: SubScope<Sc, M['to']>) => Expr<boolean>): Expr<boolean, 'bool'>
}

export interface ManyRel<Sc extends AnySchema, M extends RelMeta> extends RelAggs<Sc, M> {
  /**
   * A nested one-to-many, **paginated per parent**: the `LIMIT` lives inside the lateral, so
   * `.limit(3)` is three rows for each parent and not three rows in total (`03` §2.3 point 4).
   */
  many<P extends Projection>(
    f: (q: SubQuery<Sc, M['to']>) => SubQuery<Sc, M['to'], P>,
    opts?: RelOpts,
  ): Expr<Project<P>[]>
  /** Every column of the related rows — `03` §4.2's entity form. */
  all(opts?: RelOpts): Expr<SelAt<Sc, M['to']>[]>
}

export interface OneRel<Sc extends AnySchema, M extends RelMeta> extends RelAggs<Sc, M> {
  /** `null` iff the relation was declared with `maybeOne`. */
  one<P extends Projection>(
    f: (q: SubQuery<Sc, M['to']>) => SubQuery<Sc, M['to'], P>,
    opts?: RelOpts,
  ): Expr<RelOut<M, Project<P>>>
  all(opts?: RelOpts): Expr<RelOut<M, SelAt<Sc, M['to']>>>
}

/**
 * A relation sub-query. Its own `where` / `orderBy` / `limit` are **per parent** (`03` §2.3).
 *
 * `P` is the projection so far, and it defaults to the child's own refs — so a sub-query that
 * never calls `.select()` still has an exact row type (every column), and `.many(q => q.limit(3))`
 * means what it looks like it means. Chaining after `.select()` keeps `P`, which is why filtering
 * and ordering can be written on either side of it.
 */
export interface SubQuery<
  Sc extends AnySchema,
  N extends string,
  P extends Projection = RefsIn<Sc, N>,
> {
  readonly [PRJ]: P
  where(f: (t: SubScope<Sc, N>) => Expr<boolean>): SubQuery<Sc, N, P>
  orderBy(f: (t: SubScope<Sc, N>) => OrderBy): SubQuery<Sc, N, P>
  limit(n: number): SubQuery<Sc, N, P>
  offset(n: number): SubQuery<Sc, N, P>
  select<P2 extends Projection>(f: (t: SubScope<Sc, N>) => P2): SubQuery<Sc, N, P2>
}

/**
 * What a relation sub-query's callbacks see: the child's columns **and** the child's own
 * relations, in one object.
 *
 * That is fork F3 again, held one level down — `p.comments.count()` sits next to `p.title`, which
 * is what makes `03` §2.3's "nesting inside nesting" read as one expression rather than as a
 * second lambda parameter threaded through every level.
 */
export type SubScope<Sc extends AnySchema, N extends string> = RefsIn<Sc, N> &
  AllRefs<RefsIn<Sc, N>> &
  RelPickersIn<Sc, N>

type RelPickersIn<Sc extends AnySchema, N extends string> = {
  [K in keyof RelsIn<Sc, N>]: RelAccessor<Sc, RelsIn<Sc, N>[K]>
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP BY guard (03 §2.3)
//
// A relation *row-set* projection compiles to `LEFT JOIN LATERAL … ON TRUE` correlated on the
// parent's primary key, so after a `GROUP BY` that key must still be in the grouping list or the
// parent row is not identifiable. Relation *aggregates* are scalar subqueries and are never
// guarded (they arrive in WS5).
//
// Everything here is instantiated only from `GroupedScope`, i.e. only on a query that actually
// called `.groupBy(...)`. An ungrouped query pays nothing.
// ─────────────────────────────────────────────────────────────────────────────

/** What `groupBy`'s callback may return. A sort direction is not a grouping key, so NOT `OrderBy`. */
export type Grouping = Projectable | readonly Projectable[]

type Flatten<G> = G extends readonly (infer E)[] ? E : G

/**
 * The grouping list as a set of `"alias.column"` strings. Distributes deliberately: one entry per
 * grouped ref. Anything without a `[NAME]` (a `sql` fragment, a `nest(...)`) contributes nothing,
 * which is correct — it cannot be a parent key.
 */
export type GroupKeysOf<G> = KeyOfRef<Flatten<G>>

type KeyOfRef<X> = X extends {
  readonly [SRC]: infer A extends string
  readonly [NAME]: infer K extends string
}
  ? `${A}.${K}`
  : never

/** The table a handle names — `[SRC]` on a ref is the TABLE name, not the query alias. */
type NameOf<H extends AnyHandle> = TableAt<H>[typeof NAME & keyof TableAt<H>] & string

/**
 * The columns of table `T` that appear in the grouping list.
 *
 * Keyed on the table name rather than the query alias, because refs are pre-computed per table
 * (rule 2 at the top of this file) and so carry the table name in `[SRC]`. The one consequence is
 * a self-join: grouping `p.id` also unlocks the relations of a second alias onto the same table.
 * That is the permissive direction, which is the same bias {@link PkOf} takes.
 */
type GroupedCols<T extends string, G extends string> = G extends `${T}.${infer K}` ? K : never

/**
 * The table's primary key, **as declared per column** (`ColMeta['pk']`).
 *
 * Deliberately incomplete, and deliberately biased: a composite key declared table-level with
 * `primaryKey(t.a, t.b)` in the extras callback is runtime-only, so this is `never` for such a
 * table — and `[never] extends [anything]` is true, so the guard allows it. An unmodelled key can
 * therefore never produce a false rejection; it only produces a missed one, which PostgreSQL
 * itself then catches (`column "lp.v" must appear in the GROUP BY clause`).
 */
export type PkOf<H extends AnyHandle> = {
  [K in keyof ColsAtH<H>]: ColsAtH<H>[K]['pk' & keyof ColsAtH<H>[K]] extends true ? K : never
}[keyof ColsAtH<H>]

/**
 * Every relation accessor of `H`, with its **row-set** members replaced by ones that still accept
 * the same callback but return the branded error.
 *
 * Typing them as the bare error object (`{ [K in keyof RelsAtH<H>]: E }`) was tried first and
 * measured: it makes the accessor non-callable, so the sub-query lambda's parameters lose their
 * contextual type and `noImplicitAny` adds two TS7006 lines of pure noise per call — 4 lines
 * instead of 2 for one mistake. Keeping the signature and moving the error to the *return* type
 * keeps the diagnostic to the sentence itself.
 *
 * `RelAggs` is inherited unchanged, which is `03` §2.3's own rule: a correlated aggregate is a
 * scalar subquery and needs no identifiable parent row, so `.count()` after a `GROUP BY` is
 * always fine. Only `.many()` / `.one()` / `.all()`, which hoist a lateral keyed on the parent,
 * are guarded.
 */
type BlockedRelPickers<H extends AnyHandle, E> = {
  [K in keyof RelsAtH<H>]: BlockedRel<H[typeof SCHEMA], RelsAtH<H>[K], E>
}

interface BlockedRel<Sc extends AnySchema, M extends RelMeta, E> extends RelAggs<Sc, M> {
  many<P extends Projection>(
    f: (q: SubQuery<Sc, M['to']>) => SubQuery<Sc, M['to'], P>,
    opts?: RelOpts,
  ): E
  one<P extends Projection>(
    f: (q: SubQuery<Sc, M['to']>) => SubQuery<Sc, M['to'], P>,
    opts?: RelOpts,
  ): E
  all(opts?: RelOpts): E
}

/** Either the ordinary relation pickers, or every one of them replaced by the branded error. */
type GroupGuard<A extends string, H extends AnyHandle, G extends string> = [PkOf<H>] extends [
  GroupedCols<NameOf<H>, G>,
]
  ? RelPickers<H>
  : BlockedRelPickers<H, OrmTypeError<GroupByNeedsParentKeyMsg<A, PkOf<H> & string>>>

/** {@link ScopeOf}, with the relation accessors guarded by the grouping list. */
export type GroupedScope<S extends Sources, N, G extends string> = [N] extends [never]
  ? { [A in keyof S]: RefsAt<S[A]> & AllRefs<RefsAt<S[A]>> & GroupGuard<A & string, S[A], G> }
  : {
      [A in keyof S]: ([A] extends [N]
        ? NullRefsAt<S[A]> & AllRefs<NullRefsAt<S[A]>>
        : RefsAt<S[A]> & AllRefs<RefsAt<S[A]>>) &
        GroupGuard<A & string, S[A], G>
    }

// ─────────────────────────────────────────────────────────────────────────────
// Set operations (03 §2.8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Anything that yields rows: a `Query`, a `GroupedQuery`, a `SetQuery` — **and** an
 * `InsertQuery`/`UpdateQuery`/`DeleteQuery` with a `RETURNING` list, which is what makes a
 * writable CTE (`db.with('moved', d => d.deleteFrom(t).returning(…))`) expressible.
 */
export interface RowSource<O> {
  readonly [ROW]: O
}

/**
 * Phantom brand: "this row source is a SELECT".
 *
 * `RowSource<O>` alone is too wide for a set operation and for `$if`: an `InsertQuery` satisfies
 * it structurally, so `select … union insert …` used to typecheck and then die in the compiler,
 * and `$if(flag, q => db.insertInto(other))` used to hand back a `Query` still claiming the
 * original scope `S`. One phantom slot, present on the three SELECT stages and nowhere else,
 * closes both at the cost of a single property check.
 */
export const SELECT_SOURCE = Symbol.for('pg-prime.SELECT_SOURCE')

/** A {@link RowSource} that is a `SELECT`: the only thing a set operation may take. */
export interface SelectSource<O> extends RowSource<O> {
  readonly [SELECT_SOURCE]: true
}

type Grow<B extends readonly unknown[]> = readonly [...B, unknown]
type BranchNo<B extends readonly unknown[]> = `${B['length']}`

/**
 * `never` when the branch matches, and the branded sentence when it does not.
 *
 * Three checks, in the order a human would look: a column the branch is missing, a column it has
 * that branch 1 does not, then a column whose type differs. `OrmTypeError` is spelled inline
 * rather than through an alias so the sentence actually prints — see the header of `errors.ts`.
 */
export type SetMismatch<A, B, N extends string> = [Exclude<keyof A, keyof B>] extends [never]
  ? [Exclude<keyof B, keyof A>] extends [never]
    ? [MismatchedCols<A, B>] extends [never]
      ? never
      : OrmTypeError<SetOpColumnTypeMismatchMsg<N, MismatchedCols<A, B> & string>>
    : OrmTypeError<SetOpExtraColumnMsg<N, Exclude<keyof B, keyof A> & string>>
  : OrmTypeError<SetOpMissingColumnMsg<N, Exclude<keyof A, keyof B> & string>>

type MismatchedCols<A, B> = {
  [K in keyof A]: B[K & keyof B] extends A[K] ? never : K
}[keyof A]

/**
 * The **return-position** sentinel, which is design/04 §4.1's mechanism as written: "instead of
 * failing with a constraint mismatch, resolve to a branded type carrying a sentence".
 *
 * The alternative — checking the branch in *parameter* position, as `q: RowSource<O2> &
 * SetBranch<…>` — was built first and measured: TypeScript then prints the whole argument type
 * twice (once in the TS2345 headline, once in the "Property '[ERR]' is missing" elaboration), and
 * a `Query` prints its entire `Schema<…>` type argument. That is **926 characters on 5.9.3 and
 * 1 319 on 7.0.2** for one missing column, against D9's 300. Resolving in return position makes
 * the same mistake `Property 'execute' does not exist on type 'OrmTypeError<"union branch 2 has
 * no column \"kind\"">'` — one line, ~120 characters, sentence included.
 *
 * The trade is that a set-op result which is *never used* reports nothing. That is acceptable:
 * an unused query is dead code, and every real use (`.execute()`, `.orderBy()`, assigning it to a
 * typed binding, passing it on) lands on the sentinel.
 */
export type SetResult<O, Q, B extends readonly unknown[]> = [Q] extends [SelectSource<unknown>]
  ? SetBranch<O, Q[typeof ROW & keyof Q], B>
  : OrmTypeError<SetOpNeedsSelectMsg>

/** {@link SetResult}, once the branch is known to be a `SELECT`. */
type SetBranch<O, O2, B extends readonly unknown[]> = [unknown] extends [O | O2]
  ? OrmTypeError<SetOpNeedsProjectionMsg>
  : [SetMismatch<O, O2, BranchNo<Grow<B>>>] extends [never]
    ? SetQuery<O, Grow<B>>
    : SetMismatch<O, O2, BranchNo<Grow<B>>>

/**
 * The set-op vocabulary, shared by every stage that can start one. `B` is a tuple whose length is
 * the number of branches so far, which is how the error sentence can say "branch 3" truthfully
 * for `a.union(b).union(c)` instead of always saying "branch 2".
 */
export interface SetOps<O, B extends readonly unknown[]> {
  union<Q extends RowSource<unknown>>(q: Q): SetResult<O, Q, B>
  unionAll<Q extends RowSource<unknown>>(q: Q): SetResult<O, Q, B>
  intersect<Q extends RowSource<unknown>>(q: Q): SetResult<O, Q, B>
  intersectAll<Q extends RowSource<unknown>>(q: Q): SetResult<O, Q, B>
  except<Q extends RowSource<unknown>>(q: Q): SetResult<O, Q, B>
  exceptAll<Q extends RowSource<unknown>>(q: Q): SetResult<O, Q, B>
}

/** The refs an `ORDER BY` on a set-op result may name: the *result* columns, not a scope. */
export type ResultRefs<O> = { [K in keyof O]-?: Expr<O[K]> }

/**
 * A finished set operation. Deliberately narrower than `Query`: PostgreSQL applies `ORDER BY`,
 * `LIMIT` and `OFFSET` to the whole set-op result, and there is no scope left to filter or join
 * against — so those methods are simply absent rather than present-and-wrong.
 */
export interface SetQuery<O, B extends readonly unknown[]> extends SetOps<O, B> {
  readonly [INV]: (o: O) => O
  readonly [ROW]: O
  readonly [SELECT_SOURCE]: true
  orderBy(f: (r: ResultRefs<O>) => OrderBy): SetQuery<O, B>
  limit(n: number): SetQuery<O, B>
  offset(n: number): SetQuery<O, B>
  as<A extends string>(name: A): CteHandle<A, O>
  toAst(): SetOpNode
  compile(): Compiled<O>
  execute(): Promise<O[]>
  executeTakeFirst(): Promise<O | undefined>
  prepare<P = Record<string, never>>(name?: string, opts?: PrepareOptions): PreparedQuery<P, O>
  stream(opts?: StreamOptions): AsyncIterable<O>
  explain(opts?: ExplainOptions): Promise<ExplainResult>
  toSQL(): SqlSnapshot
  /** See {@link Query.signal} — the same four setters, the same bag. */
  signal(signal: AbortSignal): SetQuery<O, B>
  /** §6.2. `SET LOCAL statement_timeout` inside a transaction; a client timer plus cancel outside. */
  timeout(ms: number): SetQuery<O, B>
  /** §1.5 layer 3's per-statement opt-out from the dev guard. */
  outsideTransaction(): SetQuery<O, B>
  /** §2.3's per-query override of `pgPrime({ statement })`. */
  withExecMode(mode: StatementMode): SetQuery<O, B>
}

// ─────────────────────────────────────────────────────────────────────────────
// Query
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `S` — aliases in scope. `O` — the result row. `N` — the aliases that were left-joined.
 *
 * Invariant in `O` (04 §3.3, kysely.md B.2): without `[INV]`, `let q = …; if (f) q = q.select(x)`
 * silently discards `x` from the result type with no error at all. Invariance turns the
 * imperative build-up pattern into a compile error, which is why `$if` and `$call` below have to
 * be ergonomic enough to absorb it.
 */
export interface Query<S extends Sources, O, N = never> extends SetOps<O, readonly [unknown]> {
  readonly [INV]: (o: O) => O
  /** One indexed access recovers the row type — `RowOf<Q>`, no conditional. */
  readonly [ROW]: O
  readonly [SELECT_SOURCE]: true

  select<P extends Projection>(f: (t: ScopeOf<S, N>) => P): Query<S, Project<P>, N>
  /** Every column of one alias. Nullable as a whole when that alias was left-joined. */
  selectAll<A extends keyof S>(
    a: A,
  ): Query<S, [A] extends [N] ? NullRow<SelectAt<S[A]>> : SelectAt<S[A]>, N>

  where(f: (t: ScopeOf<S, N>) => Expr<boolean>): Query<S, O, N>
  orderBy(f: (t: ScopeOf<S, N>) => OrderBy): Query<S, O, N>
  limit(n: number): Query<S, O, N>
  offset(n: number): Query<S, O, N>

  distinct(): Query<S, O, N>
  /** `distinct on (…)` — PG-only, and what makes "latest row per group" need no window (03 §2.8). */
  distinctOn(f: (t: ScopeOf<S, N>) => Grouping): Query<S, O, N>
  /**
   * A named window, shared by every `over(x, 'name')` in the projection (03 §2.8).
   *
   * `name` is a bare `string`, and so is `over(e, 'name')`'s second argument: threading the
   * declared window names would need a **fourth** `Query` type parameter carried through every
   * method's return type, which is exactly the kind of cost design/04 §1.3 rule 3 forbids on the
   * hot path — every query in the program would pay for a feature used by a handful. The runtime
   * throws a `BuilderError` naming the undeclared window instead, and `over(e, spec)`'s object
   * form needs no name at all.
   */
  window(
    name: string,
    f: (t: ScopeOf<S, N>) => WindowSpec | WindowLiteral | WindowFn,
  ): Query<S, O, N>
  /** Row locking. `{ wait: 'skip locked' }` is what makes a queue workload possible (03 §2.8). */
  forUpdate(opts?: LockOpts<keyof S & string>): Query<S, O, N>

  /**
   * Moves to the {@link GroupedQuery} stage, whose scope carries the relation guard. Note the
   * order this guards: a `.select(…)` made *after* `.groupBy(…)` is checked; one made before it
   * is not, because `Query` does not carry the projection (design/09 §3.1 records the gap).
   */
  groupBy<G extends Grouping>(f: (t: ScopeOf<S, N>) => G): GroupedQuery<S, O, N, GroupKeysOf<G>>

  innerJoin<H2 extends AnyHandle, A extends string>(
    t: H2,
    alias: A,
    on: (t: ScopeOf<S, N> & Record<A, RefsAt<H2>>) => Expr<boolean>,
  ): Query<S & Record<A, H2>, O, N>
  /** The two-argument form: the alias defaults to the source's own key (03 §2.2). */
  innerJoin<H2 extends AnyHandle>(
    t: H2,
    on: (t: ScopeOf<S, N> & Record<H2[typeof NAME] & string, RefsAt<H2>>) => Expr<boolean>,
  ): Query<S & Record<H2[typeof NAME] & string, H2>, O, N>

  /** Widens `S` *and* marks `A` nullable, so every ref off it reads `T | null` (03 §2.2). */
  leftJoin<H2 extends AnyHandle, A extends string>(
    t: H2,
    alias: A,
    on: (t: ScopeOf<S, N> & Record<A, RefsAt<H2>>) => Expr<boolean>,
  ): Query<S & Record<A, H2>, O, N | A>
  leftJoin<H2 extends AnyHandle>(
    t: H2,
    on: (t: ScopeOf<S, N> & Record<H2[typeof NAME] & string, RefsAt<H2>>) => Expr<boolean>,
  ): Query<S & Record<H2[typeof NAME] & string, H2>, O, N | (H2[typeof NAME] & string)>

  /**
   * `right join` — the mirror of {@link Query.leftJoin}, and the mirror is the whole type-level
   * move: it is **every alias already in scope** that gains `| null`, not the new one, because the
   * rows that survive are the new table's.
   *
   * The witness mechanism `nest`/`nestNullable` uses is mirrored the same way at runtime
   * (`SelectBuilder`'s outer-join set). One consequence is refused rather than typed: a right or
   * full join added *after* `.select(...)` would retroactively null a column the projection has
   * already fixed the type of, so the builder throws a `BuilderError` naming the order to write
   * instead. See `09` §3.4's note on `compileProjection`, which this closes.
   */
  rightJoin<H2 extends AnyHandle, A extends string>(
    t: H2,
    alias: A,
    on: (t: ScopeOf<S, N> & Record<A, RefsAt<H2>>) => Expr<boolean>,
  ): Query<S & Record<A, H2>, O, N | (keyof S & string)>
  rightJoin<H2 extends AnyHandle>(
    t: H2,
    on: (t: ScopeOf<S, N> & Record<H2[typeof NAME] & string, RefsAt<H2>>) => Expr<boolean>,
  ): Query<S & Record<H2[typeof NAME] & string, H2>, O, N | (keyof S & string)>

  /** `full join` — both sides may be missing, so both sides' refs are nullable. */
  fullJoin<H2 extends AnyHandle, A extends string>(
    t: H2,
    alias: A,
    on: (t: ScopeOf<S, N> & Record<A, RefsAt<H2>>) => Expr<boolean>,
  ): Query<S & Record<A, H2>, O, N | (keyof S & string) | A>
  fullJoin<H2 extends AnyHandle>(
    t: H2,
    on: (t: ScopeOf<S, N> & Record<H2[typeof NAME] & string, RefsAt<H2>>) => Expr<boolean>,
  ): Query<
    S & Record<H2[typeof NAME] & string, H2>,
    O,
    N | (keyof S & string) | (H2[typeof NAME] & string)
  >

  /**
   * `cross join` — the Cartesian product, and therefore the one join with **no** `on`.
   *
   * There is no predicate parameter at all rather than an optional one: PostgreSQL rejects
   * `cross join … on …` (42601) and the emitter refuses to drop a predicate silently, so a
   * caller who has a predicate wants {@link Query.innerJoin}.
   */
  crossJoin<H2 extends AnyHandle, A extends string>(t: H2, alias: A): Query<S & Record<A, H2>, O, N>
  crossJoin<H2 extends AnyHandle>(t: H2): Query<S & Record<H2[typeof NAME] & string, H2>, O, N>

  /**
   * `inner join lateral (select …) as "alias" on …` (03 §2.2).
   *
   * `sub` is a select builder — or a callback that is handed **this query's own scope**, which is
   * what makes the sub-query correlated: `q.innerJoinLateral(t => db.from(h.posts).where(p =>
   * eq(p.authorId, t.users.id)).select(…), 'recent', …)`. The alias becomes an ordinary source, so
   * its columns are reached as `t.recent.x` with the sub-query's own codecs.
   *
   * `on` is optional and defaults to `ON TRUE`, which is the usual shape for a lateral: the
   * correlation lives inside the sub-query, not in the join condition.
   */
  innerJoinLateral<O2, A extends string>(
    sub: SelectSource<O2> | ((t: ScopeOf<S, N>) => SelectSource<O2>),
    alias: A,
    on?: (t: ScopeOf<S, N> & Record<A, RefsAt<CteHandle<A, O2>>>) => Expr<boolean>,
  ): Query<S & Record<A, CteHandle<A, O2>>, O, N>

  /** {@link Query.innerJoinLateral}, with the lateral's own alias nullable. */
  leftJoinLateral<O2, A extends string>(
    sub: SelectSource<O2> | ((t: ScopeOf<S, N>) => SelectSource<O2>),
    alias: A,
    on?: (t: ScopeOf<S, N> & Record<A, RefsAt<CteHandle<A, O2>>>) => Expr<boolean>,
  ): Query<S & Record<A, CteHandle<A, O2>>, O, N | A>

  /** Type-preserving composition. The primitive Kysely users already reach for. */
  $call<O2>(f: (q: this) => Query<S, O2, N>): Query<S, O2, N>

  /**
   * kysely.md Appendix B.1, PORT. Kysely always returns `Partial`; with the literal-condition
   * overloads we only have to when the condition really is a runtime `boolean`.
   *
   * This is the one deliberate exception to design/04 §4's "never overload a hot-path builder
   * method" — `$if` is a composition helper, not a hot path, and design/03 §1.5 specifies the
   * three signatures by name.
   */
  $if<O2>(cond: true, f: (q: this) => Query<S, O2, N>): Query<S, O2, N>
  $if<O2>(cond: false, f: (q: this) => Query<S, O2, N>): Query<S, O, N>
  $if<O2>(cond: boolean, f: (q: this) => Query<S, O2, N>): IfResult<S, O, O2, N>

  /**
   * The query as a scalar subquery: `(select max(...) from ... where ...)` (03 §2.8).
   *
   * `| null` is not defensive: a scalar subquery over **zero rows** is SQL NULL, whatever the
   * projected column's own nullability says. `(select max(v) from t where false)` is NULL for a
   * `NOT NULL` `v`, so the row type has to admit it.
   */
  asScalar(): Expr<O[keyof O] | null>
  /** The query as a derived table, usable anywhere a handle is (03 §2.8). */
  as<A extends string>(name: A): CteHandle<A, O>

  /** Pure and deterministic; the same builder always produces the same tree (03 §1.3). */
  toAst(): SelectNode
  /** Memoised on the instance — a builder cannot change, so the memo cannot go stale (03 §1.4a). */
  compile(): Compiled<O>
  execute: Selected<O, () => Promise<O[]>>
  /** The first row, or `undefined`. Same SQL as `execute()`, byte for byte (09 §3.6). */
  executeTakeFirst: Selected<O, () => Promise<O | undefined>>
  /**
   * A reusable compiled artifact with typed holes (03 §1.4b).
   *
   * `P` is written by hand — `.prepare<{ email: string }>('users_by_email')` — and checked against
   * the declared `placeholder(...)` names at `execute()`. Linking the two statically would need a
   * fourth type parameter on `Query`, which `04` §1.3 rule 3 rules out; `./prepared.ts` records
   * the measurement.
   */
  prepare: Selected<
    O,
    <P = Record<string, never>>(name?: string, opts?: PrepareOptions) => PreparedQuery<P, O>
  >
  /** Rows off a transaction-scoped server-side cursor (07 §6.3). Back-pressure is your `await`. */
  stream: Selected<O, (opts?: StreamOptions) => AsyncIterable<O>>
  explain(opts?: ExplainOptions): Promise<ExplainResult>
  /** The SQL and the encoded binds. Never throws, including on an unfilled placeholder. */
  toSQL(): SqlSnapshot
  /**
   * `07` §6.1/§6.2's per-statement options, on the builder — the spelling the design document
   * uses (`db.select(...).signal(s)`), reaching the same `RunOptions` the handle path threads.
   *
   * Thin setters: the SQL is unchanged (the tier-0 goldens assert it byte for byte) and there is
   * no second execution path. Precedence is call > builder > handle, so
   * `db.run(q.timeout(250), { timeoutMs: 50 })` runs at 50 ms.
   */
  signal(signal: AbortSignal): Query<S, O, N>
  /** §6.2. `SET LOCAL statement_timeout` inside a transaction; a client timer plus cancel outside. */
  timeout(ms: number): Query<S, O, N>
  /** §1.5 layer 3's per-statement opt-out from the dev guard. */
  outsideTransaction(): Query<S, O, N>
  /** §2.3's per-query override of `pgPrime({ statement })`. */
  withExecMode(mode: StatementMode): Query<S, O, N>
}

/**
 * `.execute()` (and every set operation) needs a projection first.
 *
 * `db.from(users).execute()` used to typecheck as `Promise<unknown[]>` and emit `select *`, which
 * is the one shape whose result the codec layer cannot decode by position. One conditional, on a
 * property nothing reads until the query is actually run.
 */
type Selected<O, T> = [unknown] extends [O] ? OrmTypeError<ExecuteNeedsProjectionMsg> : T

/**
 * `$if(boolean, f)`, typed honestly.
 *
 * Kysely's formula — `O & Partial<Omit<O2, keyof O>>` — assumes `select()` is **additive**. Ours
 * *replaces* (`select.ts`), so `.select({id}).$if(flag, q => q.select({email}))` used to be typed
 * `{ id; email? }` while the SQL selects only `email` when the flag is set: `id` is then missing
 * at runtime from a type that says it is always there.
 *
 * The fix is the return-position sentinel `SetResult` already uses, and for the same measured
 * reason (checking the branch in *parameter* position prints the whole `Query<Schema<…>>` twice).
 * When the branch keeps every existing key, Kysely's formula is exactly right and is used
 * verbatim; when it does not, the query resolves to a one-line sentence naming the dropped column.
 */
export type IfResult<S extends Sources, O, O2, N> = [Exclude<keyof O, keyof O2>] extends [never]
  ? Query<S, Defer<Simplify<O & Partial<Omit<O2, keyof O>>>>, N>
  : OrmTypeError<IfDropsColumnMsg<Exclude<keyof O, keyof O2> & string>>

/**
 * The stage a `.groupBy(...)` lands in. `G` is the grouping list as `"alias.column"` strings.
 *
 * A separate interface is not stylistic: it is what keeps the guard's conditionals off every
 * ungrouped query in the program (rule 3 at the top of this file), and it is design/04 §4's
 * "named interfaces for every builder stage" — errors print `GroupedQuery<…>`, not a method body.
 */
export interface GroupedQuery<S extends Sources, O, N, G extends string> extends SetOps<
  O,
  readonly [unknown]
> {
  readonly [INV]: (o: O) => O
  readonly [ROW]: O
  readonly [SELECT_SOURCE]: true

  select<P extends Projection>(
    f: (t: GroupedScope<S, N, G>) => P,
  ): GroupedQuery<S, Project<P>, N, G>
  having(f: (t: GroupedScope<S, N, G>) => Expr<boolean>): GroupedQuery<S, O, N, G>
  orderBy(f: (t: GroupedScope<S, N, G>) => OrderBy): GroupedQuery<S, O, N, G>
  limit(n: number): GroupedQuery<S, O, N, G>
  offset(n: number): GroupedQuery<S, O, N, G>
  $call<O2>(f: (q: this) => GroupedQuery<S, O2, N, G>): GroupedQuery<S, O2, N, G>

  window(
    name: string,
    f: (t: GroupedScope<S, N, G>) => WindowSpec | WindowLiteral | WindowFn,
  ): GroupedQuery<S, O, N, G>
  /**
   * No `asScalar()` here, deliberately: a grouped query returns one row *per group*, and
   * `(select … group by …)` in a scalar position raises 21000 the moment there are two. The
   * ungrouped aggregate — `db.from(posts).select(p => ({ v: fn.max(p.createdAt) }))` — is a
   * `Query`, and that is 03 §2.8's example.
   */
  as<A extends string>(name: A): CteHandle<A, O>
  toAst(): SelectNode
  compile(): Compiled<O>
  execute: Selected<O, () => Promise<O[]>>
  executeTakeFirst: Selected<O, () => Promise<O | undefined>>
  prepare: Selected<
    O,
    <P = Record<string, never>>(name?: string, opts?: PrepareOptions) => PreparedQuery<P, O>
  >
  stream: Selected<O, (opts?: StreamOptions) => AsyncIterable<O>>
  explain(opts?: ExplainOptions): Promise<ExplainResult>
  toSQL(): SqlSnapshot
  /** See {@link Query.signal} — the same four setters, the same bag. */
  signal(signal: AbortSignal): GroupedQuery<S, O, N, G>
  /** §6.2. `SET LOCAL statement_timeout` inside a transaction; a client timer plus cancel outside. */
  timeout(ms: number): GroupedQuery<S, O, N, G>
  /** §1.5 layer 3's per-statement opt-out from the dev guard. */
  outsideTransaction(): GroupedQuery<S, O, N, G>
  /** §2.3's per-query override of `pgPrime({ statement })`. */
  withExecMode(mode: StatementMode): GroupedQuery<S, O, N, G>
}

/** One indexed access. `InferResult<Q>` is the array form. */
export type RowOf<Q extends AnyQuery> = Q[typeof ROW]
export type InferResult<Q extends AnyQuery> = Q[typeof ROW][]

/** Minimal `Any` supertype (04 §3.3) — an O(1) constraint check. */
export interface AnyQuery {
  readonly [INV]: any
  readonly [ROW]: any
}

// ─────────────────────────────────────────────────────────────────────────────
// CTEs (03 §2.7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A CTE is modelled as an ordinary table handle over a **synthetic one-table schema**. That is
 * the whole trick: `RefsAt`, `SelectAt`, `RelsAtH`, `ScopeOf` and every operator work on it
 * unchanged, with **no conditional added to the hot path** to ask "is this alias a CTE?".
 *
 * What flows through, and what does not:
 *  - the *codec* does, in the sense design/03 §2.7 means it — `recent.amount` reads `string`
 *    because `numeric` decodes to `string`, and Kysely cannot do this because it re-parses a
 *    column list out of a string;
 *  - the *PG type class* does not. `pg` is `any` here, so a CTE column accepts any class-gated
 *    operator. Deliberate and contained: recovering it needs the projection record `P`, which
 *    would mean a fourth `Query` type parameter carried through every method. Recorded in
 *    design/04 §5 with a probe; revisit in WS4 when `.with()` gets a runtime.
 */
export interface CteColMeta<T> {
  readonly t: T
  readonly pg: any
  readonly opt: false
  readonly ro: false
  readonly pk: false
}

export interface CteTable<N extends string, O> {
  readonly [NAME]: N
  readonly [COLS]: { readonly [K in keyof O]-?: CteColMeta<O[K]> }
  readonly [REFS]: { readonly [K in keyof O]-?: Ref<N, K & string, CteColMeta<O[K]>> }
  readonly [SEL]: Defer<Simplify<{ [K in keyof O]-?: O[K] }>>
  readonly [RELS]: {}
  readonly $: TableRuntime
}

export interface CteSchema<N extends string, O> {
  readonly [TABLES]: { readonly [K in N]: CteTable<N, O> }
  /** Keyed, not `{}`: `RelsAt` of an absent key is `never`, and `keyof never` is not `never`. */
  readonly [RELS]: { readonly [K in N]: {} }
}

export interface CteHandle<N extends string, O> {
  readonly [SCHEMA]: CteSchema<N, O>
  readonly [NAME]: N
  readonly $: TableRuntime
}

/** `db.from(...)`. */
export interface Executor {
  from<H extends AnyHandle, A extends string>(t: H, alias: A): Query<Record<A, H>, unknown>
  from<H extends AnyHandle>(t: H): Query<Record<H[typeof NAME] & string, H>, unknown>
  with<N extends string, O2>(
    name: N,
    f: (d: Executor) => RowSource<O2>,
    opts?: WithOpts,
  ): CteExecutor<Record<N, CteHandle<N, O2>>>
  /**
   * `with recursive "name" as (base union all step)` — `12` decision 17.
   *
   * The row type is fixed by `base`, and `step` is handed the CTE's own handle typed by it. That
   * is deliberately **not** the self-referential row typing `03` §5 punts: nothing here infers a
   * fixed point, so the cost is one method on an interface and zero instantiations for a query
   * that does not call it (measured in `12 B`'s RESULT). A `step` whose projection disagrees with
   * `base` is a compile error at the callback's return, which is where the reader wrote it.
   */
  withRecursive<N extends string, O2>(
    name: N,
    base: (d: Executor) => SelectSource<O2>,
    step: (d: Executor, self: CteHandle<N, O2>) => SelectSource<O2>,
    opts?: RecursiveOpts,
  ): CteExecutor<Record<N, CteHandle<N, O2>>>
  /**
   * A hand-written FROM item with an explicit column→codec map — `03` §5's named v1 workaround for
   * set-returning functions the builder has no DSL for (`jsonb_to_recordset`, `xmltable`, a
   * `VALUES` list nobody wants typed).
   *
   * `shape` is the whole contract: the keys become the emitted column-alias list *and* the row's
   * keys, and each codec decodes its column, so the result is as exactly typed and as fully
   * decoded as a table's. `columnTypes: true` emits a column **definition** list
   * (`("id" bigint, …)`, from the same codecs' `sqlName`s) for a function that returns `record`,
   * which is the one thing `jsonb_to_recordset` cannot do without.
   */
  fromRaw<C extends Record<string, AnyCodec>, A extends string = 'raw'>(
    frag: AnyFragment,
    shape: C,
    opts?: FromRawOpts<A>,
  ): Query<Record<A, CteHandle<A, RawShape<C>>>, unknown>

  insertInto<H extends AnyHandle>(t: H): InsertQuery<H, never, {}>
  update<H extends AnyHandle>(t: H): UpdateQuery<H, never, never>
  deleteFrom<H extends AnyHandle>(t: H): DeleteQuery<H, never>

  /**
   * The fragment-only statement (`03` §1.4c) — the one path whose result OIDs only the server
   * knows, and therefore the only one the description cache serves. Rows are keyed by field name
   * and typed `unknown`, decoded by OID. See `./raw.ts` for what it deliberately lacks.
   */
  sql(strings: TemplateStringsArray, ...values: readonly unknown[]): RawQuery
}

/**
 * **Anything you can run a query against** (`07` §1.3). Helper functions should take THIS.
 *
 * `db.h.users` rather than the bare `users` from the schema file: `03` §2 sketches `db.from(users)`,
 * but WS1 typed the builder against `AnyHandle` (a `[SCHEMA]` + `[NAME]` pair) rather than against
 * `Table`, because relations live on the schema and a bare table would silently have none. The
 * handle is the thing that knows which schema it belongs to; `h` is where they live.
 *
 * Two divergences from `07` §1.3's listing, both inherited from `03`'s as-built builder:
 *
 *  - the query entry points are `from` / `insertInto` / `update` / `deleteFrom` (on {@link Executor}),
 *    not `select` / `insert` / `update` / `delete` — `03` §2's spelling, which every golden uses;
 *  - `run` / `explain` / `stream` accept anything that compiles (a builder, a prepared query, or a
 *    `Compiled`), which is strictly wider than `07`'s `CompiledQuery<T> | Query<T>`.
 */
export interface Queryable<Sc extends AnySchema> extends Executor {
  readonly h: { readonly [K in keyof Sc[typeof TABLES] & string]: Handle<Sc, K> }

  /** `'db' | 'tx' | 'session'`. The discriminant that makes the three mutually non-assignable. */
  readonly kind: 'db' | 'tx' | 'session'

  /** The schema this handle was built from. */
  readonly schema: Sc

  /** Execute an already-built query (`07` §1.3, §2.5). */
  run<O>(q: Runnable<O>, opts?: RunCallOptions): Promise<O[]>

  /** `EXPLAIN` any query, with `07` §7.5's rollback rail for a mutating statement under `analyze`. */
  explain<O>(q: Runnable<O>, opts?: ExplainOptions): Promise<ExplainResult>

  /** Server-side cursor as an async iterable (`07` §6.3). Transaction-scoped, `WITHOUT HOLD`. */
  stream<O>(q: Runnable<O>, opts?: StreamCallOptions): AsyncIterable<O>

  /** The same cursor, one array per `FETCH` (decision 10 of design/12 §1). */
  streamBatches<O>(q: Runnable<O>, opts?: StreamCallOptions): AsyncIterable<O[]>

  /**
   * `pg_notify($1, $2)` — works in **every** pooler profile, including the two where `listen()`
   * does not. The matrix is asymmetric and this is the asymmetry.
   */
  notify(channel: string, payload?: string): Promise<void>

  /**
   * The same handle with per-statement defaults folded in: `db.withOptions({ signal }).from(...)`.
   *
   * `07` §6.1 spells `signal` and `timeout` as builder methods; they live here because `Query` and
   * `src/query/select.ts` belong to another workstream. `run(q, { signal })` is the other spelling.
   */
  withOptions(opts: CallOptions): Queryable<Sc>

  /** `07` §1.5 layer 3's per-call opt-out from the dev guard, for a deliberate out-of-band query. */
  outsideTransaction(): Queryable<Sc>

  copyFrom: CopyFromApi
  copyTo: CopyToApi
}

/**
 * @deprecated Renamed to {@link Queryable} (`07` §1.3, decision 3 of design/12 §1). The alias stays
 * for one release.
 */
export type SchemaExecutor<Sc extends AnySchema> = Queryable<Sc>

/**
 * **The root handle.** Pool-backed; every statement may land on a different backend.
 *
 * `Db`, `Tx` and `Session` are mutually **non-assignable** — none is a subtype of the others, only
 * {@link Queryable} is shared — and that is load-bearing (`07` §1.5 layer 2): a function that
 * declares `tx: Tx<S>` cannot be handed the root `db`, which kills a large class of real bugs for
 * free and is the thing Drizzle lacks.
 */
export interface Db<Sc extends AnySchema = AnySchema> extends Queryable<Sc>, AsyncDisposable_ {
  readonly kind: 'db'

  /**
   * Everything inside runs on one connection inside one `BEGIN … COMMIT`, and a bulk insert within
   * it does NOT open its own (`03` §2.6). Rolls back and rethrows on any rejection; retries a
   * `40001` at repeatable read / serializable (`07` §3.4).
   *
   * Name the parameter `db`, not `tx`: shadowing the outer handle is `07` §1.5 layer 1 and it is
   * the cheapest, highest-yield half of the whole footgun story.
   */
  transaction<T>(fn: (db: Tx<Sc>) => Promise<T>, opts?: TxOptions): Promise<NoHandleEscape<T>>
  transaction<T>(opts: TxOptions, fn: (db: Tx<Sc>) => Promise<T>): Promise<NoHandleEscape<T>>

  /** Pin one pool connection without opening a transaction (`07` §1.4). */
  session<T>(fn: (s: Session<Sc>) => Promise<T>): Promise<NoHandleEscape<T>>

  listen(channel: string, handler: NotificationHandler, opts?: ListenOptions): Promise<Subscription>

  diagnosePooler(opts?: DiagnosePoolerOptions): Promise<PoolerDiagnosis>
  diagnose(): Promise<DbDiagnosis>
  observe(hooks: QueryHooks): () => void
  stats(): PoolStats | undefined

  /** Optional eager warm-up. `pgPrime` itself opens no socket. */
  connect(): Promise<void>
  end(): Promise<void>
}

/** Inside a transaction. Same query surface; different capabilities. */
export interface Tx<Sc extends AnySchema = AnySchema> extends Queryable<Sc> {
  readonly kind: 'tx'
  /** 1 for the first attempt; increments on serialization retry (`07` §3.4). */
  readonly attempt: number
  /** 0 = outermost; > 0 = savepoint. */
  readonly depth: number
  readonly isolation: IsolationLevel
  readonly accessMode: AccessMode

  /**
   * Nested → `SAVEPOINT`. Isolation, access mode, deferrable and retry are absent **by
   * construction** (`07` §3.3): PostgreSQL cannot change the first three mid-transaction, and a
   * `40001` aborts the whole transaction so retrying at savepoint level is meaningless.
   */
  transaction<T>(
    fn: (db: Tx<Sc>) => Promise<T>,
    opts?: SavepointOptions,
  ): Promise<NoHandleEscape<T>>
  savepoint<T>(fn: (db: Tx<Sc>) => Promise<T>, opts?: SavepointOptions): Promise<NoHandleEscape<T>>

  /** Transaction-local GUCs via parameterised `set_config(…, true)` (`07` §3.5). RLS in one line. */
  setLocal(name: string, value: string | number | boolean): Promise<void>
  setLocal(settings: Readonly<Record<string, string | number | boolean>>): Promise<void>

  /** `pg_advisory_xact_lock` and friends — the only advisory locks safe behind a pooler. */
  advisoryLock(key: bigint | string, opts?: AdvisoryLockOptions): Promise<boolean>

  /** Abort. Throws `TransactionRollback`, which `db.transaction` rethrows. */
  rollback(): never
  /** Abort but resolve the transaction with `value`, fully typed, no `| undefined` (`07` §3.7). */
  rollbackWith<V>(value: V): V

  /** Live server-side transaction state, for assertions and diagnostics. */
  readonly status: 'idle' | 'active' | 'failed'

  withOptions(opts: CallOptions): Tx<Sc>
  outsideTransaction(): Tx<Sc>
}

/** A pinned connection with no open transaction (`07` §1.4). */
export interface Session<Sc extends AnySchema = AnySchema> extends Queryable<Sc> {
  readonly kind: 'session'
  transaction<T>(fn: (db: Tx<Sc>) => Promise<T>, opts?: TxOptions): Promise<NoHandleEscape<T>>
  /** Session-level GUCs, `set_config(…, false)`. Refused under a transaction-pooler profile. */
  set(name: string, value: string | number | boolean): Promise<void>
  set(settings: Readonly<Record<string, string | number | boolean>>): Promise<void>
  /** Session-level advisory lock. Refused under a transaction pooler; use `tx.advisoryLock`. */
  advisoryLock(key: bigint | string, opts?: AdvisoryLockOptions): Promise<AdvisoryLock | boolean>
  readonly backendPid: number | undefined

  withOptions(opts: CallOptions): Session<Sc>
  outsideTransaction(): Session<Sc>
}

/**
 * `db.with('recent', …)`. The declared CTEs are ordinary handles on `.cte`, so
 * `.innerJoin(d.cte.archived, 'a', …)` needs no new method; `.fromCte(name, alias?)` is the sugar
 * that keeps the single-CTE case one chain.
 *
 * `MATERIALIZED` / `NOT MATERIALIZED` and writable CTEs (`deleteFrom(…).returning(…)`) are WS4:
 * `f` already accepts any `RowSource`, so they need no change here.
 */
export interface CteExecutor<C extends Sources> {
  /** The declared CTEs, as table handles. */
  readonly cte: C

  /** Same return-position sentinel as {@link SetResult}, and for the same measured reason. */
  with<N extends string, O2>(
    name: N,
    f: (d: CteExecutor<C>) => RowSource<O2>,
    opts?: WithOpts,
  ): [N] extends [keyof C]
    ? OrmTypeError<CteNameTakenMsg<N>>
    : CteExecutor<C & Record<N, CteHandle<N, O2>>>

  /** {@link Executor.withRecursive}, chained. Same name-taken sentinel as {@link CteExecutor.with}. */
  withRecursive<N extends string, O2>(
    name: N,
    base: (d: CteExecutor<C>) => SelectSource<O2>,
    step: (d: CteExecutor<C>, self: CteHandle<N, O2>) => SelectSource<O2>,
    opts?: RecursiveOpts,
  ): [N] extends [keyof C]
    ? OrmTypeError<CteNameTakenMsg<N>>
    : CteExecutor<C & Record<N, CteHandle<N, O2>>>

  insertInto<H extends AnyHandle>(t: H): InsertQuery<H, never, C>
  update<H extends AnyHandle>(t: H): UpdateQuery<H, never, never>
  deleteFrom<H extends AnyHandle>(t: H): DeleteQuery<H, never>

  from<H extends AnyHandle, A extends string>(t: H, alias: A): Query<Record<A, H>, unknown>
  from<H extends AnyHandle>(t: H): Query<Record<H[typeof NAME] & string, H>, unknown>
  /** {@link Executor.fromRaw}, with the declared CTEs still in scope for the rest of the chain. */
  fromRaw<CD extends Record<string, AnyCodec>, A extends string = 'raw'>(
    frag: AnyFragment,
    shape: CD,
    opts?: FromRawOpts<A>,
  ): Query<Record<A, CteHandle<A, RawShape<CD>>>, unknown>

  fromCte<K extends keyof C & string, A extends string>(
    name: K,
    alias: A,
  ): Query<Record<A, C[K]>, unknown>
  fromCte<K extends keyof C & string>(name: K): Query<Record<K, C[K]>, unknown>
}

// ─────────────────────────────────────────────────────────────────────────────
// Write statements (03 §2.5–2.6) — WS4
//
// Three separate interfaces rather than one parameterised builder, for `04` §4's reason: an error
// should print `InsertQuery<…>`, not a method body. Each is invariant in its RETURNING row for the
// same reason `Query` is (kysely.md B.2): without it, `let q = db.insertInto(t); if (x) q =
// q.returning(...)` would silently drop the returned columns from the type with no error at all.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The insert row, with expressions allowed per column.
 *
 * `Insertable<T>` (`T[INS]`) is the plain-value shape and stays the documented one; this widens
 * each column to `value | expression` so `createdAt: fn.now()` and `views: add(excluded.views, 1)`
 * typecheck without a cast. Required/optional split is `InsertRow`'s, unchanged: a column is
 * optional iff it is nullable, has a default, or is identity-by-default, and absent iff it is
 * GENERATED ALWAYS.
 */
export type InsertPatch<T extends AnyTable> = Defer<
  Simplify<
    {
      [
        K in keyof ColsOfT<T> as ColsOfT<T>[K]['ro'] extends true
          ? never
          : ColsOfT<T>[K]['opt'] extends true
            ? never
            : K
      ]: Settable<ColsOfT<T>[K]['t']>
    } & {
      [
        K in keyof ColsOfT<T> as ColsOfT<T>[K]['ro'] extends true
          ? never
          : ColsOfT<T>[K]['opt'] extends true
            ? K
            : never
      ]?: Settable<ColsOfT<T>[K]['t']>
    }
  >
>

/** The update patch: everything writable, all optional, values or expressions. */
export type SetPatch<T extends AnyTable> = Defer<
  Simplify<{
    [K in keyof ColsOfT<T> as ColsOfT<T>[K]['ro'] extends true ? never : K]?: Settable<
      ColsOfT<T>[K]['t']
    >
  }>
>

/** A value, or anything that yields one. Tuple-wrapped nowhere: `T` is already the column's type. */
type Settable<T> = T | ExprOf<T>

type ColsOfT<T extends AnyTable> = T[typeof COLS & keyof T]

/**
 * `true` iff every row of a bulk insert sets the same columns — the type-level half of the
 * runtime's per-row check (`query/insert.ts`'s `#columnsFor`).
 *
 * TypeScript infers `R` from an array literal as the *union* of its element types, so `readonly
 * R[]` alone accepts a heterogeneous batch. "Is `R` a union?" was the first spelling and it is
 * wrong for a common case: a column whose type is itself a union (`boolean` is `true | false`, an
 * enum is its labels) keeps its literal type, so `[{ published: true }, { published: false }]` —
 * one column list — was refused with a message about columns. What TypeScript produces for a
 * genuinely ragged batch is `{ a; b?: undefined } | { a; b: string }`: the missing key is present
 * as `?: undefined`, so the honest question is whether any member declares a key it cannot have a
 * value for. One mapped type per member, no `UnionToIntersection`, instantiated at most once per
 * statement.
 */
type AbsentKeys<T> = { [K in keyof T]-?: [T[K]] extends [undefined] ? K : never }[keyof T]
type SameColumns<R> = [R extends unknown ? AbsentKeys<R> : never] extends [never] ? true : false

/** `03` §2.6's two bulk strategies and the automatic switch. */
export interface BulkOpts {
  /** `auto` (default) picks `unnest` above 30 000 cells, `values` below. */
  readonly strategy?: 'values' | 'unnest' | 'auto'
  /** Rows per statement once the batch is split. Default 5 000. */
  readonly chunkSize?: number
}

export interface WithOpts {
  /** `MATERIALIZED` / `NOT MATERIALIZED`; absent lets the planner decide (03 §2.7). */
  readonly materialized?: boolean
}

/** {@link Executor.withRecursive}'s options. */
export interface RecursiveOpts extends WithOpts {
  /**
   * `UNION ALL` (default) or `UNION` when `false`.
   *
   * The default is `ALL` because it is what PostgreSQL's own documentation writes and what a
   * traversal wants; `UNION` deduplicates every intermediate row and is the cycle-avoiding
   * spelling for a graph, at the cost of an equality comparison per row.
   */
  readonly unionAll?: boolean
}

/** {@link Executor.fromRaw}'s options. */
export interface FromRawOpts<A extends string = string> {
  /** The alias the raw item is bound to, and therefore the scope key. Default `'raw'`. */
  readonly alias?: A
  /**
   * Emit a column **definition** list (`("id" bigint, "name" text)`) rather than a plain column
   * alias list. Required for a function returning `record` (`jsonb_to_recordset`), and rejected by
   * PostgreSQL for one that does not (`generate_series`), which is why it is a choice and not a
   * default. The types come from `shape`'s own codecs, so the two cannot drift.
   */
  readonly columnTypes?: boolean
}

/** The row a {@link Executor.fromRaw} shape describes: one decoded value per declared codec. */
export type RawShape<C extends Record<string, AnyCodec>> = Defer<
  Simplify<{ [K in keyof C]: CodecOut<C[K]> }>
>

export interface LockOpts<A extends string = string> {
  readonly strength?: 'update' | 'no key update' | 'share' | 'key share'
  /**
   * `FOR UPDATE OF <alias>` — the aliases **in this query's scope**, not free strings.
   *
   * PostgreSQL raises `42P01: relation "x" in FOR UPDATE clause not found in FROM clause` for a
   * name that is not one of them, and a typo in a lock list is exactly the kind of mistake that
   * only shows up under contention. Defaults to `string` so the bare `LockOpts` spelling — which
   * the builder runtime uses — still means what it did.
   */
  readonly of?: readonly A[]
  readonly wait?: 'block' | 'nowait' | 'skip locked'
}

/** The alias an insert's `RETURNING` scope is keyed by: the handle's own name. */
/**
 * The scope a RETURNING list sees: the statement's own target, keyed by its registry name.
 *
 * It carries the relation accessors too, because a RETURNING list is a projection and `03` §2.5
 * says RETURNING reuses the projection machinery. What a relation there can *emit* is narrower —
 * there is no FROM clause to hoist a LATERAL onto, so a row-set projection needs
 * `{ strategy: 'subquery' }` and says so — but that is a runtime distinction, not a type one:
 * both forms are the same expression with a different plan.
 */
type SelfScope<H extends AnyHandle> = Record<
  H[typeof NAME] & string,
  RefsAt<H> & AllRefs<RefsAt<H>> & RelPickers<H>
>

/**
 * `C` is the CTE map the executor that built this insert had in scope, so `.fromSelect(d => …)`
 * hands back an executor that can still say `d.fromCte('moved')`. It is `{}` for
 * `db.insertInto(...)` and the declared map for `db.with(...).insertInto(...)`.
 */
export interface InsertQuery<H extends AnyHandle, O, C extends Sources = {}> extends RowSource<O> {
  readonly [INV]: (o: O) => O
  readonly [ROW]: O

  values(row: InsertPatch<TableAt<H>>): InsertQuery<H, O, C>
  /**
   * `R` is inferred from the rows, so the batch is **homogeneous by construction**.
   *
   * `readonly InsertPatch<T>[]` alone let `[{ a: 1 }, { b: 2 }]` typecheck — each element is a
   * legal patch on its own — and the runtime then rejects it, because a bulk insert is one
   * statement with one column list. Inferring a single `R` from every element makes the mismatch
   * a compile error at the literal instead.
   */
  valuesMany<R extends InsertPatch<TableAt<H>>>(
    rows: readonly R[],
    opts?: BulkOpts,
  ): [SameColumns<R>] extends [true] ? InsertQuery<H, O, C> : OrmTypeError<HeterogeneousBulkMsg>
  defaultValues(): InsertQuery<H, O, C>
  /** `insert … select …`, the writable-CTE pattern (03 §2.7). */
  fromSelect<O2>(
    q: SelectSource<O2> | ((d: CteExecutor<C>) => SelectSource<O2>),
  ): InsertQuery<H, O, C>

  onConflict(f: (c: ConflictBuilder<H>) => ConflictBuilder<H>): InsertQuery<H, O, C>

  returning<P extends Projection>(f: (t: SelfScope<H>) => P): InsertQuery<H, Project<P>, C>
  returningAll(): InsertQuery<H, SelectAt<H>, C>

  toAst(): InsertNode
  compile(): Compiled<O>
  /** Every statement this builder will run — more than one iff the batch was chunked. */
  compileAll(): readonly Compiled<O>[]
  execute(): Promise<O[]>
  executeTakeFirst(): Promise<O | undefined>
  /** Throws for a chunked batch: one prepared artifact cannot mean N statements. */
  prepare<P = Record<string, never>>(name?: string, opts?: PrepareOptions): PreparedQuery<P, O>
  /** `analyze: true` wraps and rolls back by default — `EXPLAIN ANALYZE INSERT` inserts (07 §7.5). */
  explain(opts?: ExplainOptions): Promise<ExplainResult>
  toSQL(): SqlSnapshot
  /** See {@link Query.signal} — the same four setters, the same bag. */
  signal(signal: AbortSignal): InsertQuery<H, O, C>
  /** §6.2. `SET LOCAL statement_timeout` inside a transaction; a client timer plus cancel outside. */
  timeout(ms: number): InsertQuery<H, O, C>
  /** §1.5 layer 3's per-statement opt-out from the dev guard. */
  outsideTransaction(): InsertQuery<H, O, C>
  /** §2.3's per-query override of `pgPrime({ statement })`. */
  withExecMode(mode: StatementMode): InsertQuery<H, O, C>
}

/**
 * The full PostgreSQL `ON CONFLICT` surface (03 §2.5).
 *
 * `excluded` is the proposed row, handed to `doUpdate` as a second scope — the runtime-object
 * analogue of Kysely's `OnConflictDatabase` virtual table (kysely.md §2.4). Note the two different
 * `where`s: {@link ConflictBuilder.where} is the *partial-index predicate* that picks the arbiter
 * index, and {@link ConflictBuilder.whereUpdate} is `DO UPDATE … WHERE`, which decides per row
 * whether to write. Conflating them is the classic upsert bug, so they have two names.
 */
export interface ConflictBuilder<H extends AnyHandle> {
  columns(f: (t: RefsAt<H>) => Grouping): ConflictBuilder<H>
  /** For an expression index: `on conflict (lower(email))`. */
  expressions(f: (t: RefsAt<H>) => Grouping): ConflictBuilder<H>
  /**
   * `on conflict on constraint <name>`. A bare `string` on purpose: the arbiter is a *constraint*,
   * and the schema DSL models table-level `primaryKey(...)` / `uniqueIndex(...)` as `TableExtra`
   * nodes whose names are optional (design/05 D5) — there is no complete set of declared
   * constraint names to check against, so a union here would reject valid input.
   */
  constraint(name: string): ConflictBuilder<H>
  where(f: (t: RefsAt<H>) => Expr<boolean>): ConflictBuilder<H>
  doNothing(): ConflictBuilder<H>
  doUpdate(f: (set: RefsAt<H>, excluded: RefsAt<H>) => SetPatch<TableAt<H>>): ConflictBuilder<H>
  whereUpdate(f: (t: RefsAt<H>, excluded: RefsAt<H>) => Expr<boolean>): ConflictBuilder<H>
}

/** The refs a `fromValues` source exposes, one per declared codec. */
export type ValueRefs<C extends Record<string, AnyCodec>> = Defer<
  Simplify<{ [K in keyof C]: Expr<CodecOut<C[K]>, CodecPg<C[K]>> }>
>

export interface FromValuesOpts {
  readonly alias?: string
  readonly strategy?: 'values' | 'unnest'
}

export interface UpdateQuery<H extends AnyHandle, O, V> extends RowSource<O> {
  readonly [INV]: (o: O) => O
  readonly [ROW]: O

  set(f: (t: SelfScope<H>, v: V) => SetPatch<TableAt<H>>): UpdateQuery<H, O, V>
  where(f: (t: SelfScope<H>, v: V) => Expr<boolean>): UpdateQuery<H, O, V>
  /**
   * "Yes, every row." `03` §2.5 has no unconditional `UPDATE`: without a `where` or this, the
   * builder refuses to emit rather than rewrite the table.
   */
  allRows(): UpdateQuery<H, O, V>
  /**
   * Bulk update by key: `update … from (values …) as "v"(…)` (03 §2.6).
   *
   * The rows are typed by the codecs, not by `unknown`: a `VALUES` list is encoded column-by-column
   * with the codec declared for that column, so `{ id: 'not-a-bigint' }` against `{ id: int8Codec }`
   * is a compile error here rather than a `PgEncodeError` at execute time.
   */
  fromValues<C extends Record<string, AnyCodec>>(
    rows: readonly NoInfer<{ [K in keyof C]: CodecIn<C[K]> }>[],
    codecs: C,
    opts?: FromValuesOpts,
  ): UpdateQuery<H, O, ValueRefs<C>>

  returning<P extends Projection>(f: (t: SelfScope<H>) => P): UpdateQuery<H, Project<P>, V>
  returningAll(): UpdateQuery<H, SelectAt<H>, V>

  toAst(): UpdateNode
  compile(): Compiled<O>
  execute(): Promise<O[]>
  executeTakeFirst(): Promise<O | undefined>
  prepare<P = Record<string, never>>(name?: string, opts?: PrepareOptions): PreparedQuery<P, O>
  /** `analyze: true` wraps and rolls back by default — `EXPLAIN ANALYZE UPDATE` updates (07 §7.5). */
  explain(opts?: ExplainOptions): Promise<ExplainResult>
  toSQL(): SqlSnapshot
  /** See {@link Query.signal} — the same four setters, the same bag. */
  signal(signal: AbortSignal): UpdateQuery<H, O, V>
  /** §6.2. `SET LOCAL statement_timeout` inside a transaction; a client timer plus cancel outside. */
  timeout(ms: number): UpdateQuery<H, O, V>
  /** §1.5 layer 3's per-statement opt-out from the dev guard. */
  outsideTransaction(): UpdateQuery<H, O, V>
  /** §2.3's per-query override of `pgPrime({ statement })`. */
  withExecMode(mode: StatementMode): UpdateQuery<H, O, V>
}

/**
 * `S` is the scope, which `using(...)` widens exactly as `innerJoin` widens a select's. A
 * `DELETE … USING … RETURNING` may name the USING relations, so `returning` reads the same scope.
 */
export interface DeleteQuery<
  H extends AnyHandle,
  O,
  S extends Sources = Record<H[typeof NAME] & string, H>,
> extends RowSource<O> {
  readonly [INV]: (o: O) => O
  readonly [ROW]: O

  where(f: (t: ScopeOf<S>) => Expr<boolean>): DeleteQuery<H, O, S>
  /** "Yes, every row." The opt-in an unconditional `DELETE` needs (`03` §2.5). */
  allRows(): DeleteQuery<H, O, S>
  /** `delete … using other where …` — the join form. */
  using<H2 extends AnyHandle, A extends string>(
    t: H2,
    alias: A,
  ): DeleteQuery<H, O, S & Record<A, H2>>
  using<H2 extends AnyHandle>(t: H2): DeleteQuery<H, O, S & Record<H2[typeof NAME] & string, H2>>

  returning<P extends Projection>(f: (t: ScopeOf<S>) => P): DeleteQuery<H, Project<P>, S>
  returningAll(): DeleteQuery<H, SelectAt<H>, S>

  toAst(): DeleteNode
  compile(): Compiled<O>
  execute(): Promise<O[]>
  executeTakeFirst(): Promise<O | undefined>
  prepare<P = Record<string, never>>(name?: string, opts?: PrepareOptions): PreparedQuery<P, O>
  /** `analyze: true` wraps and rolls back by default — `EXPLAIN ANALYZE DELETE` deletes (07 §7.5). */
  explain(opts?: ExplainOptions): Promise<ExplainResult>
  toSQL(): SqlSnapshot
  /** See {@link Query.signal} — the same four setters, the same bag. */
  signal(signal: AbortSignal): DeleteQuery<H, O, S>
  /** §6.2. `SET LOCAL statement_timeout` inside a transaction; a client timer plus cancel outside. */
  timeout(ms: number): DeleteQuery<H, O, S>
  /** §1.5 layer 3's per-statement opt-out from the dev guard. */
  outsideTransaction(): DeleteQuery<H, O, S>
  /** §2.3's per-query override of `pgPrime({ statement })`. */
  withExecMode(mode: StatementMode): DeleteQuery<H, O, S>
}

// ─────────────────────────────────────────────────────────────────────────────
// The operator surface (WS3).
//
// `ops.ts` is fork F1's winning arm, implemented: free functions, type-class gated, each carrying
// an exact result codec. `fn.ts` holds the boolean combinators, ordering and the aggregate
// namespace, which design/03 §2.4 spells as free functions in *both* arms and which therefore
// never belonged to the fork. `ops.manifest.ts` is the vocabulary as data — the single list that
// the goldens, the OID differential, the semantic differential and `03` §2.9's own table are all
// generated from or checked against.
//
// The declaration-only arm this replaced is frozen at `bench/types/arms/f1-ops-free.ts` so
// `09` §3.0's `.d.ts` measurement stays reproducible.
// ─────────────────────────────────────────────────────────────────────────────
export * from './ops.js'
export * from './fn.js'
export type {
  AnyOperand,
  ArrayOperand,
  BoolOperand,
  ClassOperand,
  Order,
  OrderArg,
  OrderBy,
  JsonOperand,
  JsonbOperand,
  NetOperand,
  NonNullOperand,
  NumOperand,
  NumPg,
  RangeOperand,
  RangePg,
  TextOperand,
  TextPg,
  TsqueryOperand,
  TsvectorOperand,
} from './ops.types.js'
export { OPS, CONFIRMABLE } from './ops.manifest.js'
export type { OpClass, OpSpec } from './ops.manifest.js'

// ─────────────────────────────────────────────────────────────────────────────
// The builder runtime (WS4). One import for a query file: the operators, the aggregates, the
// `sql` tag, `nest`, `over`, and the two ways to make an executor.
// ─────────────────────────────────────────────────────────────────────────────
export { nest, nestNullable, omit } from './scope.js'
export { over } from './window.js'
export type { Bound, FrameOpts, WindowLiteral, WindowSpec } from './window.js'
export { pgPrime, compileOnly, statementStats } from './run.js'
export type { PgPrimeOptions, StatementStats } from './run.js'
export type {
  AccessMode,
  AdvisoryLock,
  AdvisoryLockOptions,
  AsyncDisposable_,
  AsyncDisposeKey,
  CallOptions,
  ConnectionParams,
  CopyOptions,
  CopyResult,
  Duration,
  IsolationLevel,
  ListenOptions,
  NoHandleEscape,
  NotificationHandler,
  PoolOptions,
  RetryPolicy,
  RunCallOptions,
  Runnable,
  SavepointOptions,
  SessionDefaults,
  StreamCallOptions,
  Subscription,
  TransactionDefaults,
  TxOptions,
  TxOptionsBase,
} from '../session/types.js'
export { placeholder } from './prepared.js'
export type { PrepareOptions, PreparedQuery } from './prepared.js'
export { clearDescribeCache, describeCacheStats } from './executor.js'
export type {
  DescribeCacheStats,
  ExecOptions,
  ExplainNode,
  ExplainOptions,
  ExplainResult,
  PreparedStatementOptions,
  StatementMode,
  StreamOptions,
} from './executor.js'
export type { PlaceholderRef, SqlSnapshot } from './terminals.js'
export type { RawQuery, RawRow } from './raw.js'
export { CodecMismatchError } from './errors.js'
export type { CodecMismatch } from './errors.js'
export type { WindowFn } from './window.js'
