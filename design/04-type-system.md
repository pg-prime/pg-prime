# 04 — Type System Engine

**Owner:** Agent 04 (type system) · **Date:** 2026-08-14
**Scope:** how types flow schema → query → result; the compile-time performance budget; error ergonomics.
**Status:** DECISIONS. Every type listing below was compiled and every number measured (TypeScript 5.4.5 / 5.9.3 / 7.0.2, Node 24.14.1, Apple silicon). Head-to-head numbers are against real `kysely@0.29.5` and `drizzle-orm@0.45.2` on identical schemas and identical query shapes.

---

## 0. Decisions at a glance

| # | Decision | Rationale (measured) |
|---|---|---|
| D1 | **Hybrid model**: runtime builders whose generic payload is a *flat, 4-field* `ColMeta` record, eagerly flattened into `select`/`insert`/`update` row shapes at `table()` time. Not Kysely's hand-written interface, not Drizzle's deep builder-config generics. | Schema declaration 3.7 instantiations/column; row shapes computed once per table and memoised by the instantiation cache. |
| D2 | **No whole-schema distribution on the query hot path.** The builder's `Sources` map contains only the 1–4 tables in scope. The schema registry may be *carried* as a type argument but is only ever **indexed**, never mapped or distributed over. | Per-query marginal cost is **flat at 251–661 instantiations from 25 to 300 tables**. Real Kysely rises 6.4k → 11.3k per query over the same range. |
| D3 | **Projection is an object literal; the result type is one non-conditional, non-recursive mapped type** (`Project<P>`), one indexed access per output key. Aliasing is an object key, so there is no template-literal alias parser. | Kysely's 6-way alias-parsing conditional chain per selection is deleted outright. |
| D4 | **Columns are `NOT NULL` by default; `.nullable()` opts in.** | `.nullable()` is a union formation (`T \| null`), free. `.notNull()` would require a distributive `Exclude<T, null>` on every column. Also removes Drizzle's #1 footgun. |
| D5 | **Relations are name-keyed into a single `defineSchema` registry**, resolved lazily, never structurally inlined. | No thunks, no value-level circularity, no `.d.ts` blowup on mutually-recursive graphs. Verified with a 3-table fully-cyclic graph. |
| D6 | **Relation nesting is a projection option on the one builder**, not a second API. A relation picker returns an `Expr<Out[]>` / `Expr<Out \| null>` and flows through the same `Project<P>`. | Closes the Drizzle RQB-vs-core seam at the type level for free. |
| D7 | **`Loaded<H, Rels, Cols>` is a structural contract**, not a brand. Query results are plain object types, so assignability does the work. | A function can demand a loaded relation with zero runtime cost and zero casts. |
| D8 | **Invariant `O`** on the query builder via a phantom `(o: O) => O`. | Turns Kysely's silent-column-loss footgun into a compile error. Verified. |
| D9 | **No overloads on hot-path builder methods.** | Measured: Kysely's 3-overload `select` turns a typo into an 8-line, 1,098-char cascade; ours is 1 line, 293 chars, and keeps the "Did you mean 'email'?" suggestion. |
| D10 | **TS floor stays 5.4**, gated by the `types@<5.4` export condition. | All probes pass identically on 5.4.5, 5.9.3 and 7.0.2. The export-map gate was built and verified end-to-end. |

---

## 1. Core type model

### 1.1 The column carrier

Kysely's `ColumnType<Select, Insert, Update>` is the right *idea* — one declaration, several operation-specific types — but three phantom slots is the wrong *encoding* for us, because we also need the PG type name (for per-operator operand tables and codec selection) and because deriving optionality from `IsNullable<InsertType<T>>` costs two distributive conditionals per column per use.

We encode the same information in **four flat fields**, chosen so that the hot path (`select`) is a *pure indexed access with zero conditionals*:

```ts
export interface ColMeta {
  readonly t: unknown    // TS type as read — ALREADY includes `| null` when nullable
  readonly pg: string    // pg type name literal; drives operator operand tables + codec identity
  readonly opt: boolean  // optional at INSERT (nullable | has default | identity-by-default)
  readonly ro: boolean   // never insertable/updatable (GENERATED ALWAYS)
}
```

Why this shape:

