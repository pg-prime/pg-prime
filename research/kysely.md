# Kysely — Research Dossier

> **Historical snapshot — 2026-08-14. Not maintained.**
> This is a point-in-time study of software we do not control; version numbers, APIs and bug
> reports below were accurate on that date and will drift. It is kept as the provenance for the
> decisions in [`../design/`](../design/), not as a current reference. Conclusions that survived
> review are carried into [`SUMMARY.md`](./SUMMARY.md) and cited from the design docs.

**Researched:** 2026-08-14
**Subject version:** `kysely@0.29.5` (published 2026-08-10)
**Repo:** https://github.com/kysely-org/kysely — 14.1k stars, 428 forks, ~143 open issues, MIT
**Security:** be on **≥0.28.17 or any 0.29.x** — three High-severity CVEs affect `<=0.28.16` (§5.4)
**Docs:** https://kysely.dev · API docs: https://kysely-org.github.io/kysely-apidoc/
**npm:** https://www.npmjs.com/package/kysely — ~12.5M downloads/week

> Method note: every claim marked **[verified]** was checked first-hand by unpacking
> `kysely@0.29.5` from npm and reading `dist/**/*.d.ts`, or by compiling probe files
> against it with TypeScript 5.9.3 and 7.0.2 and inspecting the emitted `.d.ts`.
> Claims from docs/community carry inline URLs.

---

## 0. Executive summary

Kysely is a **query builder, not an ORM**, and it is deliberate about that. It has
**zero runtime dependencies** [verified], models SQL faithfully rather than hiding it,
and has the most sophisticated type-level architecture of any TS database library.

For pg-orm-ts the headline is: **Kysely's type architecture is the right foundation and is
largely portable, but Kysely cannot be *extended* into an ORM — only wrapped.** Its docs
explicitly warn against subclassing and disclaim module augmentation
(https://kysely.dev/docs/recipes/extending-kysely). The wrap route is nonetheless proven:
**ZenStack v3 rewrote its entire ORM engine onto Kysely** and shipped it (§8.0). Our
recommendation is still *copy the architecture, don't depend on the package* — but that is
now a judgement about PG-only specialization and dependency risk, not about feasibility.

The second headline: **a large fraction of Kysely's residual type friction is
multi-dialect tax**, and PG-only specialization deletes it outright. Concrete examples
below: `eb.fn.count('id')` resolves to `string | number | bigint` because Kysely cannot
know which driver you're on (a PG-only library knows `node-postgres` returns `bigint` as
`string`); and a Postgres user's `InsertQueryBuilder` autocompletes **10 methods that are
invalid on Postgres**, all failing at runtime rather than compile time.

The third headline is a measurement: **type-check cost is superlinear in schema size, not
just query count.** At 300 tables / 200 queries the workload takes 30 s on TypeScript 5.9
and 4.5 s on TypeScript 7 — and per-query instantiation cost nearly doubles as the schema
grows, because the column-union types distribute over the entire `Database` interface.
Whatever we build inherits this property unless we design against it explicitly (§1.9).

The fourth is strategic: **the "database is the source of truth" model is losing ground
inside Kysely's own ecosystem.** kysely-codegen's share of Kysely installs fell from ~22.8%
to ~9.3% over the last twelve months, its release cadence has slowed to ~2/year, and the
tools gaining relative ground (`prisma-kysely`, Drizzle's `Kyselify`) are exactly the ones
that restore a declarative, offline source of truth. Meanwhile the cleanest technical
answer — **run migrations against in-memory PGlite and emit types, no Docker, no drift** —
exists only as a two-year-stale wrapper. That is an unclaimed hole, and a PG-only library
is the natural thing to fill it (§3.4–3.5).

---

## 1. The type model

### 1.1 The `Database` interface convention

There is **no runtime schema**. The entire schema is one plain TypeScript interface,
passed as the single generic to `Kysely<DB>`:

```ts
interface PersonTable {
  id: Generated<number>
  first_name: string
  last_name: string | null
  created_at: ColumnType<Date, string | undefined, never>
  metadata: JSONColumnType<{ tags: string[] }>
  status: 'active' | 'inactive'
}

interface Database {
  person: PersonTable
  pet: PetTable
  'public.person': PersonTable   // schema-qualified keys are supported
}

const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
```

Consequences worth internalizing:

- The DB type is **structural and erasable**. Nothing ships to runtime. Kysely's own
  `d.ts` surface is the whole product.
- Table keys are just strings, so schema qualification (`'public.person'`) and aliasing
  (`'person as p'`) are handled by **template-literal type parsing**, not by a registry.
- `db.withTables<{ tmp: TmpTable }>()` [verified, `kysely.d.ts:449`] widens `DB` ad hoc —
  the escape hatch for temp tables, `unnest(...)` sources, and CTE-ish shapes.

### 1.2 `ColumnType<Select, Insert, Update>` — the core primitive

[verified — `dist/util/column-type.d.ts`]

```ts
export type ColumnType<SelectType, InsertType = SelectType, UpdateType = SelectType> = {
  readonly __select__: SelectType
  readonly __insert__: InsertType
  readonly __update__: UpdateType
}

export type Generated<S>       = ColumnType<S, S | undefined, S>
export type GeneratedAlways<S> = ColumnType<S, never, never>
export type JSONColumnType<S extends object | null, I = string, U = string> = ColumnType<S, I, U>
```

This is the single best idea in the library. One column declaration carries **three
different types for three different operations**, phantom-tagged so it never exists at
runtime. `never` in a slot means "this operation is forbidden for this column", which
is how `GeneratedAlways` (i.e. PG `GENERATED ALWAYS AS IDENTITY`) becomes
un-insertable at the type level rather than at runtime.

Projections out of it [verified]:

```ts
export type SelectType<T> = T extends ColumnType<infer S, any, any> ? S : T
export type InsertType<T> = T extends ColumnType<any, infer I, any> ? I : T
export type UpdateType<T> = T extends ColumnType<any, any, infer U> ? U : T
```

Note the `: T` fallback — a bare `string` column is treated as
`ColumnType<string, string, string>`. **Plain types are the degenerate case**, so the
common path stays ergonomic. Port this exactly.

### 1.3 `Selectable` / `Insertable` / `Updateable`

[verified — `dist/util/column-type.d.ts`]

```ts
export type Selectable<R> = DrainOuterGeneric<{
  [K in NonNeverSelectKeys<R>]: SelectType<R[K]>
}>

export type Insertable<R> = DrainOuterGeneric<object & {
  [K in NonNullableInsertKeys<R>]:  InsertType<R[K]>
} & {
  [K in NullableInsertKeys<R>]?: InsertType<R[K]>
}>

export type Updateable<R> = DrainOuterGeneric<{
  [K in UpdateKeys<R>]?: UpdateType<R[K]> | undefined
}>
```

Three mechanics to steal:

1. **Optionality is derived, not declared.** A key is optional in `Insertable` iff its
   *insert* type includes `null | undefined` (`IsNullable<T> = [T] extends [NonNullable<T>] ? false : true`).
   So `Generated<number>` → `id?: number` falls out automatically.
2. **`never` erases the key.** `NonNeverSelectKeys` / `UpdateKeys` filter via
   `IsNever<T> = [T] extends [never] ? true : false`. `GeneratedAlways<number>` simply
   does not appear in `Insertable` or `Updateable`.
3. **`Updateable` makes everything optional** unconditionally — matching SQL `UPDATE`
   semantics, where any subset of columns is legal.

The tuple-wrapping (`[T] extends [X]`) in `IsNever` / `IsNullable` is deliberate: it
suppresses distribution over unions, which would otherwise silently break for
`'a' | 'b'` enum columns. Port the tuple-wrapping discipline wholesale.

### 1.4 How types flow through the builder

The builder is a **three-parameter type machine**: `SelectQueryBuilder<DB, TB, O>` where
`DB` is the whole schema, `TB` is the union of table names *currently in scope*, and `O`
is the accumulated output row. Every method is a type-level state transition
[verified — `dist/query-builder/select-query-builder.d.ts`]:

```ts
select<SE extends SelectExpression<DB, TB>>(selections: ReadonlyArray<SE>)
  : SelectQueryBuilder<DB, TB, O & Selection<DB, TB, SE>>          // :634

selectAll<T extends TB>(table: T)
  : SelectQueryBuilder<DB, TB, O & Selectable<DB[T]>>              // :812

innerJoin<TE extends TableExpression<DB, TB>, K1, K2>(table: TE, k1: K1, k2: K2)
  : SelectQueryBuilderWithInnerJoin<DB, TB, O, TE>                 // :938

leftJoin<...>(...): SelectQueryBuilderWithLeftJoin<DB, TB, O, TE>  // :943
```

`O` accumulates by intersection; `TB` grows on join. The `...WithLeftJoin` variants are
where **nullability of the joined side** is injected — `Nullable<T>` maps every property
of the joined table to `| null`. [verified via probe: `leftJoin` on `table_1` yields
`col_1: string | null`.]

Scope enforcement is `AnyColumn` / `AnyColumnWithTable` [verified — `dist/util/type-utils.ts`]:

```ts
export type AnyColumn<DB, TB extends keyof DB> = { [T in TB]: keyof DB[T] }[TB] & string
export type AnyColumnWithTable<DB, TB extends keyof DB> =
  { [T in TB]: `${T & string}.${keyof DB[T] & string}` }[TB]
```

That's the whole trick behind "you can only reference columns visible here": build a
distributed union of legal strings and constrain the parameter to it. Autocomplete falls
out for free because the parameter type *is* a string-literal union.

Alias and reference resolution is pure **template-literal parsing**
[verified — `dist/parser/select-parser.d.ts`], with a documented precedence chain that
handles `schema.table.column as alias` down to bare `column`:

```ts
type ExtractAliasFromStringSelectExpression<SE extends string> =
    SE extends `${string}.${string}.${string} as ${infer A}` ? A
  : SE extends `${string}.${string} as ${infer A}`           ? A
  : SE extends `${string} as ${infer A}`                     ? A
  : SE extends `${string}.${string}.${infer C}`              ? C
  : SE extends `${string}.${infer C}`                        ? C
  : SE
```

**`DrainOuterGeneric`** [verified] is the load-bearing performance hack, and it is worth
understanding precisely:

```ts
export type DrainOuterGeneric<T> = [T] extends [unknown] ? T : never
```

A vacuously-true conditional. Its purpose is to force TypeScript to **defer** evaluation
of the wrapped mapped type until the outer generic is instantiated, which collapses the
instantiation-depth stack and dodges "Type instantiation is excessively deep" (TS2589).
Kysely wraps essentially every mapped type in it. If you build a builder of this shape,
you will need this or an equivalent.

### 1.5 Novel technique: type-level savepoint stacks

[verified — `dist/kysely.d.ts:611-740`] This is genuinely clever and I have not seen it
elsewhere:

```ts
export declare class ControlledTransaction<DB, S extends string[] = []> extends Transaction<DB> {
  savepoint<SN extends string>(savepointName: SN extends S ? never : SN)
    : Command<ControlledTransaction<DB, [...S, SN]>>

  rollbackToSavepoint<SN extends S[number]>(savepointName: SN)
    : RollbackToSavepoint<S, SN> extends string[]
        ? Command<ControlledTransaction<DB, RollbackToSavepoint<S, SN>>>
        : never
}
```

The savepoint stack is tracked as a **type-level tuple**. Creating a savepoint pushes;
rolling back truncates the tuple at that name; you cannot reference a released or
never-created savepoint, and you cannot reuse a name. Also [verified]:

```ts
export declare class Transaction<DB> extends Kysely<DB> {
  transaction(): never          // :487 — nested transactions rejected at the type level
  startTransaction(): never
  connection(): never
  destroy(): never
}
```

Making illegal operations `never`-returning rather than runtime errors is a pattern
pg-orm-ts should adopt broadly.

### 1.6 Novel technique: `KyselyTypeError` — human-readable type errors

[verified — `dist/util/type-error.d.ts`, used in `expression-builder.d.ts:416`, `function-module.d.ts:517`]

```ts
any<RE extends StringReference<DB, TB>>(expr: RE)
  : Exclude<ExtractTypeFromReferenceExpression<DB, TB, RE>, null> extends ReadonlyArray<infer I>
      ? ExpressionWrapper<DB, TB, I>
      : KyselyTypeError<'any(expr) call failed: expr must be an array'>
```

Instead of failing with an inscrutable constraint mismatch, the type resolves to a
branded error type carrying a **sentence**. Downstream usage then fails with the message
visible. Cheap to implement, disproportionately good DX. **Port this.**

### 1.7 Novel technique: JSON "dehydration"

[verified — `ShallowDehydrateValue` in `dist/util/type-utils.d.ts`, applied by `jsonArrayFrom`]

When you aggregate rows into JSON inside the database, `Date` and `bigint` and `Uint8Array`
do not survive the round trip — they come back as strings/numbers. Kysely models this:

```ts
export type StringsWhenDataTypeNotAvailable = Date | Uint8Array
export type NumbersWhenDataTypeNotAvailable = bigint | NumericString
export type NumericString = `${number}`
```

Empirically [verified by probe, resolved `.d.ts`]:

```ts
// db.selectFrom('table_0').select(eb => ['id','created_at', jsonArrayFrom(...).as('kids')])
{
  id: number
  created_at: Date          // top level: driver parses to Date
  kids: { id: number; created_at: string }[]   // inside JSON: degraded to string
}
```

That is a subtle correctness win most libraries get wrong. There's even an opt-out,
`NonDehydrateable<T>`, for text columns that merely *look* numeric.

### 1.8 Where the types are fragile — **empirically measured**

I compiled probe files against `kysely@0.29.5` and read the emitted declarations. Results:

| # | Pattern | Resolved type | Verdict |
|---|---|---|---|
| 1 | `$if(cond, qb => qb.select('col_1'))` | `{ id: number; col_1?: string \| undefined }` | Degraded but honest |
| 2 | `flag ? qb.select(['id','col_1']) : qb.select(['id','col_2'])` | `{id;col_1} \| {id;col_2}` | Works correctly |
| 3 | `let qb = ...; if (flag) qb = qb.select('col_1')` | `{ id: number }` — **`col_1` silently lost, no error** | **Dangerous** |
| 4 | `leftJoin(...).select(['table_1.col_1'])` | `col_1: string \| null` | Correct |
| 5 | `$narrowType<{ owner_id: NotNull }>()` | `owner_id: number` | Works |
| 6 | `sql<string>\`...\`` / bare `` sql`...` `` | `string` / `unknown` | Safe default |
| 7 | `jsonArrayFrom` w/ `Date` column | `created_at: string` inside array | Correct (dehydration) |
| 8 | `db.dynamic.ref(someString)` | `{}` — **empty object** | **Silent total type loss** |

**(1) `$if` is structurally lossy.** The signature is [verified, `:2038`]:

```ts
$if<O2>(condition: boolean, func: (qb: this) => SelectQueryBuilder<any, any, O & O2>)
  : SelectQueryBuilder<DB, TB, O & Partial<Omit<O2, keyof O>>>
```

`Partial<...>` is unavoidable — `condition` is a runtime `boolean`, so the conditionally
selected columns *must* be optional. This is correct but means every conditional select
pushes an `undefined` into your domain types. In practice people either accept the
optionality, or split into two full queries and union them (pattern 2, which types
perfectly). **Design note for pg-orm-ts:** if the condition is a *literal* type
(`true`/`false`), you can do far better — overload on `condition: true` to return the
non-partial `O & O2`. Kysely does not do this. Cheap win.

**(3) is the real trap.** Because `O` is in a covariant (output) position,
`SelectQueryBuilder<DB, TB, {id} & {col_1}>` is assignable to
`SelectQueryBuilder<DB, TB, {id}>`. So the idiomatic imperative
"build up a query in a `let`" pattern **compiles clean and silently discards columns from
the result type**, and you then get `undefined` at runtime with no type error. There is no
diagnostic for this. Any builder with an accumulator generic inherits this hazard;
mitigations are to make the output param invariant (e.g. via a phantom function type) or
to steer users hard toward `$if`/`$call`.

**(8) dynamic columns are a full type hole.** `db.dynamic.ref(col: string)` with a
non-literal string yields `DynamicReferenceBuilder<never>` and the selection contributes
nothing — the probe's result type was literally `{}`. You must supply the generic
manually: `db.dynamic.ref<'col_0' | 'col_1'>(col)`. Fine, but it is opt-in safety, which
is the wrong default.

**(9) Reusable query fragments over a generic table param do not typecheck.** This is,
in my reading of community complaints, the single biggest day-to-day pain. Probe:

```ts
export function activeOnly<TB extends keyof DB>(eb: ExpressionBuilder<DB, TB & 'table_0'>) {
  return eb('table_0.status', '=', 'active')
}
// error TS2345: Argument of type 'string' is not assignable to parameter of type
//   'ReferenceExpression<DB, TB & "table_0">'
```

Because `TB` is an unresolved type variable, `ReferenceExpression<DB, TB>` cannot be
evaluated, so no string literal satisfies it. Writing genuinely generic helpers requires
either concrete table types or `any`. Compare the tracked issue on the same theme:
https://github.com/kysely-org/kysely/issues/867 ("Case of extremely slow type checking",
where reusable helpers were also the trigger).

