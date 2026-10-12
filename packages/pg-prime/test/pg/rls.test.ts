/**
 * design/20 §8 tier 2: declared policies with a LOGIN role on its own pool, pooled reuse of the
 * `''` placeholder, and transaction-local settings through PgBouncer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uuidCodec } from '../../src/codec/index.js'
import { InsufficientPrivilegeError } from '../../src/errors/index.js'
import { definePolicy, defineSchema, eq, pgPrime, pgTable, setting, sql } from '../../src/index.js'
import type { Db } from '../../src/index.js'
import { announce, liveTarget, requiresConcurrency, type TestDecl } from '../live/_harness.js'

const NS = 'pgprime_pg_rls'
const LOGIN = 'pgprime_rls_login'
const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const BOUNCER = process.env['PG_PRIME_TEST_PGBOUNCER_URL']

const orgId = setting('app.org_id', uuidCodec)
const docs = pgTable('docs', (t) => ({ orgId: t.uuid(), title: t.text() }), undefined, {
  schema: NS,
})
const schema = defineSchema({ docs })
const tenant = definePolicy('tenant', {
  on: docs,
  to: [LOGIN, 'public'],
  using: (t) => eq(t.orgId, orgId.current()),
  withCheck: (t) => eq(t.orgId, orgId.current()),
})

const open: Db<typeof schema>[] = []
const make = (url: string): Db<typeof schema> => {
  const db = pgPrime({ schema, connection: url, poolOptions: { max: 1 } })
  open.push(db)
  return db
}
let admin: Db<typeof schema>
let app: Db<typeof schema>
let canCreateRoles = false

const titles = (db: Db<typeof schema>, settings: Record<string, string>) =>
  db.transaction({ localSettings: settings }, (tx) =>
    tx
      .from(schema.h.docs)
      .select(({ docs: d }) => ({ title: d.title }))
      .orderBy(({ docs: d }) => d.title)
      .execute()
      .then((rows) => rows.map((r) => r.title)),
  )

function requiresRoles(): TestDecl {
  return (name, fn, timeout) =>
    requiresConcurrency()(
      name,
      async () => {
        if (canCreateRoles) await fn()
        else announce(`[pg] skip: ${name} — current_user cannot CREATE ROLE on this server`)
      },
      timeout,
    )
}

beforeAll(async () => {
  if (liveTarget().kind !== 'pg') return
  admin = make(liveTarget().url)
  const [row] =
    await admin.sql`select rolsuper or rolcreaterole as ok from pg_roles where rolname = current_user`.execute()
  canCreateRoles = (row as { ok: boolean }).ok
  if (!canCreateRoles) return
  await admin.sql`drop schema if exists ${sql.ident(NS)} cascade`.execute()
  await admin.sql`do $$ begin create role ${sql.ident(LOGIN)} login password 'pgprime';
    exception when duplicate_object then null; end $$`.execute()
  await admin.sql`create schema ${sql.ident(NS)}`.execute()
  await admin.sql`grant usage on schema ${sql.ident(NS)} to ${sql.ident(LOGIN)}`.execute()
  await admin.sql`create table ${sql.ident(NS, 'docs')} (org_id uuid, title text)`.execute()
  await admin.sql`grant select, insert on ${sql.ident(NS, 'docs')} to public`.execute()
  await admin.sql`insert into ${sql.ident(NS, 'docs')} values (${A}::uuid, 'a1'), (${B}::uuid, 'b1')`.execute()
  await admin.sql`alter table ${sql.ident(NS, 'docs')} enable row level security`.execute()
  await admin.sql`${sql.unsafeRaw(tenant.$.ddl((s) => s ?? 'public'))}`.execute()
  const url = new URL(liveTarget().url)
  url.username = LOGIN
  url.password = 'pgprime'
  app = make(url.toString())
}, 120_000)

afterAll(async () => {
  for (const db of open.slice(1)) await db.end().catch(() => {})
  if (canCreateRoles) {
    await admin.sql`drop schema if exists ${sql.ident(NS)} cascade`.execute().catch(() => {})
    await admin.sql`drop role if exists ${sql.ident(LOGIN)}`.execute().catch(() => {})
  }
  await admin?.end().catch(() => {})
})

describe('declared RLS policies on a real server', () => {
  requiresRoles()('a login role sees its tenant; unset sees nothing', async () => {
    expect(await titles(app, orgId.set(A))).toEqual(['a1'])
    expect(await titles(app, orgId.set(B))).toEqual(['b1'])
    expect(await titles(app, {})).toEqual([])
  })

  requiresRoles()("a pooled connection's '' placeholder reads as NULL, not 22P02", async () => {
    await titles(app, orgId.set(A))
    expect(await titles(app, {})).toEqual([])
  })

  requiresRoles()('WITH CHECK refuses another tenant (42501)', async () => {
    const err = await app
      .transaction({ localSettings: orgId.set(A) }, (tx) =>
        tx.insertInto(schema.h.docs).values({ orgId: B, title: 'x' }).execute(),
      )
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InsufficientPrivilegeError)
  })

  const viaBouncer: TestDecl = BOUNCER ? requiresRoles() : it.skip
  if (!BOUNCER)
    announce('[pg] skip: PG_PRIME_TEST_PGBOUNCER_URL is unset; RLS through PgBouncer is UNVERIFIED')
  viaBouncer(
    'transaction-local settings never leak across PgBouncer server connections',
    async () => {
      const bouncer = make(BOUNCER as string)
      const asPublic = (settings: Record<string, string>) =>
        bouncer.transaction({ localSettings: settings }, async (tx) => {
          await tx.sql`set local role ${sql.ident(LOGIN)}`.execute()
          const rows = await tx
            .from(schema.h.docs)
            .select(({ docs: d }) => ({ title: d.title }))
            .execute()
          return rows.map((r) => r.title)
        })
      for (let i = 0; i < 5; i++) {
        expect(await asPublic(orgId.set(A))).toEqual(['a1'])
        expect(await asPublic({})).toEqual([])
      }
    },
  )
})
