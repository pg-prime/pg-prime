import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMockPool } from '@pg-prime/testing'
import type { MockPool, MockStep } from '@pg-prime/testing'
import { HandleMisuseError, defineSchema, pgPrime } from 'pg-prime'
import type { Tx } from 'pg-prime'
import { describe, expect, it, vi } from 'vitest'
import { ContextError, TransactionHost } from '../../src/index.js'
import type { AsyncStorage, TransactionHostOptions } from '../../src/index.js'

const schema = defineSchema({})
function setup(opts?: TransactionHostOptions, script: MockStep[] = []) {
  const pool = createMockPool({ script })
  const db = pgPrime({ pool, schema, devGuard: true })
  return { pool, db, host: new TransactionHost(db, opts) }
}
const sent = (pool: MockPool) => pool.queries.map((q) => [q.client, q.text, ...q.values])
const code = (p: Promise<unknown> | (() => unknown)) =>
  (typeof p === 'function' ? Promise.resolve().then(p) : p).then(
    () => 'resolved',
    (e: unknown) => (e instanceof ContextError ? e.code : e),
  )
const tick = () => new Promise((r) => setTimeout(r, 1))

describe('propagation', () => {
  it('a root transaction sends scope and explicit settings in one batch, explicit winning', async () => {
    const { pool, host } = setup()
    await host.run({ settings: { 'app.tenant_id': 't1', 'app.role': 'a' } }, () =>
      host.transaction(async () => {}, { localSettings: { 'app.role': 'b' } }),
    )
    expect(sent(pool)).toEqual([
      [0, 'begin'],
      [
        0,
        'select set_config($1,$2,true), set_config($3,$4,true)',
        'app.tenant_id',
        't1',
        'app.role',
        'b',
      ],
      [0, 'commit'],
    ])
  })

  it('savepoint nests on the active transaction; new opens a second connection', async () => {
    const { pool, host } = setup()
    await host.transaction(async () => {
      await host.transaction(async () => {}, { propagation: 'savepoint' })
      await host.transaction(async () => {}, { propagation: 'new' })
    })
    expect(sent(pool)).toEqual([
      [0, 'begin'],
      [0, 'savepoint "pgprime_sp_1"'],
      [0, 'release savepoint "pgprime_sp_1"'],
      [1, 'begin'],
      [1, 'commit'],
      [0, 'commit'],
    ])
  })

  it('the host default applies and a call overrides it', async () => {
    const { pool, host } = setup({ propagation: 'savepoint' })
    await host.transaction(async () => {
      await host.transaction(async () => {})
      await host.transaction(async () => {}, { propagation: 'join' })
    })
    expect(pool.texts).toEqual([
      'begin',
      'savepoint "pgprime_sp_1"',
      'release savepoint "pgprime_sp_1"',
      'commit',
    ])
  })

  it('three nested savepoints pass', async () => {
    const { pool, host } = setup({ propagation: 'savepoint' })
    await host.transaction(() =>
      host.transaction(() => host.transaction(() => host.transaction(async () => host.tx().depth))),
    )
    expect(pool.texts.filter((t) => t.startsWith('savepoint'))).toEqual([
      'savepoint "pgprime_sp_1"',
      'savepoint "pgprime_sp_2"',
      'savepoint "pgprime_sp_3"',
    ])
  })
})

describe('join', () => {
  it('hands the callback and host.tx() the real outer Tx', async () => {
    const { pool, host } = setup()
    await host.transaction(async (outer) => {
      await host.transaction(
        async (inner) => {
          expect(inner).toBe(outer)
          expect(host.tx()).toBe(outer)
        },
        { retry: { maxAttempts: 9 } },
      )
    })
    expect(pool.texts).toEqual(['begin', 'commit'])
  })

  it('refuses options that would change the transaction', async () => {
    const { host } = setup()
    await host.transaction(async () => {
      expect(await code(host.transaction(async () => {}, { isolation: 'serializable' }))).toBe(
        'CONTEXT_OPTIONS',
      )
      expect(await code(host.transaction(async () => {}, { accessMode: 'read only' }))).toBe(
        'CONTEXT_OPTIONS',
      )
      for (const o of [
        { timeoutMs: 5 },
        { lockTimeoutMs: 5 },
        { localSettings: { 'app.x': '1' } },
      ]) {
        expect(await code(host.transaction(async () => {}, o))).toBe('CONTEXT_OPTIONS')
      }
      expect(await code(host.transaction(async () => {}, { isolation: 'read committed' }))).toBe(
        'resolved',
      )
    })
  })

  it('refuses a different deferrable', async () => {
    const { host } = setup()
    const ro = { isolation: 'serializable', accessMode: 'read only' } as const
    const join = (o: object) => code(host.transaction(async () => {}, o))
    await host.transaction(async () => {
      expect(await join({ ...ro, deferrable: true })).toBe('CONTEXT_OPTIONS')
      expect(await join({ ...ro, deferrable: false })).toBe('resolved')
    }, ro)
    await host.transaction(
      async () => {
        expect(await join({ ...ro, deferrable: false })).toBe('CONTEXT_OPTIONS')
        expect([await join({ ...ro, deferrable: true }), await join({})]).toEqual([
          'resolved',
          'resolved',
        ])
      },
      { ...ro, deferrable: true },
    )
  })

  it('rollbackWith inside a join ends the outer transaction with that value', async () => {
    const { pool, host } = setup()
    const v = await host.transaction(async () => {
      await host.transaction(async () => host.tx().rollbackWith('v'))
      return 'never'
    })
    expect(v).toBe('v')
    expect(pool.texts).toEqual(['begin', 'rollback'])
  })
})

