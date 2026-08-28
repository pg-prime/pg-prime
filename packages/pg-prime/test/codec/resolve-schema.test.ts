/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  §4.6 resolveDynamic — WHICH schema's type did we just resolve?
 *
 *  §4.6 is the moat, and the moat only holds if `{ schema: 'public', name: 'mood' }` means
 *  `public.mood` and nothing else. It did not: the catalogue query filtered on `t.typname` alone
 *  and the lookup fell back to the bare name, so a request for `public.mood` in a database whose
 *  only `mood` lives in schema `a` resolved happily to `a.mood` — with `resolved === true`, an
 *  OID, and ZERO enum labels (the label query keyed off the qualified hit, which did not exist).
 *  Every row of that column then threw "not a member of enum []", three layers away from the
 *  cause and at runtime rather than at connect.
 *
 *  Two same-named types in two schemas is not exotic: it is what a per-tenant or per-test schema
 *  layout looks like, and it is exactly the shape design/08 §4.2 uses to partition test runs.
 * ══════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeHarness, type Harness } from '../live/_harness.js'
import { createRegistry, enumCodec, PgDecodeError, textCodec } from '../../src/codec/index.js'
import type { PgConnection, PgResult } from '../../src/driver/index.js'

let h: Harness
let conn: PgConnection

beforeAll(async () => {
  h = await makeHarness()
  conn = await h.driver.acquire()
  for (const sql of [
    'drop schema if exists sa cascade',
    'drop schema if exists sb cascade',
    'create schema sa',
    'create schema sb',
    // deliberately different LABELS, so the decoded value proves which schema's type won
    `create type sa.mood as enum ('x','y')`,
    `create type sb.mood as enum ('p','q')`,
    // …and no `public.mood` at all, which is the case that used to resolve to sa.mood
  ]) {
    await conn.execute({ text: sql, params: [], mode: 'simple' })
  }
})
afterAll(async () => {
  await conn?.execute({ text: 'drop schema if exists sa cascade', params: [], mode: 'simple' })
  await conn?.execute({ text: 'drop schema if exists sb cascade', params: [], mode: 'simple' })
  await h?.driver.release(conn)
  await h?.end()
})

async function setSearchPath(path: string): Promise<void> {
  await conn.execute({ text: `set search_path to ${path}`, params: [], mode: 'simple' })
}

describe('a QUALIFIED request resolves that schema, or nothing', () => {
  it('a type that does not exist in the requested schema is a hard error at connect', async () => {
    const registry = createRegistry()
    await expect(
      registry.resolveDynamic(conn, [
        { schema: 'public', name: 'mood', kind: 'enum', enumLabels: ['x', 'y'] },
      ]),
    ).rejects.toThrow(/"public\.mood" declared in the schema does not exist/)
    // and queries stay blocked rather than proceeding with a half-built codec
    expect(registry.resolved).toBe(false)
    expect(registry.byName('mood')).toBeUndefined()
  })

  it('sa.mood resolves to sa.mood — labels, OID and all', async () => {
    const registry = createRegistry()
    await registry.resolveDynamic(conn, [
      { schema: 'sa', name: 'mood', kind: 'enum', enumLabels: ['x', 'y'] },
    ])
    const mood = registry.byName('mood')!
    const ctx = { typmod: -1, registry, serverParameters: {} }

    // the labels came from THIS type: 'x' is sa's, 'p' is sb's
    expect(mood.decodeText('x', ctx)).toBe('x')
    expect(() => mood.decodeText('p', ctx)).toThrow(PgDecodeError)

    // and the OID is the one the live server reports for an sa.mood column
    const r = await conn.execute({ text: `select 'x'::sa.mood as m`, params: [] })
    expect(r.fields[0]!.dataTypeID).toBe(mood.oid)
    expect(registry.planFor(r.fields)[0]!(r.rows[0]![0]!)).toBe('x')
    // the SQL spelling stays schema-qualified so a `$1::<sqlName>` cast works off search_path
    expect(mood.sqlName).toBe('"sa"."mood"')
  })

  it('sb.mood resolves to sb.mood — the same request shape, the other answer', async () => {
    const registry = createRegistry()
    await registry.resolveDynamic(conn, [
      { schema: 'sb', name: 'mood', kind: 'enum', enumLabels: ['p', 'q'] },
    ])
    const ctx = { typmod: -1, registry, serverParameters: {} }
    expect(registry.byName('mood')!.decodeText('p', ctx)).toBe('p')
    expect(() => registry.byName('mood')!.decodeText('x', ctx)).toThrow(PgDecodeError)

    const r = await conn.execute({ text: `select 'p'::sb.mood as m`, params: [] })
    expect(r.fields[0]!.dataTypeID).toBe(registry.byName('mood')!.oid)
  })

  it('a label mismatch is still caught — against the RIGHT schema`s labels', async () => {
    const registry = createRegistry()
    // sb's labels declared for sa's type
    await expect(
      registry.resolveDynamic(conn, [
        { schema: 'sa', name: 'mood', kind: 'enum', enumLabels: ['p', 'q'] },
      ]),
    ).rejects.toThrow(/labels differ/)
  })
})

