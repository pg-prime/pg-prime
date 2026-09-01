/**
 * `pgView` / `pgMaterializedView` — design/05 §3.6, built to design/01 §3 row 58's contract.
 *
 * Row 58 promises **typed read-only entities** whose body rides the `sql/` repeatable lane plus a
 * `REFRESH` helper; its acceptance sentence is "a queryable entity with no insert/update/delete
 * method; `insertInto(view)` is a compile error". That is what this file builds, and deliberately
 * no more:
 *
 *  - the **declared-columns** form, `pgView('v').columns((t) => ({…})).as(sql`…`)`, and
 *  - the **`.existing()`** form — declared, typed, queryable, never emitted, never dropped, and
 *    silenced in the kit's Tier-U census (`06` §2.2's `external` provenance, D10).
 *
 * `05` §3.6's third form — `pgView('v').as((q) => q.from(users)…)`, columns and TS types inferred
 * from the builder — is **not built**: it would make `src/schema` depend on `src/query`, which
 * design/08 §2.1 forbids, and its diff story is `01` row 63 (v1.x). `05` §3.6's normalized-
 * definition diff strategy is that same row 63 and is likewise not built: in v1 a view body is a
 * hashed repeatable, exactly as `01` §3's lane decision states.
 *
 * ── Why a view is its own handle ──────────────────────────────────────────────────────────────
 *
 * A `pgTable(...)` is reached through `defineSchema(...).h.users`, because the *schema* is what
 * knows a table's relations (design/04 §1.5). A view has none — it is a projection, and
 * `defineRelations` has nothing to say about it — so the registry would add nothing and cost a
 * widening of `Tables` to a union. Instead the value `pgView(...)` returns **is** a handle: it
 * carries its own one-entry `[SCHEMA]`, exactly as a CTE handle does (`src/query/types.ts`'s
 * `CteSchema`), so `db.from(activeUsers)`, every join, every operator and every projection work
 * with **zero** changes to the query layer. Unlike a CTE handle it carries real {@link Cols}, so
 * the PG type class of each column survives and the operator gates stay exact.
 *
 * The one thing it carries that a table handle does not is the {@link READONLY} slot, which is
 * what turns `insertInto(view)` into design/04 §4.1's one-line sentinel instead of a runtime 42809.
 */

import { SchemaError } from '../sql/errors.js'
import type { AnyFragment } from '../sql/fragment.js'
import { checkName, kit } from './column.js'
import type { AnyCol, ColumnKit, ColumnRuntime } from './column.js'
import { fragmentDdlText } from './ddl.js'
import type { RefRuntime, RefsOfCols } from './ref.js'
import { COLS, NAME, READONLY, REFS, RELS, SCHEMA, SEL, TABLES } from './symbols.js'
import { buildColumnRefs, snakeCase, TableImpl } from './table.js'
import type { ColsOf, TableRuntime } from './table.js'
import type { Cols, SelectRow } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Runtime metadata (design/05 D2: everything non-generic lives behind `$`)
// ─────────────────────────────────────────────────────────────────────────────

/** `WITH (…)` on a plain view. `security_invoker` defaults to **true** (design/05 D14). */
export interface ViewWithOptions {
  /**
   * `security_invoker` — the view's rows are read with the *caller's* privileges and RLS policies.
   *
   * True by default, which is D14: PG 15 is the floor, and silently bypassing RLS through a view
   * is a security bug, not a default. Set it false only when the view is deliberately a
   * privilege-crossing boundary.
   */
  readonly securityInvoker?: boolean
  /** `security_barrier` — no user-supplied qualifier is pushed below the view's own. */
  readonly securityBarrier?: boolean
  /** `WITH LOCAL CHECK OPTION` / `WITH CASCADED CHECK OPTION`, for an updatable view. */
  readonly checkOption?: 'local' | 'cascaded'
}

/** `.refreshable({ concurrently })` on a materialized view. */
export interface RefreshableOptions {
  /**
   * Declares that `REFRESH MATERIALIZED VIEW CONCURRENTLY` is the intended refresh.
   *
   * PostgreSQL requires a unique index on the matview for it, and there is no `.indexes(…)` in
   * this round (see the file header), so the index comes from the `sql/` lane. This flag is
   * therefore **documentation the refresh helper reads** — `db.refreshMaterializedView(mv)` picks
   * `CONCURRENTLY` from it — and never a claim that the index exists; a missing one is the
   * server's own `55000`, mapped and rethrown, not a silent success.
   */
  readonly concurrently?: boolean
}