describe('savepoint', () => {
  it('refuses TxOptions-only keys', async () => {
    const { host } = setup()
    await host.transaction(async () => {
      for (const o of [{ isolation: 'serializable' as const }, { retry: false }]) {
        expect(
          await code(host.transaction(async () => {}, { ...o, propagation: 'savepoint' })),
        ).toBe('CONTEXT_OPTIONS')
      }
    })
  })

  it('refuses a second in-flight savepoint on one Tx, also across scopes within it', async () => {
    const { host, db } = setup({ propagation: 'savepoint' })
    await host.transaction(async () => {
      const r = await Promise.allSettled([host.transaction(tick), host.transaction(tick)])
      expect(r.map((x) => x.status)).toEqual(['fulfilled', 'rejected'])
    })
    await db.transaction(async (tx) => {
      const scoped = (t: string) =>
        host.run({ settings: { 'app.tenant_id': t } }, () =>
          host.within(tx, () => host.transaction(tick)),
        )
      expect(await Promise.all([code(scoped('a')), code(scoped('b'))])).toEqual([
        'resolved',
        'CONTEXT_CONCURRENT_SAVEPOINT',
      ])
    })
  })

  it('puts back what its localSettings and timeouts set, before RELEASE', async () => {
    const before = { 'app.role': 'user', statement_timeout: '0' }
    const step: MockStep = (q) =>
      q.text.includes('jsonb_object_agg')
        ? { rows: [[JSON.stringify(before)]], fields: ['s'] }
        : { rows: [] }
    const { pool, host } = setup(
      {},
      Array.from({ length: 10 }, () => step),
    )
    await host.transaction(() =>
      host.transaction(async () => {}, {
        propagation: 'savepoint',
        localSettings: { 'app.role': 'admin' },
        timeoutMs: 50,
      }),
    )
    expect(pool.texts.map((t) => t.slice(0, 24))).toEqual([
      'begin',
      'select jsonb_object_agg(',
      'savepoint "pgprime_sp_1"',
      'select set_config($1,$2,',
      'select count(set_config(',
      'release savepoint "pgpri',
      'commit',
    ])
    expect(pool.queries[1]!.values).toContain(JSON.stringify(['app.role', 'statement_timeout']))
    expect(JSON.parse(pool.queries[4]!.values[0] as string)).toEqual(before)
  })
})

describe('retry', () => {
  it('40001 on COMMIT re-runs fn on a new handle with the settings re-sent', async () => {
    let commits = 0
    const step: MockStep = (q) =>
      q.text === 'commit' && commits++ === 0 ? { code: '40001' } : { rows: [] }
    const { pool, host } = setup(
      {},
      Array.from({ length: 10 }, () => step),
    )
    const seen: [Tx, number][] = []
    await host.run({ settings: { 'app.tenant_id': 't1' } }, () =>
      host.transaction(async () => void seen.push([host.tx(), host.attempt]), {
        isolation: 'serializable',
        retry: { baseDelayMs: 0 },
      }),
    )
    expect(seen.map(([, a]) => a)).toEqual([1, 2])
    expect(seen[0]![0]).not.toBe(seen[1]![0])
    expect(
      pool.queries.filter((q) => q.text.startsWith('select set_config')).map((q) => q.values),
    ).toEqual([
      ['app.tenant_id', 't1'],
      ['app.tenant_id', 't1'],
    ])
  })

  it('a retry starts from the settings it re-sends, not what the failed attempt set', async () => {
    let commits = 0
    const step: MockStep = (q) =>
      q.text === 'commit' && commits++ === 0 ? { code: '40001' } : { rows: [] }
    const { host } = setup(
      {},
      Array.from({ length: 10 }, () => step),
    )
    const seen: unknown[] = []
    await host.run({ settings: { 'app.tenant_id': 't1' } }, async () => {
      await host.transaction(
        async () => {
          seen.push({ ...host.settings })
          await host.setLocal({ 'app.tenant_id': 't2', 'app.user_id': 'u' })
        },
        { isolation: 'serializable', retry: { baseDelayMs: 0 } },
      )
      seen.push({ ...host.settings })
    })
    expect(seen).toEqual([
      { 'app.tenant_id': 't1' },
      { 'app.tenant_id': 't1' },
      { 'app.tenant_id': 't2', 'app.user_id': 'u' },
    ])
  })

  it('never retries a ContextError', async () => {
    const { host } = setup()
    let runs = 0
    const p = host.transaction(
      async () => {
        runs++
        host.run({}, () => {})
      },
      { isolation: 'serializable' },
    )
    expect(await code(p)).toBe('CONTEXT_NESTED_SCOPE')
    expect(runs).toBe(1)
  })
})

