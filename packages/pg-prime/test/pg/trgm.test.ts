/**
 * pg_trgm's `similarity` / `wordSimilarity` / `trgmSimilar` against real PostgreSQL: the result
 * OIDs their codecs claim, and the same rows as hand-written SQL. The live tier's PGlite boot does
 * not load the extension, so these are the `OPS` rows deferred there.
 */

import { afterAll, beforeAll, describe, expect } from 'vitest'
import { float4Codec } from '../../src/codec/index.js'
import type { Expr } from '../../src/compile/ast.js'
import { compileExpr } from '../../src/compile/compiler.js'
import { paramTypesOf } from '../../src/compile/contract.js'
import { codecOf } from '../../src/compile/hoist.js'
import type { PgConnection } from '../../src/driver/index.js'
import { refsOf } from '../../src/query/ref.js'
import * as q from '../../src/query/types.js'
import { pgTable } from '../../src/schema/index.js'
import { liveTarget, makeHarness, requiresRealPostgres, type Harness } from '../live/_harness.js'

const NS = 'pgprime_pg_trgm'
const words = pgTable(
  'words',
  (t) => ({ id: t.integer().primaryKey(), w: t.text(), note: t.text().nullable() }),
  undefined,
  { schema: NS },
)
const t = refsOf(words, 'w')
const test = requiresRealPostgres('pg_trgm is not loaded by the PGlite live boot')

let h: Harness | undefined
let conn: PgConnection

beforeAll(async () => {
  if (liveTarget().kind === 'pglite') return
  h = await makeHarness(1)
  conn = await h.driver.acquire()
  await conn.execute({
    text: `create extension if not exists pg_trgm;
drop schema if exists ${NS} cascade;
create schema ${NS};
create table ${NS}.words (id integer primary key, w text not null, note text);
insert into ${NS}.words values (1, 'hello', 'x'), (2, 'hallo', null), (3, 'world', null), (4, 'help me', null);`,
    params: [],
    mode: 'simple',
  })
})

afterAll(async () => {
  if (!h) return
  await conn.execute({ text: `drop schema if exists ${NS} cascade`, params: [], mode: 'simple' })
  await h.driver.release(conn)
  await h.end()
})

/** Runs `select <cols> from words w <tail> order by w.id`, with `$e` replaced by `e`'s SQL. */
async function run(
  cols: string,
  tail = '',
  e?: unknown,
): Promise<{ oid: number; rows: readonly (readonly unknown[])[] }> {
  const c = e === undefined ? { sql: '', binds: [] } : compileExpr(e as Expr)
  const r = await conn.execute({
    text: `select ${cols} from ${NS}.words as w ${tail} order by w.id`.replace('$e', () => c.sql),
    params: c.binds.map((b) => (b.k === 'value' ? b.encoded : null)),
    paramTypes: paramTypesOf(c.binds),
  })
  return { oid: r.fields[0]!.dataTypeID, rows: r.rows }
}

describe('pg_trgm', () => {
  test('similarity / wordSimilarity return the float4 their codecs claim, matching hand-written SQL', async () => {
    for (const [e, sql] of [
      [q.similarity(t.w, 'hello'), `similarity(w.w, 'hello')`],
      [q.wordSimilarity('help', t.w), `word_similarity('help', w.w)`],
      [q.similarity(t.note, t.w), `similarity(w.note, w.w)`],
    ] as const) {
      expect(codecOf(e as unknown as Expr)).toBe(float4Codec)
      const mine = await run('$e', '', e)
      expect(mine.oid).toBe(float4Codec.oid)
      expect(mine.rows).toStrictEqual((await run(sql)).rows)
    }
  })

  test('trgmSimilar is `%`, and selects what `%` selects', async () => {
    const mine = await run('w.id', 'where $e', q.trgmSimilar(t.w, 'hellp'))
    const theirs = await run('w.id', `where w.w % 'hellp'`)
    expect(mine.rows).toStrictEqual(theirs.rows)
    expect(mine.rows.length).toBeGreaterThan(0)
    expect(mine.rows.length).toBeLessThan(4)
    expect((await run('$e', '', q.trgmSimilar(t.w, 'x'))).oid).toBe(16)
  })
})
