/**
 * The codec seam, tier 0 (design/09 WS2).
 *
 * `metaOf` is the one place a `pgTable(...)` column becomes a compiler `ColumnMeta` carrying a real
 * `Codec`. Everything here is checkable without a database; the half that needs PostgreSQL as the
 * oracle — "the codec's OID is the OID the server actually reports" — is
 * `test/live-query/codec-seam.test.ts`.
 *
 * The exhaustive-builder test (R4-adjacent) is the load-bearing one: it enumerates the DSL surface
 * from `kit` itself rather than from a hand-written list, so adding a column builder without a
 * codec fails here instead of at someone's first query.
 */

import { describe, expect, it } from 'vitest'
import { Registry, arrayCodecOf, int4Codec, int8Codec, textCodec } from '../../src/codec/index.js'
import { metaOf, codecFor } from '../../src/query/meta.js'
import { kit, pgEnum, pgTable } from '../../src/schema/index.js'
import type { AnyCol } from '../../src/schema/column.js'
import { NoCodecError } from '../../src/sql/errors.js'

const mood = pgEnum('mood', ['happy', 'sad'])

const users = pgTable('users', (t) => ({
  id: t.bigint().primaryKey(),
  email: t.text(),
  age: t.integer().nullable(),
  tags: t.text().array(),
  grid: t.integer().array().array(),
  feeling: t.enum(mood),
}))

describe('metaOf — identity and caching', () => {
  it('is idempotent: the same table and registry give back the same object', () => {
    const r = new Registry()
    expect(metaOf(users, r)).toBe(metaOf(users, r))
  })

  it('two registries are two memos — a codec is never shared across databases', () => {
    // 02 §4.6: user-type OIDs are not stable across dev / prod / shadow, so a `TableMeta` is only
    // ever valid for the registry it was resolved against.
    expect(metaOf(users, new Registry())).not.toBe(metaOf(users, new Registry()))
  })

  it('a registration invalidates the memo', () => {
    // Without this, a `TableMeta` built before `resolveDynamic` would keep an enum codec whose
    // `oid` is undefined forever, and `assertShape` would compare a live dataTypeID against
    // nothing. The generation counter is what makes the memo safe.
    const r = new Registry()
    const before = metaOf(users, r)
    r.register({ ...textCodec, name: 'citext', oid: 90001 })
    expect(metaOf(users, r)).not.toBe(before)
  })
})

describe('metaOf — the mapping', () => {
  it('carries table identity from TableRuntime, defaulting the schema to public', () => {
    const m = metaOf(users, new Registry())
    expect(m.table).toMatchObject({ schema: 'public', name: 'users', qualified: '"public"."users"' })
  })

  it('resolves the DB name through the casing strategy, not the TS key', () => {
    const t = pgTable('t', (c) => ({ createdAt: c.timestamptz(), explicitName: c.text('weird_col') }))
    const m = metaOf(t, new Registry())
    expect(m.byKey['createdAt']?.name).toBe('created_at')
    expect(m.byKey['explicitName']?.name).toBe('weird_col')
  })

  it('columns are in declaration order and parallel to keys', () => {
    const m = metaOf(users, new Registry())
    expect(m.keys).toEqual(['id', 'email', 'age', 'tags', 'grid', 'feeling'])
    expect(m.columns.map((c) => c.name)).toEqual(['id', 'email', 'age', 'tags', 'grid', 'feeling'])
    expect(m.byKey['email']).toBe(m.columns[1])
  })

  it('scalar columns resolve to the built-in codec of their declared type', () => {
    const m = metaOf(users, new Registry())
    expect(m.byKey['id']?.codec.name).toBe('int8')
    expect(m.byKey['id']?.codec.oid).toBe(int8Codec.oid)
    expect(m.byKey['email']?.codec.name).toBe('text')
    expect(m.byKey['age']?.codec.name).toBe('int4')
  })

  it('nullability is not a codec concern — a nullable column keeps the same codec', () => {
    // `null` is short-circuited by the decoder before a codec ever sees it, so `t.integer()` and
    // `t.integer().nullable()` MUST resolve to the identical object. If they ever diverge, the
    // registry has grown a null-aware wrapper and the hot path has grown a branch.
    const t = pgTable('t', (c) => ({ a: c.integer(), b: c.integer().nullable() }))
    const m = metaOf(t, new Registry())
    expect(m.byKey['a']?.codec).toBe(m.byKey['b']?.codec)
    expect(m.byKey['a']?.codec).toBe(int4Codec)
  })

  it('`.array()` resolves to the element codec wrapped once', () => {
    const m = metaOf(users, new Registry())
    const tags = m.byKey['tags']?.codec
    expect(tags?.name).toBe('text[]')
    expect(tags?.oid).toBe(1009)
    expect(tags?.arrayOf?.name).toBe('text')
  })

  /**
   * The decision (design/09 WS2 asked for one): `arrayDim >= 2` resolves to the SAME one-dimensional
   * array codec, it does not throw and it does not nest.
   *
   * PostgreSQL has no distinct multi-dimensional array type. `int4[]` and `int4[][]` are both
   * OID 1007; dimensionality is a property of the *value*, which is why `arrayCodec.decodeText`
   * already walks nested literals and `writeArrayLiteral` already emits them. Wrapping twice would
   * invent a type the server does not have — and `codec-seam.test.ts` proves the choice against a
   * live `RowDescription`, which reports 1007 for a `integer[][]` column.
   */
  it('`.array().array()` resolves to the same 1-D array codec (PG has no 2-D array type)', () => {
    const r = new Registry()
    const m = metaOf(users, r)
    const oneD = pgTable('t', (c) => ({ g: c.integer().array() }))
    expect(m.byKey['grid']?.codec.name).toBe('int4[]')
    expect(m.byKey['grid']?.codec.oid).toBe(1007)
    // ...and it is the *same* codec a single `.array()` resolves to, not a lookalike.
    expect(m.byKey['grid']?.codec).toBe(metaOf(oneD, r).byKey['g']?.codec)
  })

  it('identifiers are pre-quoted here and nowhere else (03 §7)', () => {
    const weird = pgTable('na.me', (t) => ({ 'a"b': t.text() }), undefined, { schema: 'weird' })
    const m = metaOf(weird, new Registry())
    expect(m.table.qualified).toBe('"weird"."na.me"')
    expect(m.columns[0]?.quoted).toBe('"a""b"')
  })
})

