/**
 * R5 — the fixture cannot drift.
 *
 * `fixture.ts` declares each table twice: once as `pgTable(…)`, which is what the builder will
 * compile against, and once as DDL, which is what the server will actually have. This file is the
 * one place that proves they are the same thing, by asking `information_schema` (and
 * `pg_attribute` for array dimensionality, which `information_schema` does not expose) and
 * comparing to `TableRuntime`.
 *
 * Without it, a column renamed in one half and not the other turns every other live test into a
 * test of a lie — one that still passes, because the builder and the fixture would agree with
 * each other and disagree only with the database.
 *
 * The last case is the negative control (R4): a deliberately wrong runtime must be *reported* as
 * wrong, otherwise the comparison above is a tautology.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeFixture } from './fixture.js'
import { makeHarness, type Harness } from './_harness.js'
import type { TableRuntime } from '../../src/schema/index.js'
import type { PgConnection } from '../../src/driver/index.js'

const fx = makeFixture('pgprime_drift')

let h: Harness
let conn: PgConnection

beforeAll(async () => {
  h = await makeHarness()
  conn = await h.driver.acquire()
  await conn.execute({ text: fx.drop, params: [], mode: 'simple' })
  await conn.execute({ text: fx.ddl, params: [], mode: 'simple' })
  await conn.execute({ text: fx.seed, params: [], mode: 'simple' })
})

afterAll(async () => {
  await conn?.execute({ text: fx.drop, params: [], mode: 'simple' })
  await h?.driver.release(conn)
  await h?.end()
})

/** One column as the *database* describes it. Every field is a string, as it comes off the wire. */
interface CatalogColumn {
  name: string
  udtName: string
  nullable: boolean
  identity: 'ALWAYS' | 'BY DEFAULT' | 'NO'
  dims: number
}

async function catalog(table: string): Promise<CatalogColumn[]> {
  const r = await conn.execute({
    text: `select c.column_name, c.udt_name, c.is_nullable, c.is_identity,
                  coalesce(c.identity_generation, ''), a.attndims::text
           from information_schema.columns c
           join pg_namespace pn on pn.nspname = c.table_schema
           join pg_class pc on pc.relnamespace = pn.oid and pc.relname = c.table_name
           join pg_attribute a on a.attrelid = pc.oid and a.attname = c.column_name
           where c.table_schema = $1 and c.table_name = $2
           order by c.ordinal_position`,
    params: [fx.ns, table],
  })
  expect(r.rows.length).toBeGreaterThan(0)
  return r.rows.map((row) => ({
    name: String(row[0]),
    udtName: String(row[1]),
    nullable: row[2] === 'YES',
    identity: row[3] === 'YES' ? (String(row[4]) as 'ALWAYS' | 'BY DEFAULT') : 'NO',
    dims: Number(row[5]),
  }))
}

/** The same column as the *schema declaration* describes it. */
function declared(t: TableRuntime): CatalogColumn[] {
  return t.columns.map((ref) => {
    const ddl = ref.column.ddl
    const base = ddl.enumName ?? ddl.pgType.replace(/(\[\])+$/, '')
    return {
      name: ref.dbName,
      // PostgreSQL names an array type `_base` whatever its dimensionality.
      udtName: ddl.arrayDim > 0 ? `_${base}` : base,
      nullable: !ddl.notNull,
      identity: ddl.identity === 'always' ? 'ALWAYS' : ddl.identity === 'byDefault' ? 'BY DEFAULT' : 'NO',
      dims: ddl.arrayDim,
    }
  })
}

const byName = (cols: CatalogColumn[]): Map<string, CatalogColumn> =>
  new Map(cols.map((c) => [c.name, c]))

