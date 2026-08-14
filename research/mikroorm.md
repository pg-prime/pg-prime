# MikroORM — Research Notes for `pg-orm-ts`

**Researched:** 2026-08-14
**Subject version:** MikroORM **v7.1.11** (`latest`, published 2026-08-06)
**Context:** Evaluating what to PORT / ADAPT / SKIP for a PostgreSQL-only, type-safe, minimal-dependency TypeScript ORM with first-class migrations. Multi-DB abstraction is an explicit non-goal for us.

---

## 0. Version status (verified, not from memory)

| Fact | Value | Source |
|---|---|---|
| Current major | **v7** | npm `dist-tags.latest = 7.1.11` |
| v7.0.0 GA date | **2026-03-11** | npm registry `time` field |
| v7.1.0 | 2026-05-20 | npm registry `time` |
| v7.1.11 (current latest) | 2026-08-06 | npm registry `time` |
| Next line in dev | `7.2.0-dev.5` (tag `next-v7`) | npm `dist-tags` |
| v6 still maintained | `6.6.16` (2026-07-17), tag `latest-v6` | npm `dist-tags` |
| v6.0.0 GA (for reference) | 2024-01-08 | npm registry `time` |

**Weekly npm downloads** (week of 2026-08-03 → 2026-08-09), pulled from `api.npmjs.org`:

| Package | Downloads/week |
|---|---|
| `drizzle-orm` | 18,171,638 |
| `prisma` | 16,009,816 |
| `typeorm` | 4,826,597 |
| **`@mikro-orm/core`** | **855,296** |

MikroORM is roughly **5% of Drizzle's install volume**. It is a well-engineered minority ORM. The maintainer himself corrected a community analysis down to "~400k weekly downloads" — the 855k figure above is the raw `@mikro-orm/core` number which includes CI/mirror traffic. Either way: small mindshare, high engineering quality.

### v7 "Unchained" — what actually changed (this is the headline for us)

Release post: <https://mikro-orm.io/blog/mikro-orm-7-released>
Upgrade guide: <https://mikro-orm.io/docs/upgrading-v6-to-v7>

The three changes that matter most to a project like ours:

1. **Knex is gone.** `@mikro-orm/knex` was renamed to `@mikro-orm/sql`. Per the release post: *"MikroORM no longer depends on knex for generating or executing SQL queries. Instead, Kysely is now used as the query runner, while the actual query building is done entirely by MikroORM itself."* `em.getKnex()` → `em.getKysely()`; `qb.getKnexQuery()` removed. A `@mikro-orm/knex-compat` shim exists for stragglers.
2. **`@mikro-orm/core` has zero runtime dependencies.** Verified against the registry — `dependencies` is absent entirely; only an optional peer on `dataloader@2.2.3`. `dotenv`, `esprima`, `reflect-metadata`, `dataloader`, and `globby` were all removed or demoted to optional peers. Dotenv support was **removed entirely** (you call `dotenv.config()` yourself).
3. **`umzug` is gone from migrations.** Verified: `@mikro-orm/migrations@7.1.11` depends only on `@mikro-orm/sql`. Migration execution is now built directly into MikroORM. `UmzugMigration` → `MigrationInfo`; custom `MigrationStorage` no longer implements `UmzugStorage`.

Also in v7: native ESM only (Node ≥22.17, TS ≥5.8, `moduleResolution` must be `node20`/`nodenext`/`bundler`); core no longer imports `node:fs`/`node:path` (edge-runtime viable); published to JSR; polymorphic relations; table-per-type inheritance; view entities; streaming (`em.stream()`); CTEs; `$size` operator; Oracle driver; decorators moved out to `@mikro-orm/decorators` with legacy + ES-spec flavors; `balanced` is the new default loading strategy; `persistAndFlush()`/`removeAndFlush()` removed; QueryBuilder is no longer thenable.

> **Takeaway for us:** v7 is a *massive* validation of our own design constraints. The most mature data-mapper ORM in the TS ecosystem independently concluded that (a) Knex was dead weight, (b) zero core deps is achievable, (c) umzug should be replaced with ~200 lines of in-house runner. We should not re-litigate those; we should start where they landed.

---

## 1. The data-mapper core

Docs: <https://mikro-orm.io/docs/unit-of-work> · <https://mikro-orm.io/docs/identity-map> · <https://mikro-orm.io/docs/transactions> · <https://mikro-orm.io/docs/architecture>

### 1.1 How the Unit of Work actually works

MikroORM is a near-direct port of Doctrine 2's UoW. The mechanism is **snapshot-based change tracking**, not proxies and not dirty-flag setters:

1. **Load.** Every entity hydrated from the DB is registered in the `IdentityMap`, keyed by `EntityName-PK`. Simultaneously the UoW stores `originalEntityData` — a flat copy of every scalar and every FK value at load time.
2. **Mutate.** You mutate the POJO-ish entity instance freely. Nothing is intercepted (v7 note: get/set property descriptors are now *only* installed when `em.persist()` is called on an entity, specifically to reduce overhead for large result sets).
3. **Flush.** `em.flush()` walks the identity map, diffs each managed entity against its snapshot, and produces a set of `ChangeSet` objects (`CREATE` / `UPDATE` / `DELETE`). It topologically sorts them by FK dependency (the "commit order"), batches same-shape operations into multi-row `INSERT`/`UPDATE`, wraps everything in a single transaction, executes, then re-snapshots.

Doc quote: *"Whenever you fetch an object from the database MikroORM will keep a copy of all the properties and associations inside the `UnitOfWork`."* And on flush: *"For each object it will compare the original property and association values with the values that are currently set on the object."*

**Flush modes** (`FlushMode`):
- `COMMIT` — flush only at transaction commit.
- `AUTO` (default) — flush before a query *only if* the query targets an entity type with pending changes. This is the "hidden query" behavior: `em.find(Book, ...)` can silently emit an `UPDATE authors ...` first.
- `ALWAYS` — flush before every query.

Important v7 subtlety: *"Changes on managed entities are not detected automatically, you need to call `em.persist` if you want such changes to trigger auto flush."* So auto-flush is now opt-in per entity via `persist()`, while `flush()` still picks up all managed changes. That is a genuinely confusing two-tier rule.

### 1.2 Identity map

- Guarantees one instance per row per EM: `jon === authors[0]` after two independent queries.
- Enables cheap reference equality, dedup of writes, and lets `em.getReference(Author, 1)` produce a working FK stub without a query.
- **It is also the memory leak.** The map grows monotonically until `em.clear()` or the EM is discarded.

### 1.3 RequestContext / AsyncLocalStorage

This is the pattern MikroORM is *forced* into by the identity map, and it's worth understanding as a cost:

```js
app.use((req, res, next) => {
  RequestContext.create(orm.em, next);   // internally orm.em.fork()
});
```