/**
 * Everything the kit needs to render a declared view into the repeatables lane and to order it.
 *
 * Plain data, no type parameters: adding a field here costs zero type instantiations, which is the
 * same rule `src/schema/ddl.ts` states for columns.
 */
export interface ViewInfo {
  readonly kind: 'view' | 'materializedView'
  readonly name: string
  readonly schema: string | undefined
  /**
   * The `SELECT` body as DDL text, or `undefined` for `.existing()`.
   *
   * Rendered from the `sql` fragment at declaration time by {@link fragmentDdlText}, so a bind
   * parameter in a position the catalog cannot hold fails on the import of the schema file rather
   * than three steps later in a shadow database.
   */
  readonly body: string | undefined
  /** `.existing()` — declared and typed, never emitted, never dropped, census-silenced. */
  readonly existing: boolean
  /** `undefined` on a materialized view, which cannot carry the reloption. */
  readonly securityInvoker: boolean | undefined
  readonly securityBarrier: boolean | undefined
  readonly checkOption: 'local' | 'cascaded' | undefined
  readonly comment: string | undefined
  readonly renamedFrom: string | undefined
  /** `.dependsOn(…)`, as qualified `schema.name` strings, deduped and in declaration order. */
  readonly dependsOn: readonly string[]
  /** `WITH NO DATA` on `CREATE MATERIALIZED VIEW`. */
  readonly withNoData: boolean
  /** `.refreshable({ concurrently })`; `undefined` when never declared. */
  readonly refreshConcurrently: boolean | undefined
}

/** A {@link TableRuntime} whose `view` slot is populated — what `$` is on every view value. */
export interface ViewRuntime extends TableRuntime {
  readonly view: ViewInfo
}

/** A {@link ViewRuntime} narrowed to a materialized view — what `refreshMaterializedView` takes. */
export interface MaterializedViewRuntime extends ViewRuntime {
  readonly view: ViewInfo & { readonly kind: 'materializedView' }
}

// ─────────────────────────────────────────────────────────────────────────────
// The typed entity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one-table registry a view handle points at.
 *
 * Structurally `src/query/types.ts`'s `CteSchema`, and for the same reason: `TableAt<H>` is two
 * indexed accesses into `H[SCHEMA][TABLES][H[NAME]]`, so a self-contained schema is all a
 * FROM source needs to light up the whole query layer.
 */
export interface ViewSchema<N extends string, C extends Cols> {
  readonly [TABLES]: { readonly [K in N]: ViewTable<N, C> }
  readonly [RELS]: { readonly [K in N]: {} }
}

/** The `Table`-shaped entry inside a {@link ViewSchema}. No `[INS]` / `[UPD]`: a view has none. */
export interface ViewTable<N extends string, C extends Cols> {
  readonly [NAME]: N
  readonly [COLS]: C
  readonly [REFS]: RefsOfCols<N, C>
  readonly [SEL]: SelectRow<C>
  readonly [RELS]: {}
  readonly $: ViewRuntime
}

/**
 * A declared view: a FROM source with exact column types and no write surface.
 *
 * `db.from(activeUsers)` and `db.innerJoin(activeUsers, 'v', …)` take it directly — it is a
 * handle. `db.insertInto(activeUsers)` resolves to design/04 §4.1's branded sentence.
 */
export interface View<N extends string, C extends Cols> {
  readonly [SCHEMA]: ViewSchema<N, C>
  readonly [NAME]: N
  /** The slot the three write entry points read. Present only on views. */
  readonly [READONLY]: true
  readonly [COLS]: C
  readonly [REFS]: RefsOfCols<N, C>
  /** The same pre-computed `[REFS]` slot under a name a schema file can type. */
  readonly cols: RefsOfCols<N, C>
  readonly [SEL]: SelectRow<C>
  /** The discriminant the kit's export scan reads, next to `pgDomain`'s and `pgEnum`'s. */
  readonly kind: 'view'
  readonly $: ViewRuntime
}

/** A declared materialized view. {@link View} plus `REFRESH`. */
export interface MaterializedView<N extends string, C extends Cols> {
  readonly [SCHEMA]: ViewSchema<N, C>
  readonly [NAME]: N
  readonly [READONLY]: true
  readonly [COLS]: C
  readonly [REFS]: RefsOfCols<N, C>
  readonly cols: RefsOfCols<N, C>
  readonly [SEL]: SelectRow<C>
  readonly kind: 'materializedView'
  readonly $: MaterializedViewRuntime
}

