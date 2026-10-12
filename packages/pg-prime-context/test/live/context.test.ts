import { startPglite } from '@pg-prime/testing'
import type { PgliteServer } from '@pg-prime/testing'
import {
  HandleMisuseError,
  UniqueViolationError,
  defineSchema,
  pgPrime,
  setting,
  uuidCodec,
} from 'pg-prime'
import type { Db, Queryable } from 'pg-prime'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ContextError, TransactionHost } from '../../src/index.js'
import { rollbackScope } from '../../src/testing.js'
import type { RollbackScope } from '../../src/testing.js'

const tenantId = setting('app.tenant_id', uuidCodec)
const T1 = '00000000-0000-4000-8000-000000000001'
const T2 = '00000000-0000-4000-8000-000000000002'

let server: PgliteServer
let db: Db
let host: TransactionHost
beforeAll(async () => {
  server = await startPglite()
  db = pgPrime({
    connection: server.url,
    schema: defineSchema({}),
    poolOptions: { max: 1 },
    devGuard: true,
  })
  host = new TransactionHost(db)
  await db.sql`create table ctx_rows (id int primary key, tenant uuid)`.execute()
})
afterAll(async () => {
  await db.end()
  await server.stop()
})

const read = async (q: Queryable<any>, name: string) =>
  (await q.sql`select current_setting(${name}, true) as v`.executeTakeFirst())!['v']
const rows = async () =>
  (await db.sql`select id from ctx_rows order by id`.execute()).map((r) => r['id'])

describe('settings', () => {
  it('apply inside a host transaction and are gone on the same connection after commit', async () => {
    const inside = await host.run({ settings: tenantId.set(T1) }, () =>
      host.transaction(() => read(host.db, 'app.tenant_id')),
    )
    expect(inside).toBe(T1)
    expect(await read(db, 'app.tenant_id')).toBe('')
  })

  it('a caught savepoint failure leaves the outer transaction usable', async () => {
    await host.transaction(async () => {
      await host.db.sql`insert into ctx_rows values (1, null)`.execute()
      const dup = host.transaction(
        () => host.db.sql`insert into ctx_rows values (1, null)`.execute(),
        {
          propagation: 'savepoint',
        },
      )
      await expect(dup).rejects.toBeInstanceOf(UniqueViolationError)
      await host.db.sql`insert into ctx_rows values (2, null)`.execute()
      host.tx().rollbackWith(undefined)
    })
    expect(await rows()).toEqual([])
  })

  it('within(tx) makes a typed key visible to fn', async () => {
    const seen = await host.run({ settings: tenantId.set(T2) }, () =>
      db.transaction((tx) =>
        host.within(
          tx,
          async () =>
            (await host.db.sql`select ${tenantId.current()} as t`.executeTakeFirst())!['t'],
        ),
      ),
    )
    expect(seen).toBe(T2)
  })
})

describe('rollbackScope', () => {
  let scope: RollbackScope
  beforeEach(async () => {
    scope = await rollbackScope(host)
    return () => scope.rollback()
  })
  const request = (settings: Record<string, string>, fn: () => Promise<unknown>) =>
    host.request({ settings, transaction: true }, fn)

  for (const n of [1, 2]) {
    it(`test ${n} sees none of the other's writes or settings`, async () => {
      expect(await read(host.db, 'app.tenant_id')).toBeOneOf([null, ''])
      expect(await host.db.sql`select count(*)::int as n from ctx_rows`.executeTakeFirst()).toEqual(
        { n: 0 },
      )
      await request(tenantId.set(n === 1 ? T1 : T2), () =>
        host.db.sql`insert into ctx_rows values (${n}, null)`.execute(),
      )
    })
  }

  it('two tenants in sequence: request 2 never sees request 1', async () => {
    await request(tenantId.set(T1), async () => {
      await host.setLocal('app.user_id', 'u1')
      expect(await read(host.db, 'app.tenant_id')).toBe(T1)
    })
    await request(tenantId.set(T2), async () => {
      expect(await read(host.db, 'app.tenant_id')).toBe(T2)
      expect(await read(host.db, 'app.user_id')).toBe('')
    })
    await request({}, async () => expect(await read(host.db, 'app.tenant_id')).toBe(''))
  })

  it('restores built-ins to their captured values, never to empty', async () => {
    await scope.tx.setLocal('statement_timeout', '30s')
    const path = await read(scope.tx, 'search_path')
    await host.transaction(
      async (tx) => {
        expect(await read(tx, 'statement_timeout')).toBe('5s')
        await tx.setLocal({ lock_timeout: '7s', search_path: 'pg_catalog' })
      },
      { timeoutMs: 5000 },
    )
    expect(await read(scope.tx, 'statement_timeout')).toBe('30s')
    expect(await read(scope.tx, 'lock_timeout')).toBe('0')
    expect(await read(scope.tx, 'search_path')).toBe(path)
  })

  it('read only ends with ROLLBACK TO and the next request writes', async () => {
    const ro = host.transaction(
      () => host.db.sql`insert into ctx_rows values (9, null)`.execute(),
      {
        accessMode: 'read only',
      },
    )
    await expect(ro).rejects.toMatchObject({ code: expect.anything() })
    await host.transaction(() => host.db.sql`insert into ctx_rows values (9, null)`.execute(), {
      isolation: 'serializable',
    })
    expect(await host.db.sql`select id from ctx_rows`.execute()).toEqual([{ id: 9 }])
  })

  it('a failed request rolls back only its savepoint; rollbackWith is caught', async () => {
    await request({}, () => host.db.sql`insert into ctx_rows values (1, null)`.execute())
    await expect(
      request({}, () => host.db.sql`insert into ctx_rows values (1, null)`.execute()),
    ).rejects.toBeInstanceOf(UniqueViolationError)
    expect(await request({}, async () => host.tx().rollbackWith('kept'))).toBe('kept')
    expect(await host.db.sql`select id from ctx_rows`.execute()).toEqual([{ id: 1 }])
  })

  it('keeps the dev guard and strict mode', async () => {
    await request({}, async () => {
      await expect(db.sql`select 1`.execute()).rejects.toBeInstanceOf(HandleMisuseError)
    })
    await host.request({ settings: tenantId.set(T1) }, async () => {
      expect(() => host.db).toThrow(ContextError)
    })
  })
})