`RequestContext` uses Node's `AsyncLocalStorage` to bind a forked EM to the async context so that a globally-injected `orm.em` resolves to the right per-request instance. Docs are explicit that **global EM without a context leads to "weird bugs"**, and there is an `allowGlobalContext` escape hatch that exists essentially only for unit tests. Additional machinery is needed for non-HTTP entrypoints: `@CreateRequestContext()` (queue jobs, cron — must be `async` in v7), `@EnsureRequestContext()` (reuse-if-present), `@Transactional()`.

The documented reasons a per-request fork is mandatory:
- **Unbounded memory growth** in a shared map.
- **Inconsistent API responses** — "populated relation" state is stored *on the identity map entry*, so two endpoints hitting the same row (one with populate, one without) return different JSON depending on which ran first. This is a nasty, real, order-dependent bug class.

### 1.4 Transactions

- **Implicit:** every `em.flush()` is wrapped in a transaction automatically.
- **Explicit:** `em.transactional(async em => {...})` — auto-flushes before commit. Also `begin()`/`commit()`/`rollback()`.
- **`@Transactional()` decorator** with Spring-style propagation modes: `REQUIRED` (v7 default for the decorator, changed from `REQUIRES_NEW`), `REQUIRES_NEW`, `NESTED` (default for `em.transactional()`, uses **savepoints**), `SUPPORTS`, `MANDATORY`, `NOT_SUPPORTED`, `NEVER`.
- Isolation levels: `READ_UNCOMMITTED`, `READ_COMMITTED`, `SNAPSHOT`, `REPEATABLE_READ`, `SERIALIZABLE`.
- **Rollback semantics are a known sharp edge:** after a rollback, entities in the identity map are *detached* and their in-memory state reflects the rolled-back values, i.e. they are silently out of sync with the DB. The documented remedy is "throw away the EM and `em.fork()`." A retry loop on a serialization failure therefore cannot reuse the EM.
- `em.transactional()` forks the EM with `clear: false` by default, meaning the child inherits the parent's identity map contents. For parallel transactions you must pass `clear: true` or they interfere.

### 1.5 What UoW buys you vs. what it costs

**Buys:**
- **Automatic write batching.** N modified entities of the same shape collapse into one multi-row `INSERT`/`UPDATE`. This is MikroORM's strongest real performance claim and it's legitimate — hand-written repository code rarely batches.
- **Automatic FK ordering.** You never think about insert order in an object graph.
- **Write dedup + idempotence.** Setting the same field twice, or touching an entity fetched twice, produces one statement.
- **Genuinely enables DDD/aggregate-style code.** Domain methods mutate objects; persistence is a cross-cutting concern.
- Optimistic locking and concurrency checks fall out nearly free once you have change sets.

**Costs:**
- **Hidden queries.** `AUTO` flush mode means an innocuous read can emit writes. Debugging "where did that UPDATE come from" requires the SQL log.
- **Flush-order surprises.** You do not control statement order; the commit-order sort does. Triggers, deferred constraints, and `SELECT ... FOR UPDATE` interactions become non-obvious.
- **Memory.** Snapshot + instance for every row touched. A 100k-row report through the EM is a heap event. Mitigations exist (`disableIdentityMap: true`, `em.clear()`, `em.stream()` in v7) but all of them are "turn the ORM off."
- **Mandatory context plumbing.** `AsyncLocalStorage`, forks, `@CreateRequestContext` on every cron job. This is real ambient complexity and a common source of "why is my entity detached."
- **Rollback leaves the map poisoned**, so retry logic must discard the EM.
- **Lifecycle hooks run inside the commit phase** with hard restrictions (see §5.4) — you cannot `flush()` or `persist()` from `beforeUpdate`.
- **Onboarding cost.** Multiple 2025–2026 reviews independently flag it. Encore's ORM comparison: *"The Unit of Work can lead to surprising flush behavior if you're not careful about entity lifecycle."* (<https://encore.dev/articles/typescript-orms>)

---

## 2. Entity definition styles

Docs: <https://mikro-orm.io/docs/defining-entities> · <https://mikro-orm.io/docs/define-entity> · <https://mikro-orm.io/docs/entity-schema>

v7 supports four styles. **The docs were rewritten in v7 to make `defineEntity` the primary/recommended approach** — decorators are explicitly "no longer the assumed standard."

### 2.1 `defineEntity` + class (v7 recommended)

```ts
import { defineEntity } from '@mikro-orm/core';
const p = defineEntity.properties;

const BookSchema = defineEntity({
  name: 'Book',
  properties: {
    id: p.integer().primary(),
    title: p.string(),
    author: () => p.manyToOne(Author),
  },
});

export class Book extends BookSchema.class {
  slug() { return this.title.toLowerCase(); }
}
BookSchema.setClass(Book);
```

Property builders: `p.string()`, `p.integer()`, `p.float()`, `p.boolean()`, `p.datetime()`, `p.json<T>()`, `p.type(CustomType)`, plus `p.manyToOne()`, `p.oneToMany()`, `p.manyToMany()`, `p.oneToOne()`. Fluent modifiers: `.primary()`, `.nullable()`, `.unique()`, `.onCreate()`, `.onUpdate()`, `.mappedBy()`, `.inversedBy()`, `.fixedOrder()`, `.ref()`, `.lazyRef()`. v7.1 added `.strictNullable()`.

The `.class` / `setClass()` two-step exists because the schema must produce a base class *before* you can extend it, and the ORM must then be told about the subclass before `MikroORM.init()`. It works but it is a slightly awkward dance.

### 2.2 `defineEntity` interface-only

```ts
export const Book = defineEntity({ name: 'Book', properties: { ... } });
export type IBook = InferEntity<typeof Book>;
```

No class, so **no entity constructors** — you must use `em.create()`. Types come from `InferEntity<typeof Schema>`.

### 2.3 Decorators

Moved to `@mikro-orm/decorators` (zero runtime deps, verified) in two flavors:
- `@mikro-orm/decorators/legacy` — TS `experimentalDecorators: true`, works with `reflect-metadata`.
- `@mikro-orm/decorators/es` — ES-spec decorators, **no metadata reflection**, so every type must be declared explicitly.

`ReflectMetadataProvider` is **no longer the default** in v7 and must be wired up explicitly, with `reflect-metadata` installed by hand.

### 2.4 Decorators + `ts-morph` (`@mikro-orm/reflection`)

Runs the TypeScript compiler API at discovery time to read real types off the AST, so `@ManyToOne() author!: Author` needs no callback and `title?: string` is inferred as nullable. The DRYest syntax available in any TS ORM.

**But:** it depends on `ts-morph@28` (verified), needs your `.ts` sources at runtime or a cached metadata file, and is **incompatible with Babel/SWC**. It is by far the heaviest option.

### 2.5 Type brands

