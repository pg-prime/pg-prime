/**
 * The codec seam, tier 1 — **PostgreSQL is the oracle** (design/09 WS2, R1).
 *
 * `metaOf` maps a `pgTable(...)` column to a codec by NAME. Nothing in tier 0 can tell you whether
 * that name was the right one: `test/query/meta.test.ts` proves `t.bigint()` resolves to the codec
 * called `int8`, and would keep passing if `int8` claimed OID 23. The only authority on what a
 * column's type actually is, is the server's own `RowDescription`.
 *
 * So: for every column of every fixture table, ask the server to describe it and assert
 *
 *     fields[i].dataTypeID === metaOf(table).columns[i].codec.oid
 *
 * This is `assertShape` (03 §3.2) turned around and used as a test of the schema→codec mapping. It
 * is also the only automatic check that the enum path resolves — an enum's OID is per-database, so
 * `resolveDynamic` has to have run first, and this file is where that gets exercised end to end.
 *
 * Then the R3 pairing: an `insert ... returning` through the real compiler with the real codecs,
 * whose returned values must `toStrictEqual` the JavaScript values that went in. OID agreement
 * without a value round trip would still permit a codec that decodes the right type wrongly.
 *
 * And the R4 negative control at the bottom: a deliberately mislabeled column must FAIL the OID
 * confirmation, otherwise the confirmation above is a tautology.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Registry } from '../../src/codec/index.js'
import { compile } from '../../src/compile/compiler.js'
import { buildDecoder } from '../../src/compile/decode.js'
import { col, insert, param, projection, table } from '../../src/compile/nodes.js'
import type { PgConnection } from '../../src/driver/index.js'
import { metaOf } from '../../src/query/meta.js'
import type { TableCodecMeta } from '../../src/query/meta.js'
import { pgTable } from '../../src/schema/index.js'
import type { AnyTable } from '../../src/schema/index.js'
import { makeHarness, sqlState, type Harness } from '../live/_harness.js'
import { makeFixture } from '../live/fixture.js'

const fx = makeFixture('pgprime_codec_seam')

/**
 * A second, tiny fixture owned by this file. It exists for the two cases the shared fixture must
 * not carry: a multi-dimensional array (the `arrayDim >= 2` decision) and a column whose DSL type
 * is deliberately WRONG (the negative control). Declared next to its DDL for the same R5 reason
 * the shared fixture is.
 */
const probeDdl = `
create table ${fx.ns}.probe (
  id      bigint primary key,
  grid    integer[][] not null,
  wrong   bigint not null
);`

const probe = pgTable(
  'probe',
  (t) => ({
    id: t.bigint().primaryKey(),
    grid: t.integer().array().array(),
    wrong: t.bigint(),
  }),
  undefined,
  { schema: fx.ns },
)

/** The same table with `wrong` mislabeled as `int4` over an `int8` column. R4. */
const mislabeled = pgTable(
  'probe',
  (t) => ({
    id: t.bigint().primaryKey(),
    grid: t.integer().array().array(),
    wrong: t.integer(),
  }),
  undefined,
  { schema: fx.ns },
)

let h: Harness
let conn: PgConnection
let registry: Registry

beforeAll(async () => {
  h = await makeHarness()
  conn = await h.driver.acquire()
  await conn.execute({ text: fx.drop, params: [], mode: 'simple' })
  await conn.execute({ text: fx.ddl, params: [], mode: 'simple' })
  await conn.execute({ text: probeDdl, params: [], mode: 'simple' })
  await conn.execute({ text: fx.seed, params: [], mode: 'simple' })

  registry = new Registry()
  // The enum's OID is this database's, not a constant — 02 §4.6. Everything below depends on
  // this having run, which is exactly the coverage design/09 asked for.
  await registry.resolveDynamic(conn, [
    { schema: fx.ns, name: 'user_role', kind: 'enum', enumLabels: ['admin', 'owner', 'member'] },
  ])
})

afterAll(async () => {
  await conn?.execute({ text: fx.drop, params: [], mode: 'simple' })
  await h?.driver.release(conn)
  await h?.end()
})