**(10) Generic helpers poison declaration output.** A `findBy<T extends keyof DB>(table: T)`
compiles, but its emitted `.d.ts` return type is ~800 characters of unresolved conditional
types referencing `kysely/dist/parser/table-parser.js` internals [verified from emitted
`out/probe2.d.ts`]. For a *library* built on this, that is a real problem: deep import
paths leak, `.d.ts` bloats, and downstream error messages become unreadable.

**What works well:** `$call` composes perfectly and is the sanctioned escape hatch —

```ts
function paginate<DB2, TB extends keyof DB2, O>(page: number, size: number) {
  return (qb: SelectQueryBuilder<DB2, TB, O>) => qb.limit(size).offset(page * size)
}
db.selectFrom('table_0').select(['id','col_1']).$call(paginate(2, 20))
// -> { id: number; col_1: string }[]   [verified: O preserved exactly]
```

Builder→builder transforms parameterised over `O` are fully generic and lossless.
**Expression-level fragments are not.** That asymmetry is the thing to fix in pg-orm-ts.

### 1.9 Type-check performance — measured

Synthetic benchmark: N tables × 17 columns; Q queries, each with an inner join, a left
join, `eb.and`/`eb.or` composition, an aggregate, `jsonArrayFrom` + `jsonObjectFrom`,
`groupBy`, `orderBy`, `limit`. Measured with `tsc --noEmit --extendedDiagnostics`.

| Schema | Compiler | Check time | Instantiations | Memory |
|---|---|---|---|---|
| 80 tables / 60 queries | TypeScript 5.9.3 (JS) | 1.84 s | 743,495 | 204 MB |
| 80 tables / 60 queries | TypeScript 7.0.2 (native) | **0.55 s** | 743,868 | 108 MB |
| 300 tables / 200 queries | TypeScript 5.9.3 (JS) | **30.13 s** | 4,569,234 | 513 MB |
| 300 tables / 200 queries | TypeScript 7.0.2 (native) | **4.52 s** | 4,570,446 | 294 MB |

Four conclusions, and they matter for our design:

1. **TS 7 changes the picture materially — and more so at scale.** 3.4× faster on the
   small schema, **6.7× faster on the large one**. The 30-second number on TS 5.9 is
   recognisably the "Kysely types are unbearable" experience people report
   (cf. https://github.com/kysely-org/kysely/issues/867, where a single query pattern
   took ~30 s). On TS 7 the same workload is 4.5 s. As of 2026 this reputation is
   substantially stale — but only for teams that have moved to TS 7.

2. **Instantiation count is identical across compilers** (4.57M either way). The compiler
   got faster; the *type complexity* did not change. Any port inherits the complexity,
   not the speedup.

3. **Cost is superlinear in schema size, not just query count.** Going from 80/60 to
   300/200 is 3.3× the queries but **6.1× the instantiations** — per-query cost rose from
   ~12.4k to ~22.9k instantiations. The reason is structural: `AnyColumn<DB, TB>`,
   `AnyColumnWithTable<DB, TB>` and the alias parsers distribute over the schema, so
   **every query pays for the size of the whole `Database` interface**, not just the
   tables it touches. This is the single most important scaling property to design around.
   Mitigations worth exploring for pg-orm-ts: lazier column unions, per-table
   pre-computed column types emitted by codegen rather than derived on the fly, or
   interface-level caching so `AnyColumn<DB, 'person'>` is computed once.

4. **`DrainOuterGeneric` and aggressive `Simplify` are not optional.** They are what keeps
   this tractable at all; without them you hit TS2589 rather than merely slow builds.

---

## 2. Query building

### 2.1 Expression builder (`eb`)

Anywhere a callback is accepted, you get an `ExpressionBuilder<DB, TB>` scoped to the
tables in play. Surface [verified — `dist/expression/expression-builder.d.ts`]:

`eb(lhs, op, rhs)` (callable), `and`, `or`, `not`, `exists`, `neg`, `between`,
`betweenSymmetric`, `parens`, `cast`, `case`, `ref`, `val`, `lit`, `table`, `selectFrom`,
`fn`, `refTuple` (2–5 arity), `tuple` (2–5 arity), `jsonPath`, `unary`.

The callable-object design is nice: `eb` is both a function and a namespace.

```ts
db.selectFrom('person').selectAll().where((eb) => eb.and([
  eb('first_name', '=', 'Jennifer'),
  eb.or([
    eb('age', '>', 40),
    eb('last_name', 'like', '%son'),
  ]),
  eb.not(eb.exists(
    eb.selectFrom('pet').select('id').whereRef('pet.owner_id', '=', 'person.id')
  )),
]))
```

`and`/`or` are overloaded to also take an **object form** (`FilterObject<DB,TB>`)
[verified, `:779`/`:841`], i.e. `eb.and({ first_name: 'Jennifer', age: 40 })` — a
concession to the ORM-style `where` object that most people actually want.

Return typing is careful [verified, `:111`]: `eb(lhs, op, rhs)` returns
`ExpressionWrapper<DB, TB, SqlBool>` when `op` is a comparison operator, but the
*operand's* type when it's an arithmetic operator. `SqlBool = boolean | 0 | 1` — a
multi-dialect concession (SQLite/MySQL booleans). **PG-only can use plain `boolean`.**

`eb.fn` [verified — `dist/query-builder/function-module.d.ts`] gives `count`, `countAll`,
`sum`, `avg`, `min`, `max`, `coalesce` (1–5 arity), `agg` (arbitrary), plus PG-flavoured
`any`, `jsonAgg`, `toJson`.

### 2.2 Subqueries, CTEs, and `with`

Subqueries are just `eb.selectFrom(...)` inline; their output type is extracted and
nullable-ised where correlation can't be proven [verified — `select-parser.d.ts`:
`SE extends AliasedSelectQueryBuilder<infer O, any> ? O[keyof O] | null`].

CTEs via `with` [verified — `dist/parser/with-parser.d.ts`]:

```ts
export type QueryCreatorWithCommonTableExpression<DB, CN extends string, CTE> =
  QueryCreator<DB & { [K in ExtractTableFromCommonTableExpressionName<CN>]: ... }>
```

i.e. **`with` literally widens `DB`** for the remainder of the chain. Recursive CTEs get
`RecursiveCommonTableExpression<DB, CN>` where the CTE's own name is pre-injected into
`DB` so the recursive term can reference itself. `CommonTableExpressionOutput` accepts
select/insert/update/delete builders, so data-modifying CTEs (`WITH deleted AS (DELETE ... RETURNING *)`)
are typed — important for PG.

```ts
db.with('adults', (db) => db.selectFrom('person').where('age','>',18).select(['id','name']))
  .selectFrom('adults')
  .selectAll()
```

Column-name annotation is done in the CTE *name string*: `'adults(id, name)'` — parsed by
`ExtractRowFromCommonTableExpressionName`. Cute, and consistent with the
alias-in-a-string convention, but it means the CTE's row type comes from a string literal.

### 2.3 JSON helpers — relations without join-mapping

[verified — `dist/helpers/postgres.d.ts`]

```ts
function jsonArrayFrom<O>(expr: Expression<O>): RawBuilder<Simplify<ShallowDehydrateObject<O>>[]>
function jsonObjectFrom<O>(expr: Expression<O>): RawBuilder<Simplify<ShallowDehydrateObject<O>> | null>
function jsonBuildObject<O extends Record<string, Expression<unknown>>>(obj: O): RawBuilder<...>
function mergeAction(): RawBuilder<'INSERT' | 'UPDATE' | 'DELETE'>
```

Generated SQL (from the source docblock):

```sql
select "id", (
  select coalesce(json_agg(agg), '[]') from (
    select "pet"."id" as "pet_id", "pet"."name"
    from "pet" where "pet"."owner_id" = "person"."id" order by "pet"."name"
  ) as agg
) as "pets"
from "person"
```

This is the **single most important idea to port**. It solves nested relational results
in *one* round trip with *no* row-explosion and *no* result-set flattening logic, and the
result type is exact. `jsonObjectFrom` correctly returns `| null`.