- `Opt` — `createdAt: Date & Opt = new Date()`. Optional at create time, required on a managed instance. Solves the "DB default / `onCreate`" problem elegantly.
- `Hidden<T>` / `HiddenProps` symbol — excluded from serialization but still queryable. **v7 restricted `Hidden<T>` to primitives**; object-typed props (Date, Record, JSON) must use the `HiddenProps` symbol instead. That split is an inference-limitation leak into the public API.
- `RequiredNullable<T>` — must be *present* in `em.create()` but may be `null`. Nice distinction that most ORMs collapse.

### 2.6 Assessment for us

| Style | Type safety | Build tooling cost | Verdict for pg-orm-ts |
|---|---|---|---|
| `defineEntity` + builders | Full, inferred | **None** — plain TS values | **This is the model to follow** |
| `defineEntity` interface-only | Full via `InferEntity` | None | Good; offer as a variant |
| Decorators + `reflect-metadata` | Manual annotations everywhere | `experimentalDecorators`, extra runtime dep, `emitDecoratorMetadata` | Skip |
| Decorators + ts-morph | Best DX, worst plumbing | ts-morph at runtime, breaks SWC/Babel | Skip |
| `EntitySchema` | Full | None | Redundant with `defineEntity` |

The lesson is unambiguous: **a fluent builder producing a plain value beats decorators on every axis that matters** (no `reflect-metadata`, no `experimentalDecorators`, no compiler-API dependency, works under any bundler, and gives *better* inference). MikroORM took five majors to arrive here. We should start here.

Where MikroORM's builder is weaker than it could be: `p.json<T>()` requires an explicit generic rather than a `.$type<T>()` chain, and the relation-callback wrapping (`author: () => p.manyToOne(Author)`) is needed purely to break circular imports — a lazy-thunk tax we'd inherit too unless we use a single-file-per-schema + late-binding-by-name approach.

---

## 3. Relations

Docs: <https://mikro-orm.io/docs/type-safe-relations> · <https://mikro-orm.io/docs/loading-strategies>

### 3.1 Wrappers

