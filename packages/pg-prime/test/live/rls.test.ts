/**
 * design/20 §8: declared policies, `setting()` and the `updatedAtTrigger` SQL against a backend.
 * Superusers bypass RLS, so every filtered read runs under `SET LOCAL ROLE`. A server where the
 * test user cannot create roles (a project-owned database) skips the file loudly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uuidCodec } from '../../src/codec/index.js'
import { InsufficientPrivilegeError } from '../../src/errors/index.js'
import { definePolicy, defineSchema, eq, pgPrime, pgTable, setting, sql } from '../../src/index.js'
import type { Db, Tx } from '../../src/index.js'
import { announce, makeHarness, type Harness } from './_harness.js'

const NS = 'pgprime_live_rls'
const APP = 'pgprime_rls_app'
const OWNER = 'pgprime_rls_owner'
const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'

const orgId = setting('app.org_id', uuidCodec)
const userId = setting('app.user_id')

const documents = pgTable(
  'documents',
  (t) => ({
    id: t.integer().primaryKey(),
    orgId: t.uuid(),
    archived: t.boolean(),
    title: t.text(),
    updatedAt: t.timestamptz(),
  }),
  undefined,
  { schema: NS },
)
const folders = pgTable('folders', (t) => ({ id: t.integer(), orgId: t.uuid() }), undefined, {
  schema: NS,
})
const schema = defineSchema({ documents, folders })

const policies = [
  definePolicy('tenant', {
    on: documents,
    to: [APP],
    using: (t) => eq(t.orgId, orgId.current()),
    withCheck: (t) => eq(t.orgId, orgId.current()),
  }),
  definePolicy('archived_read_only', {
    on: documents,
    for: 'update',
    as: 'restrictive',
    to: [APP],
    using: (t) => eq(t.archived, false),
  }),
  definePolicy('member', {
    on: folders,
    for: 'select',
    to: [APP],
    using: (t) =>
      sql`exists (select 1 from ${sql.ident(NS, 'memberships')} m
                  where m.org_id = ${t.orgId} and m.user_id = ${userId.current()})`,
  }),
]

let h: Harness
let db: Db<typeof schema>
let skip = false

const exec = async (text: string): Promise<readonly (readonly unknown[])[]> => {
  const conn = await h.driver.acquire()
  try {
    return (await conn.execute({ text, params: [], mode: 'simple' })).rows
  } finally {
    await h.driver.release(conn)
  }
}

/** One transaction as `role`, with `settings` applied. */
const as = <T>(
  role: string,
  settings: Record<string, string>,
  fn: (tx: Tx<typeof schema>) => Promise<T>,
) =>
  db.transaction(async (tx) => {
    await tx.sql`set local role ${sql.ident(role)}`.execute()
    if (Object.keys(settings).length > 0) await tx.setLocal(settings)
    return fn(tx)
  })

const titles = (tx: Tx<typeof schema>) =>
  tx
    .from(schema.h.documents)
    .select(({ documents: d }) => ({ title: d.title }))
    .orderBy(({ documents: d }) => d.title)
    .execute()
    .then((rows) => rows.map((r) => r.title))

beforeAll(async () => {
  h = await makeHarness(1)
  db = pgPrime({ driver: h.driver, schema })
  const [[canCreate]] = (await exec(
    `select rolsuper or rolcreaterole from pg_roles where rolname = current_user`,
  )) as [[unknown]]
  if (canCreate !== 't' && canCreate !== true) {
    skip = true
    announce(`test/live/rls.test.ts: SKIPPED — current_user cannot CREATE ROLE on this server`)
    return
  }
  const role = (r: string) =>
    `do $$ begin create role ${r} nologin; exception when duplicate_object then null; end $$`
  await exec(`drop schema if exists ${NS} cascade`)
  await exec(role(APP))
  await exec(role(OWNER))
  await exec(`
    create schema ${NS};
    grant usage on schema ${NS} to ${APP}, ${OWNER};
    create table ${NS}.documents (id int primary key, org_id uuid, archived boolean, title text,
      updated_at timestamptz default now());
    create table ${NS}.folders (id int, org_id uuid);
    create table ${NS}.memberships (org_id uuid, user_id text);
    grant select, insert, update, delete on all tables in schema ${NS} to ${APP};
    insert into ${NS}.documents values
      (1, '${A}', false, 'a1', '2000-01-01'), (2, '${A}', true, 'a2', '2000-01-01'),
      (3, '${B}', false, 'b1', '2000-01-01');
    insert into ${NS}.folders values (1, '${A}'), (2, '${B}');
    insert into ${NS}.memberships values ('${A}', 'u1'), ('${B}', 'u2');
    alter table ${NS}.documents enable row level security;
    alter table ${NS}.folders enable row level security;
  `)
  for (const p of policies) await exec(p.$.ddl((s) => s ?? 'public'))
  // design/20 §4's trigger goldens; the kit renders these files.
  await exec(`
    CREATE OR REPLACE FUNCTION "${NS}"."pgprime_set_updated_at"() RETURNS trigger
      LANGUAGE plpgsql AS $$
    BEGIN
      NEW."updated_at" := now();
      RETURN NEW;
    END
    $$;
    CREATE OR REPLACE TRIGGER "pgprime_set_updated_at" BEFORE UPDATE ON "${NS}"."documents"
      FOR EACH ROW EXECUTE FUNCTION "${NS}"."pgprime_set_updated_at"();
  `)
}, 120_000)

