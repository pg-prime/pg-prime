import { requiresConcurrency } from '@pg-prime/testing'
import {
  HandleMisuseError,
  PoolTimeoutError,
  defineSchema,
  pgPrime,
  setting,
  sql,
  uuidCodec,
} from 'pg-prime'
import type { Db, DbConfig, Queryable } from 'pg-prime'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ContextError, TransactionHost } from '../../src/index.js'
import { rollbackScope } from '../../src/testing.js'

const test = requiresConcurrency(it)
const url = (): string => process.env['PG_PRIME_TEST_URL']!
const BOUNCER = process.env['PG_PRIME_TEST_PGBOUNCER_URL']
const NS = `pgprime_ctx_${Math.random().toString(16).slice(2, 10)}`
const ROLE = `${NS}_app`
const tenantId = setting('app.tenant_id', uuidCodec)
const tenant = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
const schema = defineSchema({})

const open: Db[] = []
const connect = (u: string, extra: Partial<DbConfig<typeof schema>> = {}): Db => {
  const db = pgPrime({ connection: u, schema, devGuard: true, ...extra })
  open.push(db)
  return db
}
let admin: Db
let app: Db
let canCreateRoles = false
const docs = sql.ident(NS, 'docs')
const settingOf = async (q: Queryable<any>) =>
  (await q.sql`select current_setting('app.tenant_id', true) as v`.executeTakeFirst())!['v']
const titles = async (q: Queryable<any>) =>
  (await q.sql`select title from ${docs} order by title`.execute()).map((r) => r['title'] as string)

beforeAll(async () => {
  if (!url()) return
  admin = connect(url())
  const [row] =
    await admin.sql`select rolsuper or rolcreaterole as ok from pg_roles where rolname = current_user`.execute()
  canCreateRoles = (row as { ok: boolean }).ok
  await admin.sql`create schema ${sql.ident(NS)}`.execute()
  await admin.sql`create table ${docs} (tenant uuid, title text unique)`.execute()
  for (let i = 1; i <= 10; i++)
    await admin.sql`insert into ${docs} values (${tenant(i)}::uuid, ${`t${i}`})`.execute()
  if (!canCreateRoles) return
  await admin.sql`create role ${sql.ident(ROLE)} login password 'pgprime'`.execute()
  await admin.sql`grant usage on schema ${sql.ident(NS)} to ${sql.ident(ROLE)}`.execute()
  await admin.sql`grant select, insert on ${docs} to ${sql.ident(ROLE)}`.execute()
  await admin.sql`alter table ${docs} enable row level security`.execute()
  await admin.sql`create policy tenant on ${docs} using (tenant = ${tenantId.current()})
    with check (tenant = ${tenantId.current()})`.execute()
  const u = new URL(url())
  u.username = ROLE
  u.password = 'pgprime'
  app = connect(u.toString(), { poolOptions: { max: 5 } })
}, 120_000)

afterAll(async () => {
  for (const db of open.slice(1)) await db.end().catch(() => {})
  if (!admin) return
  await admin.sql`drop schema if exists ${sql.ident(NS)} cascade`.execute()
  if (canCreateRoles) await admin.sql`drop role if exists ${sql.ident(ROLE)}`.execute()
  await admin.end()
})

/** Every pooled connection at once, so each reports its own leftover setting. */
async function everyConnection(db: Db, n: number): Promise<unknown[]> {
  let arrived = 0
  let go!: () => void
  const all = new Promise<void>((r) => (go = r))
  return Promise.all(
    Array.from({ length: n }, () =>
      db.session(async (s) => {
        if (++arrived === n) go()
        await all
        return settingOf(s)
      }),
    ),
  )
}

