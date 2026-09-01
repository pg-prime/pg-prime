/**
 * Extension types against a real pgvector server, tier 2 — design/01 §3 rows 44-`citext`, 61, 62
 * (design/14 §0 row V, decisions 5–7).
 *
 * ## Why this file has its own env var
 *
 * Every other tier-2 file runs against `PG_PRIME_TEST_URL`, and in CI that is a stock
 * `postgres:17` service. Stock PostgreSQL ships **neither** `citext` nor `vector` as an installed
 * extension, and the nightly PG 15–18 matrix images ship neither either — so pointing this suite
 * at the shared URL would mean it never ran anywhere. It takes `PG_PRIME_TEST_VECTOR_URL` and,
 * even then, checks `pg_available_extensions` before it believes it: an image can have the URL
 * and still not have the `.so`.
 *
 * Both halves of the guard skip with a sentence naming what is therefore unverified. A silent
 * skip is a test that has stopped existing (R19); a skip whose reason is "no extension" is one
 * nobody can re-evaluate.
 *
 * ## What is proved here that nowhere else can be
 *
 *  1. **The per-database OID.** `resolveDynamic` reads `citext` and `vector` out of THIS
 *     database's `pg_type` and the numbers match the catalogue. No fixed OID exists to assert.
 *  2. **The round trip, at both depths.** `citext`, `citext[]`, `vector`, `vector[]` in and out
 *     through the builder, plus R5's depth-3 payload for the two scalars.
 *  3. **`citext` is not `text`.** `eq(title, 'HELLO')` matches a row stored as `'Hello'`, which
 *     is the entire reason the type exists and the one thing a `text` codec would hide.
 *  4. **The six distance operators' result OIDs**, read off `RowDescription` — the differential
 *     `test/live-query/ops.test.ts` runs only when its target happens to have the extension.
 *  5. **Row 62 end to end**: `vector(n)` column → HNSW index → KNN `order by`, with the planner
 *     confirming the index is what answered it.
 *  6. **Row 61's acceptance sentence, literally**: a type this package has never heard of
 *     (`halfvec`) taught to it from a test file, with `definePgType` and zero forks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import {
  bitCodec,
  citextCodec,
  definePgType,
  PgDecodeError,
  Registry,
  vectorCodec,
} from '../../src/codec/index.js'
import type { AnyCodec, PgTypeDescriptor } from '../../src/codec/index.js'
import type { Expr } from '../../src/compile/ast.js'
import { compileExpr } from '../../src/compile/compiler.js'
import { paramTypesOf } from '../../src/compile/contract.js'
import { codecOf } from '../../src/compile/hoist.js'
import { pgDriver } from '../../src/driver/index.js'
import type { PgConnection, PgDriver, PgLikePool } from '../../src/driver/index.js'
import { pgPrime } from '../../src/query/run.js'
import type { Db } from '../../src/query/types.js'
import * as q from '../../src/query/types.js'
import { defineSchema, pgTable } from '../../src/schema/index.js'
import { announce } from '../live/_harness.js'

const NS = 'pgprime_pg_vector'
const VECTOR_URL = process.env['PG_PRIME_TEST_VECTOR_URL']

const RECIPE =
  `Start one with \`docker run -d --name pgprime-vec -p 54337:5432 -e POSTGRES_PASSWORD=postgres ` +
  `pgvector/pgvector:pg17\` and set PG_PRIME_TEST_VECTOR_URL to it (design/14 §2).`

/**
 * `_harness.ts`'s `TestDecl`, widened by one argument: these cases need the test CONTEXT, because
 * the second half of the guard is only knowable after a round trip and `ctx.skip(note)` is how a
 * runtime skip still prints its reason.
 */
type CtxTest = (
  name: string,
  fn: (ctx: { skip: (note?: string) => void }) => void | Promise<void>,
  timeout?: number,
) => void

/**
 * Loud, at collection time — the half of the guard that can be answered without a round trip.
 *
 * The other half (`pg_available_extensions`) needs the server and therefore runs in `beforeAll`;
 * it sets {@link unavailable}, which each case below turns into a per-test skip note. Two
 * mechanisms because there are two questions, and both print.
 */