describe('api', () => {
  it('strict throws for db in a scope with settings and no transaction; off, it is the root', async () => {
    const { host, db } = setup()
    expect(await code(() => host.run({ settings: { 'app.x': '1' } }, () => host.db))).toBe(
      'CONTEXT_UNSCOPED_QUERY',
    )
    expect(host.run({}, () => host.db)).toBe(db)
    expect(host.run({ settings: { 'app.x': '1' } }, () => host.outside())).toBeDefined()
    const lax = new TransactionHost(db, { strict: false })
    expect(lax.run({ settings: { 'app.x': '1' } }, () => lax.current())).toBe(db)
  })

  it('tx(), inTransaction, attempt and settings', async () => {
    const { host } = setup()
    expect(await code(() => host.tx())).toBe('CONTEXT_NO_TRANSACTION')
    expect([host.inTransaction, host.attempt, host.settings]).toEqual([false, 0, {}])
    await host.run({ settings: { 'app.x': '1' } }, () =>
      host.transaction(async (tx) => {
        expect([host.inTransaction, host.attempt, host.settings, host.db]).toEqual([
          true,
          1,
          { 'app.x': '1' },
          tx,
        ])
      }),
    )
  })

  it('setLocal: one batch in a tx, recorded in a scope, refused in neither', async () => {
    const { pool, host } = setup()
    expect(await code(host.setLocal('app.x', 1))).toBe('CONTEXT_NO_SCOPE')
    await host.run({}, async () => {
      await host.setLocal({ 'app.x': '1' })
      await host.transaction(async () => {
        await host.setLocal('app.y', true)
      })
      expect(host.settings).toEqual({ 'app.x': '1', 'app.y': true })
    })
    expect(sent(pool)).toEqual([
      [0, 'begin'],
      [0, 'select set_config($1,$2,true)', 'app.x', '1'],
      [0, 'select set_config($1,$2,true)', 'app.y', 'true'],
      [0, 'commit'],
    ])
  })

  it('run inherits the parent scope and is refused in a transaction', async () => {
    const { host } = setup()
    host.run({ settings: { 'app.a': 1 } }, () =>
      host.run({ settings: { 'app.b': 2 } }, () =>
        expect(host.settings).toEqual({ 'app.a': 1, 'app.b': 2 }),
      ),
    )
    expect(await code(host.transaction(async () => host.run({}, () => 0)))).toBe(
      'CONTEXT_NESTED_SCOPE',
    )
  })

  it('within sends the scope settings before fn, and nothing without them', async () => {
    const { pool, host, db } = setup()
    await db.transaction(async (tx) => {
      await host.within(tx, async () => expect(host.tx()).toBe(tx))
      await host.run({ settings: { 'app.x': '1' } }, () =>
        host.within(tx, () => tx.sql`select 1`.execute()),
      )
    })
    expect(pool.texts).toEqual(['begin', 'select set_config($1,$2,true)', 'select 1', 'commit'])
  })

  it('interleaved scopes never see each other', async () => {
    const { host } = setup()
    const seen = await Promise.all(
      ['a', 'b', 'c'].map((t) =>
        host.run({ settings: { 'app.t': t } }, () =>
          host.transaction(async (tx) => {
            await tick()
            await host.transaction(async () => {}, { propagation: 'new' })
            return [host.settings['app.t'], host.tx() === tx]
          }),
        ),
      ),
    )
    expect(seen).toEqual([
      ['a', true],
      ['b', true],
      ['c', true],
    ])
  })
})

describe('guard', () => {
  it('host.db, outside() and new pass; a captured root throws', async () => {
    const { host, db } = setup()
    await host.transaction(async () => {
      await host.db.sql`select 1`.execute()
      await host.outside().sql`select 1`.execute()
      await host.transaction(async () => host.db.sql`select 1`.execute(), { propagation: 'new' })
      await expect(db.sql`select 1`.execute()).rejects.toBeInstanceOf(HandleMisuseError)
    })
  })
})

describe('cost and graph', () => {
  it('with no scope, db reads the store once; storage is pluggable', () => {
    const storage: AsyncStorage<unknown> = {
      getStore: vi.fn(() => undefined),
      run: vi.fn((_s, fn) => fn()),
    }
    const { db } = setup()
    const host = new TransactionHost(db, { storage })
    expect(host.db).toBe(db)
    expect(storage.getStore).toHaveBeenCalledTimes(1)
    host.run({}, () => {})
    expect(storage.run).toHaveBeenCalledTimes(1)
  })

  it('src imports only node:async_hooks and pg-prime', () => {
    const dir = join(import.meta.dirname, '../../src')
    const specs = readdirSync(dir).flatMap((f) =>
      [...readFileSync(join(dir, f), 'utf8').matchAll(/from '([^.][^']*)'/g)].map((m) => m[1]),
    )
    expect(new Set(specs)).toEqual(new Set(['node:async_hooks', 'pg-prime']))
  })
})