describe('an UNQUALIFIED request resolves the way PostgreSQL itself would', () => {
  it('follows search_path order, both ways round', async () => {
    await setSearchPath('sa, sb, public')
    const first = createRegistry()
    await first.resolveDynamic(conn, [{ name: 'mood', kind: 'enum' }])
    const ctxA = { typmod: -1, registry: first, serverParameters: {} }
    expect(first.byName('mood')!.decodeText('x', ctxA)).toBe('x')
    expect(() => first.byName('mood')!.decodeText('p', ctxA)).toThrow(PgDecodeError)

    await setSearchPath('sb, sa, public')
    const second = createRegistry()
    await second.resolveDynamic(conn, [{ name: 'mood', kind: 'enum' }])
    const ctxB = { typmod: -1, registry: second, serverParameters: {} }
    expect(second.byName('mood')!.decodeText('p', ctxB)).toBe('p')
    expect(() => second.byName('mood')!.decodeText('x', ctxB)).toThrow(PgDecodeError)

    // the two OIDs really are different types, i.e. the test can tell them apart
    expect(first.byName('mood')!.oid).not.toBe(second.byName('mood')!.oid)
  })

  it('a type on NO schema of the search_path is not found, even though it exists', async () => {
    await setSearchPath('public')
    const registry = createRegistry()
    await expect(registry.resolveDynamic(conn, [{ name: 'mood', kind: 'enum' }])).rejects.toThrow(
      /"mood" declared in the schema does not exist/,
    )
    await setSearchPath('sa, sb, public')
  })

  it('two VISIBLE candidates are an ambiguity error, not a coin flip', async () => {
    // `pg_type_is_visible` already applies search_path masking, so a live server cannot easily
    // produce this. The catalogue reply is therefore hand-built — the point of the assertion is
    // that the resolver never picks one of two candidates silently.
    const registry = createRegistry()
    const twoVisible = fakeCatalogue([
      ['16001', 'mood', 'sa', 'e', '16002', '0', '0', ',', 't'],
      ['16011', 'mood', 'sb', 'e', '16012', '0', '0', ',', 't'],
    ])
    await expect(
      registry.resolveDynamic(twoVisible, [{ name: 'mood', kind: 'enum' }]),
    ).rejects.toThrow(/ambiguous/)
  })
})

