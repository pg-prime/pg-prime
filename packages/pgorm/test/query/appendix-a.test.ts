/**
 * **`03` Appendix A is generated from the builder** (design/09 WS4 exit gate: "every `03` §2
 * example compiles byte-identically to Appendix A *from the builder*").
 *
 * Appendix A was written by hand before a builder existed, so it was a second source of truth for
 * the one thing that must not have one: the exact SQL this library emits. WS3 hit the same problem
 * with §2.9's operator table and solved it the same way — the markdown between the two markers is
 * now a pure function of the builder expressions below, and any drift fails here.
 *
 * Regenerate after an intentional change:
 *
 *     PGORM_UPDATE_DOCS=1 pnpm test -- appendix-a
 *
 * and review the diff, because that diff *is* the compiled output of the public API.
 *
 * Four differences from the hand-written original are permanent and were the point of doing this:
 * the `do update set` list is one line rather than three aligned ones; `::int8` is `::bigint`
 * (the cast comes from `codec.sqlName`, a WS2 finding); a CTE reference is `"moved" as "moved"`
 * because the emitter aliases every FROM item; and every projection item is aliased, including
 * inside an `insert … select`.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { int8Codec, numericCodec } from '../../src/codec/index.js'
import { compileOnly } from '../../src/query/run.js'
import * as q from '../../src/query/types.js'
import { defineSchema, pgEnum, pgTable } from '../../src/schema/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOC = join(HERE, '..', '..', '..', '..', 'design', '03-query-builder.md')
const START = '<!-- appendix-a:start — generated from test/query/appendix-a.test.ts; do not edit -->'
const END = '<!-- appendix-a:end -->'

// ─────────────────────────────────────────────────────────────────────────────
// `03` §2's example schema, plus the four tables Appendix A's other statements use.
//
// `citext` is spelled `varchar` here for the reason `test/compile/insert.test.ts` records: citext
// is an EXTENSION type whose OID is per-database, so it has no static built-in codec and belongs
// on the `resolveDynamic` path (WS5). Nothing in Appendix A depends on which of the two it is.
// ─────────────────────────────────────────────────────────────────────────────

const userRole = pgEnum('user_role', ['admin', 'owner', 'member'])

const users = pgTable('users', (t) => ({
  id: t.bigint().primaryKey().generatedAlways(),
  email: t.varchar().unique(),
  name: t.text(),
  role: t.enum(userRole),
  tags: t.text().array().default([]),
  meta: t.jsonb().$type<{ billing?: { country: string } }>().default({}),
  createdAt: t.timestamptz().defaultSql('now()'),
  updatedAt: t.timestamptz().defaultSql('now()'),
  deletedAt: t.timestamptz().nullable(),
}))

const events = pgTable('events', (t) => ({
  kind: t.text(),
  at: t.timestamptz(),
}))

const products = pgTable('products', (t) => ({
  id: t.bigint().primaryKey(),
  price: t.numeric(),
  updatedAt: t.timestamptz().defaultSql('now()'),
}))

const staging = pgTable('staging', (t) => ({
  payload: t.jsonb(),
  at: t.timestamptz(),
  ready: t.boolean().default(false),
}))

const live = pgTable('live', (t) => ({
  id: t.bigint().primaryKey().generatedAlways(),
  payload: t.jsonb(),
  at: t.timestamptz(),
}))

const schema = defineSchema({ users, events, products, staging, live })
const db = compileOnly(schema)

const since = new Date('2026-01-01T00:00:00Z')

// ─────────────────────────────────────────────────────────────────────────────
// The statements, in Appendix A's order. Each is the §2 example, verbatim.
// ─────────────────────────────────────────────────────────────────────────────

interface Entry {
  readonly label: string
  build(): { compile(): { sql: string; binds: readonly unknown[] } }
}

const STATEMENTS: readonly Entry[] = [
  {
    label: '§2.1 select/where/order/limit',
    build: () =>
      db
        .from(schema.h.users)
        .select(({ users: u }) => ({ id: u.id, email: u.email, joined: u.createdAt }))
        .where(({ users: u }) => q.and(q.isNull(u.deletedAt), q.inList(u.role, ['admin', 'owner'])))
        .orderBy(({ users: u }) => [q.desc(u.createdAt), q.asc(u.id)])
        .limit(20),
  },
  {
    label: '§2.5 upsert with partial-index predicate + EXCLUDED + DO UPDATE WHERE',
    build: () =>
      db
        .insertInto(schema.h.users)
        .values({ email: 'a@b.c', name: 'Ada', role: 'admin' })
        .onConflict((c) =>
          c
            .columns((t) => [t.email])
            .where((t) => q.isNull(t.deletedAt))
            .doUpdate((set, excluded) => ({
              name: excluded.name,
              tags: q.arrayConcat(set.tags, excluded.tags),
              updatedAt: q.fn.now(),
            }))
            .whereUpdate((t, excluded) => q.lt(t.updatedAt, excluded.updatedAt)),
        )
        .returning(({ users: u }) => ({ id: u.id })),
  },
  {
    label: '§2.6 bulk insert, unnest strategy (2 params for any row count)',
    build: () =>
      db
        .insertInto(schema.h.events)
        .valuesMany([{ kind: 'click', at: since }], { strategy: 'unnest' }),
  },
  {
    label: '§2.6 bulk update from values',
    build: () =>
      db
        .update(schema.h.products)
        .fromValues([{ id: 1n, price: '9.99' }, { id: 2n, price: '4.50' }], {
          id: int8Codec,
          price: numericCodec,
        })
        .set((_t, v) => ({ price: v.price, updatedAt: q.fn.now() }))
        .where(({ products: p }, v) => q.eq(p.id, v.id)),
  },
  {
    label: '§2.7 writable CTE feeding an INSERT … SELECT',
    build: () =>
      db
        .with('moved', (d) =>
          d
            .deleteFrom(schema.h.staging)
            .where(({ staging: s }) => s.ready)
            .returning(({ staging: s }) => ({ payload: s.payload, at: s.at })),
        )
        .insertInto(schema.h.live)
        .fromSelect((d) =>
          d.fromCte('moved').select(({ moved: m }) => ({ payload: m.payload, at: m.at })),
        )
        .returning(({ live: l }) => ({ id: l.id })),
  },
  {
    label: '§2.9 jsonb path as a PARAMETER (the CVE class, designed out)',
    build: () =>
      db
        .from(schema.h.users)
        .select(({ users: u }) => ({ id: u.id }))
        .where(({ users: u }) => q.eq(q.jsonPathText(u.meta, ['billing', 'country']), 'DE')),
  },
]

/**
 * `-- params:` shows the ENCODED wire values, not the JavaScript that produced them.
 *
 * That is the honest artifact: `['billing','country']` reaches PostgreSQL as the `text[]` literal
 * `{billing,country}`, and the whole security claim of `03` §3.4 is about what is in the *bind
 * slot*, not about what the caller typed.
 */