function requiresVectorUrl(): CtxTest {
  if (VECTOR_URL !== undefined && VECTOR_URL !== '') return it
  announce(
    '[pg] skip: PG_PRIME_TEST_VECTOR_URL is unset, so design/01 §3 rows 44-citext / 61 / 62 ' +
      '(citext + pgvector: per-database OIDs, round trips, the six distance operators, KNN over ' +
      `an HNSW index) are UNVERIFIED in this run. ${RECIPE}`,
  )
  return it.skip
}
const forVector = requiresVectorUrl()

/** Set by `beforeAll` when the server is reachable but has no pgvector / citext. */
let unavailable: string | undefined

const docs = pgTable(
  'docs',
  (t) => ({
    id: t.integer().primaryKey(),
    title: t.citext(),
    aliases: t.citext().array(),
    embedding: t.vector(3),
    neighbours: t.vector(3).array(),
  }),
  undefined,
  { schema: NS },
)
const schema = defineSchema({ docs })

let pool: pg.Pool | undefined
let driver: PgDriver | undefined
let conn: PgConnection
let registry: Registry
let db: Db<typeof schema>
/** Operator name → the `dataTypeID` the server reported for `select <expr>`. */
const oidReadings = new Map<string, number>()

const DDL = `
create table ${NS}.docs (
  id integer primary key,
  title citext not null,
  aliases citext[] not null,
  embedding vector(3) not null,
  neighbours vector(3)[] not null
)`

const SEED = `
insert into ${NS}.docs (id, title, aliases, embedding, neighbours) values
  (1, 'Hello',  '{Alpha,Beta}', '[1,0,0]',      '{"[1,0,0]","[0,1,0]"}'),
  (2, 'World',  '{Gamma}',      '[0,1,0]',      '{"[0,1,0]"}'),
  (3, 'Nearby', '{}',           '[0.9,0.1,0]',  '{}')`

async function simple(text: string): Promise<void> {
  await conn.execute({ text, params: [], mode: 'simple' })
}

beforeAll(async () => {
  if (VECTOR_URL === undefined || VECTOR_URL === '') return
  pool = new pg.Pool({ connectionString: VECTOR_URL, max: 4 })
  driver = pgDriver({ pool: pool as unknown as PgLikePool })
  await driver.init()
  conn = await driver.acquire()

  const available = (
    await conn.execute({
      text: `select name from pg_catalog.pg_available_extensions where name in ('vector','citext')`,
      params: [],
      mode: 'simple',
    })
  ).rows.map((r) => String(r[0]))
  const missing = ['vector', 'citext'].filter((n) => !available.includes(n))
  if (missing.length > 0) {
    unavailable =
      `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not in ` +
      `pg_available_extensions on this server, so design/01 §3 rows 44-citext / 61 / 62 are ` +
      `UNVERIFIED in this run. ${RECIPE}`
    announce(`[pg] skip: ${unavailable}`)
    return
  }

  await simple('create extension if not exists vector')
  await simple('create extension if not exists citext')
  await simple(`drop schema if exists ${NS} cascade`)
  await simple(`create schema ${NS}`)
  await simple(DDL)
  await simple(SEED)

  registry = new Registry()
  registry.setServerParameters(conn.serverParameters)
  // The one line row 61 exists for: an extension type resolves exactly as an enum does.
  await registry.resolveDynamic(conn, [
    { name: 'citext', kind: 'base' },
    { name: 'vector', kind: 'base' },
  ])
  db = pgPrime({ driver: driver, schema, registry })
}, 120_000)

afterAll(async () => {
  if (conn) {
    await simple(`drop schema if exists ${NS} cascade`).catch(() => {})
    await driver?.release(conn)
  }
  await driver?.destroy()
  await pool?.end().catch(() => {})
})