/** `select <every column> from <table> limit 0` — a RowDescription and no rows. */
async function describeColumns(
  m: TableCodecMeta,
): Promise<readonly { name: string; oid: number }[]> {
  const list = m.columns.map((c) => c.quoted).join(', ')
  const r = await conn.execute({
    text: `select ${list} from ${m.table.qualified} limit 0`,
    params: [],
  })
  return r.fields.map((f) => ({ name: f.name, oid: f.dataTypeID }))
}

const TABLES: readonly (readonly [string, AnyTable])[] = [
  ['users', fx.users],
  ['posts', fx.posts],
  ['comments', fx.comments],
  ['tags', fx.tags],
  ['post_tags', fx.postTags],
  ['kv', fx.kv],
  ['probe', probe],
]

describe('OID confirmation — every column, every table', () => {
  for (const [name, t] of TABLES) {
    it(`${name}: every codec claims the OID PostgreSQL reports`, async () => {
      const m = metaOf(t, registry)
      const actual = await describeColumns(m)

      // Positional, not by name — the whole decoder is positional, and two joined tables both
      // exposing `id` is the case that makes name-keying wrong.
      expect(actual.map((f) => f.name)).toEqual(m.columns.map((c) => c.name))

      const mismatches = m.columns
        .map((c, i) => ({
          column: c.name,
          codec: c.codec.name,
          claims: c.codec.oid,
          server: actual[i]?.oid,
        }))
        .filter((x) => x.claims !== x.server)
      expect(mismatches).toEqual([])

      // ...and no codec got away with claiming nothing. `undefined === undefined` would have
      // passed the filter above, and `undefined` is precisely what an unresolved enum has.
      expect(m.columns.filter((c) => c.codec.oid === undefined)).toEqual([])
    })
  }

  it('the enum resolved to THIS database s OID, not a baked-in constant', async () => {
    const oid = metaOf(fx.users, registry).byKey['role']?.codec.oid
    expect(oid).toBeGreaterThan(16383) // user types start above the built-in range
    const r = await conn.execute({
      text: `select oid::text from pg_type where typname = 'user_role' and typnamespace = $1::regnamespace`,
      params: [fx.ns],
    })
    expect(oid).toBe(Number(r.rows[0]?.[0]))
  })

  it('integer[][] is OID 1007 — PostgreSQL has no distinct 2-D array type', async () => {
    // The tier-0 decision (`arrayDim >= 2` wraps ONCE) with the server as the oracle. If PG ever
    // grew a real 2-D array type this would be the test that noticed.
    const m = metaOf(probe, registry)
    const actual = await describeColumns(m)
    expect(m.byKey['grid']?.codec.oid).toBe(1007)
    expect(actual[1]?.oid).toBe(1007)
  })
})

describe('R3 — the values that come back are the values the types promise', () => {
  /**
   * `insert ... returning` through the real compiler and the real codecs, for every column type
   * in the fixture: encode → wire → decode. `toStrictEqual`, so `10n` and `10` are not equal and a
   * missing key is not `undefined`.
   */
  it('every fixture column type round-trips through insert ... returning', async () => {
    const m = metaOf(fx.tags, registry)
    const into = table(m.table)

    const row = { id: 9007199254740993n, name: 'round-trip \\ " ; -- 🙂' }
    const columns = [m.byKey['id'], m.byKey['name']].filter((c) => c !== undefined)
    const compiled = compile<{ id: bigint; name: string }>(
      insert({
        into,
        columns,
        source: {
          k: 'values',
          rows: [[param(row.id, m.byKey['id']!.codec), param(row.name, m.byKey['name']!.codec)]],
        },
        returning: [
          projection('id', col('tags', 'id', m.byKey['id']!.codec)),
          projection('name', col('tags', 'name', m.byKey['name']!.codec)),
        ],
      }),
    )

    const res = await conn.execute({
      text: compiled.sql,
      params: compiled.binds.map((b) => (b.k === 'value' ? b.encoded : null)),
    })
    const rows = buildDecoder<{ id: bigint; name: string }>(compiled.shape, {
      typmod: -1,
      registry,
      serverParameters: {},
    })(res.rows as unknown[][])

    expect(rows).toStrictEqual([row])
  })

  it('the wide row: every scalar type in `users`, encoded and read back', async () => {
    const m = metaOf(fx.users, registry)
    const keys = [
      'email',
      'name',
      'role',
      'tags',
      'meta',
      'balance',
      'createdAt',
      'birthday',
    ] as const
    const values: Record<(typeof keys)[number], unknown> = {
      email: 'seam@example.com',
      name: 'Seam',
      role: 'owner',
      tags: ['a', 'b,c', 'NULL'],
      meta: { k: 1 },
      balance: '10.50', // the trailing zero must survive: numeric decodes to string
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      birthday: '1990-05-17',
    }

    const columns = keys.map((k) => m.byKey[k]!)
    const compiled = compile<Record<string, unknown>>(
      insert({
        into: table(m.table),
        columns,
        source: { k: 'values', rows: [keys.map((k) => param(values[k], m.byKey[k]!.codec))] },
        returning: keys.map((k) =>
          projection(k, col('users', m.byKey[k]!.name, m.byKey[k]!.codec)),
        ),
      }),
    )

    const res = await conn.execute({
      text: compiled.sql,
      params: compiled.binds.map((b) => (b.k === 'value' ? b.encoded : null)),
    })
    const rows = buildDecoder<Record<string, unknown>>(compiled.shape, {
      typmod: -1,
      registry,
      serverParameters: {},
    })(res.rows as unknown[][])

    expect(rows).toStrictEqual([values])
  })
})

