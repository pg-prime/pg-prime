import { createMockPool } from '@pg-prime/testing'
import type { MockStep } from '@pg-prime/testing'
import { HandleMisuseError, defineSchema, pgPrime } from 'pg-prime'
import type { Tx } from 'pg-prime'
import { expect, it } from 'vitest'
import { ContextError, TransactionHost } from '../../src/index.js'
import { rollbackScope } from '../../src/testing.js'

const SNAPSHOT = JSON.stringify({ statement_timeout: '30s', 'app.tenant_id': null })
const answer: MockStep = (q) =>
  q.text.includes('jsonb_object_agg') ? { rows: [[SNAPSHOT]], fields: ['s'] } : { rows: [] }

async function pinned() {
  const pool = createMockPool({ script: Array.from({ length: 50 }, () => answer) })
  const db = pgPrime({ pool, schema: defineSchema({}), devGuard: true })
  const host = new TransactionHost(db)
  const scope = await rollbackScope(host)
  return { pool, db, host, scope }
}

it('a root transaction becomes a savepoint that captures and restores settings', async () => {
  const { pool, host, scope } = await pinned()
  expect(host.pinned).toBe(true)
  await host.run({ settings: { 'app.tenant_id': 't1' } }, () =>
    host.transaction(
      async (tx) => {
        expect(tx.depth).toBe(1)
        expect(host.tx()).toBe(tx)
      },
      { isolation: 'serializable', timeoutMs: 50 },
    ),
  )
  await scope.rollback()
  expect(host.pinned).toBe(false)
  const q = pool.queries
  expect(q.every((x) => x.client === 0)).toBe(true)
  expect(q.map((x) => x.text.slice(0, 24))).toEqual([
    'begin',
    'select set_config($1,$2,',
    'select jsonb_object_agg(',
    'savepoint "pgprime_sp_1"',
    'select set_config($1,$2,',
    'select count(set_config(',
    'release savepoint "pgpri',
    'rollback',
  ])
  expect(q[2]!.values).toEqual([JSON.stringify(['app.tenant_id'])])
  expect(q[4]!.values).toEqual(['app.tenant_id', 't1', 'statement_timeout', '50'])
  expect(JSON.parse(q[5]!.values[0] as string)).toEqual(JSON.parse(SNAPSHOT))
})

it('read only ends with ROLLBACK TO instead of a restore', async () => {
  const { pool, host, scope } = await pinned()
  expect(await host.transaction(async () => 'v', { accessMode: 'read only' })).toBe('v')
  await scope.rollback()
  expect(pool.texts.slice(3, -1)).toEqual([
    'savepoint "pgprime_sp_1"',
    'select set_config($1,$2,true)',
    'rollback to savepoint "pgprime_sp_1"',
    'release savepoint "pgprime_sp_1"',
  ])
  expect(pool.queries[4]!.values).toEqual(['transaction_read_only', 'on'])
})

it('a request without a transaction runs on its savepoint as the base; strict still fires', async () => {
  const { host, scope } = await pinned()
  let base: unknown
  await host.request({}, async () => {
    base = host.db
    expect(host.inTransaction).toBe(false)
  })
  expect((base as Tx).depth).toBe(1)
  await host.request({ settings: { 'app.tenant_id': 't1' } }, async () => {
    expect(() => host.db).toThrow(ContextError)
    await host.transaction(async (tx) => expect(tx.depth).toBe(2))
  })
  expect(host.db).toBe(scope.tx)
  await scope.rollback()
})

it('one request at a time, and a captured root Db throws inside one', async () => {
  const { db, host, scope } = await pinned()
  const tick = () => new Promise((r) => setTimeout(r, 1))
  const r = await Promise.allSettled([host.request({}, tick), host.request({}, tick)])
  expect(r[1]).toMatchObject({
    status: 'rejected',
    reason: { code: 'CONTEXT_CONCURRENT_SAVEPOINT' },
  })
  expect((r[1] as PromiseRejectedResult).reason.message).toContain('pinned')
  await host.request({}, async () => {
    await expect(db.sql`select 1`.execute()).rejects.toBeInstanceOf(HandleMisuseError)
  })
  await scope.rollback()
})