/** Minimal `Any` supertype (design/04 §3.3) — members are `any`, so the check stays O(1). */
export interface AnyView {
  readonly [SCHEMA]: any
  readonly [NAME]: any
  readonly [READONLY]: true
  readonly [COLS]: any
  readonly [REFS]: any
  readonly cols: any
  readonly [SEL]: any
  readonly kind: 'view' | 'materializedView'
  readonly $: ViewRuntime
}

/** What `db.refreshMaterializedView(…)` accepts. A plain view is refused by the `kind` literal. */
export interface AnyMaterializedView extends AnyView {
  readonly kind: 'materializedView'
  readonly $: MaterializedViewRuntime
}

/** The row a view yields — `Row<T>`'s spelling for something that has no insert shape. */
export type ViewRow<V extends AnyView> = V[typeof SEL]

// ─────────────────────────────────────────────────────────────────────────────
// The builders
// ─────────────────────────────────────────────────────────────────────────────

/** `pgView('v', { schema, casing })`. Mirrors `TableOptions`. */
export interface ViewOptions {
  readonly schema?: string
  readonly casing?: (key: string) => string
}

/**
 * What `.dependsOn(…)` accepts: any table, view or column-carrying value with a `$`, or a
 * qualified name written by hand for something the DSL cannot name (a function, a foreign table).
 */
export type ViewDependency =
  | string
  | { readonly $: { readonly name: string; readonly schema: string | undefined } }

/** Stage 1: the name is fixed, the columns are not. */
export interface ViewBuilder<N extends string> {
  /**
   * Declare the view's columns and their types. The keys become the emitted column-alias list
   * *and* the row's keys, and each column's codec decodes it — so a declared view is as exactly
   * typed and as fully decoded as a table.
   */
  columns<B extends Record<string, AnyCol>>(
    columns: B | ((t: ColumnKit) => B),
  ): ViewBody<N, ColsOf<B>>
}

/** Stage 2 of {@link pgView}: options, then a body or `.existing()`. */
export interface ViewBody<N extends string, C extends Cols> {
  /** `WITH (…)`. `securityInvoker: true` is the default and stays on unless set false (D14). */
  with(options: ViewWithOptions): ViewBody<N, C>
  /** `COMMENT ON VIEW`. */
  comment(text: string): ViewBody<N, C>
  /** design/05 §5.1's rename annotation. Idempotent, safe to leave in source. */
  renamedFrom(name: string): ViewBody<N, C>
  /** Explicit ordering for the repeatables lane, when the SQL body is opaque to the kit. */
  dependsOn(...targets: readonly ViewDependency[]): ViewBody<N, C>
  /** The `SELECT` body. This is what the kit hashes and re-applies on change. */
  as(body: AnyFragment): View<N, C>
  /** "It exists and we do not manage it" — declared, typed, never emitted (D10 `external`). */
  existing(): View<N, C>
}

/** Stage 1 of {@link pgMaterializedView}. */
export interface MaterializedViewBuilder<N extends string> {
  columns<B extends Record<string, AnyCol>>(
    columns: B | ((t: ColumnKit) => B),
  ): MaterializedViewBody<N, ColsOf<B>>
}

/**
 * Stage 2 of {@link pgMaterializedView}.
 *
 * No `.with(…)`: `security_invoker`, `security_barrier` and `check_option` are all rejected by
 * PostgreSQL on a matview, so a method that could only ever throw is worse than its absence.
 * `05` §3.6's `.using(…)`, `.tablespace(…)` and `.indexes(…)` are not built this round — see the
 * RESULT record in design/14.
 */
export interface MaterializedViewBody<N extends string, C extends Cols> {
  comment(text: string): MaterializedViewBody<N, C>
  renamedFrom(name: string): MaterializedViewBody<N, C>
  dependsOn(...targets: readonly ViewDependency[]): MaterializedViewBody<N, C>
  /** `CREATE MATERIALIZED VIEW … WITH NO DATA` — the matview is created empty and unscannable. */
  withNoData(): MaterializedViewBody<N, C>
  /** Records how `db.refreshMaterializedView(mv)` should refresh it. */
  refreshable(options?: RefreshableOptions): MaterializedViewBody<N, C>
  as(body: AnyFragment): MaterializedView<N, C>
  existing(): MaterializedView<N, C>
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime
// ─────────────────────────────────────────────────────────────────────────────

/** `TableImpl` plus the one slot a view adds. See {@link TableImpl} for why it is not a copy. */
class ViewImpl extends TableImpl implements ViewRuntime {
  readonly view: ViewInfo

