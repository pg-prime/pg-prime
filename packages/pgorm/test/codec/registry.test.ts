/**
 * The codec registry — design/02 §4.3 (the hot-path decode plan) and §4.6 (user-defined types,
 * "the part no general driver can do").
 *
 * §4.6 is the moat: Prisma collapses every OID ≥ 16384 to `Text` because it must span four
 * databases. Being PG-only we resolve them against the live catalogue, once per physical
 * database, by NAME — user-type OIDs are not stable across dev/prod/shadow, so they are never
 * baked into generated code.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeHarness, type Harness } from '../live/_harness.js'
import { createRegistry, enumCodec, PgDecodeError, textCodec } from '../../src/codec/index.js'
import type { AnyCodec } from '../../src/codec/index.js'
import type { PgConnection } from '../../src/driver/index.js'

let h: Harness
let conn: PgConnection

beforeAll(async () => {
  h = await makeHarness()
  conn = await h.driver.acquire()
  await conn.execute({ text: 'drop type if exists pgorm_mood cascade', params: [], mode: 'simple' })
  await conn.execute({ text: 'drop domain if exists pgorm_pos cascade', params: [], mode: 'simple' })
  await conn.execute({
    text: `create type pgorm_mood as enum ('sad','ok','happy')`,
    params: [],
    mode: 'simple',
  })
  await conn.execute({
    text: `create domain pgorm_pos as int4 check (value > 0)`,
    params: [],
    mode: 'simple',
  })
})
afterAll(async () => {
  await conn?.execute({ text: 'drop type if exists pgorm_mood cascade', params: [], mode: 'simple' })
  await conn?.execute({
    text: 'drop domain if exists pgorm_pos cascade',
    params: [],
    mode: 'simple',
  })
  await h?.driver.release(conn)
  await h?.end()
})

describe('planFor — the hot path', () => {
  it('builds ONE closure per column, from the RowDescription, never per row', async () => {
    const registry = createRegistry()
    const r = await conn.execute({
      text: `select g::int4 as a, g::int8 as b, g::text as c from generate_series(1,3) g`,
      params: [],
    })
    const plan = registry.planFor(r.fields)
    expect(plan).toHaveLength(3)
    expect(r.rows.map((row) => row.map((v, i) => plan[i]!(v)))).toEqual([
      [1, 1n, '1'],
      [2, 2n, '2'],
      [3, 3n, '3'],
    ])
  })

  it('short-circuits SQL NULL before the codec sees it', async () => {
    const registry = createRegistry()
    const r = await conn.execute({
      text: `select null::int8, null::text, 1::int8`,
      params: [],
    })
    // pg's array row mode writes null directly without consulting a parser (§5.6), which is why
    // `Codec.decodeText` can be non-nullable in its signature.
    expect(r.rows[0]).toEqual([null, null, '1'])
    const plan = registry.planFor(r.fields)
    expect(r.rows[0]!.map((v, i) => plan[i]!(v))).toEqual([null, null, 1n])
  })

  it('an UNREGISTERED OID passes the raw text through rather than guessing', async () => {
    const registry = createRegistry()
    // `point` (OID 600) has no codec: §4.5's geometric family is still unimplemented. (This used
    // to be `interval`, which the WS-audit registered — see the `interval` cases in r5-golden.)
    const r = await conn.execute({ text: `select '(1,2)'::point as p`, params: [] })
    expect(r.fields[0]!.dataTypeID).toBe(600)
    expect(registry.forOid(600)).toBeUndefined()
    expect(registry.planFor(r.fields)[0]!(r.rows[0]![0]!)).toBe('(1,2)')
  })

  it('the unknown-OID hook names the column, once per RowDescription and not per row', async () => {
    const registry = createRegistry()
    const seen: { oid: number; column: string }[] = []
    registry.onUnknownOid((info) => seen.push(info))
    const r = await conn.execute({
      text: `select '(1,2)'::point as p, 1::int4 as known from generate_series(1,3)`,
      params: [],
    })
    expect(r.rows).toHaveLength(3)
    const plan = registry.planFor(r.fields)
    for (const row of r.rows) row.map((v, i) => plan[i]!(v))
    // one entry: the point column, named — NOT three, and not the int4 column
    expect(seen).toEqual([{ oid: 600, column: 'p' }])

    registry.onUnknownOid(undefined)
    registry.planFor(r.fields)
    expect(seen).toHaveLength(1)
  })

  it('binds typmod per column, so two numerics in one row get their own context', async () => {
    const registry = createRegistry()
    const r = await conn.execute({
      text: `select 1.10::numeric(10,2) as a, 1.100::numeric(12,3) as b`,
      params: [],
    })
    expect(r.fields.map((f) => f.dataTypeModifier)).toEqual([655366, 786439])
    expect(r.rows[0]!.map((v, i) => registry.planFor(r.fields)[i]!(v))).toEqual(['1.10', '1.100'])
  })
})

describe('register / byName / jsonCastFor', () => {
  it('throws on an OID collision unless { override: true }', () => {
    const registry = createRegistry()
    const impostor: AnyCodec = { ...textCodec, name: 'my-text' } as unknown as AnyCodec
    expect(() => registry.register(impostor)).toThrow(/already claimed by codec 'text'/)
    registry.register(impostor, { override: true })
    expect(registry.forOid(25)!.name).toBe('my-text')
    expect(registry.byName('text')!.name).toBe('text') // the original stays addressable by name
  })

  it('re-registering the SAME codec name is idempotent', () => {
    const registry = createRegistry()
    expect(() => registry.register(registry.byName('text')!)).not.toThrow()
  })

  it('jsonCastFor is the compiler-facing form of Codec.jsonEncode (R5)', () => {
    const registry = createRegistry()
    expect(registry.jsonCastFor(registry.byName('int8')!)).toBe('::text')
    expect(registry.jsonCastFor(registry.byName('numeric')!)).toBe('::text')
    expect(registry.jsonCastFor(registry.byName('int8[]')!)).toBe('::text')
    expect(registry.jsonCastFor(registry.byName('text')!)).toBe('')
    expect(registry.jsonCastFor(registry.byName('timestamptz')!)).toBe('')
  })

  it('every shipped codec has a decodeJson — R5 makes it REQUIRED, not optional', () => {
    const registry = createRegistry()
    for (const name of ['int8', 'numeric', 'date', 'timestamptz', 'jsonb', 'bytea', 'text[]']) {
      expect(typeof registry.byName(name)!.decodeJson).toBe('function')
    }
  })
})

describe('§4.6 resolveDynamic — user-defined types, resolved by NAME against the catalogue', () => {
  it('resolves an enum and a domain, and derives their array codecs for free', async () => {
    const registry = createRegistry()
    expect(registry.resolved).toBe(true)
    await registry.resolveDynamic(conn, [
      { name: 'pgorm_mood', kind: 'enum', enumLabels: ['sad', 'ok', 'happy'] },
      { name: 'pgorm_pos', kind: 'domain' },
    ])
    expect(registry.resolved).toBe(true)

    const mood = registry.byName('pgorm_mood')!
    expect(mood.typeClass).toBe('enum')
    expect(mood.oid).toBeGreaterThan(16384) // a user OID — never baked into generated code
    expect(registry.byName('pgorm_mood[]')).toBeDefined()

    // the OID the live server reports for the column is the one we resolved
    const r = await conn.execute({
      text: `select 'happy'::pgorm_mood as m, array['sad','ok']::pgorm_mood[] as ms`,
      params: [],
    })
    expect(r.fields[0]!.dataTypeID).toBe(mood.oid)
    const plan = registry.planFor(r.fields)
    expect(plan[0]!(r.rows[0]![0]!)).toBe('happy')
    expect(plan[1]!(r.rows[0]![1]!)).toEqual(['sad', 'ok'])
  })

  it('a domain delegates to its base type and widens paramOid to `unknown` (705)', async () => {
    const registry = createRegistry()
    await registry.resolveDynamic(conn, [{ name: 'pgorm_pos', kind: 'domain' }])
    const pos = registry.byName('pgorm_pos')!
    expect(pos.paramOid).toBe(705) // so PG applies the domain's OWN cast and CHECK
    expect(pos.typeClass).toBe('number') // delegates to int4

    const r = await conn.execute({
      text: 'select $1::pgorm_pos as p',
      params: ['5'],
      paramTypes: [705],
    })
    // ⚠️ MEASURED, and not in design/02 §4.6: PostgreSQL reports a SCALAR domain in the
    // RowDescription as its BASE type OID (23), never as the domain's own OID. So `forOid`
    // never sees a scalar domain — and does not need to, because the base codec produces the
    // identical value. The domain codec earns its keep on the PARAMETER side (paramOid 705)
    // and in the schema DSL.
    expect(r.fields[0]!.dataTypeID).toBe(23)
    expect(r.fields[0]!.dataTypeID).not.toBe(pos.oid)
    expect(registry.planFor(r.fields)[0]!(r.rows[0]![0]!)).toBe(5)

    // the domain's CHECK really is enforced server-side — that is what widening buys
    await expect(
      conn.execute({ text: 'select $1::pgorm_pos', params: ['-1'], paramTypes: [705] }),
    ).rejects.toMatchObject({ pgorm: { server: { sqlstate: '23514' } } })
  })

  it('a domain ARRAY column IS reported under its own user OID — so the derived array codec is load-bearing', async () => {
    const registry = createRegistry()
    await registry.resolveDynamic(conn, [{ name: 'pgorm_pos', kind: 'domain' }])
    const arr = registry.byName('pgorm_pos[]')!
    expect(arr.oid).toBeGreaterThan(16384)

    await conn.execute({
      text: 'create temp table dom_arr_t (a pgorm_pos, b pgorm_pos[])',
      params: [],
    })
    await conn.execute({ text: `insert into dom_arr_t values (1, '{1,2}')`, params: [] })
    const r = await conn.execute({ text: 'select a, b from dom_arr_t', params: [] })
    expect(r.fields[0]!.dataTypeID).toBe(23) // scalar domain → base OID
    expect(r.fields[1]!.dataTypeID).toBe(arr.oid) // domain array → user OID
    const plan = registry.planFor(r.fields)
    expect(plan[0]!(r.rows[0]![0]!)).toBe(1)
    expect(plan[1]!(r.rows[0]![1]!)).toEqual([1, 2])

    // without resolveDynamic that array OID is unknown and would fall back to raw text
    expect(createRegistry().forOid(arr.oid!)).toBeUndefined()
  })

  it('a label mismatch is a HARD ERROR at connect, not a runtime surprise', async () => {
    const registry = createRegistry()
    await expect(
      registry.resolveDynamic(conn, [
        { name: 'pgorm_mood', kind: 'enum', enumLabels: ['sad', 'happy', 'ok'] }, // wrong ORDER
      ]),
    ).rejects.toThrow(/labels differ/)
    expect(registry.resolved).toBe(false) // queries stay blocked
  })

  it('a kind mismatch against pg_type.typtype is a hard error too', async () => {
    const registry = createRegistry()
    await expect(
      registry.resolveDynamic(conn, [{ name: 'pgorm_mood', kind: 'domain' }]),
    ).rejects.toThrow(/typtype is 'e'/)
  })

  it('a missing type names itself in the error', async () => {
    const registry = createRegistry()
    await expect(
      registry.resolveDynamic(conn, [{ name: 'pgorm_nope', kind: 'enum' }]),
    ).rejects.toThrow(/"pgorm_nope" declared in the schema does not exist/)
  })
})

describe('enumCodec — decode is identity plus a membership assert', () => {
  it('accepts members and rejects everything else at both depths', () => {
    const registry = createRegistry()
    const c = enumCodec('mood', 99999, ['sad', 'ok', 'happy'])
    const ctx = { typmod: -1, registry, serverParameters: {} }
    expect(c.decodeText('happy', ctx)).toBe('happy')
    expect(c.decodeJson('happy', ctx)).toBe('happy')
    expect(() => c.decodeText('elated', ctx)).toThrow(PgDecodeError)
    expect(() => c.decodeJson('elated', ctx)).toThrow(/not a member of enum mood/)
  })
})