/** Every way the two halves can disagree, as human-readable lines. Empty ⇒ they agree. */
function differences(want: CatalogColumn[], got: CatalogColumn[]): string[] {
  const out: string[] = []
  const w = byName(want)
  const g = byName(got)
  for (const name of w.keys()) if (!g.has(name)) out.push(`declared but not in the database: ${name}`)
  for (const name of g.keys()) if (!w.has(name)) out.push(`in the database but not declared: ${name}`)
  for (const [name, a] of w) {
    const b = g.get(name)
    if (!b) continue
    for (const key of ['udtName', 'nullable', 'identity', 'dims'] as const) {
      if (a[key] !== b[key]) out.push(`${name}.${key}: declared ${String(a[key])}, database ${String(b[key])}`)
    }
  }
  return out.sort()
}

describe('R5 — information_schema ≡ TableRuntime', () => {
  it.each(Object.entries({ ...fx.tables }))('%s', async (_key, table) => {
    expect(differences(declared(table.$), await catalog(table.$.name))).toEqual([])
  })
})

describe('the seed is the dataset Appendix A promises', () => {
  const count = async (table: string): Promise<number> =>
    Number((await conn.execute({ text: `select count(*) from ${fx.ns}.${table}`, params: [] })).rows[0]![0])

  it('has the row counts every other live test will assume', async () => {
    expect({
      users: await count('users'),
      posts: await count('posts'),
      comments: await count('comments'),
      tags: await count('tags'),
      post_tags: await count('post_tags'),
      kv: await count('kv'),
    }).toEqual({ users: 6, posts: 6, comments: 3, tags: 3, post_tags: 3, kv: 2 })
  })

  it('starts post ids past 2^53, so a JSON-number id loses a digit', async () => {
    const r = await conn.execute({ text: `select min(id), max(id) from ${fx.ns}.posts`, params: [] })
    expect(r.rows[0]![0]).toBe('9007199254740993')
    expect(Number(r.rows[0]![0])).toBe(9007199254740992) // the bug, made visible
    expect(r.rows[0]![1]).toBe('9007199254740998')
  })

  it('gives two of one author’s posts the SAME created_at, to the microsecond', async () => {
    const r = await conn.execute({
      text: `select created_at::text, count(*) from ${fx.ns}.posts
             group by 1 having count(*) > 1`,
      params: [],
    })
    expect(r.rows.map((row) => row[1])).toEqual(['2'])
  })

  it('distinguishes JSON null from SQL NULL, and an empty array from NULL', async () => {
    const r = await conn.execute({
      text: `select meta::text, meta is null, tags::text, array_length(tags, 1) is null
             from ${fx.ns}.users where email = 'eve@example.com'`,
      params: [],
    })
    expect(r.rows[0]).toEqual(['null', 'f', '{}', 't'])
  })

  it('keeps the trailing zero on a numeric, which a float would eat', async () => {
    const r = await conn.execute({
      text: `select balance::text from ${fx.ns}.users where email = 'bob@example.com'`,
      params: [],
    })
    expect(r.rows[0]![0]).toBe('10.50')
  })
})

describe('NEGATIVE CONTROL — the comparison can fail', () => {
  it('reports a renamed column, a wrong type, a wrong nullability and a wrong identity', async () => {
    const real = await catalog('users')
    const mutated = declared(fx.users.$).map((c) =>
      c.name === 'email'
        ? { ...c, name: 'e_mail' }
        : c.name === 'balance'
          ? { ...c, udtName: 'float8' }
          : c.name === 'deleted_at'
            ? { ...c, nullable: false }
            : c.name === 'id'
              ? { ...c, identity: 'NO' as const }
              : c,
    )
    expect(differences(mutated, real)).toEqual([
      'balance.udtName: declared float8, database numeric',
      'declared but not in the database: e_mail',
      'deleted_at.nullable: declared false, database true',
      'id.identity: declared NO, database ALWAYS',
      'in the database but not declared: email',
    ])
  })

  it('an array column is only equal to an array column', () => {
    const tags = declared(fx.users.$).find((c) => c.name === 'tags')!
    expect(tags).toMatchObject({ udtName: '_text', dims: 1 })
    expect(differences([{ ...tags, udtName: 'text', dims: 0 }], [tags])).toEqual([
      'tags.dims: declared 0, database 1',
      'tags.udtName: declared text, database _text',
    ])
  })
})
