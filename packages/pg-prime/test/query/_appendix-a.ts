/**
 * `03` Appendix A's schema and statements, as data — one list, two consumers.
 *
 * `appendix-a.test.ts` compiles them and regenerates the markdown (WS4). `test/live-query/
 * appendix-explain.test.ts` runs `EXPLAIN` over the same list against a real server (WS6), which
 * is R1's strongest form applied to the whole `03` §2 vocabulary at once: PostgreSQL's planner
 * accepting a statement is a verdict from something that is not our implementation.
 *
 * The list lives here rather than in either test so the two cannot drift. `ns` is what makes the
 * second consumer possible: with no namespace the tables are `public.*` and the compiled SQL is
 * byte-identical to the committed Appendix A; with one they are `"<ns>"."…"`, so a live suite can
 * create them beside every other file's fixture without collision (R6).
 */

import { int8Codec, jsonbCodec, numericCodec } from '../../src/codec/index.js'
import * as q from '../../src/query/types.js'
import type { Executor } from '../../src/query/types.js'
import { defineSchema, pgEnum, pgTable } from '../../src/schema/index.js'

/**
 * `citext` is spelled `varchar` here for the reason `test/compile/insert.test.ts` records: citext
 * is an EXTENSION type whose OID is per-database, so it has no static built-in codec and belongs
 * on the `resolveDynamic` path. Nothing in Appendix A depends on which of the two it is.
 */
export const userRole = pgEnum('user_role', ['admin', 'owner', 'member'])

export interface Entry {
  readonly label: string
  build(d: Executor): { compile(): { sql: string; binds: readonly unknown[] } }
}

const since = new Date('2026-01-01T00:00:00Z')