function render(): string {
  const out: string[] = [START, '', '```sql']
  for (const [i, entry] of STATEMENTS.entries()) {
    if (i > 0) out.push('')
    const compiled = entry.build().compile()
    out.push(`-- ${entry.label}`)
    out.push(compiled.sql)
    const params = compiled.binds.map((b) => (b as { encoded?: unknown }).encoded)
    if (params.length > 0) out.push(`-- params: ${JSON.stringify(params)}`)
  }
  out.push('```', '', END)
  return out.join('\n')
}

it('`03` Appendix A matches what the builder compiles, byte for byte', () => {
  const doc = readFileSync(DOC, 'utf8')
  const from = doc.indexOf(START)
  const to = doc.indexOf(END)
  expect(from, `${START} not found in design/03-query-builder.md`).toBeGreaterThan(-1)
  expect(to).toBeGreaterThan(from)

  const generated = render()
  if (process.env['PGORM_UPDATE_DOCS'] === '1') {
    writeFileSync(DOC, doc.slice(0, from) + generated + doc.slice(to + END.length))
    return
  }
  expect(doc.slice(from, to + END.length)).toBe(generated)
})

it('every statement compiles to exactly one statement with no stray semicolon', () => {
  for (const entry of STATEMENTS) {
    const { sql } = entry.build().compile()
    expect(sql, entry.label).not.toContain(';')
    expect(sql.trim(), entry.label).toBe(sql)
  }
})