afterAll(async () => {
  if (!skip) {
    await exec(`drop schema if exists ${NS} cascade`).catch(() => {})
    await exec(`drop role if exists ${APP}`).catch(() => {})
    await exec(`drop role if exists ${OWNER}`).catch(() => {})
  }
  await h?.end()
})

describe('declared RLS policies', () => {
  it('filters by the setting; unset sees nothing', async () => {
    if (skip) return
    expect(await as(APP, orgId.set(A), titles)).toEqual(['a1', 'a2'])
    expect(await as(APP, orgId.set(B), titles)).toEqual(['b1'])
    expect(await as(APP, {}, titles)).toEqual([])
    const seen = await as(APP, orgId.set(A), (tx) =>
      tx
        .from(schema.h.documents)
        .select(() => ({ org: orgId.current() }))
        .limit(1)
        .execute(),
    )
    expect(seen).toEqual([{ org: A }])
  })

  it("a reused connection's '' placeholder reads as NULL, not 22P02", async () => {
    if (skip) return
    await as(APP, orgId.set(A), titles)
    expect(await as(APP, {}, titles)).toEqual([])
  })

  it('WITH CHECK refuses a row for another tenant (42501)', async () => {
    if (skip) return
    const err = await as(APP, orgId.set(A), (tx) =>
      tx
        .insertInto(schema.h.documents)
        .values({ id: 9, orgId: B, archived: false, title: 'x', updatedAt: new Date() })
        .execute(),
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InsufficientPrivilegeError)
  })

  it('the restrictive policy blocks updates of archived rows', async () => {
    if (skip) return
    const changed = await as(APP, orgId.set(A), (tx) =>
      tx
        .update(schema.h.documents)
        .set(() => ({ title: 'changed' }))
        .where(({ documents: d }) => eq(d.orgId, A))
        .returning(({ documents: d }) => ({ id: d.id }))
        .execute(),
    )
    expect(changed).toEqual([{ id: 1 }])
  })

  it('a qualified column survives a subquery whose table has the same column', async () => {
    if (skip) return
    const folderIds = (user: string) =>
      as(APP, userId.set(user), (tx) =>
        tx
          .from(schema.h.folders)
          .select(({ folders: f }) => ({ id: f.id }))
          .execute(),
      )
    expect(await folderIds('u1')).toEqual([{ id: 1 }])
    expect(await folderIds('u2')).toEqual([{ id: 2 }])
    // The unqualified spelling binds `org_id` to the inner table and matches every folder.
    const control = await exec(
      `select count(*) from ${NS}.folders where exists (select 1 from ${NS}.memberships m where m.org_id = org_id and m.user_id = 'u1')`,
    )
    expect(Number(control[0]?.[0])).toBe(2)
  })

  it('the trigger overwrites an explicit updated_at with now()', async () => {
    if (skip) return
    const [[bumped]] = (await exec(
      `update ${NS}.documents set updated_at = '2000-01-01' where id = 3 returning updated_at > now() - interval '1 minute'`,
    )) as [[unknown]]
    expect(bumped === 't' || bumped === true).toBe(true)
  })

  it('the owner bypasses RLS until FORCE', async () => {
    if (skip) return
    await exec(`alter table ${NS}.documents owner to ${OWNER}`)
    expect(await as(OWNER, orgId.set(A), titles)).toHaveLength(3)
    await exec(`alter table ${NS}.documents force row level security`)
    expect(await as(OWNER, orgId.set(A), titles)).toEqual([])
  })
})
