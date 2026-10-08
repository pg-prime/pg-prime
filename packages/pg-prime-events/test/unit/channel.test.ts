import { describe, expect, it } from 'vitest'
import { UsageError, compileOnly, defineSchema, sql } from 'pg-prime'
import { channelHandle } from '../../src/channel.js'
import { PayloadError, defineChannel, engineChannel, engineChannelSql } from '../../src/index.js'
import type { StandardSchemaV1 } from '../../src/index.js'
import { fakeDb } from './_fake.js'

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('engine channels', () => {
  it('are ev_ + 24 hex chars of sha256(schema/kind/name)', () => {
    expect(engineChannel('pgprime_events', 't', 'orders')).toBe('ev_db4a47e9f6ea4daad7acd74f')
    expect(engineChannel('s1', 't', 'x')).not.toBe(engineChannel('s2', 't', 'x'))
    expect(engineChannel('s', 'q', 'x')).not.toBe(engineChannel('s', 't', 'x'))
  })

  it('the SQL twin binds the prefix and splices the name', () => {
    const q = compileOnly(defineSchema({}))
    const snap = q.sql`select ${engineChannelSql('pgprime_mq', 'q', sql`m.queue`)}`.toSQL()
    expect(snap.sql).toBe(
      "select ('ev_' || left(encode(sha256(convert_to($1::text || (m.queue)::text, 'UTF8')), 'hex'), 24))",
    )
    expect(snap.params).toStrictEqual(['pgprime_mq/q/'])
  })
})

describe('defineChannel', () => {
  it('takes the literal name, 1–63 bytes', () => {
    expect(defineChannel('cache-bust').name).toBe('cache-bust')
    expect(() => defineChannel('')).toThrow(UsageError)
    expect(() => defineChannel('x'.repeat(64))).toThrow(UsageError)
    expect(() => defineChannel('é'.repeat(32))).toThrow(UsageError)
  })
})

describe('channel handles', () => {
  const schema: StandardSchemaV1<unknown, { id: number }> = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (v) =>
        typeof (v as { id?: unknown }).id === 'number'
          ? { value: v as { id: number } }
          : { issues: [{ message: 'id must be a number', path: ['id'] }] },
    },
  }
  const ping = defineChannel('ping', { schema })

  it('notify encodes, validates and sends through db.notify or tx.notify', async () => {
    const f = fakeDb()
    const h = channelHandle(f.db, ping)
    await h.notify({ id: 1 })
    const tx = fakeDb()
    await h.notify({ id: 2 }, { tx: tx.db })
    expect(f.notified).toStrictEqual([['ping', '{"id":1}']])
    expect(tx.notified).toStrictEqual([['ping', '{"id":2}']])
    await expect(h.notify({ id: 'x' } as never)).rejects.toBeInstanceOf(PayloadError)
  })

  it('listen decodes valid payloads; invalid ones go to error, not the handler', async () => {
    const f = fakeDb()
    const got: number[] = []
    const errors: unknown[] = []
    const gaps: number[] = []
    const sub = await channelHandle(f.db, ping).listen((p) => void got.push(p.id), {
      onGap: (e) => void gaps.push(e.downMs),
    })
    sub.on('error', (e) => void errors.push(e))
    f.deliver('ping', '{"id":7}')
    f.deliver('ping', '{"id":"no"}')
    f.deliver('ping', 'not json')
    f.error('ping', new Error('hub'))
    f.gap('ping')
    await tick()
    expect(got).toStrictEqual([7])
    expect(errors.map((e) => (e as Error).constructor.name)).toStrictEqual([
      'SyntaxError',
      'Error',
      'PayloadError',
    ])
    expect(gaps).toStrictEqual([5])
    await sub.close()
    expect(f.closed()).toBe(1)
  })
})