* **`t` absorbs nullability.** `SelectRow` is then `{ [K in keyof C]: C[K]['t'] }` — one indexed access per column, **no conditional at all**. Kysely needs `SelectType<T>` (a conditional) per column.
* **`opt` and `ro` are booleans, not `never` sentinels.** Key filtering is a single `extends true` check in an `as` clause, and the runtime needs these flags anyway for DDL emission — one source of truth for types and migrations.
* **`pg` is a string literal**, so the operator layer can pattern-match `'jsonb'`, `'tsvector'`, `'int4range'` without a 150-member union lookup table. (Drizzle's `codecs.d.ts` `unionsTypeTable` is 34 KB of `.d.ts` for exactly this job — **SKIP**, per research.)
* Only four fields, so every modifier rebuild is 3 indexed accesses + 1 literal.

### 1.2 The column builder

```ts
export interface Col<M extends ColMeta> {
  readonly [META]: M
  nullable():          Col<{ t: M['t'] | null; pg: M['pg']; opt: true;     ro: M['ro'] }>
  default(v: M['t']):  Col<{ t: M['t'];        pg: M['pg']; opt: true;     ro: M['ro'] }>
  generatedAlways():   Col<{ t: M['t'];        pg: M['pg']; opt: true;     ro: true    }>
  generatedByDefault():Col<{ t: M['t'];        pg: M['pg']; opt: true;     ro: M['ro'] }>
  primaryKey():        Col<M>
  unique():            Col<M>
  /** narrow-only: T must be a subtype of the column's own type */
  $type<T extends M['t']>(): Col<{ t: T; pg: M['pg']; opt: M['opt']; ro: M['ro'] }>
}
export type AnyCol = Col<any>

export declare function text():        Col<{ t: string;  pg: 'text';        opt: false; ro: false }>
export declare function integer():     Col<{ t: number;  pg: 'int4';        opt: false; ro: false }>
export declare function bigint():      Col<{ t: bigint;  pg: 'int8';        opt: false; ro: false }>
export declare function boolean():     Col<{ t: boolean; pg: 'bool';        opt: false; ro: false }>
export declare function timestamptz(): Col<{ t: Date;    pg: 'timestamptz'; opt: false; ro: false }>
export declare function numeric():     Col<{ t: string;  pg: 'numeric';     opt: false; ro: false }>
export declare function jsonb():       Col<{ t: unknown; pg: 'jsonb';       opt: false; ro: false }>
/** any codec becomes a column: this is the extension point (agent 02) */
export declare function codec<C extends AnyCodec>(c: C):
  Col<{ t: CodecT<C>; pg: C['pgType']; opt: false; ro: false }>
```

Notes:

* **`$type<T extends M['t']>` can only narrow, never replace.** Drizzle allows `text().$type<number>()`, which is a silent lie. Ours rejects it (verified). It still permits the two real use cases: branded scalars (`text().$type<string & {__brand:'UserId'}>()`) and `jsonb().$type<Meta>()` (base is `unknown`, so any `T` is admissible).
* `generatedAlways()` sets `opt: true` **and** `ro: true`: absent from `Insertable` *and* `Updateable`, present in `Selectable`.
* `.default()` marks `opt` but does **not** touch `t` — a defaulted column is still non-null on read. Kysely's `Generated<T> = ColumnType<T, T|undefined, T>` says the same thing more indirectly.

### 1.3 The table, and eager flattening

```ts
type Cols = Record<string, ColMeta>

type SelectRow<C extends Cols> = Simplify<{ [K in keyof C]: C[K]['t'] }>

type InsertRow<C extends Cols> = Simplify<
  { [K in keyof C as C[K]['ro'] extends true ? never
                  : C[K]['opt'] extends true ? never : K]:  C[K]['t'] } &
  { [K in keyof C as C[K]['ro'] extends true ? never
                  : C[K]['opt'] extends true ? K : never]?: C[K]['t'] }
>

type UpdateRow<C extends Cols> =
  Simplify<{ [K in keyof C as C[K]['ro'] extends true ? never : K]?: C[K]['t'] }>

type RefsOfCols<N extends string, C extends Cols> = { [K in keyof C]: Ref<N, K & string, C[K]> }

export interface Table<N extends string, C extends Cols, R extends Rels = {}> {
  readonly [NAME]:  N
  readonly [COLS]:  C
  readonly [REFS]:  RefsOfCols<N, C>   // ← pre-computed once, reused by every query
  readonly [SEL]:   SelectRow<C>       // ← $inferSelect
  readonly [INS]:   InsertRow<C>       // ← $inferInsert
  readonly [UPD]:   UpdateRow<C>       // ← $inferUpdate
  readonly [RELS]:  R
}

export type Selectable<T extends AnyTable> = T[typeof SEL]
export type Insertable<T extends AnyTable> = T[typeof INS]
export type Updateable<T extends AnyTable> = T[typeof UPD]

export declare function table<N extends string, B extends Record<string, AnyCol>>(
  name: N,
  cols: B,
  extra?: (t: RefsOfCols<N, { [K in keyof B]: B[K][typeof META] }>) => unknown[],
): Table<N, { [K in keyof B]: B[K][typeof META] }>
```

**This is the load-bearing perf decision.** The row shapes and the column-reference object are *properties of an instantiated interface*. TypeScript computes an instantiated type's property type lazily and then **caches it on that instantiation**. So `SelectRow<C>` for `users` is computed at most once per program, no matter how many queries touch `users`. Kysely instead evaluates `Selectable<DB[T]>`, `AnyColumn<DB, TB>` and the alias parsers inside method signatures whose type arguments differ per query — which is precisely why its per-query cost grows with schema size.

Note `B[K][typeof META]` rather than `B[K] extends Col<infer M> ? M : never`. Because `B` is inferred as a literal object type, the indexed access resolves to the exact meta with **no conditional**. Small, repeated ×N-columns×N-tables.

**Deliberately absent: `Table & Columns` intersection.** Drizzle's `PgTableWithColumns<T> = PgTable<T> & T['columns'] & {...}` is what makes `users.email` work and is a documented TS antipattern (`§4.5` of the Drizzle dossier — the source of its error spew). We reach columns through callbacks (`.select(t => …)`, `table(name, cols, t => [index().on(t.email)])`) whose parameter type is the pre-computed `[REFS]` slot. Same ergonomics, no intersection.

### 1.4 The codec generic signature (contract with agent 02)

Agent 02 owns the codec *runtime* (registry, wire format, binary vs text). The **generic signature is fixed here**:

```ts
export interface Codec<T, Pg extends string = string> {
  readonly [CT]: T          // phantom type carrier — indexed access, never a conditional
  readonly pgType: Pg       // 'text' | 'int8' | 'tstzrange' | 'vector' | …
  encode(value: T): unknown
  decode(raw: unknown): T
}
export type AnyCodec = Codec<any, string>
export type CodecT<C extends AnyCodec> = C[typeof CT]
```

Three properties I need from agent 02, and what each buys:

1. **`T` is naturally invariant.** `encode(v: T)` is contravariant and `decode(): T` is covariant, so no extra variance marker is needed. This means `Codec<'a'|'b'>` is not silently assignable to `Codec<string>` — an enum codec cannot be swapped for a text codec.
2. **`[CT]` is a phantom property, not a conditional-extractable slot.** `CodecT<C>` is `C[typeof CT]` — one indexed access. If instead we wrote `C extends Codec<infer T> ? T : never`, every `sql\`…\`.as(codec)` in the codebase would pay a conditional.
3. **`pgType` must be a string *literal* on every built-in codec** (`pgType: 'int8'`, not `pgType: string`). It is the join key between the type layer and (a) the operator operand tables, (b) the migration diff engine's type identity, (c) the JSON-rehydration map in §3.4.

Everything downstream flows from `codec()`: a user-defined PG type becomes a first-class column with correct `Selectable`/`Insertable` types and correct decode, with no changes to the type engine.

### 1.5 The schema registry

Relations create a circularity problem: `users.posts → posts` and `posts.author → users`. MikroORM pays for it with lazy thunks (`() => p.manyToOne(Author)`); Drizzle v2 solved it with a single `defineRelations` over a schema record. We take Drizzle's answer and make the target a **name**, not a type:

```ts
export interface RelMeta<N extends string = string> {
  readonly kind: 'one' | 'many'
  readonly opt: boolean
  readonly to: N               // ← a KEY into the registry, never an inlined Table type
}
export type Rels = Record<string, RelMeta>

export declare function many<N extends string>(to: N, on?: JoinSpec):     { kind: 'many'; opt: false; to: N }
export declare function one<N extends string>(to: N, on?: JoinSpec):      { kind: 'one';  opt: false; to: N }
export declare function maybeOne<N extends string>(to: N, on?: JoinSpec): { kind: 'one';  opt: true;  to: N }

export interface Schema<T extends Record<string, AnyTable>, R extends Record<keyof T & string, Rels>> {
  readonly [TABLES]: T
  readonly [RELS]:   R
}

export declare function defineSchema<
  T extends Record<string, AnyTable>,
  R extends { [K in keyof T]?: Record<string, RelMeta<keyof T & string>> },
>(tables: T, rels?: (t: T) => R): Schema<T, R & { [K in keyof T & string]: {} }>

/** A table handle. Two indexed accesses reach anything; nothing is structurally inlined. */
export interface Handle<Sc extends AnySchema, N extends string> {
  readonly [SCHEMA]: Sc
  readonly [NAME]:   N
}

type TableOf<Sc, N extends PropertyKey> = Sc[typeof TABLES & keyof Sc][N & keyof Sc[typeof TABLES & keyof Sc]]
type RelsAt<Sc, N extends PropertyKey>  = Sc[typeof RELS   & keyof Sc][N & keyof Sc[typeof RELS   & keyof Sc]]
```

Usage:

```ts
export const schema = defineSchema({
  users:    table('users',    { id: integer().generatedAlways().primaryKey(), email: text(), name: text().nullable() }),
  posts:    table('posts',    { id: integer().generatedAlways().primaryKey(), authorId: integer(), title: text(),
                                published: boolean().default(false) }),
  comments: table('comments', { id: integer().generatedAlways().primaryKey(), postId: integer(), body: text() }),
}, () => ({
  users:    { posts: many('posts'), latest: maybeOne('posts') },
  posts:    { author: one('users'), comments: many('comments') },   // fully cyclic — fine
  comments: { post: one('posts') },
}))
```

`RelMeta.to` being a *name* is what makes the mutually-recursive graph typecheck with no thunks and no `.d.ts` explosion: nothing in the graph structurally contains a `Table`. Verified against the fully-cyclic 3-table graph above.

`on?: JoinSpec` is where agent 03 attaches the FK columns / `through` table for m2m; it is runtime-only and carries no type-level weight.

---

## 2. Result narrowing

### 2.1 The projection algebra — one mapped type, no conditionals

Everything projectable exposes the same phantom output slot:

```ts
export interface Projectable { readonly [OUT]: unknown }
export interface Expr<T>     { readonly [OUT]: T; readonly [SRC]: string }
export interface ExprOf<T>   { readonly [OUT]: T }                    // structural operand
export interface Ref<A extends string, K extends string, M extends ColMeta> {
  readonly [SRC]: A; readonly [OUT]: M['t']; readonly [META]: M
}

/** THE result-narrowing type. One indexed access per output key. */
export type Project<P extends Record<string, Projectable>> =
  Defer<Simplify<{ [K in keyof P]: P[K][typeof OUT] }>>
```

`Project` is deliberately **not conditional and not recursive**. That is affordable only because grouping and relation-nesting are done by *helpers that return an `Expr`*, rather than by nested object literals that `Project` would have to recurse into:

```ts
export declare function nest<P extends Record<string, Projectable>>(p: P): Expr<Project<P>>
export declare function nestNullable<P extends Record<string, Projectable>>(p: P): Expr<Project<P> | null>
```

If we allowed bare nested object literals, `Project` would need `P[K] extends Projectable ? … : Project<P[K]>` — a conditional **plus** recursion on the single hottest type in the library. Requiring `nest({...})` costs the user 6 characters and keeps the hot path linear.

### 2.2 Expressions and `sql` with a real codec

```ts
export interface SqlFragment {
  as<C extends AnyCodec>(c: C): Expr<CodecT<C>>
  /** greppable, lintable escape hatch: no codec, no decode guarantee */
  asUnsafe<T>(): Expr<T>
}
export declare function sql(s: TemplateStringsArray, ...v: unknown[]): SqlFragment
```

A bare `` sql`…` `` is a `SqlFragment`, which is **not** `Projectable` — you physically cannot put it in a projection without choosing `.as(codec)` or `.asUnsafe<T>()`. This is the research directive "`sql<T>` must carry a real codec, not be a bare cast" enforced structurally rather than by convention, and it is strictly stronger than Kysely's `unknown` default.

Operator operands are typed from the **left operand's output**, with the right side accepting a literal or any compatible expression:

```ts
export declare function eq<A extends Projectable>(a: A, b: A[typeof OUT] | ExprOf<A[typeof OUT]>): Expr<boolean>
```

For the PG operators where the operand type is *not* the column type (`jsonb ? text`, `tsvector @@ tsquery`, `anyrange && anyrange`, `vector <-> vector`), the operand is selected from `M['pg']` via a small per-operator table. This is the Kysely "operand typed from column rather than operator" **SKIP (fix it)** verdict; it is finite and writable because we have exactly one dialect.

### 2.3 Query scope: the reason per-query cost is flat

```ts
type Sources = Record<string, AnyHandle>
type RefsOf<S extends Sources> = { [A in keyof S]: TableOf<S[A][typeof SCHEMA], S[A][typeof NAME]>[typeof REFS] }

export interface Query<S extends Sources, O> {
  readonly [INV]: (o: O) => O        // invariant in O — see §3.3

  select<P extends Record<string, Projectable>>(f: (t: RefsOf<S>, r: RelsNs<S>) => P): Query<S, Project<P>>
  selectAll<A extends keyof S>(a: A): Query<S, TableOf<S[A][typeof SCHEMA], S[A][typeof NAME]>[typeof SEL]>

  where(f:   (t: RefsOf<S>) => Expr<boolean>): Query<S, O>
  groupBy(f: (t: RefsOf<S>) => Projectable | Projectable[]): Query<S, O>
  orderBy(f: (t: RefsOf<S>) => Projectable | Projectable[]): Query<S, O>
  limit(n: number): Query<S, O>
  offset(n: number): Query<S, O>

  innerJoin<H2 extends AnyHandle, A extends string>(
    t: H2, alias: A,
    on: (t: RefsOf<S> & Record<A, TableOf<H2[typeof SCHEMA], H2[typeof NAME]>[typeof REFS]>) => Expr<boolean>,
  ): Query<S & Record<A, H2>, O>

  $call<O2>(f: (q: this) => Query<S, O2>): Query<S, O2>
  execute(): Promise<O[]>
}
```

`S` holds **only the tables in scope**. There is no `DB` parameter and no `keyof DB` union anywhere on the hot path. `RefsOf<S>` maps over 1–4 entries. Column legality is ordinary property access on a pre-computed object type, so autocomplete, "Did you mean…?", and go-to-definition all work without a string-literal-union machine.

The schema *is* reachable (through `Handle`), but only by **indexed access**. A controlled micro-experiment confirmed that merely carrying a large schema record as a type argument costs **zero** extra instantiations per query (flat 118/query at 25 and at 300 tables).

### 2.4 Relations as a projection option

```ts
type RelsNs<S extends Sources> =
  { [A in keyof S]: RelPickers<S[A][typeof SCHEMA], RelsAt<S[A][typeof SCHEMA], S[A][typeof NAME]>> }

type RelPickers<Sc extends AnySchema, R extends Rels> = {
  [K in keyof R]: <P extends Record<string, Projectable>>(
    f: (q: SubQuery<TableOf<Sc, R[K]['to']>>) => SubSelected<P>,
  ) => Expr<RelOut<R[K], Project<P>>>
}

export type RelOut<M extends RelMeta, O> =
  M['kind'] extends 'many' ? O[] : M['opt'] extends true ? O | null : O
```

The picker returns an ordinary `Expr`, so a relation flows through the *same* `Project<P>` as a column or an aggregate — this is D6, "nesting is a projection option", realised in the type system with two conditionals per projected relation:

```ts
const rows = await db.from(users, 'u')
  .where(t => eq(t.u.email, 'a@b.c'))
  .select((t, r) => ({
    id:     t.u.id,
    email:  t.u.email,
    posts:  r.u.posts(q => q.where(p => eq(p.published, true))
                            .orderBy(p => p.id).limit(5)
                            .select(p => ({ id: p.id, title: p.title }))),
    latest: r.u.latest(q => q.select(p => ({ title: p.title }))),
  }))
  .execute()
```

Resolved type, read off the emitted `.d.ts` (verified, not hand-written):

```ts
const rows: {
  id: number
  email: string
  posts: { id: number; title: string }[]
  latest: { title: string } | null
}[]
```

Agent 03 compiles the picker to `LEFT JOIN LATERAL (…) ON TRUE` + `json_agg`; the type layer neither knows nor cares. The relation namespace is a **separate callback parameter** (`(t, r) => …`) rather than merged into the refs object, specifically to avoid an intersection.

### 2.5 `Loaded<>` — a signature that demands a loaded relation

```ts
export type Loaded<
  H extends AnyHandle,
  K extends keyof RelsAt<H[typeof SCHEMA], H[typeof NAME]> & string = never,
  F extends keyof TableOf<H[typeof SCHEMA], H[typeof NAME]>[typeof COLS]
    = keyof TableOf<H[typeof SCHEMA], H[typeof NAME]>[typeof COLS],
> = LoadedIn<H[typeof SCHEMA], H[typeof NAME], K, F>

type LoadedIn<Sc extends AnySchema, N extends string, K extends string, F extends PropertyKey> = Defer<
  Simplify<
    { [P in F & keyof Sc[typeof TABLES][N][typeof COLS]]: Sc[typeof TABLES][N][typeof COLS][P]['t'] } &
    { [P in K & keyof RelsAt<Sc, N>]-?:
        RelOut<RelsAt<Sc, N>[P], TableOf<Sc, RelsAt<Sc, N>[P]['to']>[typeof SEL]> }
  >
>
```

Three parameters, mirroring MikroORM v7: the handle, the **required** relations, and the **selected** columns.

```ts
// a function that DEMANDS a loaded relation
export function notify(u: Loaded<typeof users, 'posts'>): string {
  return `${u.email}: ${u.posts.map(p => p.title).join(', ')}`      // sync, type-safe, non-null
}

declare const full:   Loaded<typeof users, 'posts'>
declare const bare:   Loaded<typeof users>
notify(full)                                     // ok
notify(bare)                                     // ✗ Property 'posts' is missing            [verified]
type Nope = Loaded<typeof users, 'author'>       // ✗ 'author' is not a relation of users    [verified]

// partial-column load state
export function shortName(u: Loaded<typeof users, never, 'id' | 'name'>) { return u.name }
declare const partial: Loaded<typeof users, never, 'id' | 'name'>
partial.email                                    // ✗ not selected                           [verified]
shortName(bare)                                  // ok — a full row satisfies a partial contract

declare const withLatest: Loaded<typeof users, 'latest'>
withLatest.latest.title                          // ✗ 'latest' is possibly null              [verified]
```

**`Loaded` is a structural contract, not a brand.** Because query results are plain object types, a result that projected all of `users` plus `posts` is *assignable* to `Loaded<typeof users, 'posts'>` with no cast, no runtime marker, and no `Ref`/`Collection` wrapper. This is strictly better than MikroORM, which needs `Ref<T>`/`Collection<T>` runtime wrappers and `.$`/`.get()` accessors.

**Deliberate limitation: no dotted paths.** MikroORM's `AutoPath<'books.author.identity'>` is explicitly called out in its own release notes as one of the most expensive types in the library. We do not enumerate the relation graph. Depth is expressed by the *query projection literal* (which is structural and free); `Loaded` covers the one-level contract. For a deeper contract, intersect:

```ts
type Deep = Loaded<typeof posts, 'author'> & { author: Loaded<typeof users, 'posts'> }
```

**Unloaded relations are absent, not branded-error-typed.** Accessing one yields `Property 'posts' does not exist on type …`. The alternative — carrying every relation on every row typed as `NotLoaded<'posts'>` — would put N extra properties on every row type in the program. Rejected on budget.

---

## 3. Compile-performance engineering

This is the #1 technical risk of the whole project (SUMMARY §6.1), and it is owned here.

### 3.1 Head-to-head measurements

Identical schemas, identical query shapes, `tsc --noEmit --extendedDiagnostics`, **TypeScript 5.9.3**. Query shape: 2-table inner join, `and`/`gt`/`eq` where, `count()` aggregate, a `sql` fragment, a nested group, 5-key `groupBy`, `orderBy`, `limit`. **pg-orm-ts additionally projects a relation (LATERAL sub-select) in every query — the other two do not.**

| Scenario | pg-orm-ts | kysely@0.29.5 | drizzle-orm@0.45.2 |
|---|---|---|---|
| schema only, 13t × 7c (Northwind-ish) | 1,680 | **5** | 1,805 |
| schema only, 100t × 12c | 9,739 | **406** | 9,731 |
| + all row types materialised, 100t | 45,670 | 42,126 | 326,343 |
| schema + 25 queries, 100t | **35,152** | 161,191 | 195,114 |
| schema + 25 queries, 300t | **68,352** | 282,191 | 209,914 |
| schema + 100 queries, 300t | **117,927** | 1,117,541 | 734,464 |
| schema + 200 queries, 300t | **184,027** | 2,231,341 | 1,433,864 |

Check time / peak memory at 300t + 200q: **pg-orm-ts 2.60 s / 157 MB**, kysely 12.98 s / 338 MB, drizzle 2.29 s / 444 MB.

Read this honestly:

* **We lose on pure schema declaration to Kysely and always will.** Kysely's schema is hand-written interfaces; declaring them costs 5 instantiations because nothing is computed. That is the price of inference, and it is the correct trade (SUMMARY §3.1). We tie Drizzle 0.45 here and must not regress.
* **We win decisively on the query hot path** — 3.1–12.1× fewer instantiations whole-program, and **7–17× lower marginal cost per query** (§3.2), with **5×** faster check time than Kysely at scale.
* **Instantiations are a proxy, not the goal.** Drizzle's check time at 300t/200q (2.29 s) is slightly *better* than ours (2.60 s) despite 7.8× more instantiations — while our benchmark queries do strictly more work (relation projection) and use 2.8× less memory. Both metrics go in CI; check time is the user-facing one.

### 3.2 The scaling property that matters

Marginal cost of one additional query, isolated by differencing a 0-query against a 25-query compilation of the same schema (`queries`-only compilation, TS 5.9.3):

| tables | pg-orm-ts | kysely@0.29.5 | drizzle-orm@0.45.2 |
|---|---|---|---|
| 25 | 251 – 659 | 4,623 | 7,218 |
| 100 | 251 – 661 | 6,431 | 7,415 |
| 300 | **661** | **11,239** | 7,415 |
| **ratio 300 ÷ 25** | **1.00** | **2.43** | 1.03 |

Three readings, all of them important:

* **Ours is flat.** The 251-vs-661 range is instantiation caching, not schema size: a query over already-seen tables costs 251, one introducing new tables costs 661. Neither moves as the schema grows from 25 to 300 tables. And our benchmark query does *more* than the other two — it projects a relation.
* **Kysely's per-query cost grows 2.43× over the same range.** This is the "every query pays for the size of the whole `Database` interface" property identified in the research (kysely.md §1.9, conclusion 3), reproduced here against the real published package. It is the reason its 300-table check time is 13 s.
* **Drizzle already has the right cost *shape*** (1.03 ratio) — its per-query cost is schema-independent too. Its problem is the *level*: 7,415 vs our 251–661, i.e. **11–29× higher per query**, plus a schema-declaration cost we match. Credit where due; the scaling fix we need is only against Kysely, but the constant-factor win is against both.

There is one **fixed** O(N) cost, paid once per program when the schema registry is first touched: 3,807 instantiations at 25 tables, 23,332 at 300 (≈78/table). This is the mapped type that materialises the table handles. It is one-time and acceptable; it is *not* per-query, and an earlier appearance of schema-dependent "marginal" cost in our own measurements turned out to be this fixed cost being misattributed by differencing at low query counts.

### 3.3 Techniques adopted, with the trade each buys

| Technique | What it buys | Trade |
|---|---|---|
| **Interface over intersection.** `Table` is an interface with symbol slots; no `Table & Columns`. Public builder stages are all *named exported interfaces*. | Named interfaces cut the emitted `.d.ts` of a probe file by **22 %** (5,871 → 4,583 bytes) and removed leaked `{ [K in keyof {…}]: … }` mapped-type spew. | Column access goes through a callback instead of `users.email`. |
| **Pre-flattening at declaration time** (§1.3). | Row shapes and refs computed once per table, memoised by the instantiation cache. | Schema-declaration cost is non-zero (unlike Kysely). |
| **`Simplify<T> = { [K in keyof T]: T[K] } & {}` at declaration, never in a query-time signature.** | Collapses the two-mapped-type `InsertRow` intersection into one object type: better errors, cheaper downstream property access. | One extra mapped type per table. |
| **`Defer<T> = [T] extends [unknown] ? T : never`** (Kysely's `DrainOuterGeneric`) on `Project` and `Loaded`. | Avoids TS2589 at depth and keeps the alias *unresolved* in emitted declarations, so `.d.ts` prints `Project<P>` instead of its expansion. | None measured. |
| **No conditional types on the hottest path.** `SelectRow` and `Project` are pure indexed access; conditionals appear only in `InsertRow`/`UpdateRow` key filters (per table, once) and `RelOut` (per projected relation). | Directly responsible for the flat 251–661/query. | Nested projections need `nest({…})`; `$if` needs literal overloads. |
| **Minimal `Any*` supertypes.** `AnyTable`/`AnySchema`/`AnyHandle` are interfaces whose members are `any`, **not** `Table<any,any,any>`. | `X extends AnyTable` becomes an O(1) check that never forces `SEL`/`INS`/`UPD`/`REFS` to be computed. Measured: −2,561 instantiations on a 100-table schema, −1,661 on a 100t/25q compile. | Two type declarations per carrier instead of one. |
| **Lazy relation graph.** Targets are names; nothing is enumerated. | Mutually-recursive graphs cost nothing until projected; no `AutoPath` explosion. | No dotted-path `Loaded` hints (§2.5). |
| **No overloads on hot-path methods.** | See §4 — one clean error instead of an N-branch cascade. | `$if`'s literal-condition overloads are the single sanctioned exception, and it is off the hot path. |
| **Symbol-keyed phantom slots — all exported.** | Nominal-ish carriers, invisible in ordinary autocomplete. | **Mandatory:** every phantom `unique symbol` must be exported from the package root, or downstream builds with `declaration: true` fail with **TS2527 "The inferred type … references an inaccessible 'unique symbol'"**. Hit and fixed during prototyping; add a CI probe that compiles a consumer with `declaration: true`. |
| **Invariant `O`** via `readonly [INV]: (o: O) => O`. | `let q = …; if (f) q = q.select('x')` becomes a compile error instead of silently discarding a column (Kysely probe §1.8(3): no diagnostic, `undefined` at runtime). | Users cannot assign a wider builder to a narrower variable; `$if`/`$call` must cover the imperative build-up cases. Both are type-preserving. |

### 3.4 A correctness win the type system does *not* have to model

Kysely models JSON round-trip degradation in the types (`ShallowDehydrateValue`: `Date` → `string` inside `json_agg`). **We do not need to**, because we own decoding end-to-end: the projection shape is statically known, so the result mapper walks it and applies each column's codec to the JSON payload. A `timestamptz` inside a nested relation comes back as a `Date`, and the type says `Date` — truthfully.

This is a hard contract on agent 02/03: **the LATERAL/`json_agg` result mapper must rehydrate nested values using the per-column codecs of the nested projection.** If that is not implemented, the types in §2.4 become a lie and we must fall back to Kysely-style dehydration types. Flagged as the top cross-agent risk.

### 3.5 The budget (enforced in CI)

Measured headline — **100 tables × 12 columns, 200 relations, all three row shapes materialised for every table, and 200 realistic queries** (join + where + aggregate + `sql` + nested group + relation projection each):

| | TypeScript 5.9.3 | TypeScript 7.0.2 |
|---|---|---|
| Instantiations | 137,778 | 164,582 |
| Types | 24,011 | 29,074 |
| **Check time** | **1.11 s** | **0.231 s** |
| Total time | 1.30 s | 0.256 s |
| Peak memory | 145 MB | 66 MB |

**Budget — CI fails the build on breach.** Headroom over measured is deliberate (~35–50 %) to absorb the operator operand tables, `$if` overloads, CTEs, window functions and set operations that the prototype does not yet carry.

| Metric | Budget | Measured today |
|---|---|---|
| Instantiations per column, declaration | **≤ 8** | 3.7 (attest: 22 for a 6-column table) |
| Instantiations per table, declaration (no relations) | **≤ 50** | 31 |
| Instantiations per declared relation | **≤ 50** | 33 |
| Instantiations per table for all 3 row shapes | **≤ 500** | 359 |
| Instantiations per *distinct* query (attest, cold) — simple select | **≤ 1,500** | 990 |
| … join + aggregate + `sql` + nest | **≤ 2,000** | 1,280 |
| … with relation projection | **≤ 2,750** | 1,830 |
| Whole-program marginal instantiations per query, steady state | **≤ 1,000** | 251 – 661 |
| **Schema-size independence:** marginal/query at 300 tables ÷ at 25 tables | **≤ 1.15** | **1.00** |
| Headline scenario (100t × 12c + 200 rels + rows + 200 queries), check time, TS 5.9 | **≤ 2.0 s** | 1.11 s |
| … same, TS 7 | **≤ 0.5 s** | 0.231 s |
| … same, peak memory | **≤ 250 MB** | 145 MB |
| … same, instantiations | **≤ 200,000** | 137,778 |
| Emitted `.d.ts` per query result | fully-resolved literal object type, **zero** unresolved conditionals | verified |
| Probes pass identically on TS 5.4 / 5.9 / 7.0 | required | verified |

The **schema-size-independence ratio is the single most important line in this table.** Everything else is a level; that one is the *shape* of the cost curve, and it is what makes a 500-table schema tractable.

Known optimisation target already identified: 33 instantiations per declared relation is the largest per-entity line item (6,614 of the 9,739 for a 100-table schema with 2 relations each). It comes from the `many()`/`one()` helper generics plus the `R & { [K in keyof T & string]: {} }` normalisation in `defineSchema`. If the schema budget gets tight, replacing the helper calls with a plain literal validated by a constraint is the first move.

### 3.6 CI harness — verified hands-on

Four tools were installed and run. Findings:

1. **`@ark/attest@0.56.3` — adopt, for per-construct regression gating.** `bench(name, fn).types()` reports the instantiations contributed by a single snippet and writes an inline baseline snapshot; reruns print a delta. Exactly the granularity the per-query budget lines need. Sample real output from our prototype:

   ```
   🏌️  declare a 6-column table            ⛳ 22 instantiations
   🏌️  simple 2-column select              ⛳ 990 instantiations
   🏌️  join + aggregate + sql + nest       ⛳ 1,280 instantiations
   🏌️  relation projection (LATERAL)       ⛳ 1,830 instantiations
   ```

   > **Blocking caveat, verified:** `@ark/attest` **does not work on TypeScript 7.0.2**. It fails at startup with `TypeError: Cannot read properties of undefined (reading 'fileExists')` — it drives the classic `typescript` JS API (`ts.sys`, tsserver) which the native TS 7 build does not expose. The attest job must pin TypeScript 5.9.x. It also pulls `arktype`, `prettier`, `@prettier/sync` and `@typescript/analyze-trace` as dev dependencies (47 packages) — acceptable for a dev-only tool, but it is not a small dependency.

2. **`tsc --noEmit --extendedDiagnostics` — adopt, for whole-program budgets.** The only tool that works on **both** TS 5.x and TS 7, and the source of every number in §3.1/§3.5. Drives the headline scenario gate on both compilers.

3. **`tsc --generateTrace` + `@typescript/analyze-trace` — adopt, for diagnosis only.** Works on TS 5.x and attributes cost to source spans. Not a gate (too noisy); the tool you reach for when a gate fails.

4. **`attest stats <dir>` — skip.** Aggregate-only; `--extendedDiagnostics` gives the same numbers without the dependency.

**Harness shape:**

```
bench/type-perf/
  schema.gen.ts        # generated: N tables × C columns × R relations
  queries.gen.ts       # generated: Q queries across the archetypes
  gen.mjs              # deterministic generator (N, C, R, Q as args)
  budget.json          # every threshold in §3.5
  run.mjs              # tsc --extendedDiagnostics × {5.4 floor, 5.9 LTS, 7 native}; asserts budget.json
  attest.bench.ts      # @ark/attest per-construct baselines (TS 5.9 only)
```

Gates, from the first table builder (SUMMARY §6.1 — "budget for type-perf benchmarks in CI from the first table builder"):

* **PR gate:** `run.mjs` on the headline scenario, all three compilers, fail on any `budget.json` breach.
* **PR gate:** `@ark/attest` baselines; any construct exceeding its budget or drifting > 10 % fails.
* **PR gate:** the **schema-size-independence ratio** — compile 25t and 300t at fixed query count, assert marginal ratio ≤ 1.15. This is the regression that would otherwise creep in unnoticed.
* **PR gate:** a consumer package compiled with `declaration: true` and `strict` (catches TS2527 and `.d.ts` leakage).
* **PR gate:** the `@ts-expect-error` probe suite (§5) compiled on **5.4, 5.9 and 7.0** — an unused `@ts-expect-error` is a failure, so a lost type error breaks the build.
* **Nightly:** 300t/200q + trace generation, artefacts uploaded.

---

## 4. Error-message ergonomics

Drizzle's error spew is its own top complaint (drizzle.md §4.5); Kysely's overload cascades are close behind. Measured, on three identical mistakes (`tsc --pretty false`, TS 5.9.3):

| Mistake | pg-orm-ts | kysely@0.29.5 | drizzle-orm@0.45.2 |
|---|---|---|---|
| E1 misspelled column in projection | **1 line / 293 chars** | 8 lines / 1,098 chars | 1 line / 418 chars |
| E2 wrong operand type in `where` | **1 line / 127 chars** | 1 line / 157 chars | 8 lines / 1,723 chars |
| E3 inserting a `GENERATED ALWAYS` column | **1 line / 221 chars** | 1 line / 147 chars | 5 lines / 1,085 chars |
| **total** | **3 lines / 641 chars** | 10 lines / 1,402 chars | 14 lines / 3,226 chars |

**2.2× smaller than Kysely, 5.0× smaller than Drizzle**, and our E1 keeps the critical suggestion inline:

```
error TS2551: Property 'emial' does not exist on type 'RefsOfCols<"users", {…}>'. Did you mean 'email'?
```

versus Kysely, where the same suggestion is buried in "Overload 1 of 3" of an eight-line cascade. **The rule this proves: never overload a hot-path builder method.** One signature per method; use a callback or a helper for the variant.

Four mechanisms, in order of leverage:

**1. Sentinel error types (Kysely's `KyselyTypeError`, PORT).** Instead of failing with a constraint mismatch, resolve to a branded type carrying a sentence:

```ts
declare const ERR: unique symbol
export interface OrmTypeError<M extends string> { readonly [ERR]: M }

declare function anyOf<R extends Projectable>(r: R):
  R[typeof OUT] extends readonly (infer I)[] ? Expr<I>
  : OrmTypeError<'anyOf(x): x must be an array column; `text` is not'>
```

Verified output:

```
error TS2741: Property 'out' is missing in type
  'OrmTypeError<"anyOf(x): x must be an array column; `text` is not">' but required in type 'Ref<string>'.
```

The sentence is right there. ~20 lines of implementation. Apply to: array/range/JSON operator misuse, aggregate-without-`groupBy`, `tx` handle used outside its scope, relation name not on this table, `RETURNING` on a view.

**2. The `types@<5.4` export-map gate (PORT) — built and verified end-to-end.**

```jsonc
// package.json
"exports": { ".": {
  "types@<5.4": "./outdated-typescript.d.ts",
  "types":      "./dist/index.d.ts",
  "default":    "./dist/index.js"
}}
```

```ts
// outdated-typescript.d.ts
declare const _err: { readonly __ormTypeError:
  'Your TypeScript is older than 5.4, which pg-orm-ts requires for correct inference. Please upgrade TypeScript to >= 5.4.' }
export declare const defineSchema: typeof _err
// …one stub per public entry point
```

Verified with a real `file:` package: **TypeScript 5.3.3** produces

```
error TS2349: This expression is not callable. Type '{ readonly __ormTypeError: "Your TypeScript is older
than 5.4, which pg-orm-ts requires for correct inference. Please upgrade TypeScript to >= 5.4."; }'
has no call signatures.
```

and **TypeScript 5.9.3** compiles clean. One sentence instead of an inference cascade.

**3. Short public constraints.** Method parameters are constrained by the non-generic `AnyTable`/`AnySchema`/`AnyHandle`/`Projectable` interfaces, so the *expected* half of a mismatch prints as a short name. (This is also the O(1)-constraint-check optimisation from §3.3 — the same choice pays twice.)

**4. Named interfaces for every builder stage.** No anonymous inline return objects. Measured: 22 % smaller `.d.ts`, and errors print `InsertReturning<Table<"users", …>>` rather than the full method body.

Residual weakness: our E1 still prints the table's full column-meta record (293 chars). The information is at least *readable* (`{ t: string; pg: "text"; opt: false; ro: false }` per column) rather than unresolved conditionals. Reducing `ColMeta` in the printed form is a v2 optimisation, not a v1 blocker.

---

## 5. Where the types will lie, and how we contain it

Every ORM's type system lies somewhere. Ours lies in exactly these places, each with a containment strategy and each pinned by a `@ts-expect-error` probe in the CI suite.

| # | Hazard | Policy | Status |
|---|---|---|---|
| 1 | **Dynamic column names.** A `string` variable cannot index a refs object. | No silent degradation. Kysely's `db.dynamic.ref(s)` resolves to `{}` — total silent type loss (kysely.md §1.8(8)). Ours: `t[name]` simply fails to compile. The escape hatch is explicit and greppable: `unsafeRef<T>(name: string, codec: Codec<T>)`. The codec is **required**, so even the unsafe path decodes correctly. | Designed |
| 2 | **`$if` with a runtime boolean.** Conditionally selected columns must become optional. | Literal-condition overloads (Appendix B.1 of the Kysely dossier, prototyped there and verified): `$if(true, …) → O & O2`; `$if(false, …) → O`; `$if(boolean, …) → O & Partial<Omit<O2, keyof O>>`. Literal overloads must precede the `boolean` one. This is the **only** sanctioned overload in the library. | Designed |
| 3 | **Raw fragments without a codec.** | A bare `` sql`…` `` returns `SqlFragment`, which is not `Projectable` — it cannot enter a projection at all. You must pick `.as(codec)` (decoded, honest) or `.asUnsafe<T>()` (a cast). `asUnsafe` is greppable, lint-flagged, and its name appears in the type. Strictly stronger than Kysely's `unknown` default and than Drizzle's `sql<T>` cast. | Implemented in prototype |
| 4 | **JSON columns.** `jsonb()` is `t: unknown`. | `.$type<T>()` is a **cast, and we say so** — the constraint `T extends M['t']` is vacuous for `jsonb` because the base is `unknown`. Policy: (a) `.$type` is the documented, honest escape hatch (Drizzle's is the best idea in its schema layer — PORT); (b) a `jsonb` column may *optionally* carry a validator (`.check(schema)`) that emits a PG `CHECK (jsonb_matches_schema(...))` **and** validates on write, closing the loop for those who want it; (c) on **non-JSON** columns `.$type` is genuinely constrained — `text().$type<number>()` is rejected (verified), unlike Drizzle. | Implemented in prototype |
| 5 | **`text({ enum: [...] })`-style unions.** | Per drizzle.md §7 **ADAPT**: the type says `'a'\|'b'`, so the DB must too. We emit a real `CREATE TYPE … AS ENUM` or a `CHECK` constraint. Never a type without a constraint. | Policy, owned jointly with the migration agent |
| 6 | **Result rehydration inside `json_agg`.** | The types promise `Date`/`bigint`/`numeric` survive a nested relation projection. That promise is only true if agent 02/03's mapper applies codecs to the JSON payload (§3.4). **Top cross-agent risk.** If it slips, we must ship Kysely-style `ShallowDehydrateValue` degradation types instead — a visible product regression. | **Contract, unresolved** |
| 7 | **Casts defeat everything.** `Loaded<>` is type-level only; `as any` erases it. | Same caveat MikroORM documents. Accepted, documented, lint-suggested (`no-explicit-any` on ORM results). | Accepted |
| 8 | **Views and matviews.** | Non-insertable at the type level: view tables carry `ro: true` on every column, so `Insertable` and `Updateable` are `{}` and `insertInto(view)` fails to compile. (kysely-codegen gets this wrong; kanel gets it right.) | Designed |

---

## 6. Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **Full codegen (Prisma-style client emission).** | Would win the schema-declaration line outright (Prisma: 428 instantiations, because emitted interfaces compute nothing). Rejected because the whole industry is walking away from it — Prisma's own v8 rewrite abandons client emission, and Drizzle/MikroORM v7/Kysely all derive from TS values (SUMMARY §3.1). A generate step is a competitive liability, breaks in monorepos and Docker builds, and creates an ordering dependency between `tsc` and a build artefact. **And we no longer need it:** at 137,778 instantiations / 1.11 s for a 100-table, 200-query program, inference is comfortably fast enough. |
| **Hand-written `Database` interface (bare Kysely).** | Cheapest possible declaration (5 instantiations). Rejected because we need a **runtime** schema for migrations, defaults, DDL diffing, codec resolution, drift detection and serialization (kysely.md §7, "No runtime schema — SKIP, this is the core divergence"). Writing the schema twice is not an option. |
| **Kysely-style whole-schema `DB` generic on the builder.** | It is what makes per-query cost scale with schema size (measured: 6.4k → 11.3k instantiations/query from 100 → 300 tables on the real package). Our `Sources`-scoped design is flat. This is the single biggest architectural difference and the one that produces the 8–12× win. |
| **Drizzle-style `Table & Columns` intersection** for `users.email`. | Documented TS antipattern; the direct cause of Drizzle's `PgTableWithColumns<{…}>` error walls (drizzle.md §4.5) and of a large share of its 9,731-instantiation schema cost. Callbacks give the same ergonomics with no intersection. |
| **Nested object literals in projections** (instead of `nest({…})`). | Would force `Project` to be conditional **and** recursive — on the single hottest type in the library. Six characters of user syntax buys a linear hot path. |
| **`ColumnType<S, I, U>` phantom triple as our carrier.** | Excellent idea, wrong encoding for us: it cannot carry the PG type name (needed for operator operand tables and codec identity), and deriving optionality from it costs two distributive conditionals per column. We keep the *semantics* (one declaration → several operation-specific shapes, `never`/`ro` forbids an operation) with a cheaper encoding. `ColumnType`-style aliases can still be offered as sugar. |
| **MikroORM-style dotted-path `Loaded<T, 'a.b.c'>` hints.** | `AutoPath` is called out in MikroORM's own v7 notes as among the most expensive types in the library and a known TS-server hazard at scale. We get depth from the projection literal, which is structural and free. |
| **Brand/marker on unloaded relations** (`posts: NotLoaded<'posts'>`). | Would add one property per relation to every row type in the program. `Property 'posts' does not exist` is a good enough error at a fraction of the cost. |
| **Drizzle's `unionsTypeTable` codec union table.** | 34 KB of `.d.ts` — the single largest file in `drizzle-orm@1.0-rc` `pg-core` — to unify types across `sql`/set operations. A small set of nominal codec types with a `pgType` literal does the same job for one dialect (drizzle.md §7 **SKIP**). |
| **Raising the TS floor above 5.4.** | Considered, since TS 7 is 4.8× faster on our headline scenario. Rejected: all probes pass identically on 5.4.5, 5.9.3 and 7.0.2, and 5.4 is where the ecosystem floor sits (Kysely 0.29's floor). The `types@<5.4` gate makes the boundary a readable sentence. Revisit only if a needed feature demands it. |

---

## 7. Open items and contracts with other agents

1. **[BLOCKING — agent 02/03] JSON rehydration.** The nested-relation result types (§2.4) are only truthful if the `json_agg` result mapper applies per-column codecs to the nested payload. Without it, `Date` comes back as `string` and we must ship degradation types instead. This is the largest unresolved type-level risk in this document.
2. **[agent 02] Codec `pgType` must be a string literal** on every built-in codec. It is the join key between the type layer, the operator operand tables, and the migration diff engine's type identity.
3. **[agent 03] Relation `on:` spec.** `RelMeta` carries `kind`/`opt`/`to` for typing; the FK columns, `through` table and per-parent `limit`/`orderBy` live in the runtime `JoinSpec` and must not enter the type parameters.
4. **[agent 05/tx] Transaction handle typing.** The plan is a distinct `Tx<Sc>` type where `Db<Sc>`'s methods are absent, plus Kysely's type-level savepoint-stack tuple and `never`-returning illegal methods (kysely.md §1.5 — PORT). Design owned elsewhere; the invariance and sentinel machinery here is available to it.
5. **[me, next]** Per-operator operand tables (`jsonb ? text`, `tsvector @@ tsquery`, range `&&`, `vector <->`), CTE typing that widens `Sources`, window functions, set operations, and the `unsafeRef`/`$if` overload implementations. Budget headroom in §3.5 is sized for these; each lands with its own attest baseline.
6. **Optimisation backlog:** 33 instantiations per declared relation is the largest per-entity line item. First move if the schema budget tightens is replacing the `many()`/`one()` helper generics with a constrained plain literal.

---

## Appendix — reproducing the measurements

Prototype and harness were built at `…/scratchpad/tsperf` (ephemeral). To reproduce:

* `src/core.ts` — the complete type engine, declaration-only (~290 lines; every listing in §1–§2 is verbatim from it).
* `probe/probe.ts`, `probe/rel.ts` — 17 correctness probes including 9 `@ts-expect-error` assertions (generated-column insert, missing required column, invariant-`O` widening, out-of-scope alias, `$type` retyping, unloaded relation, unknown relation name, unselected column, nullable to-one); all pass on TS 5.4.5, 5.9.3 and 7.0.2, and an unused `@ts-expect-error` fails the build.
* `gen.mjs`, `gen-real.mjs` — deterministic generators for pg-orm-ts / kysely / drizzle on identical schemas and query shapes.
* `bench4.mjs` — the §3.1 head-to-head; `bench5.mjs` — the §3.2 fixed-vs-marginal split.
* `errs/` — the §4 error-size comparison; `vgate/` — the verified `types@<5.4` export-map gate.

Environment: Node 24.14.1, macOS/arm64. `typescript@5.4.5`, `@5.9.3`, `@7.0.2`; `kysely@0.29.5`; `drizzle-orm@0.45.2`; `@ark/attest@0.56.3`.
