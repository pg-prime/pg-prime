import { UsageError } from 'pg-prime'
import { describe, expect, it } from 'vitest'
import { channelOf, errorText, hooksOf } from '../../src/context.js'
import { defineOutbox, migrationSql } from '../../src/index.js'

describe('defineOutbox', () => {
  it('applies the defaults', () => {
    expect(defineOutbox('orders')).toStrictEqual({
      topic: 'orders',
      partitions: 16,
      ordered: true,
      keepDeliveredMs: 86_400_000,
      schema: undefined,
      codec: undefined,
    })
  })

  it.each([
    ['', {}],
    ['t', { partitions: 0 }],
    ['t', { partitions: 1025 }],
    ['t', { partitions: 1.5 }],
    ['t', { keepDeliveredMs: -1 }],
  ])('refuses %j %j', (topic, opts) => {
    expect(() => defineOutbox(topic, opts)).toThrow(UsageError)
  })
})

describe('helpers', () => {
  it('channel names are short, stable and per schema', () => {
    const c = channelOf('pgprime_outbox', 'a'.repeat(200))
    expect(c).toMatch(/^ob_[0-9a-f]{24}$/)
    expect(channelOf('pgprime_outbox', 'a'.repeat(200))).toBe(c)
    expect(channelOf('other', 'a'.repeat(200))).not.toBe(c)
  })

  it('error text is the message, capped', () => {
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText(42)).toBe('42')
    expect(errorText('x'.repeat(5000)).length).toBe(2000)
  })

  it('a throwing hook is reported as hook-failed, and a throwing onInternal is swallowed', () => {
    const internal: string[] = []
    const hooks = hooksOf({
      onWrite: () => {
        throw new Error('hook bug')
      },
      onInternal: (e) => {
        internal.push(e.kind)
        throw new Error('worse')
      },
    })
    expect(() => hooks.call('onWrite', { topic: 't', count: 1, duplicates: 0 })).not.toThrow()
    expect(internal).toStrictEqual(['hook-failed'])
    expect(() =>
      hooksOf(undefined).call('onPark', { topic: 't', id: 1n, key: null, error: 0 }),
    ).not.toThrow()
  })

  it('migrationSql renders the vendorable files for a custom schema', () => {
    const [v1] = migrationSql({ schema: 'my_outbox' })
    expect(v1!.version).toBe(1)
    expect(v1!.sql).toContain('create table "my_outbox".records')
    expect(v1!.sql).toContain('insert into "my_outbox".migrations')
  })
})