Caveats [https://kysely.dev/docs/recipes/relations]:
- Kysely explicitly says it "DOES NOT have the concept of relations" — these are helpers,
  not a relation graph. You re-state the join predicate (`whereRef`) at every call site.
- People wrap them in per-relation helper functions (`withPets(eb)`) to DRY it up — but
  see §1.8(9): those helpers can't be generic over the outer table.
- Nullability is conservative; `$notNull()` / `$narrowType` are the manual overrides.
- `ParseJSONResultsPlugin` needed when the driver doesn't parse `json`. With `pg` +
  `PostgresDialect`, `json`/`jsonb` are parsed natively, so it's not needed.

**PG-only notes:**
- `json_agg` vs `jsonb_agg` matters — `jsonb` reorders keys and dedupes, `json` preserves.
  Kysely hardcodes `json_agg` + `to_json`. A PG-only library should make this a choice.
- `coalesce(json_agg(...), '[]')` is the correct empty-array handling and is easy to get
  wrong; copy it.
- Kysely **does** have `innerJoinLateral` / `leftJoinLateral` [verified,
  `select-query-builder.d.ts:996/1033`] — but the JSON relation helpers do **not** use
  them; they emit correlated scalar subqueries. For large fan-outs
  `LEFT JOIN LATERAL (... ) ON TRUE` can plan better. Since the helpers and the lateral
  joins already coexist, wiring the relation layer to choose between them is an
  opportunity Kysely left on the table.

### 2.4 `onConflict` — and the `excluded` typing trick

[verified — `dist/query-builder/on-conflict-builder.d.ts`]

```ts
export type OnConflictDatabase<DB, TB extends keyof DB> = {
  [K in keyof DB | 'excluded']: Updateable<K extends keyof DB ? DB[K] : DB[TB]>
}
export type OnConflictTables<TB> = TB | 'excluded'
```

PG's `EXCLUDED` pseudo-table is modelled by **synthesising a virtual table into `DB`**
for the duration of the `doUpdateSet` callback. Elegant, and directly reusable.

```ts
db.insertInto('person')
  .values({ id: 1, first_name: 'Jennifer' })
  .onConflict((oc) => oc
    .column('id')
    .where('person.deleted_at', 'is', null)          // partial-index predicate
    .doUpdateSet((eb) => ({ first_name: eb.ref('excluded.first_name') })))
  .returning(['id'])
  .executeTakeFirstOrThrow()
```

Full builder: `.column()`, `.columns()`, `.constraint()`, `.expression()` (for
expression indexes), `.where()`/`.whereRef()` (partial indexes), `.doNothing()`,
`.doUpdateSet()`, and a `where` on the update builder for the `DO UPDATE ... WHERE` clause.
That is essentially complete PG `ON CONFLICT` coverage.

### 2.5 `returning`

[verified, `insert-query-builder.d.ts:804-813`]

```ts
returning<SE extends SelectExpression<DB, TB>>(selections: ReadonlyArray<SE>)
  : InsertQueryBuilder<DB, TB, ReturningRow<DB, TB, O, SE>>
returningAll(): InsertQueryBuilder<DB, TB, Selectable<DB[TB]>>
```

`returning` reuses the *exact same* `SelectExpression` machinery as `select` — so
aliases, expressions, subqueries, and raw ``sql`` `` fragments all work in `RETURNING`. Right call.
Available on insert/update/delete/merge.

### 2.6 The `sql` template tag

```ts
const persons = await db.selectFrom('person')
  .select(sql<string>`concat(first_name, ' ', last_name)`.as('full_name'))
  .where(sql<SqlBool>`lower(email) = ${email.toLowerCase()}`)
  .execute()
```

Substitutions are always **parameterised**, never interpolated [verified — docblock and
`RawNode` construction]. Identifier/literal injection is explicit and opt-in via
`sql.ref`, `sql.table`, `sql.id`, `sql.lit`, `sql.raw`, `sql.join`, `sql.val`.

Typing is **assertion, not inference**: `sql<T>` is whatever you claim. Probe [verified]:
bare `` sql`whatever()` `` resolves to **`unknown`**, not `any`. That's the right default —
you're forced to acknowledge the hole. `RawBuilder<O>` implements `AliasableExpression<O>`,
so raw fragments are first-class citizens everywhere an expression is accepted, which is
what makes the escape hatch actually usable rather than a dead end.

`InferResult<typeof query>` [verified — `dist/util/infer-result.d.ts`] recovers the row
type from a built-but-unexecuted query, enabling the "compile with `DummyDriver`, execute
elsewhere" split (https://kysely.dev/docs/recipes/splitting-query-building-and-execution).

---

## 3. How schemas come to exist — the source-of-truth inversion

**Kysely has no schema.** It has a *type* you must produce by some other means. There are
three ecosystem answers, and the choice determines your entire workflow.

### 3.1 `kysely-codegen` — introspect the live DB

- npm `kysely-codegen@0.20.0` (2026-02-16), ~1.13M downloads/week.
  https://github.com/RobinBlomberg/kysely-codegen
- Connects to a **running database**, introspects, emits a `Database` interface with
  `Generated<>` / `ColumnType<>` and enums as string-literal unions.
- Not zero-dep: pulls `zod`, `cosmiconfig`, `chalk`, `dotenv`, `micromatch`, `pluralize`,
  `diff`. Package is ~6.8 MB / 35 deps.
- Introspector dialects: `postgres, mysql, sqlite, mssql, libsql, kysely-bun-sqlite`.

**There is no offline mode.** `Introspector.connect()` builds a real Kysely instance from
a connection string, tries SSL then retries without, and runs `SELECT 1`. No migration-file
parsing, no PGlite. The only "offline" case is SQLite, where the URL is a file path.

Postgres introspection is Kysely's `getTables()` plus four bespoke queries: domains
(recursive CTE to root base type), enums (`pg_enum`), partitions (`pg_inherits`), and —
new in 0.20.0 — materialized views.

Emitted shape:

```ts
import { ColumnType } from 'kysely';
export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U> : ColumnType<T, T | undefined, T>;
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface User {
  company_id: number | null;
  created_at: Generated<Timestamp>;
  email: string;
  id: Generated<number>;
}
export interface DB { company: Company; user: User; }
```

PG type mapping: `int8` → `ColumnType<string, string|number|bigint, …>`; `numeric` →
`string` by default; `timestamptz` → `Timestamp`; `json`/`jsonb` → a structural
`JsonValue`; `interval` → `IPostgresInterval`; `bytea` → `Buffer`; arrays detected by the
`_` type-name prefix; **enums → string literal unions** by default. `defaultScalar` is
`string`, so **composite types, PostGIS `geometry`, and `vector` all silently become
`string`.**

Limitations that matter for our design (all verified, mostly open issues):

- **No `GeneratedAlways` anywhere in the codebase.** The rule is one line —
  `isGenerated = column.hasDefaultValue || column.isAutoIncrementing` — so identity and
  `GENERATED ALWAYS AS … STORED` columns get plain `Generated<T>` and remain insertable
  at the type level ([#271](https://github.com/RobinBlomberg/kysely-codegen/issues/271)).
- **`isView` is captured but never read.** Views and matviews are emitted byte-identically
  to tables, so `db.insertInto('some_view')` typechecks. Worse, PG reports all view columns
  nullable, so a view over `NOT NULL` columns generates `id: number | null`
  ([#261](https://github.com/RobinBlomberg/kysely-codegen/issues/261), open).
- **Composite types: no support at all** (no `typtype='c'` query). Domains are *flattened*
  to their base type rather than branded ([#207](https://github.com/RobinBlomberg/kysely-codegen/issues/207)).
- **Extension types can't be overridden** — `typeMapping` is gated behind a hardcoded
  `isKnownType` allowlist, so pgvector's `vector` is unfixable
  ([#300](https://github.com/RobinBlomberg/kysely-codegen/issues/300)).
- **Multiple schemas collide**: two schemas each with a `foo` table emit two
  `interface Foo` and a `DB` with a duplicate key — invalid TypeScript
  ([#219](https://github.com/RobinBlomberg/kysely-codegen/issues/219)).
- **Default output is `./node_modules/kysely-codegen/dist/db.d.ts`** — which `npm install`
  deletes. marmelab's writeup states the consequence plainly: *"You must regenerate the
  types each time you change the database schema, **and after each `npm install`**"*
  (https://marmelab.com/blog/2024/02/14/type-safe-sql-wheries-with-kysely.html).
- Release cadence has slowed to ~2/year (0.18.0 Mar 2025, 0.19.0 Sep 2025, 0.20.0 Feb 2026,
  nothing since), prompting at least one fork. Materialized-view support took ~2.8 years
  from request to ship ([#72](https://github.com/RobinBlomberg/kysely-codegen/issues/72),
  Apr 2023 → 0.20.0, Feb 2026).
- **`--verify` checks the wrong invariant.** It reads the committed file, re-introspects,
  and throws `"Generated types are not up-to-date!"` on any diff — but `newOutput` still
  comes from **a live database**. So it asserts *committed file == this database*, when
  what you actually want asserted is *committed file == my migration files*. If CI's DB is
  on the wrong migration, `--verify` fails for the wrong reason, or passes while wrong.
  Combined with the fact that it silently exited `0` on drift until 0.18.0, this is a guard
  that has never quite guarded the right thing.

Signal worth weighing: **kysely-codegen carries ~72 open issues against prisma-kysely's 5**
— consistent with live introspection having a far larger surface of edge cases than
reading a declarative schema file.

**Adoption trend is the most interesting datum.** Monthly downloads Aug 2025 → Jul 2026:
`kysely` 4.08M → 48.4M (11.8×) but `kysely-codegen` 0.93M → 4.49M (4.8×). **kysely-codegen's
share of Kysely dropped from ~22.8% to ~9.3% in twelve months.** Some of that is Kysely
becoming a transitive dependency (better-auth adapters, ZenStack v3) inflating the
denominator — but directionally, DB-first codegen is losing share, not gaining it.

### 3.2 `prisma-kysely` — Prisma schema as source of truth

- npm `prisma-kysely@3.1.1` (2026-05-24), ~193k/week, 1.2k stars, **only 5 open issues**
  (healthiest tracker of the three). https://github.com/valtyr/prisma-kysely

A Prisma *generator*: it runs inside `prisma generate` / `prisma migrate dev`. Its own
pitch: *"Do you like Prisma's migration flow, schema language and DX but not the
limitations of the Prisma Client?"*

**The key architectural property: it never touches a database.** It reads the Prisma AST.
That deletes the entire ordering problem — types exist the moment the schema file is
edited, and CI needs no Postgres container to typecheck.

It is also *more correct* than kysely-codegen on two axes: `readOnlyIds: true` emits real
**`GeneratedAlways`**, and `exportWrappedTypes` emits `Selectable`/`Insertable`/`Updateable`
variants so `Generated<>` doesn't leak into app code.

Costs: **3.0.0 hard-requires Prisma ≥ 7**, so you inherit Prisma's major-version treadmill
and its Rust toolchain for what is ultimately a code generator. Documented gotcha: Prisma's
`uuid()`/`cuid()` are JS-side and never become DB defaults, so you must write
`@default(dbgenerated("gen_random_uuid()"))` for `Generated<>` to apply.

Irony worth noting: Prisma's *own* Kysely quickstart
(https://www.prisma.io/docs/prisma-postgres/quickstart/kysely) doesn't use prisma-kysely —
it tells you to hand-write the `Database` interface.

### 3.3 `kanel` / `kanel-kysely` — PG-only, and materially better

- npm `kanel@4.0.3` (2026-07-18) ~152k/week; `kanel-kysely@4.0.0` ~89k/week.
  https://github.com/kristiandupont/kanel

PG-only, built on `extract-pg-schema` — substantially richer than Kysely's own
introspector. Emits flavored ID types and the three operation variants:

```ts
export type ActorId = number & { __flavor?: "ActorId" };
export default interface ActorTable {
  actor_id: ColumnType<ActorId, ActorId | null, ActorId | null>;
  first_name: ColumnType<string, string, string | null>;
}
export type Actor = Selectable<ActorTable>;
export type NewActor = Insertable<ActorTable>;
export type ActorUpdate = Updateable<ActorTable>;
```

`__flavor?` is *optional*, so it's "flavored" not strictly branded: a raw `number` is
accepted where `ActorId` is expected, but an `OrderId` is not.

**Where PG-only specialization visibly pays off** — every one of these is something the
multi-DB tool gets wrong:

- **Composite types are first-class.** Dedicated generators also exist for domains, ranges,
  enums, routines (functions/procedures), and Markdown schema docs.
- **Views and matviews get `canInitialize = false; canMutate = false`**, so no
  `New*`/`*Update` types are emitted — you *cannot* accidentally insert into a view.
- **Respects `column.generated !== "ALWAYS"`**, so generated-always columns are `never`
  on insert/update — correct, unlike kysely-codegen.
- **`resolveViews: true` parses view SQL definitions** to recover nullability and identifier
  types from source columns — the direct fix for kysely-codegen's #261.
- Doc comments from PG `COMMENT ON`; companion `kanel-zod` (~22k/week) emits Zod schemas
  from the same introspection pass.

**This is the single strongest empirical argument in this entire document that PG-only
specialization produces a better tool, not just a smaller one.** Study
`extract-pg-schema` closely for pg-orm-ts's introspector.

Honest framing from a LogRocket tutorial: *"Kanel will be very handy for scenarios where
the database is already developed and acts as the single source of truth. Otherwise, it
may not be as useful."*

### 3.4 Alternatives and the 2025–2026 direction of travel

**Drizzle → Kysely.** `drizzle-kysely` is not an npm package (it's a demo repo). The real
bridge is the `drizzle-orm/kysely` subpath export, which ships exactly one type:

```ts
interface Database { customer: Kyselify<typeof customers> }
```

`Kyselify<T>` builds `ColumnType<Select, Insert, Update>` from Drizzle's
`InferSelectModel`/`InferInsertModel` with `dbColumnNames: true` (keys off DB snake_case,
not JS property names). It is **per-table** — no `KyselifyAll<typeof schema>` — so you
hand-assemble `Database`. Zero runtime code. Note the standalone `drizzle-kysely`
**package is not published to npm**; the GitHub repo of that name is a Northwind demo, and
the real artifact is the subpath export. Drizzle frames it narrowly, but it is **the only
mature schema-in-code → Kysely-types path**, riding on 18.2M weekly downloads.

**Supabase → Kysely** deserves a mention because it is the closest thing to a *first-party*
codegen artifact: `kysely-supabase` (~22k/week) is hosted under **`kysely-org/`** and
bridges `supabase gen types typescript` output in one line —
`type Database = KyselifyDatabase<SupabaseDatabase>`. It is a type *translator*, not a
generator, and hasn't been touched since Aug 2025.

**`kysely-typegen`** (v2.0.0, 2026-05-22) is worth watching for a structural reason: it is a
**library, not a CLI** — `new KyselyTypegenPostgresDialect({ database }).typegen()` takes
any Kysely instance and calls `database.introspection.getTables()`. 22.1 kB with zero
runtime deps against kysely-codegen's 6.8 MB / 35 deps. Because it accepts *any* Kysely
instance, it would compose with a PGlite-backed one — which is the offline story below,
assembled from live parts. (That composition is my inference from the API shape, not a
documented use case; downloads are ~39/week.)

**Migrations-as-source-of-truth via ephemeral PGlite — the most important finding here.**
`kysely-pglite` (~18k/week) ships a CLI that is, per its own README, *"a wrapper around
kysely-codegen to get around its requirement of a connection to a running database."*

```bash
npx kysely-pglite ./src/db/migrations --outFile ./src/db/schema.ts --watch
```

Run your migrations against in-memory PGlite, emit types. **No Docker, no live DB, no
ordering problem, no possible drift**, and `--watch` regenerates on save. But it was last
published 2024-09-16 and pins `kysely-codegen@^0.15.0`, so it misses everything from
0.16–0.20. `@electric-sql/pglite` itself is very healthy (0.5.5, ~13.5M/week).

The same pattern reappeared independently in June 2026 as `bun-sqlgen`
(https://news.ycombinator.com/item?id=48645393), for Bun.sql:

> *"A codegen step reads your migration `.sql` files, stands up a throwaway Postgres via
> PGlite (so no Docker) or SQLite, prepares every tagged query against it, and writes a
> `.d.ts`… Nullability was the annoying part. Postgres's describe doesn't hand you
> per-column nullability, so I infer it from the query plan plus the catalog."*

and its author names the structural constraint precisely
(https://news.ycombinator.com/item?id=48646848):

> *"in JS/TS you don't have compile-time scripts that you can run like with Rust's macros,
> so you need to run a codegen command before running the type checks (disadvantage)."*

Also in this direction: `@izumisy/kyrage` (declarative TS schema → generated migrations,
using **Testcontainers for an ephemeral shadow DB**), and `kysely-tables` — the purest
statement of the full inversion (*"Your Kysely types become the single source of truth for
your `CREATE TABLE` statements"*), but a self-declared proof of concept at 22 downloads/week
with nothing published since May 2025.

**Dead ends, so we don't re-investigate them:** `pg-to-ts` (2023, never mentions Kysely);
Atlas emits **no TypeScript types and has no Kysely provider**; Squawk is DDL linting only;
`kysely-migrate` is dead (2023); Supabase's `gen types` has no Kysely mode (only the
`kysely-supabase` type *translator*, untouched since Aug 2025); Neon/PlanetScale/Xata ship
dialects, not codegen. **No LLM-based schema-to-type tooling exists** in this space.

**`kysely-ctl` explicitly does not do codegen.** Its command surface is exactly
`migrate:*`, `seed:*`, `sql` — no codegen command, no mention of kysely-codegen in its
README. Kysely maintainer Igal Klebanov stated the gap plainly on HN, 2026-05-23
(https://news.ycombinator.com/item?id=48249804): *"`kysely-ctl` doesn't generate migrations
for you, and `kysely` not being an ORM, doesn't provide declarative schema design."*

There is **no first-party kysely-org codegen and no roadmap for one.** `awesome-kysely`
(also kysely-org) has no "type generators" section at all, and the org's own docs page
lists a fourth recommended generator, `kysely-schema-generator`, whose **npm package name
404s** — so that recommendation is stale.

### 3.5 Assessment of the inversion

Arguments **for** database-as-source-of-truth (stated fairly):
- The types describe what is *actually* there. yashap on HN
  (https://news.ycombinator.com/item?id=36419056): *"it generates the types from your DB
  schema, **guaranteeing they match**."*
- No impedance mismatch with hand-written DDL, extensions, views, or anything a schema DSL
  can't express. *"Using vanilla SQL DDL for that part gives you more escape hatches"*
  (https://news.ycombinator.com/item?id=42343344).
- Works when you inherited a database you don't control, or share it across languages.

Arguments **against** — and these are now backed by specific, citable failures:

- **Ordering inversion.** `tsc` cannot run until a live DB has been migrated. The canonical
  thread is [kysely-codegen #179 "Usage in CI pipeline?"](https://github.com/RobinBlomberg/kysely-codegen/issues/179):
  *"I could probably start docker compose with Postgres during CI, run migrations and
  generate types. However, that seems like an overkill."* The only answer he received was
  "check the generated types into your repo" — which manufactures the drift problem.
- **CI becomes a five-step dance**: spin up throwaway Postgres → run migrations → generate
  to a temp file → diff against the committed file → fail on difference. Teams write this
  with an explicit budget ("must run in under 60 seconds").
- **Drift silently voids the guarantee.** Best statement of it, from a real repo issue:
  *"If the types file drifts from the actual schema, **the compile-time guarantees the
  whole adoption was built on evaporate silently.**"* And the guard itself was broken for
  two years — [#213](https://github.com/RobinBlomberg/kysely-codegen/issues/213):
  **`--verify` exited `0` on drift** until 0.18.0, so every drift-check CI job written
  before that was a no-op.
- **Generated-file churn is worse than diff noise — it's non-deterministic.**
  [#95](https://github.com/RobinBlomberg/kysely-codegen/issues/95)/[#96](https://github.com/RobinBlomberg/kysely-codegen/issues/96):
  *"columns are generated in different orders in some tables when run in CICD vs locally,
  which creates some file diffs and fails the tests."* The identical bug exists in
  Supabase's equivalent tool ([postgres-meta #968](https://github.com/supabase/postgres-meta/issues/968)):
  *"The same database schema produces different field orders across different runs, making
  it impossible to maintain consistent type definitions in version control."* This is
  inherent to the pattern: a `git diff --exit-code` gate over a file produced by querying a
  database is only as stable as that database's row ordering.
- **Monorepos break it twice**: hoisted `node_modules` breaks driver resolution while the
  tool writes a **silently empty** output file after printing `✓ Introspected 55 tables`
  ([#116](https://github.com/RobinBlomberg/kysely-codegen/issues/116), open since Nov 2023);
  and N packages each need their own types file regenerated in lockstep.
- **`Generated<>`/`ColumnType<>` leak into application code.**
  [#63](https://github.com/RobinBlomberg/kysely-codegen/issues/63): *"If I'm using
  something like React or Svelte, and I want to type a prop… I'll get errors for the
  `Generated<number>` on the `id` column."* Still open. `prisma-kysely` and `kanel-kysely`
  both fix this by emitting the wrapped variants; kysely-codegen still doesn't.
- **No compile-time migration safety.** Nothing connects "I dropped column X" to "37
  queries reference X" until after the drop.

**Where the complaint record is genuinely thin** (reported honestly rather than
embellished): there are **no citable sources** for branch-switching pain or for merge
conflicts in the generated file, despite both being plausible corollaries. The
gitignore-vs-commit debate exists only as fragments. And no blog post or conference talk
arguing against DB-first codegen for Kysely appears to exist — the critique lives entirely
in scattered issues, competing tools' README bullets, and HN comments. Also note some of
the 2026-vintage GitHub issues describing CI drift pipelines read as agent-authored
planning documents; they are real artifacts describing real workflows, but they are not a
human venting.

**For pg-orm-ts, three conclusions:**

1. **Schema-in-code as primary.** Types exist offline, CI needs no database, and the
   migration tool can diff because it holds both desired and actual state. The Kysely
   ecosystem has effectively voted for this already — `prisma-kysely` is popular precisely
   because it restores a declarative source of truth, and codegen's share of Kysely
   installs is falling.
2. **Introspection as bootstrap + drift check, never as the source of truth.** And learn
   the drift-check lessons the hard way already paid: make output **deterministic**
   (explicit ordering, not catalog order), make `--verify`-equivalent actually fail, and
   never write generated output into `node_modules`.
3. **Ship ephemeral-PGlite codegen as a supported path.** The "run migrations against
   in-memory PGlite, emit types, no Docker" pattern is architecturally the cleanest answer
   to the ordering problem, is clearly where 2026 experimentation is heading
   (`kysely-pglite`, `bun-sqlgen`, `kyrage`), and **the only Kysely-specific implementation
   is two years stale and pinned to an ancient codegen.** That is a visible, unclaimed hole
   in the ecosystem, and for a PG-only library PGlite is a natural fit.

---

## 4. Migrations

### 4.1 What Kysely provides

A **programmatic `Migrator`**, exported from `kysely/migration` [verified — export map].

```ts
import { Migrator, FileMigrationProvider } from 'kysely'

const migrator = new Migrator({
  db,
  provider: new FileMigrationProvider({ fs, path, migrationFolder: '...' }),
})
const { error, results } = await migrator.migrateToLatest()
```

A migration is a module exporting `up(db: Kysely<any>)` and optional `down(db)`.
Methods: `migrateToLatest`, `migrateUp`, `migrateDown`, `migrateTo`, `getMigrations`.
Ordering is by filename (lexicographic), so the convention is timestamp prefixes.
Bookkeeping lives in `kysely_migration` and `kysely_migration_lock`.

PG locking is done properly [verified — `dist/dialect/postgres/postgres-adapter.js`]:

```js
const LOCK_ID = BigInt('3853314791062309107')
await sql`
  with set_timeout as (
    select set_config('lock_timeout', '${sql.lit(LOCK_TIMEOUT_MILLISECONDS)}', true) as config_val
  )
  select pg_advisory_lock(${sql.lit(LOCK_ID)})
  from set_timeout`.execute(db)
```

A **session-level advisory lock with a timeout, acquired in one round trip**. That's the
right primitive for PG and directly portable. `PostgresAdapter` also declares
`supportsTransactionalDdl = true`, so migrations run inside transactions — which PG
genuinely supports and MySQL does not.

### 4.2 The DDL builder

[verified — `dist/schema/`] Reasonably broad: `createTable`/`alterTable`/`dropTable`,
`createIndex`/`dropIndex`, `createType`/`alterType`/`dropType` (PG enums, incl.
`alterTypeAddValue`), `createView`/`dropView`/`refreshMaterializedView`,
`createSchema`/`dropSchema`, and constraint builders (foreign key, primary key, unique,
check).

`ColumnDefinitionBuilder` [verified]: `primaryKey`, `notNull`, `unique`, `references` +
`onDelete`/`onUpdate`, `defaultTo`, `check`, `generatedAlwaysAs` + `stored`,
`generatedAlwaysAsIdentity`, `generatedByDefaultAsIdentity`, `identity`,
`nullsNotDistinct`, `ifNotExists`, plus `modifyFront`/`modifyEnd` raw escape hatches.

`nullsNotDistinct` and `generatedAlwaysAsIdentity` are PG-specific — the DDL builder is
already more PG-flavoured than the query builder. `unsigned`/`autoIncrement` are the
MySQL/SQLite pollution going the other way.

Not covered natively (needs the raw ``sql`` `` tag): `CREATE INDEX CONCURRENTLY`, partial index
predicates on `createIndex` (there's `.where()` on some paths but coverage is uneven),
GIN/GiST/BRIN operator classes, extensions, RLS policies, triggers, partitions,
`CREATE STATISTICS`, exclusion constraints. All are one `sql` call away, but untyped.

### 4.3 Migrations are untyped — deliberately

Migrations receive `Kysely<any>`. The docs are explicit about why
(https://kysely.dev/docs/migrations):

> *"Migrations should never depend on the current code of your app because they need to
> work even when the app changes."*

The reasoning is sound: a migration is a snapshot of history, and your `Database` type is
always the *current* schema. Importing it means old migrations break every time you change
the schema. Every migration system faces this; Kysely's answer (just use `any`) is the
honest one, at the cost of zero autocomplete in exactly the place you're typing table and
column names by hand.

Other verified behaviours from the docs: ordering is "alpha-numeric order of your
migration names" (ISO-8601 prefixes recommended); Kysely **validates that new migrations
don't violate previously-executed order**, disableable via `allowUnorderedMigrations: true`;
"the migration methods use a lock on the database level and parallel calls are executed
serially", and locks auto-release on crash or connection loss (a direct consequence of
using a *session-level* PG advisory lock rather than a row in a table — note this).
`migrateToLatest()` returns a `MigrationResultSet` of `{ migrationName, direction, status }`
plus an `error` property, rather than throwing.

**Design note for pg-orm-ts:** you could do better by generating a *per-migration
snapshot type* — each migration gets the schema type as of its own point in history. That
is genuinely feasible if the schema is declared in code and versioned, and would be a
differentiator. Cost: snapshot files, and they must be regenerated correctly.

### 4.4 No diffing, no autogeneration — how much does it hurt?

Kysely will not look at your schema and produce a migration. You write every
`ALTER TABLE` by hand. Contrast: `prisma migrate dev` diffs against a shadow database;
`drizzle-kit generate` diffs the TS schema against a stored snapshot; Atlas
(https://atlasgo.io) does declarative diffing for PG including things ORM DSLs can't
express.

Honest assessment:

- **It hurts less than you'd expect for schema-in-DB workflows**, because there's nothing
  to diff *against* — the DB is the truth and migrations are how you change it. The
  workflow is coherent, just manual.
- **It hurts a lot for iteration speed.** Adding a field is: write migration → run it →
  run codegen → use it. In Prisma/Drizzle it's: edit schema → one command.
- **It's arguably safer.** Auto-generated migrations for PG are where data loss happens
  (column renames diffed as drop+add; type changes needing `USING`; index creation
  locking a hot table). Hand-written migrations force you to think. Several people cite
  this as a feature.
- The real gap isn't diffing per se — it's that **nothing tells you your DB has drifted**
  from what your code expects.

**Recommendation for pg-orm-ts:** diffing is worth building *if* schema-in-code is the
source of truth, but the deliverable people actually need is (a) a **drift detector**,
(b) **generated migrations you are expected to edit**, not run blind, and (c) **safety
linting** on the generated DDL (destructive change detection, lock-level analysis, the
`CONCURRENTLY` recommendation). Generating a migration is the easy 30%.

### 4.5 What the ecosystem bolts on

- **`kysely-ctl`** (npm `kysely-ctl@0.21.0`, 2026-05-10, ~257k/week) —
  https://github.com/kysely-org/kysely-ctl. A CLI wrapper: `migrate make/latest/up/down`,
  seeds, config file, TS loading via `jiti`. It is under the `kysely-org` umbrella and is
  the de facto official CLI. Note it is ~20× less installed than Kysely itself — most
  people script the `Migrator` themselves.
- **Prisma migrate + `prisma-kysely`** — the most common "I want real migrations" answer.
- **Atlas** — declarative PG schema management alongside Kysely; strongest option for
  teams who want diffing without Prisma's weight.
- Safety tooling (`squawk`, `pgroll`, `reshape`) is orthogonal and composes with any of
  the above.

---

## 5. Plugins, dialects, dependencies, maintenance

### 5.1 Plugin system

```ts
export interface KyselyPlugin {
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode
  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>>
}
```

Two hooks: rewrite the **operation-node tree** before compilation, and transform the
**result rows** after execution. Correlating the two is done with a `WeakMap` keyed on
`args.queryId` (the docblock says so explicitly [verified]). `OperationNodeTransformer`
is the provided visitor base class.

Built-in plugins [verified — `dist/plugin/`]:

| Plugin | Purpose |
|---|---|
| `CamelCasePlugin` | camelCase in TS ↔ snake_case in SQL, both directions |
| `ParseJSONResultsPlugin` | `JSON.parse` string-returned json columns |
| `DeduplicateJoinsPlugin` | drop duplicate joins introduced by composed fragments |
| `HandleEmptyInListsPlugin` | rewrite `in ()` (invalid SQL) to a constant false |
| `ImmediateValuePlugin` | inline parameters as literals |
| `WithSchemaPlugin` | prefix a schema onto unqualified identifiers |
| `SafeNullComparisonPlugin` | `= null` → `is null` |
| `NoopPlugin` | base/test |

**The `CamelCasePlugin` type gap is the archetypal example of "runtime plugin, no type
awareness."** The docblock is blunt [verified]: *"__everything__ needs to be defined in
camelCase in the TypeScript code: table names, columns, schemas, __everything__. When
using the `CamelCasePlugin` Kysely works as if the database was defined in camelCase."*
The plugin cannot change types — it only rewrites nodes and rows. Your `Database`
interface must *already* be camelCase (hence `kysely-codegen --camel-case`). So the
plugin is really a **runtime half of a two-part feature whose type half lives in your
codegen tool**. Two independent knobs that must agree, or everything silently breaks.

**Lesson for pg-orm-ts:** naming strategy must be a **first-class, type-aware** concern
resolved in one place — ideally a type-level `SnakeCase<T>` mapping applied by the library
itself, so the `Database` type can stay in DB-native casing and the surface is camelCase.
This is very achievable with template-literal types and is a clear differentiator.

`DeduplicateJoinsPlugin` and `HandleEmptyInListsPlugin` are both **papering over
composition problems** the API should arguably prevent. Worth designing out rather than
plugging in: an `in []` should compile to `false` by construction, and composed fragments
shouldn't be able to double-add joins.

### 5.2 Dialect abstraction cost — measured, and surprising

```ts
export interface Dialect {
  createDriver(): Driver
  createQueryCompiler(): QueryCompiler
  createAdapter(): DialectAdapter
  createIntrospector(db: Kysely<any>): DatabaseIntrospector
}
```

Structural cost [verified]: 108 operation-node types, one 1,452-line
`DefaultQueryCompiler`, ~6 files (~48–68 KB) per dialect.

The surprise: **`PostgresQueryCompiler` overrides exactly one method** [verified, full file]:

```js
export class PostgresQueryCompiler extends DefaultQueryCompiler {
  sanitizeIdentifier(identifier) { return identifier.replace(ID_WRAP_REGEX, '""') }
}
```

`PostgresAdapter` is likewise ~30 lines (two capability flags + advisory-lock SQL).
So the *compiler-level* dialect cost for Postgres is near zero. **The real cost is
elsewhere, and it is entirely in the type surface:**

1. **API pollution — quantified.** Grepping the four main query builders for
   "only supported by some dialects" returns **28 hits** [verified]. On
   `InsertQueryBuilder` alone, **10 methods are invalid on PostgreSQL** and yet
   autocomplete for a Postgres user [verified, with line numbers]:

   ```
   ignore (:347)  orIgnore (:383)  orAbort (:410)  orFail (:437)
   orReplace (:466)  orRollback (:493)          -> SQLite
   top (:541)  output (:928)  outputAll (:937)  -> MS SQL Server
   onDuplicateKeyUpdate (:748)                  -> MySQL
   ```

   Every one is a method the user can call that produces SQL their database rejects
   **at runtime, not compile time**. This is the single clearest thing PG-only
   specialization deletes — and it's a pure win, not a trade-off.
2. **Lowest-common-denominator result types.** The killer example [verified by probe]:

   ```ts
   eb.fn.countAll().as('a')          // -> string | number | bigint
   eb.fn.count('id').as('b')         // -> string | number | bigint
   eb.fn.count<number>('id').as('c') // -> number   (you asserted it)
   eb.fn.sum('owner_id').as('d')     // -> string | number | bigint
   eb.fn.avg('owner_id').as('e')     // -> string | number
   ```

   Kysely cannot know your driver, so it hands you a union and makes you assert. **A
   PG-only library knows**: with `node-postgres` defaults, `count()` → `string`,
   `sum(int)` → `string`, `avg(int)` → `string`, `max(timestamptz)` → `Date`. That is a
   *correct, single* type per function, no generic required. Same for `SqlBool =
   boolean | 0 | 1` → just `boolean`.
3. **PG operators exist, but operand typing is naive.** Credit where due: the
   `ComparisonOperator` union [verified — `dist/operation-node/operator-node.d.ts`]
   already includes `@>`, `<@`, `^@`, `&&`, `?`, `?&`, `?|`, `@@`, `@@@`, `<->`, `~`,
   `~*`, `!~`, `is distinct from`, plus `->`/`->>` as `JSONOperator`. So PG-specific
   operators *are* callable.

   But the **right-hand operand is typed against the column's type, not the operator's
   semantics** [verified by probe]:

   ```ts
   eb('tags', '@>', ['x'])       // ok — text[] @> text[] happens to match the column type
   eb('span', '&&', 'whatever')  // error: not assignable to OperandValueExpressionOrList<..., 'span'>
   ```

   That's correct by accident for `@>` on an array and wrong in general: `jsonb ? key`
   takes **text**, not jsonb; `tsvector @@ tsquery` takes a **tsquery**; `&&` on a range
   takes a **range**. Kysely derives the operand from the column because it cannot encode
   per-operator operand rules across four dialects. **PG-only can**: a map from
   `(columnType, operator) → operandType` is finite and writable, and it turns a whole
   class of runtime `42883 operator does not exist` errors into compile errors.

4. **Missing PG-native types.** No first-class ranges, composite types, domains, `ltree`,
   `citext`, PostGIS, `interval`, `tsvector`, or `numeric`-precision handling, because
   none generalise. (Arrays do work, as plain TS arrays, and `eb.fn.any()` correctly
   requires an array-typed reference [verified].) A PG-only library can ship all of these
   properly typed.

### 5.3 Zero dependencies — verified, and the mechanism is worth stealing

`npm view kysely dependencies` → **none**. `peerDependencies` → **none**.
`npm ls` in a clean project shows `kysely@0.29.5` with no children. [verified]

Installed footprint: **3.4 MB / 610 files** (`node_modules/kysely`) — overwhelmingly
`.d.ts`. `sideEffects: false` and per-feature export paths (`kysely/helpers/postgres`,
`kysely/migration`, `kysely/readonly`) make it tree-shakeable. Published with npm
**provenance attestation** (SLSA).

**0.29.0 is ESM-only** [verified — `package.json` has `"type": "module"`, no `.cjs`
files anywhere in the tarball, and the export map is just two conditions]. CommonJS output
was removed entirely and ESM moved from `dist/esm/` to `dist/`. `engines.node >= 22` is a
*consequence* of that, not an independent choice — Node 22 is the first line where
`require(esm)` works. Anyone still on CJS cannot upgrade.

**A technique worth stealing — version-gated type errors via the export map:**

```jsonc
"exports": { ".": {
  "types@<5.4": "./outdated-typescript.d.ts",
  "default": "./dist/index.js"
}}
```

and `outdated-typescript.d.ts` is simply:

```ts
declare const Kysely: KyselyTypeError<'The installed TypeScript version is outdated and
  cannot guarantee type-safety with Kysely. Please upgrade to version 5.4 or newer.'>
declare const sql: KyselyTypeError<'…'>
declare const RawBuilder: KyselyTypeError<'…'>
```

So a user on TypeScript ≤5.3 gets a *sentence* explaining the problem instead of a cascade
of incomprehensible inference failures. Combines the `KyselyTypeError` pattern (§1.6) with
the `types@<version>` export condition. Cheap, and excellent DX. **PORT.**

**How is there no `pg` dependency?** [verified — `dist/dialect/postgres/postgres-dialect-config.d.ts`]
Kysely never imports `pg`, not even dynamically. It declares **structural interfaces** the
`pg` types happen to satisfy, and you inject the pool:

```ts
export interface PostgresPool {
  Client?: PostgresClientConstructor
  connect(): Promise<PostgresPoolClient>
  end(): Promise<void>
  options: object
}
export interface PostgresDialectConfig {
  pool: PostgresPool | ((options?) => Promise<PostgresPool>)
  cursor?: PostgresCursorConstructor
  controlClient?: PostgresClientConstructor
  onCreateConnection?: (connection: DatabaseConnection, options?) => Promise<void>
  onReserveConnection?: (connection: DatabaseConnection, options?) => Promise<void>
}
```

`new PostgresDialect({ pool: new Pool(...) })`. Structural typing instead of importing.
This is how you get zero deps *and* driver flexibility (`pg`, `pg-pool`, Neon serverless,
`pglite`) simultaneously. **Port this pattern directly** — it also decouples pg-orm-ts
from `pg`'s release cycle and lets users pick their driver.

Kysely also exposes a **runtime introspector** [verified — `dist/dialect/database-introspector.d.ts`]:

```ts
interface DatabaseIntrospector {
  getSchemas(): Promise<SchemaMetadata[]>
  getTables(options?): Promise<TableMetadata[]>
}
interface ColumnMetadata {
  name: string; dataType: string; dataTypeSchema?: string
  isAutoIncrementing: boolean; isNullable: boolean; hasDefaultValue: boolean; comment?: string
}
```

Thin (no indexes, constraints, FKs, defaults-as-expressions, enums, or composite types),
which is exactly why `kysely-codegen` and `kanel` roll their own PG introspection instead
of using it. A PG-only library should ship a *real* introspector.

### 5.4 Security — three High-severity CVEs in 2026

**This is the most operationally actionable finding in the document**, and I verified it
independently with `npm audit` rather than taking it on trust.

Installing `kysely@0.28.11` and running `npm audit` reports **three High-severity
advisories, all with range `<=0.28.16`**:

| Advisory | CWE | Summary |
|---|---|---|
| [GHSA-wmrf-hv6w-mr66](https://github.com/advisories/GHSA-wmrf-hv6w-mr66) | CWE-89 | SQL injection via unsanitized JSON path keys when silencing compilation errors or using `Kysely<any>` |
| [GHSA-pv5w-4p9q-p3v2](https://github.com/advisories/GHSA-pv5w-4p9q-p3v2) | CWE-22, 89, 915, 1284 | JSON-path traversal injection via unsanitized path-leg metacharacters in `JSONPathBuilder.key()` / `.at()` |
| [GHSA-8cpq-38p9-67gx](https://github.com/advisories/GHSA-8cpq-38p9-67gx) | CWE-89 | MySQL SQL injection via insufficient backslash escaping in `sql.lit(string)` |

Root cause in both families: `sanitizeStringLiteral` doubled single quotes but did not
escape backslashes, and JSON-path legs were emitted without neutralising path
metacharacters. The traversal one is the nastiest because **it bites even in fully
type-safe code** — with a `Record<string, T>` / JSON column, attacker-controlled input to
`.key()` or `.at()` can traverse into sibling JSON fields without any `any` or raw SQL
involved.

**Both `0.28.17` and `0.29.5` audit clean** [verified: `found 0 vulnerabilities`]. The fix
is visible in the source — `sanitizeJSONPathMemberValue()` now escapes both quote
characters [verified, `dist/query-compiler/default-query-compiler.js:1377`]:

```js
sanitizeJSONPathMemberValue(value) {
  return value.replace(JSON_PATH_MEMBER_WRAP_REGEX, (char) => char === "'" ? "''" : '\\"')
}
```

Response quality was good — patches shipped fast, one on the same day as its advisory. But
the lesson for us is design-level, not process-level: **the `sql` tag's parameterisation
guarantee did not extend to identifier-ish and JSON-path positions**, which are compiled
into the SQL string by construction. Any library that emits JSON paths, identifiers, or
literals needs those sanitizers treated as security-critical code with fuzz tests, not as
formatting helpers. The MySQL `sql.lit` variant is irrelevant to a PG-only library; the
JSON-path ones are directly relevant.

### 5.5 Maintenance / bus factor — worse than the headline

- 14.1k stars, 428 forks, ~143 open issues, ~26 open PRs, 158 contributors, MIT.
- Cadence is **healthy and not slowing**: ~289 commits over the trailing 52 weeks
  (~5.6/week), by quarter 55 → 57 → 104 → 73. The issue tracker (143 open) is an order of
  magnitude tidier than Drizzle's (~1,950) or Prisma's (~2,542).
- **Bus factor is ≈ 1, not 2.** Lifetime commits: koskimas 733 (47.6%), igalklebanov 531
  (34.5%). But **koskimas has largely stepped back** — his share of recent commits by year
  runs 2023: 56, 2024: 34, 2025: 9, **2026: 1** (a single commit on 2026-07-30, after a
  ~13-month gap). Of the 100 most recent commits, igalklebanov has 55, dependabot 39,
  koskimas 1 — i.e. **~90% of human commits are one person**, who is also sole npm
  maintainer of `kysely-ctl` and `kysely-postgres-js` and has published every release since
  v0.27.4 (Jul 2024). No handover was ever announced; it is visible only in the data.
- **Funding is refused, permanently and on principle.** Kysely's `FUNDING.md` says
  verbatim **"We do not accept donations."** The reasoning: *"Getting paid for open-source
  won't make us put more time and effort into open-source. We have family, friends, and
  other hobbies"*; they want independence from *"companies' and VCs' opinions and business
  needs"*; and *"Kysely is escapism for us. We don't want it to feel like another job."*
  `CONTRIBUTING.md` adds *"There is no company behind this organization and project."*
  The Vercel badge is docs hosting only.

  This cuts both ways and the framing matters: Kysely **cannot be rug-pulled or
  relicensed** by an investor, which is a genuine advantage over VC-backed alternatives.
  But it is also **structurally incapable of scaling maintenance**, because it has
  explicitly declined the mechanism.

- **1.0 has been publicly and permanently refused.**
  [Issue #1328 "Roadmap to v1.0?"](https://github.com/kysely-org/kysely/issues/1328) was
  opened and closed the same day (2025-01-20). igalklebanov: *"We follow Semantic
  Versioning. Minor versions are major versions… **There is no roadmap**… Major >0 usually
  brings a library's velocity and innovation down."* Pushed again on 2026-01-06, the answer
  was **"Because we don't feel like it, at this point."** So `0.x` is a permanent posture,
  not a phase. **Treat every minor as a major and pin exactly** — which is precisely what
  ZenStack does with `~0.29.0` (§8.0).

- **0.29.0 is a hard break, not a soft one.** Beyond ESM-only, the migration API was moved
  out of the root entry point. The root re-exports are not merely `@deprecated` — they are
  **type-poisoned and `undefined` at runtime** [verified by executing it]:

  ```
  import('kysely')            -> Migrator: undefined, FileMigrationProvider: undefined
  import('kysely/migration')  -> Migrator: function,  DEFAULT_MIGRATION_TABLE: "kysely_migration"
  ```

  with declarations like
  `export declare const DEFAULT_MIGRATION_TABLE: KyselyTypeError<"import from 'kysely/migration' instead">`.
  A nice application of the error-message technique, but it is a breaking change delivered
  in a minor bump — the concrete cost of the permanent-`0.x` policy.

- Version landmarks: **savepoints landed in 0.28.0** (2025-04-13) — 0.27.6 contains zero
  savepoint-referencing files, 0.28.0 contains 34. **TypeScript minimum is now 5.4.**
  `kysely/readonly` and the `PGlite` dialect are recent additions.

- **Forward-compat gotcha:** `kysely-ctl`'s peer range is `kysely: ">=0.18.1 <0.30.0"` — it
  will *not* satisfy 0.30.0 when it ships. And `kysely-codegen`'s last commit (2026-02-16)
  **predates 0.29.0 by three months**, so its compatibility with ESM-only Kysely is
  unverified.

- **Adoption is real and named.** The kysely.dev proof wall lists **Bluesky, Mozilla,
  Maersk, Deno, Cal.com, Materialize, tldraw, Cypress, Documenso, Parabol, Civitai, Open
  Collective, Farcaster, Canton Network**. Bluesky was cited by the maintainer in the 1.0
  thread as the de-facto stability argument. None of it funds the project.

**Net:** health good, security response fast, API stability real despite the `0.x`, adopters
genuine — but you would be depending on **one unpaid person who has publicly declined both
money and a 1.0.** That is the single strongest argument for porting the architecture
rather than taking the dependency.

**`kysely/readonly` is worth calling out** [verified — `dist/readonly/readonly-kysely.d.ts`].
It is a purely **type-level capability narrowing**:

```ts
export interface ReadonlyQueryCreator<DB> extends Pick<QueryCreator<DB>, 'selectFrom' | 'selectNoFrom'> {}
export interface ReadonlyKysely<DB> extends ReadonlyQueryCreator<DB>,
  Pick<Kysely<DB>, 'case' | 'destroy' | 'dynamic' | 'fn' | 'introspection' | 'isTransaction'> { ... }

const db: ReadonlyKysely<Database> = getDB()
db.selectFrom('person')  // ok
db.deleteFrom('person')  // compile error
```

Built with `Pick` rather than a parallel class hierarchy — cheap to implement, and it
pairs with a runtime `ReadonlyAccessMode` (`SET TRANSACTION READ ONLY`) for read-replica
routing. **PORT**: exposing narrowed capability views of the DB handle to different layers
(read-replica handles, per-request scoped handles, repository-facing handles) is exactly
the kind of thing an ORM layer needs, and `Pick` makes it nearly free.
- Development is active and the release cadence is healthy (0.29.5 shipped 2026-08-10,
  four days before this writing).
- Adoption is strong: **~12.5M downloads/week**, ahead of `typeorm` (4.8M) and
  `sequelize` (2.9M), behind `drizzle-orm` (18.2M) and `prisma` (16.0M) [verified via
  npm downloads API, 2026-08-14].

---

## 6. What building on bare Kysely feels like

### 6.1 The patterns people build

- **Repository/service modules over a shared `db`.** Plain functions taking
  `db: Kysely<DB> | Transaction<DB>` as the first parameter. Because `Transaction<DB>
  extends Kysely<DB>` [verified], this substitutes cleanly. It's the dominant pattern.
- **`$call` for builder-level composition.** Pagination, soft-delete filters, ordering
  helpers. Fully type-preserving [verified].
- **`AsyncLocalStorage` for ambient transactions.** Because the trx must be threaded
  through every function signature, teams commonly build an ALS-backed
  `getDb()`/`withTransaction()` so repositories don't take a `db` param. This is the most
  frequently hand-rolled piece of infrastructure around Kysely.
- **Relation helpers.** `const withPets = (eb) => jsonArrayFrom(...).as('pets')` — DRYs
  the JSON helpers, but only at concrete table types (§1.8(9)).
- **`.compile()` + `InferResult`** to split query construction from execution
  (https://kysely.dev/docs/recipes/splitting-query-building-and-execution).
- **Hand-written `Selectable<T>`-derived domain types** + a manual mapper to API DTOs.

### 6.2 Transactions — good API, awkward ergonomics

[verified — `dist/kysely.d.ts:593-609`]

```ts
class TransactionBuilder<DB> {
  setAccessMode(accessMode: AccessMode): TransactionBuilder<DB>
  setIsolationLevel(isolationLevel: IsolationLevel): TransactionBuilder<DB>
  execute<T>(callback: (trx: Transaction<DB>) => Promise<T>): Promise<T>
}
```

```ts
await db.transaction()
  .setIsolationLevel('serializable')
  .execute(async (trx) => { ... })          // auto commit/rollback

const trx = await db.startTransaction().execute()   // manual control
const sp  = await trx.savepoint('sp1').execute()    // typed savepoint stack (§1.5)
```

The API itself is complete and well-typed — isolation levels, access mode, callback-scoped
auto-commit/rollback, and manual `ControlledTransaction` with type-tracked savepoints.

**The ergonomic problem is `trx` propagation.** Because `execute` hands you a `Transaction<DB>`
that you must pass explicitly, every repository function needs a `db: Kysely<DB> | Transaction<DB>`
parameter threaded through the whole call stack. `Transaction<DB> extends Kysely<DB>`
[verified, `:475`] makes that substitution type-safe, but it is still a parameter on every
function, and forgetting it means a query silently runs *outside* the transaction — a bug
with no type-level signal. This is why the `AsyncLocalStorage` ambient-transaction wrapper
is the most commonly hand-rolled piece of infrastructure around Kysely.

**For pg-orm-ts:** ship ambient transaction context (ALS-backed) as a first-class,
supported feature, while keeping explicit passing available. This is a small amount of
code that removes a whole category of bug and a whole category of boilerplate.

### 6.3 What's genuinely missing vs an ORM

Relations (a real graph, not per-call-site `whereRef`), eager/lazy loading, identity map
and unit of work, cascading persist, lifecycle hooks (`beforeInsert`, `afterUpdate`),
soft deletes, `createdAt`/`updatedAt` auto-management, optimistic locking / version
columns, validation, serialization/DTO mapping, ambient transaction context, query
caching, and multi-tenancy scoping. All hand-rolled.

Also missing structurally: **you cannot extend Kysely to add them.** The docs are explicit
(https://kysely.dev/docs/recipes/extending-kysely):

> *"You usually don't want to [extend via class inheritance] because of the complexity of
> the types and TypeScript's limitations when it comes to inheritance and return types."*

and on module augmentation:

> *"We do not support this method. Use at your own risk."*

That is the definitive answer to "can we layer an ORM on Kysely": **not by extending it.**
Only by wrapping it, which means re-declaring the type surface at the boundary and losing
Kysely's inference the moment you cross it.

### 6.4 Loss or liberation?

Both camps are real, and the split is predictable:

**Liberation** — the majority view among people who chose Kysely deliberately. No hidden
N+1, no query-plan surprises, SQL you can read in `pg_stat_statements`, and the ability to
express any PG feature via the raw ``sql`` `` tag. Comparisons consistently frame Kysely as "for SQL
purists who want type safety without an ORM"
(https://www.pkgpulse.com/guides/drizzle-vs-kysely-2026,
https://encore.dev/articles/typescript-orms). The lack of magic is the product.

**Loss** — the complaints cluster tightly:
1. **Verbosity.** Kysely is consistently described as more verbose than Drizzle for
   equivalent queries.
2. **Schema management is your problem.** "Query builder only, no schema management,
   relies on external migration tools" is the recurring one-line critique.
3. **Reusable fragments are hard** (§1.8(9)) and helper extraction can tank tsc
   (https://github.com/kysely-org/kysely/issues/867).
4. **Relations require restating the join at every call site.**

Notably, nobody complains that the *types are wrong*. The complaints are about **ergonomics
and scope**, not correctness. That's the highest compliment a type system gets, and it
tells us precisely where the opportunity is: keep the correctness, fix the ergonomics.

---

## 7. Verdicts — PORT / ADAPT / SKIP

### Type architecture

| Element | Verdict | Rationale |
|---|---|---|
| `ColumnType<S,I,U>` phantom triple | **PORT** | Best-in-class primitive; one declaration, three operation-specific types, zero runtime cost. |
| `Generated` / `GeneratedAlways` / `JSONColumnType` | **PORT** | Trivial aliases over `ColumnType`; `never` correctly forbids insert/update. |
| Derived optionality (`IsNullable` → `?`) | **PORT** | Optionality falls out of the insert type; nothing to declare twice. |
| `never`-erases-key filtering | **PORT** | Makes `GENERATED ALWAYS AS IDENTITY` un-insertable at compile time. |
| `Selectable` / `Insertable` / `Updateable` | **PORT** | Exactly the three shapes an app needs; name them the same for familiarity. |
| Tuple-wrapping (`[T] extends [X]`) to stop distribution | **PORT** | Non-obvious and load-bearing; enum columns break without it. |
| `DrainOuterGeneric` | **PORT** | Required to avoid TS2589 at real schema sizes. Measured 743k instantiations at 80 tables/60 queries. |
| `KyselyTypeError<'message'>` | **PORT** | Human-readable type errors for ~20 lines of code. Huge DX/effort ratio. |
| Type-level savepoint stack (`ControlledTransaction<DB, S[]>`) | **PORT** | Novel, correct, and PG savepoints matter. |
| `never`-returning illegal methods (`Transaction.transaction(): never`) | **PORT** | Compile-time prevention beats runtime errors. |
| `ShallowDehydrateValue` (JSON round-trip degradation) | **PORT** | `Date`→`string` inside `json_agg` is real and almost universally modelled wrong. |
| `AnyColumn` / `AnyColumnWithTable` scope unions | **PORT** | The mechanism behind scope enforcement + autocomplete. |
| Template-literal alias parsing (`'person as p'`) | **ADAPT** | Works and is ergonomic, but strings-as-AST hurts errors. Consider `.as()` combinators as the primary form with strings as sugar. |
| `$if` returning `Partial<O2>` | **ADAPT** | Correct for runtime booleans, but add a `condition: true` literal overload to return non-partial `O & O2`. Kysely misses this. |
| Covariant `O` allowing silent column loss on reassignment | **SKIP (fix it)** | Real footgun — probe showed a column silently dropped with **no error**. Make `O` invariant or hard-steer to `$if`/`$call`. |
| `db.dynamic.ref(string)` defaulting to `{}` | **SKIP (fix it)** | Silent total type loss. Require an explicit column union; make the unsafe form loudly named. |
| `SqlBool = boolean \| 0 \| 1` | **SKIP** | Pure multi-dialect tax. PG has real booleans. |

### Query building

| Element | Verdict | Rationale |
|---|---|---|
| `ExpressionBuilder` (callable + namespace) | **PORT** | Scoped, composable, and the callable-object shape is genuinely pleasant. |
| `and`/`or`/`not` array **and** object forms | **PORT** | Object form is what people actually reach for; both should exist. |
| CTEs that widen `DB` for the rest of the chain | **PORT** | Correct model; covers recursive and data-modifying CTEs (critical for PG). |
| `jsonArrayFrom` / `jsonObjectFrom` | **PORT — top priority** | One round trip, no row explosion, exact types. The single best idea for relations without an ORM. |
| `OnConflictDatabase` synthesising an `excluded` virtual table | **PORT** | Elegant, exactly right for PG upserts. |
| `onConflict` builder breadth (constraint/expression/partial-index `where`) | **PORT** | Already complete PG coverage. |
| `returning` reusing `SelectExpression` | **PORT** | No reason to have a second, weaker expression language for `RETURNING`. |
| ``sql`` `` tag: always-parameterised, `unknown` default, explicit `sql.ref`/`.lit`/`.raw` | **PORT** | The escape hatch is safe by default and first-class everywhere. Non-negotiable. |
| `InferResult` + `.compile()` split | **PORT** | Enables prepared/cached queries and testing without a DB. |
| `$call` builder-transform composition | **PORT** | Fully type-preserving [verified]; the sanctioned composition primitive. |
| Transaction API (`setIsolationLevel`, `setAccessMode`, callback `execute`) | **PORT** | Complete and well-typed as-is. |
| Explicit `trx` threading through every function | **ADAPT** | Keep explicit passing, but ship ALS-backed ambient transaction context as first-class. Most hand-rolled thing in the ecosystem. |
| Expression-level fragments generic over table | **SKIP (must do better)** | Kysely's biggest ergonomic gap — generic `eb` helpers do not typecheck. Design for this from day one. |
| `eb.fn.count()` → `string \| number \| bigint` | **SKIP** | Multi-dialect tax. PG-only knows `count()` is `string` under `pg`. Ship exact types, drop the generic. |
| PG operator strings in `ComparisonOperator` | **PORT** | `@>`, `<@`, `&&`, `?`, `?&`, `?\|`, `@@`, `<->`, `^@`, `~` are already there — keep the list. |
| Operand typed from *column* rather than *operator* | **SKIP (fix it)** | Wrong for `jsonb ? text`, `tsvector @@ tsquery`, range `&&`. Build a per-operator operand table — finite and writable for one dialect. |
| `jsonArrayFrom` as correlated subquery | **ADAPT** | Kysely has `leftJoinLateral` but doesn't use it here. Let the relation layer choose subquery vs `LEFT JOIN LATERAL ... ON TRUE`, and `json_agg` vs `jsonb_agg`. |
| `innerJoinLateral` / `leftJoinLateral` | **PORT** | Already present and correctly typed; essential PG feature. |

### Schema & migrations

| Element | Verdict | Rationale |
|---|---|---|
| No runtime schema (types only) | **SKIP** | We need runtime schema for migrations, defaults, validation, serialization, and drift detection. This is the core divergence. |
| Database-as-source-of-truth + codegen | **SKIP as primary** | Ordering inversion: `tsc` depends on live DB state; CI needs a container. Codegen's share of Kysely installs fell 22.8%→9.3% in 12 months. |
| Introspection as bootstrap + **drift check** | **PORT** | Keep introspection's honesty without making it the source of truth. |
| **Deterministic** generated output | **PORT (as a fix)** | Non-deterministic column ordering breaks `git diff` CI gates in both kysely-codegen (#95/#96) and Supabase postgres-meta (#968). Sort explicitly. |
| Drift-check command that actually fails | **PORT (as a fix)** | kysely-codegen's `--verify` exited `0` on drift until 0.18.0 — every CI gate before that was a no-op. |
| Emitting `Selectable`/`Insertable`/`Updateable` variants | **PORT** | Stops `Generated<>`/`ColumnType<>` leaking into React props etc. (kysely-codegen #63, still open). |
| Views/matviews as non-insertable | **PORT** | kanel gets this right (`canInitialize=false`); kysely-codegen emits them identically to tables so `insertInto(view)` typechecks. |
| Composite types, domains, ranges, routines in introspection | **PORT** | kanel/`extract-pg-schema` proves PG-only introspection is strictly richer. kysely-codegen maps all of these to `string`. |
| Ephemeral-PGlite codegen (migrations → in-memory PG → types) | **PORT — unclaimed opportunity** | Cleanest answer to the ordering problem; where 2026 experiments point; only Kysely implementation is 2 years stale. |
| Writing generated output into `node_modules` | **SKIP** | kysely-codegen's default; `npm install` deletes it. |
| PG advisory-lock migration locking (single round trip + `lock_timeout`) | **PORT** | Correct PG primitive; copy the implementation shape verbatim. |
| Transactional DDL by default | **PORT** | PG supports it; MySQL doesn't. Free win from PG-only. |
| Filename-ordered `up`/`down` migrations | **PORT** | Simple, predictable, debuggable. Keep it. |
| `Migrator` as a *library*, CLI as a thin wrapper | **PORT** | Programmatic migration is essential for embedding in app startup and tests. Note `kysely-ctl` is only ~2% of Kysely installs — the library matters more than the CLI. |
| `Kysely<any>` in migrations | **ADAPT** | Improve on it: generate a **per-migration schema snapshot type** so migrations are typed as of their own point in history. Real differentiator. |
| No diffing / autogeneration | **ADAPT** | Build diffing, but ship it as *editable generated migrations* + destructive-change linting + `CONCURRENTLY` advice. Generating the DDL is the easy 30%. |
| DDL builder breadth | **ADAPT** | Good base; must add PG-native gaps: `CONCURRENTLY`, partial/expression indexes, operator classes, extensions, RLS, triggers, partitions, exclusion constraints. |
| Kysely's thin `DatabaseIntrospector` | **SKIP** | Too thin — no indexes, FKs, enums, or composite types. Study `kanel`/`extract-pg-schema` instead. |

### Runtime, plugins, packaging

| Element | Verdict | Rationale |
|---|---|---|
| Zero runtime dependencies | **PORT** | Verified and achievable. Directly matches our stated goal. |
| Structural driver interface (no `pg` import) | **PORT** | The mechanism that makes zero-dep possible; also enables `pg`/Neon/`pglite` interchangeably. |
| `sideEffects: false` + granular export paths | **PORT** | Cheap, keeps bundles honest. |
| npm provenance attestation | **PORT** | Supply-chain table stakes in 2026. |
| Version-gated type errors (`"types@<5.4"` → `KyselyTypeError` stub) | **PORT** | Turns an old-TypeScript inference cascade into one readable sentence. Cheap, excellent DX. |
| ESM-only | **PORT** | Right call in 2026; drop the dual-build tax. Note it forces Node ≥22. |
| Treating literal/identifier/JSON-path sanitizers as formatting helpers | **SKIP (fix it)** | Source of all three 2026 High-severity CVEs. These are security-critical; fuzz them. |
| Operation-node IR + visitor transformer | **PORT** | A real IR (not string concat) is what makes plugins, `EXPLAIN` tooling, and query rewriting possible at all. 108 nodes is the multi-dialect count; PG-only needs fewer. |
| Two-hook plugin interface (`transformQuery` / `transformResult`) | **ADAPT** | Keep the shape, but add a **type-level** channel so plugins can change result types (Kysely's #1 plugin limitation). |
| `CamelCasePlugin` (runtime-only casing) | **SKIP** | Split-brain: runtime plugin + separate codegen flag must agree. Do naming as a type-aware, first-class, single-source concern. |
| `ParseJSONResultsPlugin` | **SKIP** | `pg` parses `json`/`jsonb` natively. Pure non-PG dialect tax. |
| `DeduplicateJoinsPlugin`, `HandleEmptyInListsPlugin` | **SKIP** | Both patch composition defects. Design them out: `in []` should compile to `false`; composition shouldn't double-add joins. |
| `WithSchemaPlugin` | **ADAPT** | Multi-schema and search_path are real PG concerns; make schema qualification a typed first-class concept, not a node rewriter. |
| Full `Dialect` abstraction | **SKIP** | Explicit non-goal, and measurably costly: ~25 "only supported by some dialects" methods pollute PG builders, and result types degrade to unions. |
| Permanent `0.x` (1.0 explicitly refused), bus factor ≈1, donations refused on principle | **(risk note)** | Not a design element, but the strongest reason to *port the architecture* rather than *depend on the package*. |

---

## 8. The key question: can pg-orm-ts use a Kysely-grade typed SQL layer as its foundation?

### 8.0 The existence proof: ZenStack v3

**Someone already did exactly this, and it is the strongest evidence in this document.**

`@zenstackhq/orm@3.9.1` — published **2026-08-14, the day of this writing** — lists
`kysely: '~0.29.0'` as a **direct runtime dependency** [verified via `npm view` and by
unpacking the tarball]. ZenStack v2 (`@zenstackhq/runtime@2.22.3`, June 2026) had no
Kysely; it was built on Prisma. So **v3 is a from-scratch ORM rewrite that swapped Prisma
for Kysely as its engine.** Their own docs (https://zenstack.dev/docs/3.x/) put it:

> *"a complete rewrite that removed Prisma as a runtime dependency and replaced it with an
> implementation built from scratch ('scratch' = Kysely 😆)"*

…while keeping *"a query API compatible with PrismaClient."* Their creator on HN
(https://news.ycombinator.com/item?id=48265460): *"rewriting our ORM engine for v3 with
Kysely was honestly one of the best technical decisions we've made."*

**How they layered it** — verified by reading `dist/index.d.mts` in the published package,
and it maps almost exactly onto the three-tier design proposed below:

1. **They own a runtime schema.** `SchemaDef`, `GetModels<Schema>`, `GetModelField<…>` —
   a real declarative schema, not Kysely's phantom `Database` interface.
2. **They *derive* the Kysely type from it** rather than asking users to maintain one:
   ```ts
   type ToKysely<Schema extends SchemaDef> = Kysely<ToKyselySchema<Schema>>
   type ToKyselyTable<Schema, Model> = {
     [Field in ScalarFields<Schema, Model, false> | ForeignKeyFields<Schema, Model>
       as GetModelField<Schema, Model, Field>['originModel'] extends string ? never : Field]
     : toKyselyFieldType<Schema, Model, Field>
   }
   type toKyselyFieldType<Schema, Model, Field> =
     FieldHasDefault<Schema, Model, Field> extends true
       ? Generated<MapType<Schema, Model, Field>>
       : MapType<Schema, Model, Field>
   ```
   Note what this does: relation fields are filtered out (`originModel extends string ?
   never`), FK columns are kept, and `Generated<>` is applied from schema knowledge — which
   is how they get `GeneratedAlways`-grade correctness that introspection-based codegen
   cannot (§3.1).
3. **They manipulate Kysely's operation-node IR directly.** The public `.d.mts` imports
   **~100 `*Node` types plus `OperationNodeVisitor`** from `kysely` — that's how
   row-level access-control policies get injected into queries. This is the payoff of
   Kysely having a real IR rather than string concatenation (§5.1).
4. **They wrap, they do not subclass** — consistent with Kysely's own guidance (§6.3) — and
   re-export `ExpressionBuilder` / `SelectQueryBuilder` in their public surface as escape
   hatches, with `toKysely` as the explicit drop-down.
5. **They kept their own dialect layer** (`./dialects/{postgres,mysql,sqlite,sql.js}`) and
   their own scalar mapping (`DateTime → string`, `Decimal → decimal.js`), i.e. they did
   *not* inherit Kysely's type decisions wholesale.

**What this changes about our conclusion.** It softens my "not extensible" framing into
something more precise: you cannot *extend* Kysely, but you can very successfully
**wrap** it if you bring your own schema and generate the `Database` type from it. That is
a validated path, shipping today, at a company betting its product on it.

**What it does not change.** ZenStack is multi-dialect, so it inherits every dialect tax in
§5.2 and adds its own dialect layer on top. And it takes a hard runtime dependency on a
pre-1.0 library with a bus factor of ~2 — note the `~0.29.0` pin, which is them defending
against exactly that. For a PG-only project the calculus is different, and my
recommendation below still stands.

### 8.1 Recommendation

**Yes — build one, don't wrap Kysely.**

Three reasons the wrapping option is worse *for us* than it looks — granting that §8.0
shows it is workable in general:

1. **Kysely is explicitly not extensible, only wrappable.** Its own docs advise against
   inheritance and disclaim module augmentation. ZenStack's route — own the schema, derive
   the `Database` type, drive the IR — works, but it means you already own the schema
   layer, the type-derivation layer, and the node-transformation layer. At that point
   Kysely is supplying the compiler and the builder surface, and you have inherited a
   pre-1.0 dependency with a bus factor of ~2 (note ZenStack pins `~0.29.0` defensively)
   plus every multi-dialect compromise in §5.2 that you cannot opt out of.
2. **PG-only deletes a large fraction of the complexity we'd be inheriting.** No `Dialect`
   interface, no `DialectAdapter` capability flags, no `SqlBool = boolean | 0 | 1`, no
   `count() → string | number | bigint`, no MySQL/MSSQL methods polluting autocomplete,
   fewer operation nodes, transactional DDL assumed, `RETURNING` assumed, `ON CONFLICT`
   assumed. We can also add what Kysely structurally cannot: typed arrays, ranges,
   composite types, domains, enums, `interval`, `numeric` precision, `LATERAL`, and exact
   `pg` result types per function.
3. **A runtime schema unlocks everything an ORM needs** — migrations, diffing, drift
   detection, defaults, serialization, validation, relation graphs — and Kysely
   deliberately has none. That is the fundamental architectural divergence, and it's
   upstream of every other decision. The ecosystem evidence in §3 says the market agrees:
   the DB-first codegen path is shrinking, and the tools people move toward are the ones
   that restore a declarative source of truth.

**What to copy, concretely:** the `ColumnType` phantom triple and its
`Selectable`/`Insertable`/`Updateable` projections; the `<DB, TB, O>` builder-as-state-machine
shape with intersection accumulation; `AnyColumn`-style scope unions; `DrainOuterGeneric`;
tuple-wrapped non-distributive conditionals; `KyselyTypeError` messages; the JSON
dehydration model; `jsonArrayFrom`/`jsonObjectFrom`; the `excluded` virtual-table trick;
the always-parameterised `sql` tag with `unknown` as the untyped default; `$call`;
type-level savepoint stacks; `never`-returning illegal methods; the operation-node IR; the
structural driver interface; and the PG advisory-lock migration lock.

**What to fix while copying:** (a) expression-level fragments must be generic over tables —
Kysely's single worst ergonomic gap; (b) `$if` should return non-partial for literal-`true`
conditions; (c) `O` must not be silently covariant, so imperative builder reassignment
can't drop columns without an error; (d) dynamic references must not default to `{}`;
(e) naming strategy must be type-aware and single-source, not a runtime plugin plus a
codegen flag; (f) plugins need a type-level channel.

**The correct layering** is three tiers, with each one usable on its own:

```
  tier 3   ORM: schema-in-code, relation graph, repositories, hooks, serialization
  tier 2   typed SQL builder  (Kysely-grade, PG-only)
  tier 1   operation-node IR + compiler + structural pg driver
```

Tier 3 must be **built on top of the same generic machinery**, not bolted beside it, so
that dropping from a relation query to `selectFrom` to the raw ``sql`` `` tag is a smooth gradient
rather than three disjoint APIs. Kysely proves tiers 1–2 are achievable with zero runtime
dependencies and excellent types. **ZenStack v3 proves tier 3 is achievable on top of
tiers 1–2** (§8.0) — schema-owned, type-derived, IR-driven, wrapped not subclassed. That is
the blueprint; the difference is that we build tiers 1–2 ourselves, PG-only, instead of
renting them.

Kysely's unfinished business — schema, relations, migrations, composition ergonomics — is
exactly the space pg-orm-ts is aiming at. And §3.4's ephemeral-PGlite codegen hole is a
second, adjacent opportunity that nobody currently occupies.

---

## Appendix A — Compiled SQL, verified

Compiled against `kysely@0.29.5` with `DummyDriver` + `PostgresQueryCompiler` (no database
required — note that this "cold compile" capability is itself a useful feature to port,
since it makes SQL generation unit-testable).

```
-- jsonArrayFrom
select "id", (select coalesce(json_agg(agg), '[]') from (
  select "pet"."id", "pet"."name" from "pet" where "pet"."owner_id" = "person"."id"
) as agg) as "pets" from "person"
  params: []

-- upsert with partial-index predicate + excluded
insert into "person" ("id", "first_name") values ($1, $2)
  on conflict ("id") where "person"."deleted_at" is null
  do update set "first_name" = "excluded"."first_name"
  returning "id"
  params: [1,"J"]

-- raw sql injection attempt is parameterised, not interpolated
select * from "person" where email = $1
  params: ["x'; DROP TABLE person; --"]

-- CTE
with "adults" as (select "id", "first_name" from "person" where "age" > $1)
select * from "adults"
  params: [18]

-- CamelCasePlugin
select "first_name", "created_at" from "user_metadata"
  params: []
```

Everything checks out: correct `coalesce(json_agg(...), '[]')` empty-array handling,
correct PG upsert with a partial-index predicate, and the `sql` tag genuinely
parameterises rather than interpolates.

---

## Appendix B — Two improvements over Kysely, prototyped and verified

Both of the type-architecture fixes recommended above were prototyped and compiled
against TypeScript 7.0.2. Both work.

### B.1 `$if` with literal-condition overloads

Kysely always returns `Partial`. But when the condition is a *literal* `true`/`false`
(a compile-time constant, feature flag, or const), we can do better with overload
ordering:

```ts
$if<O2>(cond: true,    f: (qb: this) => QB<O & O2>): QB<O & O2>
$if<O2>(cond: false,   f: (qb: this) => QB<O & O2>): QB<O>
$if<O2>(cond: boolean, f: (qb: this) => QB<O & O2>): QB<O & Partial<Omit<O2, keyof O>>>
```

Verified resolved types:

| Call | Kysely today | With overloads |
|---|---|---|
| `$if(true, …select('name'))` | `{id} & Partial<{name}>` | **`{id} & {name}`** |
| `$if(false, …)` | `{id} & Partial<{name}>` | **`{id}`** |
| `$if(runtimeBool, …)` | `{id} & Partial<{name}>` | `{id} & Partial<{name}>` (unchanged) |

Zero cost, strictly better. Overload order matters — literals must precede `boolean`.

### B.2 Invariant `O` closes the silent-column-loss hole

The §1.8(3) footgun exists because `O` sits only in output position. Adding a single
phantom property that mentions `O` in *both* variance positions makes the builder
invariant in `O`:

```ts
declare const INV: unique symbol
interface QBInv<O> {
  readonly [INV]: (o: O) => O          // O appears co- AND contravariantly
  select<K extends string, V>(k: K, v: V): QBInv<O & Record<K, V>>
}
```

Verified: with this marker, `let q = builder; if (f) q = q.select(...)` becomes a
**compile error** instead of silently discarding `name` from the result type. The
covariant control case (Kysely's current shape) compiles clean and loses the column,
exactly as measured in §1.8.

Trade-off: users can no longer assign a wider builder to a narrower variable at all, so
the ergonomic escape must be good — `$if` and `$call` need to cover the imperative
build-up cases comfortably. Given both are already type-preserving, that seems
achievable, and turning a silent wrong-type bug into a compile error is a clearly
favourable trade.

---

## Sources

- Kysely docs — https://kysely.dev/ · https://kysely.dev/docs/getting-started
- Relations recipe — https://kysely.dev/docs/recipes/relations
- Extending Kysely — https://kysely.dev/docs/recipes/extending-kysely
- Splitting query building and execution — https://kysely.dev/docs/recipes/splitting-query-building-and-execution
- Migrations — https://kysely.dev/docs/migrations
- API docs — https://kysely-org.github.io/kysely-apidoc/
- GitHub — https://github.com/kysely-org/kysely
- Slow type checking issue — https://github.com/kysely-org/kysely/issues/867
- npm — https://www.npmjs.com/package/kysely
- Generating types (official docs) — https://kysely.dev/docs/generating-types
- kysely-codegen — https://github.com/RobinBlomberg/kysely-codegen
  (issues cited: [#48](https://github.com/RobinBlomberg/kysely-codegen/issues/48),
  [#63](https://github.com/RobinBlomberg/kysely-codegen/issues/63),
  [#95](https://github.com/RobinBlomberg/kysely-codegen/issues/95),
  [#96](https://github.com/RobinBlomberg/kysely-codegen/issues/96),
  [#116](https://github.com/RobinBlomberg/kysely-codegen/issues/116),
  [#179](https://github.com/RobinBlomberg/kysely-codegen/issues/179),
  [#207](https://github.com/RobinBlomberg/kysely-codegen/issues/207),
  [#213](https://github.com/RobinBlomberg/kysely-codegen/issues/213),
  [#219](https://github.com/RobinBlomberg/kysely-codegen/issues/219),
  [#261](https://github.com/RobinBlomberg/kysely-codegen/issues/261),
  [#271](https://github.com/RobinBlomberg/kysely-codegen/issues/271),
  [#300](https://github.com/RobinBlomberg/kysely-codegen/issues/300))
- prisma-kysely — https://github.com/valtyr/prisma-kysely
- Prisma's own Kysely quickstart (hand-written types) — https://www.prisma.io/docs/prisma-postgres/quickstart/kysely
- kanel — https://github.com/kristiandupont/kanel · https://kristiandupont.github.io/kanel
- Kanel origin post — https://dev.to/kristiandupont/generating-typescript-types-from-postgres-o91
- kysely-ctl — https://github.com/kysely-org/kysely-ctl
- kysely-pglite (PGlite-backed offline codegen) — https://www.npmjs.com/package/kysely-pglite
- bun-sqlgen (same pattern, Bun.sql) — https://github.com/ilbertt/bun-sqlgen · https://news.ycombinator.com/item?id=48645393
- kysely-tables (types → DDL, full inversion PoC) — https://github.com/galvez/kysely-tables
- kyrage (declarative schema + Testcontainers shadow DB) — https://dev.to/izumisy/kyrage-a-typescript-first-database-migration-tool-for-modern-development-5272
- Supabase postgres-meta non-determinism — https://github.com/supabase/postgres-meta/issues/968
- marmelab on regenerating after `npm install` — https://marmelab.com/blog/2024/02/14/type-safe-sql-wheries-with-kysely.html
- HN: Kysely maintainer on the declarative-schema gap — https://news.ycombinator.com/item?id=48249804
- HN: "the database is leading" — https://news.ycombinator.com/item?id=36419056 · https://news.ycombinator.com/item?id=39395301 · https://news.ycombinator.com/item?id=42343344
- HN: no compile-time codegen in TS — https://news.ycombinator.com/item?id=48646848
- Atlas (no Kysely provider, no TS types) — https://atlasgo.io/orms
- **ZenStack v3 — an ORM built on Kysely** — https://zenstack.dev/docs/3.x/ ·
  https://www.npmjs.com/package/@zenstackhq/orm ·
  HN: https://news.ycombinator.com/item?id=48265460
- kysely-typegen — https://github.com/theoludwig/kysely-typegen
- kysely-supabase (kysely-org) — https://github.com/kysely-org/kysely-supabase

- Kysely funding policy — https://github.com/kysely-org/kysely/blob/master/FUNDING.md
- "Roadmap to v1.0?" (refused) — https://github.com/kysely-org/kysely/issues/1328
- Security advisories — https://github.com/advisories/GHSA-wmrf-hv6w-mr66 ·
  https://github.com/advisories/GHSA-pv5w-4p9q-p3v2 ·
  https://github.com/advisories/GHSA-8cpq-38p9-67gx
  (verified independently via `npm audit` against 0.28.11, 0.28.17 and 0.29.5 on 2026-08-14)

**Research caveats.** Reddit's endpoints were unreachable from this environment, so the
developer-sentiment evidence here is GitHub issues, Hacker News, blogs, and package
metadata only — no r/node or r/typescript sourcing. Some 2026-vintage GitHub issues
describing codegen CI pipelines read as agent-authored planning documents; they are real
artifacts in real repositories, but they are not a human venting, and I have weighted them
accordingly. All version and publish dates were taken from the npm registry `time` map
rather than GitHub release pages, which rendered inconsistently.
- Drizzle vs Kysely 2026 — https://www.pkgpulse.com/guides/drizzle-vs-kysely-2026
- Comparing the best TypeScript ORMs (2026) — https://encore.dev/articles/typescript-orms
- ORM selection guide 2026 — https://tomodahinata.com/en/blog/prisma-vs-drizzle-vs-typeorm-kysely-orm-comparison-guide
- Package metadata and download counts verified via `npm view` and `https://api.npmjs.org/downloads/point/last-week/*` on 2026-08-14.
- Type behaviour and benchmarks verified by compiling probe files against `kysely@0.29.5` with TypeScript 5.9.3 and 7.0.2.
