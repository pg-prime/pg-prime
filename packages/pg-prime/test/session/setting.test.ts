import { describe, expect, it } from 'vitest'
import { byteaCodec, int4Codec, textCodec, uuidCodec } from '../../src/codec/index.js'
import { UsageError } from '../../src/errors/index.js'
import { compileOnly, definePolicy, eq, pgTable, setting } from '../../src/index.js'
import { setConfigParams } from '../../src/session/transaction.js'
import { schema } from '../query/_schema.js'

const ID = '6f1c2a3b-0000-4000-8000-000000000001'

describe('setting()', () => {
  it('set() returns the encoded record setLocal takes', () => {
    const org = setting('app.org_id', uuidCodec)
    expect(org.name).toBe('app.org_id')
    expect(org.codec).toBe(uuidCodec)
    expect(org.set(ID.toUpperCase())).toEqual({ 'app.org_id': ID })
    expect(setting('app.n', int4Codec).set(7)).toEqual({ 'app.n': '7' })
    expect(setting('app.user').codec).toBe(textCodec)
  })

  it('current() renders the same SQL in a query and in a policy, with no bind and no unsafeRaw', () => {
    const org = setting('app.org_id', uuidCodec)
    expect(org.current()).toBe(org.current())
    const db = compileOnly(schema)
    const c = db
      .from(schema.h.users)
      .select(() => ({ org: org.current() }))
      .compile()
    expect(c.sql).toBe(
      `select nullif(current_setting('app.org_id', true), '')::uuid as "org"\nfrom "public"."users" as "users"`,
    )
    expect(c.binds).toEqual([])
    expect(c.meta.usedUnsafeRaw).toBe(false)

    const docs = pgTable('docs', (t) => ({ orgId: t.uuid() }))
    const p = definePolicy('t', { on: docs, using: (t) => eq(t.orgId, org.current()) })
    expect(p.$.ddl(() => 'public')).toContain(
      `USING ("docs"."org_id" = (nullif(current_setting('app.org_id', true), '')::uuid))`,
    )
  })

  it.each(['app.a.b', 'app.$x', '', '1app', "app.x'y"])('refuses %j like setLocal does', (name) => {
    expect(() => setting(name)).toThrow(UsageError)
    expect(() => setConfigParams({ [name]: 'v' })).toThrow(UsageError)
  })

  it('refuses a codec that encodes to bytes', () => {
    expect(() => setting('app.blob', byteaCodec).set(new Uint8Array([1]))).toThrow(UsageError)
  })
})
