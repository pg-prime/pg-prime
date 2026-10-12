import { Controller, Get, Inject, Post, UseGuards } from '@nestjs/common'
import { requiresConcurrency } from '@pg-prime/testing'
import { defineSchema, pgPrime, setting, sql, uuidCodec } from 'pg-prime'
import type { Db } from 'pg-prime'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PgPrimeModule, TransactionHost } from '../../src/index.js'
import { rollbackScopeFor } from '../../src/testing.js'
import { Auth, serve } from '../fixture.js'

const test = requiresConcurrency(it)
const url = (): string => process.env['PG_PRIME_TEST_URL']!
const NS = `pgprime_nest_${Math.random().toString(16).slice(2, 10)}`
const ROLE = `${NS}_app`
const tenantId = setting('app.tenant_id', uuidCodec)
const tenant = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
const schema = defineSchema({})
const docs = sql.ident(NS, 'docs')

@Controller('docs')
@UseGuards(Auth)
class Docs {
  constructor(@Inject(TransactionHost) readonly host: TransactionHost) {}
  @Get()
  async titles() {
    const rows = await this.host.db.sql`select title from ${docs} order by title`.execute()
    return rows.map((r) => r['title'])
  }
  @Post()
  async add() {
    await this.host.db.sql`insert into ${docs} values (${tenantId.current()}, 'new')`.execute()
    return this.titles()
  }
}

let admin: Db
let canCreateRoles = false
let s: Awaited<ReturnType<typeof serve>>

beforeAll(async () => {
  if (!url()) return
  admin = pgPrime({ connection: url(), schema })
  const [row] =
    await admin.sql`select rolsuper or rolcreaterole as ok from pg_roles where rolname = current_user`.execute()
  canCreateRoles = (row as { ok: boolean }).ok
  if (!canCreateRoles) return
  await admin.sql`create schema ${sql.ident(NS)}`.execute()
  await admin.sql`create table ${docs} (tenant uuid, title text)`.execute()
  for (let i = 1; i <= 10; i++)
    await admin.sql`insert into ${docs} values (${tenant(i)}::uuid, ${`t${i}`})`.execute()
  await admin.sql`create role ${sql.ident(ROLE)} login password 'pgprime'`.execute()
  await admin.sql`grant usage on schema ${sql.ident(NS)} to ${sql.ident(ROLE)}`.execute()
  await admin.sql`grant select, insert on ${docs} to ${sql.ident(ROLE)}`.execute()
  await admin.sql`alter table ${docs} enable row level security`.execute()
  await admin.sql`create policy tenant on ${docs} using (tenant = ${tenantId.current()})
    with check (tenant = ${tenantId.current()})`.execute()
  const u = new URL(url())
  u.username = ROLE
  u.password = 'pgprime'
  s = await serve({
    imports: [
      PgPrimeModule.forRoot({
        config: { connection: u.toString(), schema, poolOptions: { max: 5 }, devGuard: true },
        request: {
          settings: (ctx) => {
            const t = ctx.switchToHttp().getRequest().auth?.tenant as string | undefined
            return t ? tenantId.set(t) : undefined
          },
        },
      }),
    ],
    controllers: [Docs],
  })
}, 120_000)

afterAll(async () => {
  if (!admin) return
  await s?.app.close()
  if (canCreateRoles) {
    await admin.sql`drop schema if exists ${sql.ident(NS)} cascade`.execute()
    await admin.sql`drop role if exists ${sql.ident(ROLE)}`.execute()
  }
  await admin.end()
})

describe('RLS through the request scope', () => {
  const rls = (name: string, fn: () => Promise<void>) =>
    test(name, async () => {
      if (!canCreateRoles)
        return void process.stderr.write(`[pg] skip: ${name} — cannot CREATE ROLE\n`)
      await fn()
    })

  rls('20 concurrent requests of different tenants each see only their rows', async () => {
    const seen = await Promise.all(
      Array.from({ length: 20 }, (_, i) => s.get('/docs', tenant((i % 10) + 1))),
    )
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => [`t${(i % 10) + 1}`]))
    expect(await s.get('/docs')).toEqual([])
  })

  rls('rollbackScopeFor: a pinned write is visible to its tenant only, then gone', async () => {
    const scope = await rollbackScopeFor(s.app)
    try {
      expect(await s.call('/docs', tenant(1), 'POST')).toEqual({ status: 201, body: ['new', 't1'] })
      expect(await s.get('/docs', tenant(2))).toEqual(['t2'])
    } finally {
      await scope.rollback()
    }
    expect(await s.get('/docs', tenant(1))).toEqual(['t1'])
  })
})