export function makeAppendixA(ns?: string) {
  const opts = ns === undefined ? undefined : ({ schema: ns } as const)

  const users = pgTable(
    'users',
    (t) => ({
      id: t.bigint().primaryKey().generatedAlways(),
      email: t.varchar().unique(),
      name: t.text(),
      role: t.enum(userRole),
      tags: t.text().array().default([]),
      meta: t.jsonb().$type<{ billing?: { country: string } }>().default({}),
      createdAt: t.timestamptz().defaultSql('now()'),
      updatedAt: t.timestamptz().defaultSql('now()'),
      deletedAt: t.timestamptz().nullable(),
    }),
    undefined,
    opts,
  )

  const events = pgTable(
    'events',
    (t) => ({ kind: t.text(), at: t.timestamptz() }),
    undefined,
    opts,
  )

  const products = pgTable(
    'products',
    (t) => ({
      id: t.bigint().primaryKey(),
      price: t.numeric(),
      updatedAt: t.timestamptz().defaultSql('now()'),
    }),
    undefined,
    opts,
  )

  const staging = pgTable(
    'staging',
    (t) => ({ payload: t.jsonb(), at: t.timestamptz(), ready: t.boolean().default(false) }),
    undefined,
    opts,
  )

  const live = pgTable(
    'live',
    (t) => ({
      id: t.bigint().primaryKey().generatedAlways(),
      payload: t.jsonb(),
      at: t.timestamptz(),
    }),
    undefined,
    opts,
  )

  const schema = defineSchema({ users, events, products, staging, live })
  const h = schema.h

  // ── The statements, in Appendix A's order. Each is the §2 example, verbatim. ──
  const statements: readonly Entry[] = [
    {
      label: '§2.1 select/where/order/limit',
      build: (db) =>
        db
          .from(h.users)
          .select(({ users: u }) => ({ id: u.id, email: u.email, joined: u.createdAt }))
          .where(({ users: u }) => q.and(q.isNull(u.deletedAt), q.inList(u.role, ['admin', 'owner'])))
          .orderBy(({ users: u }) => [q.desc(u.createdAt), q.asc(u.id)])
          .limit(20),
    },
    {
      label: '§2.5 upsert with partial-index predicate + EXCLUDED + DO UPDATE WHERE',
      build: (db) =>
        db
          .insertInto(h.users)
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
      build: (db) =>
        db.insertInto(h.events).valuesMany([{ kind: 'click', at: since }], { strategy: 'unnest' }),
    },
    {
      label: '§2.6 bulk update from values',
      build: (db) =>
        db
          .update(h.products)
          .fromValues([{ id: 1n, price: '9.99' }, { id: 2n, price: '4.50' }], {
            id: int8Codec,
            price: numericCodec,
          })
          .set((_t, v) => ({ price: v.price, updatedAt: q.fn.now() }))
          .where(({ products: p }, v) => q.eq(p.id, v.id)),
    },
    {
      label: '§2.7 writable CTE feeding an INSERT … SELECT',
      build: (db) =>
        db
          .with('moved', (d) =>
            d
              .deleteFrom(h.staging)
              .where(({ staging: s }) => s.ready)
              .returning(({ staging: s }) => ({ payload: s.payload, at: s.at })),
          )
          .insertInto(h.live)
          .fromSelect((d) =>
            d.fromCte('moved').select(({ moved: m }) => ({ payload: m.payload, at: m.at })),
          )
          .returning(({ live: l }) => ({ id: l.id })),
    },
    {
      label: '§2.1 the `$all` spread, with one column omitted (12 B)',
      build: (db) =>
        db
          .from(h.products)
          .select(({ products: p }) => ({ ...q.omit(p.$all, 'updatedAt') }))
          .orderBy(({ products: p }) => q.asc(p.id)),
    },
    {
      label: '§2.2 right join — the aliases already in scope are the nullable ones (12 B)',
      build: (db) =>
        db
          .from(h.events, 'e')
          .rightJoin(h.users, 'u', ({ e, u }) => q.eq(e.kind, u.name))
          .select(({ e, u }) => ({ email: u.email, kind: e.kind })),
    },
    {
      label: '§2.2 left join lateral — the per-parent top-N (12 B)',
      build: (db) =>
        db
          .from(h.users)
          .leftJoinLateral(
            (t) =>
              db
                .from(h.events, 'e')
                .where(({ e }) => q.eq(e.kind, t.users.name))
                .orderBy(({ e }) => q.desc(e.at))
                .limit(3)
                .select(({ e }) => ({ kind: e.kind, at: e.at })),
            'recent',
          )
          .select(({ users: u, recent }) => ({ email: u.email, kind: recent.kind })),
    },
    {
      label: '§2.7 withRecursive — the row type is the base term\'s (12 B)',
      build: (db) =>
        db
          .withRecursive(
            'tree',
            (d) =>
              d
                .from(h.events, 'e')
                .where(({ e }) => q.eq(e.kind, 'root'))
                .select(({ e }) => ({ kind: e.kind, at: e.at })),
            (d, self) =>
              d
                .from(h.events, 'e')
                .innerJoin(self, 't', ({ e, t }) => q.eq(e.kind, t.kind))
                .select(({ e }) => ({ kind: e.kind, at: e.at })),
          )
          .fromCte('tree')
          .select(({ tree }) => ({ kind: tree.kind })),
    },
    {
      label: '§5 fromRaw — a set-returning function with a column definition list (12 B)',
      build: (db) =>
        db
          .fromRaw(
            q.sql`jsonb_to_recordset(${q.val({ id: 1 }, jsonbCodec)})`,
            { id: int8Codec, price: numericCodec },
            { alias: 'j', columnTypes: true },
          )
          .select(({ j }) => ({ id: j.id, price: j.price })),
    },
    {
      label: '§2.9 jsonb path as a PARAMETER (the CVE class, designed out)',
      build: (db) =>
        db
          .from(h.users)
          .select(({ users: u }) => ({ id: u.id }))
          .where(({ users: u }) => q.eq(q.jsonPathText(u.meta, ['billing', 'country']), 'DE')),
    },
  ]

  /**
   * DDL for the five tables, in `ns`.
   *
   * The `email` unique constraint is a **partial** index, because §2.5's `ON CONFLICT (email)
   * WHERE deleted_at IS NULL` needs an arbiter index whose predicate implies its own: a plain
   * `unique (email)` would make PostgreSQL raise `42P10 there is no unique or exclusion
   * constraint matching the ON CONFLICT specification`, which is the example's whole point.
   */
  const ddl = (name: string): string => `
create schema ${name};
create type ${name}.user_role as enum ('admin', 'owner', 'member');
create table ${name}.users (
  id         bigint generated always as identity primary key,
  email      varchar not null,
  name       text not null,
  role       ${name}.user_role not null,
  tags       text[] not null default '{}',
  meta       jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index users_email_live on ${name}.users (email) where deleted_at is null;
create table ${name}.events (kind text not null, at timestamptz not null);
create table ${name}.products (
  id bigint primary key,
  price numeric not null,
  updated_at timestamptz not null default now()
);
create table ${name}.staging (
  payload jsonb not null,
  at timestamptz not null,
  ready boolean not null default false
);
create table ${name}.live (
  id      bigint generated always as identity primary key,
  payload jsonb not null,
  at      timestamptz not null
);
`

  return { schema, statements, ddl, drop: (name: string) => `drop schema if exists ${name} cascade` }
}