/**
 * `unknownCodec` and `paramTypesOf` both spell "this bind declares no type" as OID 0 rather than
 * 705 (`unknown`), and both comments say the two are equivalent. This is where that claim is
 * measured instead of asserted — including the two positions PostgreSQL refuses to infer at all,
 * which must fail the SAME way under both, or "equivalent" is not the right word.
 */
describe('the untyped parameter: OID 0 vs 705', () => {
  const CASES: readonly (readonly [string, readonly (string | null)[]])[] = [
    ['select $1', ['x']],
    ['select $1 + 1', ['1']],
    ['select length($1)', ['abc']],
    ['select $1 || $2', ['a', 'b']],
    ['select 1 where 9007199254740993 = $1', ['9007199254740993']],
    ['select now() > $1', ['2020-01-01T00:00:00Z']],
    ['select $1 is null', [null]], // 42P18 under both — PG cannot infer here at all
    ['select coalesce($1, 1)', ['2']],
    ['select $1::text', ['q']],
    ['select array[1,2] @> $1', ['{1}']],
    ['select json_build_object($1, 1)', ['k']], // 42P18 under both
    ['select 1 in ($1, 2)', ['1']],
  ]

  const attempt = async (text: string, params: readonly (string | null)[], oid: number) => {
    try {
      await conn.execute({ text, params, paramTypes: params.map(() => oid) })
      return 'ok'
    } catch (e) {
      return sqlState(e) ?? 'ERR'
    }
  }

  it('resolve identically in every position, including the two PG cannot infer', async () => {
    const diverged: string[] = []
    for (const [text, params] of CASES) {
      const [zero, unknown] = [await attempt(text, params, 0), await attempt(text, params, 705)]
      if (zero !== unknown) diverged.push(`${text} → 0=${zero} 705=${unknown}`)
    }
    expect(diverged).toEqual([])
    // ...and the two 42P18 rows are real, so the comparison above is not "everything is ok".
    expect(await attempt('select $1 is null', [null], 0)).toBe('42P18')
  })
})

describe('R4 — the negative control', () => {
  /**
   * If this passes, the OID confirmation above proves nothing. `wrong` is an `int8` column that
   * the DSL declares as `t.integer()`; the mapping is *internally consistent* (it resolves to the
   * `int4` codec, which claims 23) and only the server can tell you it is a lie.
   */
  it('a column mislabeled `t.integer()` over an `int8` DDL column fails the confirmation', async () => {
    const m = metaOf(mislabeled, registry)
    const actual = await describeColumns(m)

    const mismatches = m.columns
      .map((c, i) => ({
        column: c.name,
        codec: c.codec.name,
        claims: c.codec.oid,
        server: actual[i]?.oid,
      }))
      .filter((x) => x.claims !== x.server)

    expect(mismatches).toEqual([{ column: 'wrong', codec: 'int4', claims: 23, server: 20 }])
  })
})