- **`Ref<T>`** (`ref: true`) — a runtime `Reference` wrapper. `.load()`, `.unwrap()`, `.isInitialized()`, `.getEntity()`, `.$` / `.get()` for sync access on a loaded ref. PK is always accessible without a load (`book.author.id` is fine).
- **`LazyRef<T>`** — *type-only* marker. The property holds the real entity at runtime (so `instanceof` works, and serialization is natural), but TS refuses property access until narrowed by a populate hint. This is strictly better ergonomics than `Ref<T>` and is the direction to copy.
- **`Collection<T>`** — to-many wrapper with `init()`, `loadItems()`, `add()`, `remove()`, `getItems()`, `isInitialized()`. In v7 `ArrayCollection` was merged into `Collection`.
- **`ScalarRef<T>`** — for `lazy: true` scalar columns (e.g. a big `jsonb` blob or a password hash you don't want in every SELECT).

### 3.2 `Loaded<T, Hint>`

```ts
const users = await em.find(User, {});                                 // Loaded<User, never>[]
const users = await em.find(User, {}, { populate: ['identity','friends'] }); // Loaded<User, 'identity'|'friends'>[]

function sendEmail(user: Loaded<User, 'identity'>) {
  const email = user.identity.$.email;   // type-safe, sync
}
```

This is **the single best idea in MikroORM's type system.** The load-state of a relation is tracked in the type, populate hints are validated against an `AutoPath`-style dotted-path type (`'books.author.identity'` autocompletes), and function signatures can *demand* a populate state. It converts an entire category of runtime `undefined` errors into compile errors, and it makes "which relations does this service need?" a checkable contract.

v7 extended the same idea to **partial loading**: `Loaded<Author, never, 'id' | 'email'>` — the third type parameter tracks selected fields, so accessing a non-selected column is a compile error. QueryBuilder participates too: `leftJoinAndSelect('a.books','b')` widens the result type to `Loaded<Author, 'books'>[]`.

Caveat noted in the docs: it's *"all just type-level information"* — a cast defeats it. And `AutoPath`/`Loaded` are among the most expensive types in the library; v7's release notes call out a deliberate campaign that cut type instantiations by up to 40% in `em.assign()`. Deep dotted-path inference is a known TS-server performance hazard at scale.

### 3.3 Loading strategies

| Strategy | Behavior | Queries |
|---|---|---|
| `select-in` | One query per relation | 1 + N relations |
| `joined` | Single query with JOINs | 1 |
| **`balanced`** (v7 default) | JOIN to-one, select-in to-many | Middle |

`balanced` is the right default and it's newly so in v7 — the previous `joined` default produced cartesian blowups on to-many. Precedence: property-level `strategy` > per-query `strategy` > global `loadStrategy`.

v7 added **`populateHints`** for per-relation overrides, including per-relation `joinType`, and — importantly — **per-parent limiting**:

```ts
const users = await em.find(User, {}, {
  populate: ['posts.comments'],
  populateHints: {
    posts: { limit: 5, orderBy: { createdAt: 'desc' } },
    'posts.comments': { limit: 3 },
  },
});
```

This is "top-N per parent," which in Postgres means a `LATERAL` / window-function subquery. It's a genuinely hard feature that most ORMs punt on, and MikroORM handles it — with the honest caveat that such collections are **marked partial and readonly**, and that per-parent limiting **forces `select-in`** because a plain join cannot express it.

Also: `populateWhere: 'infer'` (apply the root WHERE to populated relations) and `populateOrderBy`. And QueryBuilder auto-detects to-many join + `limit`/`offset` and rewrites the root selection into a subquery to avoid the classic pagination-with-join bug.

---

## 4. Query layer

Docs: <https://mikro-orm.io/docs/query-conditions> · <https://mikro-orm.io/docs/query-builder> · <https://mikro-orm.io/docs/entity-manager>

### 4.1 `em.find` filter objects

Mongo-style operator objects, typed against the entity shape:

- Comparison: `$eq $ne $gt $gte $lt $lte $in $nin $like $ilike $re $fulltext`
- Logical: `$and $or $not`
- **Postgres-only: `$ilike`, `$overlap` (`&&`), `$contains` (`@>`), `$contained` (`<@`), `$hasKey` (`?`), `$hasSomeKeys` (`?|`), `$hasKeys` (`?&`)**
- Collection: `$some`, `$none`, `$every`, **`$size` (new in v7)**
- JSON arrays: `$elemMatch` (new in v7)

`$some`/`$none`/`$every` are excellent — they compile to `EXISTS` / `NOT EXISTS` subqueries and cover the majority of "filter parent by child" needs without a manual join. `$every` in particular ("all children match") is a double-negation subquery that people routinely get wrong by hand.

The Postgres-only operator set is notable: MikroORM already **does not** hold itself to a lowest-common-denominator here. It just leaks per-dialect operators into a shared type. In a PG-only ORM these stop being exceptions and become first-class.

### 4.2 QueryBuilder

**Built on Kysely as of v7** — but read the nuance carefully. Per the release post: *Kysely is the **query runner**, while the actual query building is done entirely by MikroORM itself.* So MikroORM emits its own AST and uses Kysely for dialect-aware compilation + execution + connection management. Escape hatch: `em.getKysely()`.

v7 QueryBuilder capabilities:
- **Type-tracked aliases.** Joined aliases flow through generics; `.where({'b.title': {$like:'%orm%'}})` autocompletes.
- **CTEs**: `.with('older_authors', subQb)` and `.withRecursive()`, incl. Postgres `MATERIALIZED` hints. Entity types propagate from the CTE into `.from()`.
- **`unionWhere`** — rewrites complex `$or` into `UNION ALL` sub-queries so each branch can use an index. This is a real Postgres planner win and I've not seen another TS ORM ship it.
- **Subqueries** as `$in` operands; UNION builders.
- `execute('all' | 'get' | 'run')` with `mapResults` / `mergeResults` / `rawResults` options; `getResult()` / `getResultList()` / `getSingleResult()` for managed entities.
- **Breaking in v7: QueryBuilder is no longer thenable.** You must call `.execute()` / `.getResult()`. Good change — implicit `await` on a builder is a footgun.

### 4.3 Raw SQL escape hatches

- `raw()` returns a `RawQueryFragment` (v7: typed, was a string before).
- `sql` tagged template: `.where({ [sql`lower(email)`]: 'foo@bar.baz' })` — computed keys as raw fragments is a clever trick that keeps the filter-object shape.
- **v7: raw fragments are keyed by `Symbol` and held in a `WeakMap`, so they're reusable across queries and GC'd.** In v6 they were single-use, which was a well-known wart.
- v7 added a `quote` tagged template for platform-correct identifier quoting inside `@Formula`, index expressions, check constraints, and generated columns (whose callback signatures also swapped to `(columns, table)`).

### 4.4 Cursor pagination

```ts
const cursor = await em.findByCursor(User, {}, {
  first: 10, after: prev, orderBy: { id: 'desc' },
});
// { items, totalCount, length, startCursor, endCursor, hasPrevPage, hasNextPage }
```

Relay-shaped (`first`/`after`, `last`/`before`), with `includeCount` (default `true`) that you'll want to turn off — the docs themselves note it costs an extra COUNT. Supports multi-column ordering with proper tuple comparison. This is a well-executed, self-contained feature.

### 4.5 Virtual entities & view entities

- **Virtual entity**: read-only, no PK, `expression` is either a raw SQL string or `(em) => QueryBuilder`. Resolved at query time. Supports scalars + to-one relations (select-in only). Perfect for report/aggregate DTOs that still want `em.find` filtering, ordering, and pagination.
- **View entity (new in v7)**: `{ view: true, expression: '...' }` — the schema generator emits an actual `CREATE VIEW` / `CREATE MATERIALIZED VIEW` (Postgres) and tracks it in migrations.

The virtual/view split is a good design: one is "map arbitrary SQL to a typed shape," the other is "manage a real DB object." Both are cheap to implement and disproportionately useful.

---

## 5. Extras

### 5.1 Filters (soft-delete etc.)
Docs: <https://mikro-orm.io/docs/filters>

```ts
@Filter({ name: 'expensive', cond: { price: { $gt: 1000 } } })
em.addFilter({ name: 'writtenBy', cond: args => ({ author: args.id }), entity: Book }); // v7 object signature
```

Per-query control: `{ filters: ['writtenBy'] }`, `{ filters: { tenant: false } }`, `{ filters: false }`. Callbacks get `(args, type, em)` where `type` is `'read' | 'update' | 'delete'`, and may be **async**.

Crucially, **filters are applied to relations as part of the `JOIN ON` condition**, not just the root WHERE — which is exactly what makes soft-delete correct rather than half-correct. Non-nullable FKs get `INNER JOIN`; nullable get `LEFT JOIN` + WHERE.

Caveats: filter names are globally scoped across entities; `autoJoinRefsForFilters` sometimes needs disabling; and **`QueryBuilder` does not apply filters automatically — you must call `qb.applyFilters()`**. That last one is a silent-data-leak footgun in a multi-tenant app and we must not reproduce it.

### 5.2 Embeddables
Docs: <https://mikro-orm.io/docs/embeddables>

Inline mode (flattened to `address_street`, `address_city`, ...) vs object mode (a single JSON column). v7 changed default `prefixMode` to `relative` and made arrays inside object embeddables map to JSON arrays by default. Arrays of embeddables are always JSON, and v7 lets you query into them: multiple conditions on array props match the **same element** (Mongo `$elemMatch` semantics), compiling to `jsonb_array_elements` on Postgres. Polymorphic embeddables via discriminator columns are supported.

### 5.3 Locking
Optimistic: `@Property({ version: true })` (number or Date) → `OptimisticLockError` on mismatch; plus `concurrencyCheck: true` per-property for version-less checks. Pessimistic (needs an open transaction): `PESSIMISTIC_READ` (`FOR SHARE`), `PESSIMISTIC_WRITE` (`FOR UPDATE`), `PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`), `PESSIMISTIC_WRITE_OR_FAIL` (`FOR UPDATE NOWAIT`), `PESSIMISTIC_PARTIAL_READ`, `PESSIMISTIC_READ_OR_FAIL`. That's a complete, correctly-named mapping of Postgres row-locking clauses — `SKIP LOCKED` support in particular makes job-queue patterns viable.

### 5.4 Hooks & subscribers
Docs: <https://mikro-orm.io/docs/events>

Entity hooks: `onInit` (sync only, fires on `em.create()` and hydration, **may fire twice for references**), `onLoad` (async, full entities only), `before/afterCreate`, `before/afterUpdate`, `before/afterUpsert`, `before/afterDelete`. Flush-level: `beforeFlush` (before change sets computed — safe place to `persist()` new entities), `onFlush` (after change sets computed — can mutate change sets), `afterFlush`. Transaction-level: `before/afterTransactionStart|Commit|Rollback`.

**Hard restriction:** hooks run inside the UoW commit phase. Calling `em.flush()` throws a validation error; calling `em.persist()` "can cause undefined behavior." Also: **collection changes do not trigger update events.** These are inherent consequences of the UoW design, not bugs — and they're a good illustration of how UoW's complexity radiates outward into adjacent features.

### 5.5 Serialization
Docs: <https://mikro-orm.io/docs/serializing>

- Implicit: `toJSON()` auto-attached at discovery → `EntityTransformer.toObject()`, unwraps `Reference`/`Collection`, follows populate hints (unpopulated relations serialize as FK scalars).
- Explicit: `serialize(entity, { populate, exclude, fields, forceObject, skipNull })` with a typed `EntityDTO` result.
- `hidden: true` / `Hidden` brand / `HiddenProps`; **serialization groups** (`groups: ['public']` on props + `serialize(u, { groups: ['public'] })`); per-property `serializer: v => v.name`; `persist: false` shadow properties; `toPOJO()` for cache scenarios (expands everything, cycle-aware).