describe('one registry per database — the guard rails', () => {
  it('re-registering a NAME evicts the OID it used to claim', () => {
    // The two-database scenario, without needing two databases: `mood` is OID 16001 in the first
    // and 16011 in the second. The stale 16001 → mood mapping used to survive, so the moment the
    // second database reused 16001 for an unrelated type, its columns decoded through this enum.
    const registry = createRegistry()
    registry.register(enumCodec('mood', 16001, ['x', 'y']))
    expect(registry.forOid(16001)!.name).toBe('mood')

    registry.register(enumCodec('mood', 16011, ['p', 'q']), { override: true })
    expect(registry.forOid(16001)).toBeUndefined()
    expect(registry.forOid(16011)!.name).toBe('mood')
    // NEGATIVE CONTROL: an unrelated codec's OID is untouched
    expect(registry.forOid(25)!.name).toBe('text')
  })

  it('LIVE: resolving the same registry against a second schema leaves no stale OID', async () => {
    const registry = createRegistry()
    await registry.resolveDynamic(conn, [
      { schema: 'sa', name: 'mood', kind: 'enum', enumLabels: ['x', 'y'] },
    ])
    const saOid = registry.byName('mood')!.oid!
    await registry.resolveDynamic(conn, [
      { schema: 'sb', name: 'mood', kind: 'enum', enumLabels: ['p', 'q'] },
    ])
    const sbOid = registry.byName('mood')!.oid!
    expect(sbOid).not.toBe(saOid)
    expect(registry.forOid(saOid)).toBeUndefined()
    expect(registry.forOid(sbOid)!.name).toBe('mood')
    // the derived array codec is evicted with it
    expect(registry.byName('mood[]')!.oid).not.toBe(saOid)
  })

  it('clone() carries the built-ins and the registrations, and nothing pending', async () => {
    const source = createRegistry()
    source.register({ ...textCodec, name: 'my-text', oid: 99123 })
    await source.resolveDynamic(conn, [
      { schema: 'sa', name: 'mood', kind: 'enum', enumLabels: ['x', 'y'] },
    ])

    const copy = source.clone()
    expect(copy.resolved).toBe(true)
    expect(copy.forOid(25)!.name).toBe('text') // built-ins
    expect(copy.byName('text[]')).toBe(source.byName('text[]'))
    expect(copy.byName('my-text')!.oid).toBe(99123) // registrations
    expect(copy.byName('mood')!.oid).toBe(source.byName('mood')!.oid) // resolved user types

    // …and the two are independent from here on: this is the whole point of cloning per database
    copy.register(enumCodec('mood', 16999, ['z']), { override: true })
    expect(copy.byName('mood')!.oid).toBe(16999)
    expect(source.byName('mood')!.oid).not.toBe(16999)
  })

  it('a domain array codec claims the DOMAIN`s typarray, not the base type`s', async () => {
    await conn.execute({
      text: `create domain sa.pos as int4 check (value > 0)`,
      params: [],
      mode: 'simple',
    })
    const registry = createRegistry()
    await registry.resolveDynamic(conn, [{ schema: 'sa', name: 'pos', kind: 'domain' }])
    const pos = registry.byName('pos')!
    // the spread of the int4 codec used to carry int4's arrayOid (1007) onto the domain
    expect(pos.arrayOid).not.toBe(1007)
    expect(pos.arrayOid).toBe(registry.byName('pos[]')!.oid)

    const r = await conn.execute({ text: `select '{1,2}'::sa.pos[] as a`, params: [] })
    expect(r.fields[0]!.dataTypeID).toBe(pos.arrayOid)
  })
})

/**
 * A `PgConnection` that answers the catalogue query with rows we chose. Not a mock of the codec
 * under test — it stands in for PostgreSQL, and only for the one query `resolveDynamic` issues.
 */
function fakeCatalogue(rows: readonly (readonly string[])[]): PgConnection {
  const result: PgResult = {
    rows,
    fields: [],
    rowCount: rows.length,
    command: 'SELECT',
    notices: [],
  }
  return {
    execute: () => Promise.resolve(result),
    stream: () => {
      throw new Error('not used by resolveDynamic')
    },
    backendPid: undefined,
    serverParameters: {},
    transactionStatus: 'I',
    usable: true,
  }
}
