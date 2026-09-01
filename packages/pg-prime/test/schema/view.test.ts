/**
 * `pgView` / `pgMaterializedView` — the declaration half of design/01 §3 row 58.
 *
 * Runtime-only, and deliberately so: the type-level half is `test/query/types/view.probe.ts`
 * plus `tools/type-errors/cases/insert-into-view.ts`, and the emitted DDL is the kit's
 * (`packages/pg-prime-kit/test/schema-emit/views.test.ts`). What is pinned here is the
 * **`ViewInfo` a kit reads** — because that record is the whole contract between the two
 * packages — and the refusals that must fire on the import of a schema file rather than three
 * steps later in a shadow database.
 */
import { describe, expect, it } from 'vitest'
import { isView, pgMaterializedView, pgTable, pgView, text, uuid } from '../../src/schema/index.js'
import { SchemaError } from '../../src/sql/errors.js'
import { sql } from '../../src/sql/index.js'

const orgs = pgTable('orgs', { id: uuid(), name: text() }, undefined, { schema: 'app' })

describe('pgView (design/05 §3.6 form b)', () => {
  it('carries every declared option, with securityInvoker true by default (D14)', () => {
    const v = pgView('org_health')
      .columns((t) => ({ orgId: t.uuid(), status: t.text() }))
      .with({ securityBarrier: true, checkOption: 'cascaded' })
      .comment('one row per org')
      .renamedFrom('org_healthcheck')
      .dependsOn(orgs, 'app.billing')
      .as(sql`select id as org_id, 'ok' as status from app.orgs`)

    expect(v.kind).toBe('view')
    expect(v.$.view).toEqual({
      kind: 'view',
      name: 'org_health',
      schema: undefined,
      body: "select id as org_id, 'ok' as status from app.orgs",
      existing: false,
      // D14: on unless the declaration turns it off. Nothing here mentioned it.
      securityInvoker: true,
      securityBarrier: true,
      checkOption: 'cascaded',
      comment: 'one row per org',
      renamedFrom: 'org_healthcheck',
      dependsOn: ['app.orgs', 'app.billing'],
      withNoData: false,
      refreshConcurrently: undefined,
    })
  })

  it('lets a declaration opt out of security_invoker deliberately', () => {
    const v = pgView('elevated')
      .columns({ id: uuid() })
      .with({ securityInvoker: false })
      .as(sql`select id from app.orgs`)
    expect(v.$.view.securityInvoker).toBe(false)
  })

  it('applies the casing strategy to column names and keeps the TS keys', () => {
    const v = pgView('org_health', { schema: 'reporting' })
      .columns((t) => ({ orgId: t.uuid(), lastSeenAt: t.timestamptz() }))
      .as(sql`select 1, now()`)
    expect(v.$.columns.map((c) => [c.key, c.dbName])).toEqual([
      ['orgId', 'org_id'],
      ['lastSeenAt', 'last_seen_at'],
    ])
    expect(v.$.schema).toBe('reporting')
    expect(v.$.name).toBe('org_health')
    expect(v.cols.orgId.$.table).toBe('org_health')
  })

  it('`.existing()` declares the type and emits nothing', () => {
    const v = pgView('legacy_report').columns({ id: uuid() }).existing()
    expect(v.$.view.existing).toBe(true)
    expect(v.$.view.body).toBeUndefined()
  })

  it('deduplicates dependsOn and qualifies a bare name as public', () => {
    const v = pgView('v')
      .columns({ id: uuid() })
      .dependsOn('orgs', 'public.orgs', orgs)
      .as(sql`select 1`)
    expect(v.$.view.dependsOn).toEqual(['public.orgs', 'app.orgs'])
  })

  it('refuses a bind parameter in the body, at declaration time', () => {
    const cutoff = 5
    expect(() =>
      pgView('v')
        .columns({ id: uuid() })
        .as(sql`select id from t where n > ${cutoff}`),
    ).toThrow(SchemaError)
  })

  it('refuses an empty column list', () => {
    expect(() => pgView('v').columns({})).toThrow(/declares no columns/)
  })

  it('refuses two keys that map to one column name', () => {
    expect(() => pgView('v').columns({ orgId: uuid(), org_id: text() })).toThrow(SchemaError)
  })

  it('refuses a value that is not a column', () => {
    // @ts-expect-error — a bare string is not a column builder
    expect(() => pgView('v').columns({ id: 'uuid' })).toThrow(/is not a column/)
  })

  it('refuses a checkOption PostgreSQL does not have', () => {
    expect(() =>
      // @ts-expect-error — 'sometimes' is not one of the two spellings
      pgView('v').columns({ id: uuid() }).with({ checkOption: 'sometimes' }),
    ).toThrow(SchemaError)
  })

  it('refuses a name that is not an identifier', () => {
    expect(() => pgView('a'.repeat(64))).toThrow(SchemaError)
  })
})

describe('pgMaterializedView (design/05 §3.6)', () => {
  it('carries WITH NO DATA and the refresh declaration, and never security_invoker', () => {
    const mv = pgMaterializedView('org_rollup', { schema: 'reporting' })
      .columns((t) => ({ orgId: t.uuid(), n: t.bigint() }))
      .withNoData()
      .refreshable({ concurrently: true })
      .comment('nightly')
      .as(sql`select id, count(*) from app.orgs group by 1`)

    expect(mv.kind).toBe('materializedView')
    expect(mv.$.view.kind).toBe('materializedView')
    expect(mv.$.view.withNoData).toBe(true)
    expect(mv.$.view.refreshConcurrently).toBe(true)
    // A matview cannot carry the reloption; PostgreSQL rejects it outright.
    expect(mv.$.view.securityInvoker).toBeUndefined()
  })

  it('`.refreshable()` with no argument means a plain, blocking refresh', () => {
    const mv = pgMaterializedView('m')
      .columns({ id: uuid() })
      .refreshable()
      .as(sql`select 1`)
    expect(mv.$.view.refreshConcurrently).toBe(false)
  })

  it('leaves refreshConcurrently undeclared when `.refreshable()` was never called', () => {
    const mv = pgMaterializedView('m')
      .columns({ id: uuid() })
      .as(sql`select 1`)
    expect(mv.$.view.refreshConcurrently).toBeUndefined()
  })
})

describe('isView', () => {
  it('is true for both view kinds and false for a table', () => {
    expect(isView(pgView('v').columns({ id: uuid() }).existing())).toBe(true)
    expect(isView(pgMaterializedView('m').columns({ id: uuid() }).existing())).toBe(true)
    expect(isView(orgs)).toBe(false)
    expect(isView(null)).toBe(false)
    expect(isView({ $: {} })).toBe(false)
  })
})