The `forceObject` option (render FKs as `{ id: 1 }` rather than `1`) is a small but very good idea — it makes API response shapes stable regardless of populate state.

### 5.6 Seeding
Docs: <https://mikro-orm.io/docs/seeding>

`Seeder` classes with `run(em)`, auto-flush+clear afterwards, `this.call(em, [A, B])` for ordering, a shared context object for passing entities between seeders. `Factory` base class (`definition()`, `makeOne()`, `make(n)`, `create()`), typically paired with faker. CLI: `seeder:create`, `seeder:run --class=X`, and `migration:fresh --seed` / `schema:fresh --seed`. Notably `persistOnCreate` is force-enabled inside seeders regardless of config.

### 5.7 Entity generator
Docs: <https://mikro-orm.io/docs/entity-generator>

`npx mikro-orm generate-entities --save --path=./entities`. Options: `takeTables`/`skipTables`/`skipColumns` (string or RegExp), `bidirectionalRelations`, `identifiedReferences`, `scalarPropertiesForRelations`, `outputPurePivotTables`, `esmImport`, `coreImportsPrefix`, `enumMode` (TS enum / union / dict), and **`entityDefinition`** to emit decorators, `defineEntity`, or `EntitySchema`. Customization hooks: `onImport`, `onInitialMetadata`, `onProcessedMetadata`. This is a mature DB-first story and the `onProcessedMetadata` hook (mutate the metadata graph before codegen) is a smart extensibility point.

---

## 6. Migrations

Docs: <https://mikro-orm.io/docs/migrations> · <https://mikro-orm.io/docs/schema-generator>

### 6.1 Architecture

Two layers:
1. **`SchemaComparator` / `SchemaGenerator`** — introspects live Postgres into a `DatabaseSchema` model, builds the target `DatabaseSchema` from entity metadata, and diffs them into DDL.
2. **`Migrator`** — wraps that diff into timestamped migration classes and manages execution state.

**`umzug` was removed in v7** (verified: `@mikro-orm/migrations` depends only on `@mikro-orm/sql`). `UmzugMigration` → `MigrationInfo`. Migration running is now in-house.

### 6.2 Snapshot files — the key design decision

`migration:create` writes a **schema snapshot JSON** alongside the migration. Docs: *"Creating new migration will automatically save the target schema snapshot into migrations folder. This snapshot will be then used if you try to create new migration, instead of using current database schema."*

- `migration:create` → snapshot derived from **entity metadata**
- `migration:up` / `migration:down` → snapshot regenerated from **live DB introspection**

This solves the "generate migration #3 while #2 is still pending" problem, which otherwise produces a duplicate or corrupt diff. It's the correct answer and we should copy it. Disable with `migrations.snapshot: false`. Snapshots are meant to be committed.

### 6.3 Migration file shape

```ts
export class Migration20260814120000 extends Migration {
  async up(): Promise<void> { this.addSql('alter table ...'); }
  async down(): Promise<void> { this.addSql('alter table ...'); }  // optional; throws by default
}
```

`this.addSql()` (raw string or a QueryBuilder) queues; `this.execute()` runs immediately inside the migration's transaction. **Using `EntityManager` inside migrations is explicitly discouraged** — *"it can lead to errors when your metadata change over time, since this will depend on your currently checked out app state, not on the time when the migration was generated."* That warning is correct and universal; we should bake it in structurally by simply not exposing an EM to migrations.

`down()` is optional and throws unless implemented. Generated migrations do get a `down()` from the reverse diff.

### 6.4 Options

| Option | Default | Notes |
|---|---|---|
| `transactional` | `true` | Wrap each migration |
| `allOrNothing` | `true` | Wrap the whole batch in one master transaction — Postgres supports transactional DDL, so this actually works |
| `dropTables` | `true` | |
| `safe` | `false` | Disables table + column drops |
| `disableForeignKeys` | `false` | |
| `tableName` | `mikro_orm_migrations` | |
| `emit` | `'ts'` | also `js`, `cjs` |
| `path` / `pathTs`, `glob`, `fileName`, `generator` | | |
| `migrationsList` | — | Static imports for bundlers (no fs) |

Per-migration override via `isTransactional(): boolean`.

### 6.5 CLI surface

`migration:create` (`--initial` for existing DBs — dumps current schema and marks it executed), `migration:up` / `:down` (`--from`, `--to`, `--only`), `migration:list`, `migration:pending`, **`migration:check`** (verify entities match DB — great CI gate), `migration:fresh` (`--seed`), **`migration:rollup`** (squash executed migrations into one), `migration:log` / `:unlog` (adjust history without executing).

`migration:check` and `migration:rollup` are both underrated and cheap to build. Multi-tenant: `migrations.schema`, `includeWildcardSchema: true`, `migrator.up({ schema: 'tenant_42' })` (Postgres uses `SET search_path`). Explicitly **sequential only** — parallel `Promise.all` fan-out over one ORM instance is unsupported.

### 6.6 What users complain about

- **Phantom/repeating diffs.** The recurring complaint class. A migration regenerates the same DDL every time because the comparator sees a difference the user doesn't. Root causes are almost always `columnType` / `default` / `defaultRaw` mismatches between the declared property and what Postgres reports back. Enums are the worst offender — e.g. [#5751](https://github.com/mikro-orm/mikro-orm/issues/5751) (empty-string enum values regenerate the check constraint every run), [#1142](https://github.com/mikro-orm/mikro-orm/issues/1142) (enum diff instability). Historically also empty migration files ([#822](https://github.com/mikro-orm/mikro-orm/issues/822), fixed by [#1362](https://github.com/mikro-orm/mikro-orm/pull/1362)).
- The official mitigation is a debug flag: `MIKRO_ORM_CLI_VERBOSE=1` dumps the `SchemaComparator` reasoning. **The fact that a debug env var is the documented answer tells you this is a permanent tax on any diffing engine.**
- **No rename detection.** `SchemaGenerator` treats a rename as drop + create — silent data loss if you `schema:update` in production. Docs say use migrations and hand-edit. Universal limitation; nobody solves it without explicit annotations.
- **No data migrations.** By design.
- MySQL can't roll back DDL (irrelevant for us — Postgres has transactional DDL, which is a real PG-only advantage).

---

## 7. Dependency footprint & Postgres support quality

### 7.1 Measured install footprint

Fresh `npm install @mikro-orm/core @mikro-orm/postgresql @mikro-orm/migrations` (v7.1.11), measured 2026-08-14:

```
node_modules total : 8.0 MB
packages installed : 21
```