/** Every case funnels through here, so the runtime half of the guard is impossible to forget. */
function guard(ctx: { skip: (note?: string) => void }): boolean {
  if (unavailable === undefined) return false
  ctx.skip(unavailable)
  return true
}

async function catalogueOid(typname: string): Promise<number> {
  const r = await conn.execute({
    text: `select t.oid::text, t.typarray::text from pg_catalog.pg_type t
           join pg_catalog.pg_namespace n on n.oid = t.typnamespace
           where t.typname = $1 and pg_catalog.pg_type_is_visible(t.oid)`,
    params: [typname],
  })
  return Number(r.rows[0]![0])
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The per-database OID — §4.6's moat, for an EXTENSION type
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveDynamic reads an extension type out of THIS database (row 61)', () => {
  forVector('citext and vector get the OID pg_type reports, and nothing baked in', async (ctx) => {
    if (guard(ctx)) return
    const citext = registry.byName('citext')!
    const vec = registry.byName('vector')!
    expect(citext.oid).toBe(await catalogueOid('citext'))
    expect(vec.oid).toBe(await catalogueOid('vector'))
    // The module-level codecs are still OID-less: `resolveDynamic` registers a NEW codec on this
    // registry rather than mutating the shared one, which is what makes one registry per physical
    // database (§4.6) actually mean something.
    expect(vectorCodec.oid).toBeUndefined()
    expect(citextCodec.oid).toBeUndefined()
    // A second, independent registry resolves to the same numbers and does not disturb the first.
    const other = new Registry()
    await other.resolveDynamic(conn, [{ name: 'vector', kind: 'base' }])
    expect(other.byName('vector')!.oid).toBe(vec.oid)
    expect(registry.byName('vector')!.oid).toBe(vec.oid)
  })

  forVector('the array codec is derived from typarray, delimiter included', async (ctx) => {
    if (guard(ctx)) return
    expect(registry.byName('citext[]')).toBeDefined()
    expect(registry.byName('vector[]')).toBeDefined()
    expect(registry.byName('vector[]')!.oid).toBe(
      Number(
        (
          await conn.execute({
            text: `select typarray::text from pg_catalog.pg_type where typname = 'vector'`,
            params: [],
          })
        ).rows[0]![0],
      ),
    )
  })

  forVector('the ::type cast is byte-identical before and after resolution', async (ctx) => {
    if (guard(ctx)) return
    // The pending codec's `sqlName` is kept verbatim, so a golden taken before connect matches
    // one taken after — the property `pendingEnumCodec` documents for enums, generalized.
    expect(registry.byName('vector')!.sqlName).toBe(vectorCodec.sqlName)
    expect(registry.byName('citext')!.sqlName).toBe(citextCodec.sqlName)
  })

  forVector('a base request with nothing registered says what to do about it', async (ctx) => {
    if (guard(ctx)) return
    const empty = new Registry()
    // `halfvec` exists in this database and this package has never heard of it.
    await expect(empty.resolveDynamic(conn, [{ name: 'halfvec', kind: 'base' }])).rejects.toThrow(
      /definePgType/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 & 3. The round trip, and citext actually being citext
// ─────────────────────────────────────────────────────────────────────────────

describe('citext and vector round-trip through the builder (rows 44, 62)', () => {
  forVector('R3: the promised types are the values that come back', async (ctx) => {
    if (guard(ctx)) return
    const rows = await db
      .from(schema.h.docs)
      .select(({ docs: d }) => ({
        id: d.id,
        title: d.title,
        aliases: d.aliases,
        embedding: d.embedding,
        neighbours: d.neighbours,
      }))
      .where(({ docs: d }) => q.eq(d.id, 1))
      .execute()

    expect(rows).toStrictEqual([
      {
        id: 1,
        title: 'Hello',
        aliases: ['Alpha', 'Beta'],
        embedding: [1, 0, 0],
        neighbours: [
          [1, 0, 0],
          [0, 1, 0],
        ],
      },
    ])
  })

  forVector('a written vector comes back as the same numbers (insert … returning)', async (ctx) => {
    if (guard(ctx)) return
    const rows = await db
      .insertInto(schema.h.docs)
      .values({
        id: 10,
        title: 'Written',
        aliases: ['Delta'],
        embedding: [0.25, -0.5, 1],
        neighbours: [[1, 1, 1]],
      })
      .returning(({ docs: d }) => ({ e: d.embedding, n: d.neighbours, t: d.title }))
      .execute()
    expect(rows).toStrictEqual([{ e: [0.25, -0.5, 1], n: [[1, 1, 1]], t: 'Written' }])
    // The oracle: hand-written SQL, so this is not the builder agreeing with itself.
    const raw = await conn.execute({
      text: `select embedding::text, neighbours::text from ${NS}.docs where id = 10`,
      params: [],
    })
    expect(raw.rows[0]).toStrictEqual(['[0.25,-0.5,1]', '{"[1,1,1]"}'])
    await simple(`delete from ${NS}.docs where id = 10`)
  })

  forVector('citext compares case-insensitively — which `text` would not', async (ctx) => {
    if (guard(ctx)) return
    const hit = await db
      .from(schema.h.docs)
      .select(({ docs: d }) => ({ id: d.id }))
      .where(({ docs: d }) => q.eq(d.title, 'HELLO'))
      .execute()
    expect(hit).toStrictEqual([{ id: 1 }])
    // The oracle, and the control: the same comparison against `text` finds nothing.
    const oracle = await conn.execute({
      text: `select id from ${NS}.docs where title = 'HELLO'`,
      params: [],
    })
    expect(oracle.rows.map((r) => Number(r[0]))).toStrictEqual([1])
    const control = await conn.execute({
      text: `select id from ${NS}.docs where title::text = 'HELLO'`,
      params: [],
    })
    expect(control.rows).toStrictEqual([])
  })

  forVector('R5: the depth-3 payload decodes to the depth-0 value', async (ctx) => {
    if (guard(ctx)) return
    // `jsonEncode: 'text'` means the compiler emits `::text` inside `json_build_object`; this is
    // that payload, and the two decoders must agree on it.
    const r = await conn.execute({
      text: `select json_build_object('t', title::text, 'e', embedding::text)::text
             from ${NS}.docs where id = 1`,
      params: [],
    })
    const payload = JSON.parse(String(r.rows[0]![0])) as { t: string; e: string }
    const cctx = { typmod: -1, registry, serverParameters: {} }
    expect(citextCodec.decodeJson(payload.t, cctx)).toBe('Hello')
    expect(vectorCodec.decodeJson(payload.e, cctx)).toStrictEqual([1, 0, 0])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4 & 5. The six operators, and row 62 end to end
// ─────────────────────────────────────────────────────────────────────────────

describe('the six pgvector distance operators (03 §2.9, row 62)', () => {
  const VEC = () => q.sql`'[1,0,0]'::vector`.as(vectorCodec)
  const BITS = () => q.sql`B'101'`.as(bitCodec)
  const CASES: readonly (readonly [string, () => unknown])[] = [
    ['l2', () => q.l2(VEC(), [0, 1, 0])],
    ['cosine', () => q.cosine(VEC(), [0, 1, 0])],
    ['innerProduct', () => q.innerProduct(VEC(), [0, 1, 0])],
    ['l1', () => q.l1(VEC(), [0, 1, 0])],
    ['hamming', () => q.hamming(BITS(), '110')],
    ['jaccard', () => q.jaccard(BITS(), '110')],
  ]

  for (const [name, build] of CASES) {
    forVector(`${name} → float8, confirmed by RowDescription`, async (ctx) => {
      if (guard(ctx)) return
      const out = compileExpr(build() as Expr)
      const r = await conn.execute({
        text: `select ${out.sql} as v limit 1`,
        params: out.binds.map((b) => (b.k === 'value' ? b.encoded : null)),
        paramTypes: paramTypesOf(out.binds),
      })
      const reported = r.fields[0]!.dataTypeID
      oidReadings.set(name, reported)
      expect(reported).toBe(codecOf(build() as Expr).oid)
    })
  }

  forVector('the six readings, printed so the record can quote them', async (ctx) => {
    if (guard(ctx)) return
    expect(oidReadings.size).toBe(6)
    announce(
      `[pg] pgvector OID differential: ${[...oidReadings]
        .map(([n, oid]) => `${n}=${oid}`)
        .join(' · ')}`,
    )
    for (const oid of oidReadings.values()) expect(oid).toBe(701)
  })

  forVector('KNN: order by distance returns nearest first, over an HNSW index', async (ctx) => {
    if (guard(ctx)) return
    // The DSL spelling for this index is `index('docs_embedding_hnsw').using('hnsw')
    //   .on({ column: docs.embedding, opclass: 'vector_cosine_ops' })` — rendering it to DDL is
    // @pg-prime/kit's job and is tested there. What is proved HERE is the half the kit cannot
    // see: that the builder's `order by <distance>` is the shape the planner answers with the
    // index rather than a sort.
    await simple(
      `create index if not exists docs_embedding_hnsw on ${NS}.docs
       using hnsw (embedding vector_cosine_ops)`,
    )
    const query = db
      .from(schema.h.docs)
      .select(({ docs: d }) => ({ id: d.id }))
      .orderBy(({ docs: d }) => q.asc(q.cosine(d.embedding, [1, 0, 0])))
      .limit(2)

    expect(await query.execute()).toStrictEqual([{ id: 1 }, { id: 3 }])

    // …and the planner used the index. `enable_seqscan = off` because three rows is far below
    // the point where a cost-based planner would ever prefer one.
    const compiled = query.compile()
    await simple('set enable_seqscan = off')
    const plan = await conn.execute({
      text: `explain ${compiled.sql}`,
      params: compiled.binds.map((b) => (b.k === 'value' ? b.encoded : null)),
      paramTypes: paramTypesOf(compiled.binds),
    })
    await simple('reset enable_seqscan')
    expect(plan.rows.map((r) => String(r[0])).join('\n')).toMatch(/docs_embedding_hnsw/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. Row 61's acceptance sentence, literally
// ─────────────────────────────────────────────────────────────────────────────

describe('a third party adds a type this package has never heard of, with zero forks', () => {
  /**
   * `halfvec` — pgvector's float16 vector. Nothing in `src/` mentions it; every line needed to
   * support it is right here, in a test file, through the public API.
   *
   * `arrayOf: false` is the other half of the descriptor under test: it says "I model my own
   * array form", and the registry must then NOT claim `halfvec[]` with the generic one.
   */
  const halfvecDescriptor: PgTypeDescriptor<readonly number[], number[], 'halfvec'> = {
    name: 'halfvec',
    typeClass: 'vector',
    arrayOf: false,
    encode: (v: readonly number[]) => `[${v.join(',')}]`,
    decode: (raw): number[] => {
      if (!raw.startsWith('[')) throw new PgDecodeError('halfvec', raw, 'expected [a,b,c]')
      return raw.slice(1, -1).split(',').map(Number)
    },
  }

  forVector('definePgType + register + resolveDynamic is the whole story', async (ctx) => {
    if (guard(ctx)) return
    const halfvec = definePgType(halfvecDescriptor)
    const r = new Registry()
    r.register(halfvec as unknown as AnyCodec)
    expect(r.byName('halfvec')!.oid).toBeUndefined()

    await r.resolveDynamic(conn, [{ name: 'halfvec', kind: 'base' }])
    expect(r.byName('halfvec')!.oid).toBe(await catalogueOid('halfvec'))
    // `arrayOf: false` — the generic array codec did NOT claim the name.
    expect(r.byName('halfvec[]')).toBeUndefined()

    // And it decodes a real value off the wire, through `planFor`, keyed on that OID.
    const row = await conn.execute({ text: `select '[1,2,3]'::halfvec as v`, params: [] })
    const plan = r.planFor(row.fields)
    expect(plan[0]!(row.rows[0]![0]!)).toStrictEqual([1, 2, 3])
  })
})