describe('metaOf — enums', () => {
  it('before resolveDynamic: a pending codec that decodes but claims no OID', () => {
    // 02 §4.6 — a user type's OID is not stable across databases and is never baked in. Until
    // `resolveDynamic` has read THIS database's pg_enum we know the labels but not the OID.
    const registry = new Registry()
    const ctx = { typmod: -1, registry, serverParameters: {} }
    const c = metaOf(users, registry).byKey['feeling']?.codec
    expect(c?.name).toBe('mood')
    expect(c?.oid).toBeUndefined()
    // `sqlName` is what a `::type` cast is spelled from, so it has to be the SAME text the
    // registry produces after `resolveDynamic` (`sqlNameOf`: quoted and schema-qualified).
    // The bare `mood` differed from `"public"."mood"` — one statement, two spellings, depending
    // on whether the registry had met the database yet — and 42704s off `search_path`.
    expect(c?.sqlName).toBe('"public"."mood"')
    expect(c?.decodeText('happy', ctx)).toBe('happy')
    expect(() => c?.decodeText('furious', ctx)).toThrow(/not a member of enum mood/)
  })

  it('after the enum is registered: the registry codec, with its OID', () => {
    const r = new Registry()
    r.register({ ...textCodec, name: 'mood', oid: 99001, sqlName: 'mood', typeClass: 'enum' })
    expect(metaOf(users, r).byKey['feeling']?.codec.oid).toBe(99001)
  })

  it('an enum array asks the registry for `mood[]`', () => {
    const t = pgTable('t', (c) => ({ moods: c.enum(mood).array() }))
    const r = new Registry()
    const element = { ...textCodec, name: 'mood', oid: 99001, sqlName: 'mood', typeClass: 'enum' as const }
    r.register(element)
    r.register({ ...arrayCodecOf(element), name: 'mood[]', oid: 99002 })
    expect(metaOf(t, r).byKey['moods']?.codec.oid).toBe(99002)
  })
})

describe('codecFor — failing loudly, at seam time', () => {
  it('a column whose type has no codec throws NoCodecError, naming table, column and type', () => {
    const r = new Registry()
    const ddl = {
      pgType: 'hstore',
      dbName: undefined,
      notNull: true,
      default: undefined,
      identity: undefined,
      primaryKey: false,
      unique: false,
      uniqueSpec: undefined,
      enumName: undefined,
      enumValues: undefined,
      enumSchema: undefined,
      arrayDim: 0,
      references: undefined,
      checks: [],
      comment: undefined,
      renamedFrom: undefined,
    }
    expect(() => codecFor(ddl, r, 'settings', 'prefs')).toThrow(NoCodecError)
    expect(() => codecFor(ddl, r, 'settings', 'prefs')).toThrow(
      /"settings"\."prefs" is declared as PostgreSQL type 'hstore'/,
    )
  })

  /**
   * The exhaustive gate. Enumerated from `kit` itself, so a new builder with no codec fails HERE
   * rather than at a user's first query — which is the whole point of resolving at seam time.
   */
  it('EVERY builder the DSL ships resolves to a codec', () => {
    const r = new Registry()
    const names = Object.keys(kit) as (keyof typeof kit)[]
    expect(names.length).toBeGreaterThan(0)

    const built: Record<string, AnyCol> = {}
    for (const n of names) {
      const col = n === 'enum' ? kit.enum(mood) : (kit[n] as () => AnyCol)()
      built[n] = col
      built[`${n}_arr`] = (col as unknown as { array(): AnyCol }).array()
    }
    const t = pgTable('every_builder', built)
    const m = metaOf(t, r)

    const unresolved = m.keys.filter((k) => m.byKey[k]?.codec === undefined)
    expect(unresolved).toEqual([])
    // Every non-enum builder resolves against the built-ins; the enum is the documented pending
    // case, so it is the only one allowed to have no OID before `resolveDynamic`.
    const oidless = m.keys.filter((k) => m.byKey[k]?.codec.oid === undefined)
    expect(oidless).toEqual(['enum', 'enum_arr'])
  })
})