  constructor(columns: readonly RefRuntime[], view: ViewInfo) {
    super(view.name, view.schema, columns, NO_EXTRAS)
    this.view = view
  }
}

const NO_EXTRAS: readonly never[] = Object.freeze([])

/** Mutable accumulator behind the two stage-2 builders. One object, patched in place. */
interface Draft {
  kind: 'view' | 'materializedView'
  name: string
  schema: string | undefined
  securityInvoker: boolean | undefined
  securityBarrier: boolean | undefined
  checkOption: 'local' | 'cascaded' | undefined
  comment: string | undefined
  renamedFrom: string | undefined
  dependsOn: string[]
  withNoData: boolean
  refreshConcurrently: boolean | undefined
}

function qualify(dep: ViewDependency, what: string): string {
  if (typeof dep === 'string') {
    const dotted = dep.includes('.')
    for (const part of dotted ? dep.split('.') : [dep]) checkName(part, `${what} target "${dep}"`)
    return dotted ? dep : `public.${dep}`
  }
  const runtime: unknown = (dep as { $?: unknown }).$
  const name = (runtime as { name?: unknown } | undefined)?.name
  if (typeof name !== 'string') {
    throw new SchemaError(
      `pg-prime: ${what} takes a table, a view, or a qualified name string like ` +
        `"public.orgs" — this value has no \`$\` runtime.`,
    )
  }
  const schema = (runtime as { schema?: unknown }).schema
  return `${typeof schema === 'string' ? schema : 'public'}.${name}`
}

/**
 * {@link buildColumnRefs} plus the one rule only a view has: it must declare at least one column.
 *
 * `CREATE TABLE t ()` is legal PostgreSQL and `pgTable` allows it; a view with no columns is not a
 * view, and the declared column list IS the entity's type, so an empty one is a mistake with no
 * useful reading.
 */
function viewRefs(
  name: string,
  draft: Draft,
  record: Record<string, { $?: ColumnRuntime } | undefined>,
  casing: (key: string) => string,
  what: string,
): { refs: Record<string, unknown>; runtimes: RefRuntime[] } {
  const built = buildColumnRefs(
    name,
    draft.schema,
    record,
    casing,
    what,
    casing === snakeCase ? 'snakeCase' : 'custom',
  )
  if (built.runtimes.length === 0) {
    throw new SchemaError(
      `pg-prime: ${what} declares no columns. A view's column list is its whole type — declare ` +
        `at least one, or drop the declaration and query the underlying table.`,
    )
  }
  return built
}

function finish(
  draft: Draft,
  runtimes: readonly RefRuntime[],
  refs: Record<string, unknown>,
  body: string | undefined,
): object {
  const info: ViewInfo = Object.freeze({
    kind: draft.kind,
    name: draft.name,
    schema: draft.schema,
    body,
    existing: body === undefined,
    securityInvoker:
      draft.kind === 'materializedView' ? undefined : (draft.securityInvoker ?? true),
    securityBarrier: draft.securityBarrier,
    checkOption: draft.checkOption,
    comment: draft.comment,
    renamedFrom: draft.renamedFrom,
    dependsOn: Object.freeze([...draft.dependsOn]),
    withNoData: draft.withNoData,
    refreshConcurrently: draft.refreshConcurrently,
  })
  const refsObj = Object.freeze(refs)
  return Object.freeze({
    [SCHEMA]: undefined,
    [NAME]: draft.name,
    [READONLY]: true,
    [COLS]: undefined,
    [REFS]: refsObj,
    cols: refsObj,
    [SEL]: undefined,
    kind: draft.kind,
    $: new ViewImpl(Object.freeze([...runtimes]), info),
  })
}

function makeDraft(
  kind: Draft['kind'],
  name: string,
  options: ViewOptions | undefined,
  what: string,
): Draft {
  checkName(name, `${what} name`)
  if (options?.schema !== undefined) checkName(options.schema, `${what} schema name`)
  return {
    kind,
    name,
    schema: options?.schema,
    securityInvoker: undefined,
    securityBarrier: undefined,
    checkOption: undefined,
    comment: undefined,
    renamedFrom: undefined,
    dependsOn: [],
    withNoData: false,
    refreshConcurrently: undefined,
  }
}

function checkText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SchemaError(`pg-prime: ${what} takes a non-empty string.`)
  }
  return value
}