| Package | Size |
|---|---|
| `kysely` | 3.4 MB |
| `@mikro-orm/core` | 2.2 MB |
| `@mikro-orm/sql` | 1.3 MB |
| `pg-protocol` | 300 KB |
| `pg` | 140 KB |
| `pg-types` | 124 KB |
| `@mikro-orm/migrations` | 108 KB |
| `@mikro-orm/postgresql` | 80 KB |
| (pg-cloudflare, pg-pool, pg-connection-string, postgres-{array,date,interval,bytea}, pg-int8, pg-cursor, pgpass, split2, xtend) | rest |

Declared dependencies (verified against registry):
- `@mikro-orm/core@7.1.11` → **no `dependencies` field at all**; optional peer `dataloader@2.2.3`.
- `@mikro-orm/postgresql@7.1.11` → `pg@8.22.0`, `kysely@0.29.4`, `pg-cursor@2.21.0`, `postgres-date@2.1.0`, `postgres-array@3.0.4`, `postgres-interval@4.1.0`, `@mikro-orm/sql`.
- `@mikro-orm/sql@7.1.11` → `kysely@0.29.4` only.
- `@mikro-orm/migrations@7.1.11` → `@mikro-orm/sql` only.
- `@mikro-orm/decorators@7.1.11` → none.
- `@mikro-orm/reflection@7.1.11` → `ts-morph@28.0.0` (opt-in only).
- `@mikro-orm/cli@7.1.11` → `yargs@17.7.2` (+ workspace deps).

**21 packages / 8 MB is genuinely lean** for an ORM with this surface area. Kysely (3.4 MB) is 42% of it, and MikroORM only uses it as a runner/compiler — for a PG-only ORM talking directly to `pg`, that entire 3.4 MB is avoidable. A PG-only ORM should be able to hit **`pg` + nothing else**, i.e. ~700 KB and ~13 packages, most of which are `pg`'s own tree.

### 7.2 Postgres feature support

