# packages/pg-prime/src/schema/view.ts

## Purpose
Declares typed read-only views: `pgView` and `pgMaterializedView` take declared columns and a `sql` body (or `.existing()`) and return a self-contained handle usable as a FROM source with no write surface.
Reuses `buildColumnRefs`, `TableImpl`, `snakeCase` from `table.ts` and `fragmentDdlText` from `ddl.ts`. `$.view` is read by `packages/pg-prime/src/query/scope.ts:207`, `packages/pg-prime/src/session/handles.ts:852` (`refreshMaterializedView`) and the kit's `packages/pg-prime-kit/src/schema/views.ts`; `[READONLY]` is read by `packages/pg-prime/src/query/types.ts:1096`.

## Public API
- `ViewWithOptions` — `securityInvoker?` (default true), `securityBarrier?`, `checkOption?: 'local' | 'cascaded'`.
- `RefreshableOptions` — `{ concurrently? }` for a materialized view's refresh.
- `ViewInfo` — `kind`, `name`, `schema`, `body` (text or `undefined`), `existing`, reloptions, `comment`, `renamedFrom`, `dependsOn`, `withNoData`, `refreshConcurrently`.
- `ViewRuntime` / `MaterializedViewRuntime` — `TableRuntime` with `view` populated (narrowed to `materializedView`).
- `ViewSchema<N, C>` / `ViewTable<N, C>` — the one-entry registry a view handle carries; no `[INS]` / `[UPD]`.
- `View<N, C>` / `MaterializedView<N, C>` — handle with `[SCHEMA]`, `[NAME]`, `[READONLY]: true`, `[COLS]`, `[REFS]`, `cols`, `[SEL]`, `kind`, `$`.
- `AnyView` / `AnyMaterializedView` — `any`-membered supertypes; the latter is what refresh accepts.
- `ViewRow<V>` — `V[SEL]`.
- `ViewOptions` — `{ schema?, casing? }`.
- `ViewDependency` — a qualified-name string or any value with `$.name` / `$.schema`.
- `ViewBuilder<N>` / `MaterializedViewBuilder<N>` — stage 1: `.columns(record | (t) => record)`.
- `ViewBody<N, C>` — `with`, `comment`, `renamedFrom`, `dependsOn`, then `as(body)` or `existing()`.
- `MaterializedViewBody<N, C>` — `comment`, `renamedFrom`, `dependsOn`, `withNoData`, `refreshable`, `as`, `existing`.
- `pgView(name, options?)` / `pgMaterializedView(name, options?)` — start the builder; throw `SchemaError` on bad names.
- `isView(value)` — `true` when `value.$.view` is an object.

## Flow
1. `makeBuilder` validates the name / schema into a mutable `Draft` and returns `{ columns }` (`packages/pg-prime/src/schema/view.ts:525`–`:535`).
2. `.columns()` evaluates the record with `kit` and runs `buildColumnRefs`; zero columns throws (`packages/pg-prime/src/schema/view.ts:334`–`:356`).
3. `makeStage` returns one untyped stage object whose methods patch the draft and return the same stage (`packages/pg-prime/src/schema/view.ts:436`–`:500`).
4. `dependsOn` qualifies each target as `schema.name` and dedupes (`packages/pg-prime/src/schema/view.ts:309`–`:325`, `:475`).
5. `.as(body)` renders the body with `fragmentDdlText`; `.existing()` passes `undefined` (`packages/pg-prime/src/schema/view.ts:492`–`:497`).
6. `finish` freezes `ViewInfo` (`securityInvoker ?? true` for plain views, `undefined` for matviews) and returns a frozen handle with `$: new ViewImpl(...)` (`packages/pg-prime/src/schema/view.ts:358`–`:392`).

## Gotchas
- All stage methods share one mutable draft, so branching a stage (two `.as()` calls, or options added after one) leaks settings between the resulting views.
- `with`, `withNoData`, `refreshable` exist on both kinds at runtime and throw on the wrong one (`packages/pg-prime/src/schema/view.ts:442`).
- `.refreshable()` with no argument records `refreshConcurrently: false`; never calling it leaves `undefined` (`packages/pg-prime/src/schema/view.ts:489`).
- A bare `dependsOn` string, or a target whose `$.schema` is `undefined`, is qualified as `public.`, not the emitter's default schema (`packages/pg-prime/src/schema/view.ts:313`, `:324`).
- A view is not registered with `defineSchema`; it is its own handle and has no relations or extras (`packages/pg-prime/src/schema/view.ts:292`). Its `[SCHEMA]` is `undefined` at runtime.
- `refreshable({ concurrently: true })` does not create the required unique index; a missing one fails at refresh with `55000` (`packages/pg-prime/src/schema/view.ts:70`–`:74`).
- `.existing()` views are typed and queryable but never emitted or dropped by the kit.

## Tests
- `packages/pg-prime/test/schema/view.test.ts` — options, `securityInvoker` default, casing, `.existing()`, `dependsOn` dedupe and `public` qualification, refusals, matview flags, `isView`.
- `packages/pg-prime/test/query/types/view.probe.ts` — type-level write refusal.
- `packages/pg-prime/test/live-query/views.test.ts` (live, PGlite) and `test/pg/views.test.ts` (needs `PG_PRIME_TEST_URL`).
- Kit: `packages/pg-prime-kit/test/schema-emit/views.test.ts` (partly needs a server).
- Run: `pnpm --filter pg-prime exec vitest run test/schema/view.test.ts`.