/**
 * The stage-2 builder, **untyped**, shared by both kinds.
 *
 * `pgTable` does the same thing and for the same measured reason (design/04 §1.3): an
 * implementation that annotates every method with `ViewBody<N, ColsOf<B>>` instantiates that type
 * once per method per factory, and `bench:types` counts every one of them in the library's own
 * baseline — the `empty` scenario, which has no schema in it at all. One cast at the public
 * boundary costs one instantiation and says exactly as much.
 *
 * The methods only one kind admits are present on both objects and refuse at runtime, because the
 * cast is the only thing keeping them apart and a cast is not a guarantee.
 */
function makeStage(
  draft: Draft,
  what: string,
  runtimes: readonly RefRuntime[],
  refs: Record<string, unknown>,
): object {
  const onlyOn = (kind: Draft['kind'], method: string): void => {
    if (draft.kind === kind) return
    throw new SchemaError(
      `pg-prime: ${what}.${method} is only available on a ` +
        `${kind === 'view' ? 'pgView' : 'pgMaterializedView'}.`,
    )
  }
  const stage = {
    with(o: ViewWithOptions): object {
      // A matview carries none of the three reloptions; PostgreSQL rejects all of them.
      onlyOn('view', 'with(…)')
      if (o.securityInvoker !== undefined) draft.securityInvoker = o.securityInvoker === true
      if (o.securityBarrier !== undefined) draft.securityBarrier = o.securityBarrier === true
      if (o.checkOption !== undefined) {
        if (o.checkOption !== 'local' && o.checkOption !== 'cascaded') {
          throw new SchemaError(
            `pg-prime: ${what}.with({ checkOption }) is ${JSON.stringify(o.checkOption)}; ` +
              `PostgreSQL takes "local" or "cascaded".`,
          )
        }
        draft.checkOption = o.checkOption
      }
      return stage
    },
    comment(text: string): object {
      draft.comment = checkText(text, `${what}.comment(…)`)
      return stage
    },
    renamedFrom(old: string): object {
      checkName(old, `${what}.renamedFrom(…)`)
      draft.renamedFrom = old
      return stage
    },
    dependsOn(...targets: readonly ViewDependency[]): object {
      for (const t of targets) {
        const q = qualify(t, `${what}.dependsOn(…)`)
        if (!draft.dependsOn.includes(q)) draft.dependsOn.push(q)
      }
      return stage
    },
    withNoData(): object {
      onlyOn('materializedView', 'withNoData()')
      draft.withNoData = true
      return stage
    },
    refreshable(o?: RefreshableOptions): object {
      onlyOn('materializedView', 'refreshable(…)')
      draft.refreshConcurrently = o?.concurrently === true
      return stage
    },
    as(body: AnyFragment): object {
      return finish(draft, runtimes, refs, fragmentDdlText(body, `${what} body`))
    },
    existing(): object {
      return finish(draft, runtimes, refs, undefined)
    },
  }
  return stage
}

function columnRecord(columns: unknown): Record<string, { $?: ColumnRuntime } | undefined> {
  const record =
    typeof columns === 'function' ? (columns as (t: ColumnKit) => unknown)(kit) : columns
  return record as Record<string, { $?: ColumnRuntime } | undefined>
}

/**
 * `pgView('org_health').columns((t) => ({ orgId: t.uuid(), status: t.text() }))` then a body —
 * design/05 §3.6's form (b), and `.existing()` is its form (c).
 *
 * The builder-inferred form (a) is not built; see the file header.
 */
export function pgView<N extends string>(name: N, options?: ViewOptions): ViewBuilder<N> {
  return makeBuilder('view', name, options) as ViewBuilder<N>
}

export function pgMaterializedView<N extends string>(
  name: N,
  options?: ViewOptions,
): MaterializedViewBuilder<N> {
  return makeBuilder('materializedView', name, options) as MaterializedViewBuilder<N>
}

function makeBuilder(kind: Draft['kind'], name: string, options: ViewOptions | undefined): object {
  const what = kind === 'view' ? `pgView("${name}")` : `pgMaterializedView("${name}")`
  const draft = makeDraft(kind, name, options, what)
  const casing = options?.casing ?? snakeCase
  return {
    columns(columns: unknown): object {
      const { refs, runtimes } = viewRefs(name, draft, columnRecord(columns), casing, what)
      return makeStage(draft, what, runtimes, refs)
    },
  }
}

/** `true` when the value is a `pgView(...)` / `pgMaterializedView(...)` handle. */
export function isView(value: unknown): value is AnyView {
  if (typeof value !== 'object' || value === null) return false
  const runtime = (value as { $?: { view?: unknown } }).$
  return typeof runtime === 'object' && runtime !== null && typeof runtime.view === 'object'
}