Genuinely good:
- **Operators**: `$ilike`, `$overlap` (`&&`), `$contains` (`@>`), `$contained` (`<@`), `$hasKey` (`?`), `$hasSomeKeys` (`?|`), `$hasKeys` (`?&`) — first-class jsonb/array operator coverage.
- **jsonb**: queryable nested paths; v7 embedded-array queries compile to `jsonb_array_elements`; `$elemMatch` for plain JSON arrays with per-platform casting.
- **Arrays**: `postgres-array` in the driver; array columns and native **pg enum arrays** supported ([PR #2584](https://github.com/mikro-orm/mikro-orm/pull/2584)).
- **Native enums**: supported by the schema generator ([#2764](https://github.com/mikro-orm/mikro-orm/issues/2764)); `enumMode` in the entity generator emits TS enum / union / dict.
- **Full-text**: `FullTextType` exported from `@mikro-orm/postgresql` — a `tsvector` column type with `onCreate`/`onUpdate` callbacks, configurable `regconfig` (`new FullTextType('english')`), and **weighted tsvectors** ([commit a0e2c7f](https://github.com/mikro-orm/mikro-orm/commit/a0e2c7f4063d0774afd608a178b0e1edc220c3d5)), queried via `$fulltext`. Known gap: [#3696](https://github.com/mikro-orm/mikro-orm/issues/3696) — can't search nested full-text columns.
- **Declarative partitioning** (hash/list/range) with round-trip introspection.
- **Materialized views** via v7 view entities.
- **Advanced indexes** (v7): `ASC`/`DESC` per column, `NULLS FIRST/LAST`, covering indexes (`INCLUDE`), fill factor, clustered/invisible where the platform supports it.
- **Row locking**: full `FOR UPDATE`/`FOR SHARE` × `SKIP LOCKED`/`NOWAIT` matrix.
- **Streaming**: `em.stream()` / `qb.stream()` backed by `pg-cursor`.
- **Multi-schema** / `search_path` support incl. per-tenant migrations.
- **Transactional DDL** in migrations actually works (unlike MySQL).

Lowest-common-denominator compromises still visible:
- Operators like `$ilike`/`$contains` live in a shared `FilterQuery` type and are documented as "(PostgreSQL only)" rather than being unconditionally available — the type surface is DB-generic with per-DB carve-outs.
- Everything routes through a `Platform` abstraction plus Kysely's dialect layer; there are two indirection layers between "I want `@>`" and the emitted SQL.
- Some features are documented at the generic layer and then qualified per-driver (e.g. "only MySQL and PostgreSQL support searching by JSON properties"), which means the *type* allows things the *driver* may reject at runtime.
- v7's `forceUtcTimezone` default change exists purely to paper over MySQL/MSSQL datetime semantics — a PG-only ORM would just use `timestamptz` and never have the problem.
- No first-class exposure of PG-specific things a PG-only ORM should own outright: `RETURNING` composition beyond inserts, `ON CONFLICT` beyond `em.upsert`'s fixed shape, `LISTEN`/`NOTIFY`, range/geometric types, `tsrange`, exclusion constraints, `COPY`.

**Net:** MikroORM's PG support is the best of the multi-DB TS ORMs, and it proves the features are implementable. But the abstraction tax is visible in both the type surface and the runtime path, and it is precisely the tax we're declining to pay.

---

## 8. Verdicts

### 8.1 Feature-by-feature

| Feature | Verdict | Rationale |
|---|---|---|
| **`Loaded<T, Hint>` + populate-hint typing** | **PORT** | The single best idea in the library; turns unloaded-relation bugs into compile errors. Watch TS perf on deep `AutoPath`. |
| **`LazyRef<T>` (type-only relation marker)** | **PORT** | All of `Ref<T>`'s safety, none of the runtime wrapper, `instanceof` and JSON stay natural. |
| **`defineEntity` fluent builder + `InferEntity`** | **PORT** | Zero build tooling, best inference. MikroORM took 5 majors to reach this; start here. |
| **Migration snapshot files** | **PORT** | Correctly solves "generate migration N+1 while N is pending." Cheap, high value. |
| **`migration:check` + `migration:rollup`** | **PORT** | `check` is a great CI gate; `rollup` keeps old projects sane. Both trivial to build. |
| **`up()`/`down()` with `addSql`, no EM access** | **PORT** | Their own docs warn against EM-in-migrations; enforce it structurally. |
| **In-house migration runner (no umzug)** | **PORT** | v7 proved umzug is ~200 lines of replaceable code. |
| **Postgres operator set (`$ilike/$overlap/$contains/$hasKey/...`)** | **PORT** | Already PG-only in MikroORM; for us they're just… the operators. |
| **`$some`/`$none`/`$every`/`$size` collection operators** | **PORT** | Compile to EXISTS subqueries; huge ergonomic win, easy to get wrong by hand. |
| **Pessimistic lock mode matrix (`FOR UPDATE SKIP LOCKED` etc.)** | **PORT** | Thin mapping over PG syntax; unlocks job-queue patterns. |
| **Filters (soft-delete, tenancy) incl. `JOIN ON` application** | **PORT** | Applying filters to join conditions, not just root WHERE, is what makes them correct. **Do NOT copy the `qb.applyFilters()` opt-in — it's a data-leak footgun.** |
| **Cursor pagination (`findByCursor`, Relay shape)** | **PORT** | Self-contained, correct multi-column tuple comparison; default `includeCount: false`. |
| **Virtual entities (SQL → typed shape)** | **PORT** | Cheap; makes reports/aggregates first-class without leaving the type system. |
| **`Opt` / `RequiredNullable` type brands** | **PORT** | Correctly models "DB default" vs "nullable but must be passed." |
| **Per-parent relation limiting (`populateHints: { posts: { limit: 5 }}`)** | **ADAPT** | Very valuable; on PG implement with `LATERAL` instead of forcing select-in, and drop the readonly-collection caveat. |
| **Loading strategies (`select-in` / `joined` / `balanced`)** | **ADAPT** | Keep the concept, but PG-only means we can lean harder on `LATERAL` + `json_agg` and offer 2 strategies, not 3. |
| **Explicit transactions + isolation levels + savepoints** | **ADAPT** | Keep `transactional()`, savepoints, isolation levels. **Skip the 7 Spring propagation modes** — `REQUIRED` + `REQUIRES_NEW` + `NESTED` covers reality. |
| **Serialization (`serialize()`, groups, hidden, `forceObject`)** | **ADAPT** | Explicit `serialize()` with `fields`/`exclude`/`forceObject` is great. Drop implicit `toJSON` auto-attachment — magic on a class you didn't opt into. |
| **View entities (`CREATE [MATERIALIZED] VIEW`)** | **ADAPT** | Good idea; on PG make matviews + `REFRESH` first-class rather than a flag. |
| **Raw SQL escape hatch (`sql` tagged template, `raw()`, WeakMap fragments)** | **ADAPT** | Port the tagged-template + reusable-fragment design; ours should be the *primary* escape hatch, not a corner. |
| **Schema diffing engine** | **ADAPT** | We need one, but PG-only lets us diff against `pg_catalog` precisely instead of a generic `DatabaseSchema` model — that's the whole cause of their phantom-diff complaints. Ship a `--verbose` diff explainer from day one. |
| **Entity generator (DB-first codegen)** | **ADAPT** | Worth having; PG-only makes introspection far simpler. Copy the `onProcessedMetadata` extensibility hook. Ship post-v1. |
| **Embeddables** | **ADAPT** | Object/JSON mode over `jsonb` is genuinely useful. Inline/column-flattening mode adds prefix-mode complexity for little gain — ship JSON mode only. |
| **Optimistic locking (`version` column)** | **ADAPT** | Useful, but only coherent if we have change tracking. If we skip UoW, expose it as an explicit `.whereVersion(n)` on updates instead. |
| **QueryBuilder** | **ADAPT** | Build our own PG-only AST → SQL. Don't take a Kysely dependency (3.4 MB of the 8 MB footprint for a dialect layer we don't need). |
| **Seeding (`Seeder` + `Factory`)** | **ADAPT** | Seeders yes, keep them thin. `Factory` + faker should be a separate optional package, not core. |
| **Lifecycle hooks / subscribers** | **ADAPT** | The full 16-hook UoW-phase matrix is over-built and constrained (`can't flush in a hook`, `collections don't fire updates`). Ship 4: `beforeInsert`/`afterInsert`/`beforeUpdate`/`beforeDelete`, plus a query-level logging hook. |
| **`RequestContext` / `AsyncLocalStorage` ambient EM** | **SKIP** | Only exists to make a mutable identity map survive a request. Pass the connection/tx explicitly. |
| **Decorators + `reflect-metadata`** | **SKIP** | Requires `experimentalDecorators`, `emitDecoratorMetadata`, a runtime polyfill. MikroORM itself demoted it in v7. |
| **`ts-morph` metadata provider** | **SKIP** | Runtime dependency on the TS compiler; breaks under SWC/Babel; ~all of `@mikro-orm/reflection`'s weight. |
| **`EntitySchema`** | **SKIP** | Fully redundant with a `defineEntity`-style builder. |
| **Kysely (or any query-builder) dependency** | **SKIP** | Its job is dialect abstraction. We have one dialect. |
| **Spring-style transaction propagation (7 modes)** | **SKIP** | Enterprise-Java cosplay; `NOT_SUPPORTED`/`NEVER`/`MANDATORY` earn nothing. |
| **Multi-DB `Platform` abstraction** | **SKIP** | Our stated non-goal, and the direct cause of MikroORM's LCD compromises. |
| **Polymorphic relations / TPT / STI inheritance** | **SKIP** | Large surface, small audience, disproportionate diffing complexity. Discriminator + `jsonb` covers most real cases. |
| **Table-per-type & single-table inheritance** | **SKIP** | Same. |
| **Implicit `toJSON` on every entity** | **SKIP** | Action at a distance; explicit `serialize()` is strictly better. |
| **`$re` (regex) operator** | **SKIP** | `~`/`~*` via raw SQL is clearer than a Mongo-ism. |
| **`flushMode: AUTO` (flush-before-query)** | **SKIP** | The primary source of "where did that query come from." |

### 8.2 The big one: does Unit of Work + identity map belong in `pg-orm-ts`?

**The case FOR:**

1. **Write batching is real and hard to replicate by hand.** MikroORM's strongest defensible claim, per the maintainer in [discussion #7176](https://github.com/mikro-orm/mikro-orm/discussions/7176), is that UoW auto-batches inserts/updates and therefore beats naive repository code on bulk paths. A user modifying 500 entities in a loop gets one multi-row `UPDATE`. Without UoW they get 500 round trips unless they hand-roll it.
2. **FK ordering is solved for free.** Saving an object graph without thinking about insert order is a genuine ergonomic win, and topological sort is not something users should write.
3. **It's the only differentiated position left.** Drizzle owns "thin and fast" (18M/wk). Prisma owns "batteries and tooling" (16M/wk). Data-mapper + UoW is the one architectural niche with no crowded incumbent — MikroORM is, in its own words, *"the only mainstream TS ORM implementing Unit of Work + Identity Map + Data Mapper together."*
4. **It enables DDD.** Teams with rich domain models genuinely want `order.addLine(x)` to persist without a repository call at every mutation site.
5. **Identity map makes reference equality free** and prevents the "two objects for one row that disagree" class of bug.

**The case AGAINST:**

1. **It contradicts "minimal."** UoW is not a feature you add; it's an architecture that colonizes everything. Look at what it forced on MikroORM: `RequestContext` + `AsyncLocalStorage` + `em.fork()` + `@CreateRequestContext` + `@EnsureRequestContext` + `allowGlobalContext` + `disableIdentityMap` + `em.clear()` + `em.refresh()` + three flush modes + seven propagation modes + a 16-hook lifecycle with "you may not call flush in a hook" + "collections don't fire update events" + "after rollback your entities are detached, fork a new EM." **Every one of those exists to manage the mutable graph.** That is not a minimal ORM; that's the price of admission.
2. **Hidden queries destroy the mental model.** In a PG-only ORM whose pitch is "you know what SQL runs," `AUTO` flush mode emitting an `UPDATE` in the middle of a `find()` is a direct contradiction of the value proposition.
3. **The order-dependent populate-state bug is disqualifying-adjacent.** Their own docs admit that two endpoints touching the same row can return different JSON depending on execution order, because populate state lives on the identity map. Requiring `AsyncLocalStorage` to avoid that means we'd ship a correctness hazard and then ship the mitigation for it.
4. **Memory.** Snapshot + hydrated instance per row, retained until the EM dies. Every escape hatch (`disableIdentityMap`, `em.stream()`, `em.clear()`) amounts to "opt out of the ORM."
5. **The market voted.** 855k vs 18.1M weekly downloads. Drizzle won the last three years with *no* UoW, no identity map, and no change tracking. The maintainer's own concession — *"given what this project does (class mapping + serialization), it's inevitable it will be slower than the rest"* — is a structural admission, not a tuning problem.
6. **Serverless/edge is where growth is,** and a long-lived mutable identity map is actively wrong there.
7. **We'd be building the hard 20% for the 5% who want it,** and the UoW is by far the most expensive, most bug-prone, most support-burden-generating subsystem in the entire design.

**My position: SKIP the Unit of Work and the ambient identity map. ADAPT the parts that are actually valuable, in explicit form.**

Concretely, the design I'd argue for:

- **No ambient EntityManager, no `AsyncLocalStorage`, no `RequestContext`.** Queries take an explicit connection or transaction handle. This deletes the single largest source of MikroORM's conceptual overhead.
- **No implicit flush.** Nothing writes unless you call a write method. `find()` never emits an `UPDATE`. This is the core promise.
- **Entities are plain objects.** No proxies, no property descriptors, no `Reference` wrappers at runtime (use `LazyRef`-style *type-only* markers). Serialization is trivial and `structuredClone` works.
- **Recover batching explicitly.** Ship a first-class `insertMany` / `updateMany` / bulk-upsert API built on Postgres `INSERT ... ON CONFLICT` and `UPDATE ... FROM (VALUES ...)`. This delivers UoW's headline performance benefit with zero hidden state — you just have to *ask* for it.
- **Recover FK ordering explicitly** with an optional `saveGraph(root)` helper that topologically sorts a single object graph in one call. Same benefit, opt-in, no global tracking.
- **Optional scoped, non-ambient identity map.** If we want dedup, offer `db.session(async s => { ... })` where `s` has a short-lived, explicitly-created map that is *read-only dedup*, not change tracking, and dies at the end of the block. Explicit lifetime, no `fork()`, no detach semantics, no flush.
- **Optimistic locking without change tracking:** an explicit `.ifVersion(n)` on updates that emits `WHERE version = $n` and throws on zero rows affected.

This keeps ~80% of what UoW actually delivers in practice (batching, FK ordering, optional dedup, optimistic concurrency) while deleting ~95% of its complexity, its hidden-query behavior, its memory profile, and its onboarding cost. It also keeps us honest with the "minimal runtime dependencies / you know what SQL runs" thesis.

The counter-argument I'd want on the record: if `pg-orm-ts`'s intended audience is DDD teams building rich domain models, this position is wrong and we should just be a better MikroORM. But that audience is small, already served, and served *well* — and competing there means inheriting all seven of the costs above.

---

## 9. Sources

- MikroORM v7 release post — <https://mikro-orm.io/blog/mikro-orm-7-released>
- v6 → v7 upgrade guide — <https://mikro-orm.io/docs/upgrading-v6-to-v7>
- Unit of Work — <https://mikro-orm.io/docs/unit-of-work>
- Identity Map — <https://mikro-orm.io/docs/identity-map>
- Architecture overview — <https://mikro-orm.io/docs/architecture>
- Transactions — <https://mikro-orm.io/docs/transactions>
- Defining entities — <https://mikro-orm.io/docs/defining-entities>
- `defineEntity` — <https://mikro-orm.io/docs/define-entity>
- `EntitySchema` — <https://mikro-orm.io/docs/entity-schema>
- Type-safe relations — <https://mikro-orm.io/docs/type-safe-relations>
- Type safety guide — <https://mikro-orm.io/docs/guide/type-safety>
- Loading strategies — <https://mikro-orm.io/docs/loading-strategies>
- Query conditions / operators — <https://mikro-orm.io/docs/query-conditions>
- QueryBuilder — <https://mikro-orm.io/docs/query-builder>
- Entity manager (incl. cursor pagination, upsert) — <https://mikro-orm.io/docs/entity-manager>
- Virtual entities — <https://mikro-orm.io/docs/virtual-entities>
- Filters — <https://mikro-orm.io/docs/filters>
- Embeddables — <https://mikro-orm.io/docs/embeddables>
- Events / hooks — <https://mikro-orm.io/docs/events>
- Serialization — <https://mikro-orm.io/docs/serializing>
- Seeding — <https://mikro-orm.io/docs/seeding>
- Migrations — <https://mikro-orm.io/docs/migrations>
- Schema generator — <https://mikro-orm.io/docs/schema-generator>
- Entity generator — <https://mikro-orm.io/docs/entity-generator>
- Competitive landscape discussion (maintainer responses) — <https://github.com/mikro-orm/mikro-orm/discussions/7176> and <https://github.com/mikro-orm/mikro-orm/issues/7170>
- Encore, "Comparing the best TypeScript ORMs (2026)" — <https://encore.dev/articles/typescript-orms>
- Bytebase, "Top TypeScript ORM 2026" — <https://www.bytebase.com/blog/top-typescript-orm/>
- PG native enum arrays — <https://github.com/mikro-orm/mikro-orm/pull/2584>
- PG native enum support — <https://github.com/mikro-orm/mikro-orm/issues/2764>
- Weighted tsvectors + custom regconfig — <https://github.com/mikro-orm/mikro-orm/commit/a0e2c7f4063d0774afd608a178b0e1edc220c3d5>
- Full-text tsvector Postgres tests — <https://github.com/mikro-orm/mikro-orm/blob/master/tests/features/fulltext/full-text-search-tsvector.postgres.test.ts>
- Nested full-text search gap — <https://github.com/mikro-orm/mikro-orm/issues/3696>
- Enum diff instability — <https://github.com/mikro-orm/mikro-orm/issues/5751>, <https://github.com/mikro-orm/mikro-orm/issues/1142>
- Empty migration generation — <https://github.com/mikro-orm/mikro-orm/issues/822>, <https://github.com/mikro-orm/mikro-orm/pull/1362>
- Version/dependency/size data: `npm view` against registry.npmjs.org and `du -sh` on a clean install, 2026-08-14
- Download stats: `api.npmjs.org/downloads/point/last-week/*`, week of 2026-08-03 → 2026-08-09
