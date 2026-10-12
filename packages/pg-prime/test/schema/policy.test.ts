import { describe, expect, it } from 'vitest'
import { uuidCodec } from '../../src/codec/index.js'
import { SchemaError } from '../../src/sql/errors.js'
import { and, compileOnly, eq, exists, isNull, lt, not, or } from '../../src/index.js'
import { definePolicy, defineSchema, pgSchema, pgTable, rls } from '../../src/schema/index.js'
import { setting } from '../../src/session/setting.js'
import { sql } from '../../src/sql/index.js'

const orgId = setting('app.org_id', uuidCodec)

const documents = pgTable(
  'documents',
  (t) => ({
    id: t.uuid().primaryKey(),
    orgId: t.uuid(),
    archived: t.boolean().default(false),
    rank: t.integer(),
  }),
  () => [rls.force()],
)
const memberships = pgTable('memberships', (t) => ({ userId: t.uuid(), orgId: t.uuid() }))
const pub = (s: string | undefined): string => s ?? 'public'

describe('definePolicy $.ddl()', () => {
  it('renders the tenant policy with every column qualified and the setting inlined', () => {
    const p = definePolicy('tenant', {
      on: documents,
      to: ['app_user'],
      using: (t) => eq(t.orgId, orgId.current()),
      withCheck: (t) => eq(t.orgId, orgId.current()),
    })
    expect(p.kind).toBe('policy')
    expect(p.$).toMatchObject({
      name: 'tenant',
      command: 'all',
      permissive: true,
      roles: ['app_user'],
    })
    expect(p.$.table).toBe(documents.$)
    expect(p.$.ddl(pub)).toBe(
      `CREATE POLICY "tenant" ON "public"."documents" AS PERMISSIVE FOR ALL TO "app_user"\n` +
        `  USING ("documents"."org_id" = (nullif(current_setting('app.org_id', true), '')::uuid))\n` +
        `  WITH CHECK ("documents"."org_id" = (nullif(current_setting('app.org_id', true), '')::uuid))`,
    )
  })

  it('inlines a bind as the codec-encoded literal with its cast', () => {
    const p = definePolicy('archived_read_only', {
      on: documents,
      for: 'update',
      as: 'restrictive',
      to: ['app_user'],
      using: (t) => and(eq(t.archived, false), lt(t.rank, 10), not(isNull(t.id))),
    })
    expect(p.$.ddl(pub)).toBe(
      `CREATE POLICY "archived_read_only" ON "public"."documents" AS RESTRICTIVE FOR UPDATE TO "app_user"\n` +
        `  USING (("documents"."archived" = 'f'::boolean and "documents"."rank" < '10'::integer and not ("documents"."id" is null)))`,
    )
  })

  it('qualifies refs inside a raw subquery, own table and other tables alike', () => {
    const p = definePolicy('member', {
      on: documents,
      for: 'select',
      using: (t) =>
        sql`exists (select 1 from memberships m where m.org_id = ${t.orgId} and ${memberships.cols.userId} = ${'x'} or ${1} = ${2.5})`,
    })
    expect(p.$.ddl(pub)).toBe(
      `CREATE POLICY "member" ON "public"."documents" AS PERMISSIVE FOR SELECT TO PUBLIC\n` +
        `  USING (exists (select 1 from memberships m where m.org_id = "documents"."org_id" and "memberships"."user_id" = 'x' or '1' = '2.5'))`,
    )
  })

  it('renders a typed subquery from a compileOnly handle', () => {
    const sc = defineSchema({ memberships })
    const db = compileOnly(sc)
    const p = definePolicy('typed', {
      on: documents,
      for: 'delete',
      to: ['current_user', 'auditor'],
      using: (t) =>
        exists(
          db
            .from(sc.h.memberships)
            .select(({ memberships: m }) => ({ u: m.userId }))
            .where(({ memberships: m }) => eq(m.orgId, t.orgId)),
        ),
    })
    expect(p.$.ddl(pub)).toMatchInlineSnapshot(`
      "CREATE POLICY "typed" ON "public"."documents" AS PERMISSIVE FOR DELETE TO CURRENT_USER, "auditor"
        USING (exists (
        select "memberships"."user_id" as "u"
        from "public"."memberships" as "memberships"
        where "memberships"."org_id" = "documents"."org_id"
      ))"
    `)
  })

  it('maps a typed FROM table through schemaOf', () => {
    const sc = defineSchema({ memberships })
    const db = compileOnly(sc)
    const p = definePolicy('typed', {
      on: documents,
      using: (t) =>
        exists(
          db
            .from(sc.h.memberships)
            .select(({ memberships: m }) => ({ u: m.userId }))
            .where(({ memberships: m }) => eq(m.orgId, t.orgId)),
        ),
    })
    expect(p.$.ddl((s) => `shadow_${s ?? 'public'}`)).toContain(
      'from "shadow_public"."memberships" as "memberships"',
    )
  })

  it("refuses a typed FROM aliased like the policy's table, in any schema", () => {
    const archive = pgSchema('archive').table('documents', (t) => ({ orgId: t.uuid() }))
    for (const sc of [defineSchema({ documents }), defineSchema({ documents: archive })]) {
      const db = compileOnly(sc)
      const p = definePolicy('captured', {
        on: documents,
        using: (t) =>
          exists(
            db
              .from(sc.h.documents)
              .select(({ documents: d }) => ({ o: d.orgId }))
              .where(({ documents: d }) => eq(d.orgId, t.orgId)),
          ),
      })
      expect(() => p.$.ddl(pub)).toThrow(/FROM item aliased "documents"/)
    }
  })

  it('maps the schema through schemaOf and leaves omitted clauses out', () => {
    const audit = pgSchema('audit')
    const log = audit.table('log', (t) => ({ id: t.integer() }))
    const p = definePolicy('none', { on: log, for: 'insert', to: ['session_user'] })
    expect(p.$.ddl((s) => `shadow_${s ?? 'public'}`)).toBe(
      'CREATE POLICY "none" ON "shadow_audit"."log" AS PERMISSIVE FOR INSERT TO SESSION_USER',
    )
  })

  it('evaluates the thunks lazily, on every ddl() call', () => {
    let calls = 0
    const p = definePolicy('lazy', {
      on: documents,
      using: (t) => {
        calls++
        return or(eq(t.archived, true))
      },
    })
    expect(calls).toBe(0)
    p.$.ddl(pub)
    p.$.ddl(pub)
    expect(calls).toBe(2)
  })

  it.each([
    ['a bad name', () => definePolicy('', { on: documents })],
    ['no table', () => definePolicy('p', {} as never)],
    ['a bad command', () => definePolicy('p', { on: documents, for: 'merge' as never })],
    ['a bad as', () => definePolicy('p', { on: documents, as: 'strict' as never })],
    ['an empty role list', () => definePolicy('p', { on: documents, to: [] })],
    ['a duplicate role', () => definePolicy('p', { on: documents, to: ['a', 'a'] })],
    ['an invalid role', () => definePolicy('p', { on: documents, to: ['a\u0000b'] })],
    ['a non-function predicate', () => definePolicy('p', { on: documents, using: 1 as never })],
    [
      'using on insert',
      () => definePolicy('p', { on: documents, for: 'insert', using: (() => sql`true`) as never }),
    ],
    [
      'withCheck on select',
      () =>
        definePolicy('p', { on: documents, for: 'select', withCheck: (() => sql`true`) as never }),
    ],
  ])('refuses %s with a SchemaError', (_, f) => {
    expect(f).toThrow(SchemaError)
  })

  it('refuses a binary bind when rendered, naming the policy', () => {
    const p = definePolicy('p', { on: documents, using: () => sql`${new Uint8Array([1])} is null` })
    expect(() => p.$.ddl(pub)).toThrow(/definePolicy\("p"\) using contains a binary bind/)
  })
})