describe('RLS', () => {
  const rls = (name: string, fn: () => Promise<void>) =>
    test(name, async () => {
      if (!canCreateRoles)
        return void process.stderr.write(`[pg] skip: ${name} — cannot CREATE ROLE\n`)
      await fn()
    })

  rls(
    'a scoped host transaction sees only its tenant; strict throws on an unscoped read',
    async () => {
      const host = new TransactionHost(app)
      expect(
        await host.run({ settings: tenantId.set(tenant(3)) }, () =>
          host.transaction(() => titles(host.db)),
        ),
      ).toEqual(['t3'])
      expect(() => host.run({ settings: tenantId.set(tenant(3)) }, () => host.db)).toThrow(
        ContextError,
      )
      expect(await titles(app)).toEqual([])
    },
  )

  rls('within(tx) sees only the scope tenant', async () => {
    const host = new TransactionHost(app)
    const seen = await host.run({ settings: tenantId.set(tenant(4)) }, () =>
      app.transaction((tx) => host.within(tx, () => titles(host.db))),
    )
    expect(seen).toEqual(['t4'])
  })

  rls(
    'no leak: 50 concurrent scopes on max 5, then every pooled connection reads empty',
    async () => {
      const host = new TransactionHost(app)
      const seen = await Promise.all(
        Array.from({ length: 50 }, (_, i) => {
          const t = (i % 10) + 1
          return host.run({ settings: tenantId.set(tenant(t)) }, () =>
            host.transaction(async () => [await titles(host.db), await settingOf(host.db), t]),
          )
        }),
      )
      for (const [rows, s, t] of seen) expect([rows, s]).toEqual([[`t${t}`], tenant(t as number)])
      for (const v of await everyConnection(app, 5)) expect(v).toBeOneOf([null, ''])
    },
  )

  rls('the pin: requests of two tenants are isolated, and a captured root throws', async () => {
    const host = new TransactionHost(app)
    const scope = await rollbackScope(host)
    try {
      await host.request({ settings: tenantId.set(tenant(1)), transaction: true }, async () => {
        await host.db.sql`insert into ${docs} values (${tenant(1)}::uuid, 'pinned')`.execute()
        expect(await titles(host.db)).toEqual(['pinned', 't1'])
        await expect(app.sql`select 1`.execute()).rejects.toBeInstanceOf(HandleMisuseError)
      })
      await host.request({ settings: tenantId.set(tenant(2)), transaction: true }, async () => {
        expect(await titles(host.db)).toEqual(['t2'])
      })
    } finally {
      await scope.rollback()
    }
    expect(await titles(admin)).not.toContain('pinned')
  })
})

describe('transactions', () => {
  test('three savepoint levels: inner failures are caught, the outer commits the rest', async () => {
    const host = new TransactionHost(admin, { propagation: 'savepoint' })
    const ins = (t: string) => host.db.sql`insert into ${docs} values (null, ${t})`.execute()
    await host.transaction(async () => {
      await ins('sp0')
      await host.transaction(async () => {
        await ins('sp1')
        await host.transaction(async () => {
          await ins('sp2')
          await expect(host.transaction(() => ins('sp0'))).rejects.toThrow()
        })
        await expect(host.transaction(() => ins('sp1'))).rejects.toThrow()
      })
    })
    expect((await titles(admin)).filter((t) => t.startsWith('sp'))).toEqual(['sp0', 'sp1', 'sp2'])
  })

  test('40001: the loser re-runs with its settings on attempt 2', async () => {
    const host = new TransactionHost(connect(url(), { poolOptions: { max: 2 } }))
    let arrived = 0
    let go!: () => void
    const both = new Promise<void>((r) => (go = r))
    const attempts: [string, number, unknown][] = []
    const writer = (name: string, t: number) =>
      host.run({ settings: tenantId.set(tenant(t)) }, () =>
        host.transaction(
          async () => {
            attempts.push([name, host.attempt, await settingOf(host.db)])
            await host.db.sql`select count(*) from ${docs} where title like 'ser%'`.execute()
            if (host.attempt === 1 && ++arrived === 2) go()
            if (host.attempt === 1) await both
            await host.db
              .sql`insert into ${docs} values (null, ${`ser-${name}-${host.attempt}`})`.execute()
          },
          { isolation: 'serializable', retry: { baseDelayMs: 1 } },
        ),
      )
    await Promise.all([writer('a', 1), writer('b', 2)])
    const retried = attempts.filter(([, a]) => a === 2)
    expect(retried).toHaveLength(1)
    const [name] = retried[0]!
    expect(retried[0]![2]).toBe(tenant(name === 'a' ? 1 : 2))
  })

  test('new commits when the outer rolls back; on max 1 it times out instead of hanging', async () => {
    const host = new TransactionHost(admin)
    await host.transaction(async () => {
      await host.transaction(
        () => host.db.sql`insert into ${docs} values (null, 'new')`.execute(),
        { propagation: 'new' },
      )
      host.tx().rollbackWith(undefined)
    })
    expect(await titles(admin)).toContain('new')
    const one = new TransactionHost(
      connect(url(), { poolOptions: { max: 1, connectionTimeoutMillis: 300 } }),
    )
    const nested = one.transaction(() => one.transaction(async () => {}, { propagation: 'new' }))
    await expect(nested).rejects.toBeInstanceOf(PoolTimeoutError)
  })
})

const bouncer = BOUNCER === undefined || BOUNCER === '' ? it.skip : it
if (bouncer === it.skip)
  process.stderr.write(
    '[pg] skip: PG_PRIME_TEST_PGBOUNCER_URL is unset; the PgBouncer leak case is UNVERIFIED.\n',
  )

bouncer('no leak through PgBouncer transaction mode', async () => {
  const db = connect(BOUNCER!, { poolOptions: { max: 5 }, poolerMode: 'pgbouncer-transaction' })
  const host = new TransactionHost(db)
  const seen = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      host.run({ settings: tenantId.set(tenant(i)) }, () =>
        host.transaction(() => settingOf(host.db)),
      ),
    ),
  )
  expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => tenant(i)))
  for (let i = 0; i < 10; i++) expect(await settingOf(db)).toBeOneOf([null, ''])
})
