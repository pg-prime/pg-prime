import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ConfigError } from '../../src/errors/index.js'
import { pgPrime } from '../../src/query/run.js'
import type { Db } from '../../src/query/types.js'
import { defineSchema } from '../../src/schema/index.js'
import { migrateOwnedSchema, ownedSchemaSql } from '../../src/session/owned-schema.js'
import type { OwnedMigration } from '../../src/session/owned-schema.js'
import { makeHarness, type Harness } from './_harness.js'

const NS = 'pgprime_live_owned'
const v1: OwnedMigration = {
  version: 1,
  name: 'init',
  up: (s) => [`create table ${s}.items (id int primary key)`],
}
const v2: OwnedMigration = {
  version: 2,
  name: 'label',
  up: (s) => [`alter table ${s}.items add column label text`, `create index on ${s}.items (label)`],
}

let h: Harness
let db: Db

async function exec(text: string): Promise<readonly (readonly unknown[])[]> {
  const conn = await h.driver.acquire()
  try {
    return (await conn.execute({ text, params: [], mode: 'simple' })).rows
  } finally {
    await h.driver.release(conn)
  }
}

const ledger = async () =>
  (await exec(`select version, name, min_client from ${NS}.migrations order by version`)).map((r) =>
    r.map(String).join(':'),
  )

beforeAll(async () => {
  h = await makeHarness(2)
  db = pgPrime({ driver: h.driver, schema: defineSchema({}) })
}, 120_000)

beforeEach(async () => {
  await exec(`drop schema if exists ${NS} cascade`)
})

afterAll(async () => {
  await exec(`drop schema if exists ${NS} cascade`).catch(() => {})
  await h?.end()
})

describe('migrateOwnedSchema', () => {
  it('creates the schema and ledger, applies each version once, and is idempotent', async () => {
    expect(await migrateOwnedSchema(db, { schema: NS, migrations: [v1] })).toStrictEqual({
      from: 0,
      to: 1,
    })
    expect(await migrateOwnedSchema(db, { schema: NS, migrations: [v1, v2] })).toStrictEqual({
      from: 1,
      to: 2,
    })
    expect(await migrateOwnedSchema(db, { schema: NS, migrations: [v1, v2] })).toStrictEqual({
      from: 2,
      to: 2,
    })
    expect(await ledger()).toStrictEqual(['1:init:1', '2:label:1'])
    await exec(`insert into ${NS}.items (id, label) values (1, 'x')`)
  })

  it('apply: false reads without creating anything', async () => {
    const opts = { schema: NS, migrations: [v1, v2], apply: false }
    expect(await migrateOwnedSchema(db, opts)).toStrictEqual({ from: 0, to: 0 })
    expect(await exec(`select to_regnamespace('${NS}')`)).toStrictEqual([[null]])
    await migrateOwnedSchema(db, { schema: NS, migrations: [v1] })
    expect(await migrateOwnedSchema(db, opts)).toStrictEqual({ from: 1, to: 1 })
  })

  it('refuses a checksum mismatch', async () => {
    await migrateOwnedSchema(db, { schema: NS, migrations: [v1] })
    const edited = { ...v1, up: (s: string) => [`create table ${s}.items (id bigint primary key)`] }
    await expect(migrateOwnedSchema(db, { schema: NS, migrations: [edited] })).rejects.toThrow(
      ConfigError,
    )
  })

  it('a newer schema serves an older client until min_client says otherwise', async () => {
    await migrateOwnedSchema(db, { schema: NS, migrations: [v1, v2] })
    expect(await migrateOwnedSchema(db, { schema: NS, migrations: [v1] })).toStrictEqual({
      from: 2,
      to: 2,
    })
    const v3: OwnedMigration = { version: 3, name: 'break', minClient: 3, up: () => [] }
    await migrateOwnedSchema(db, { schema: NS, migrations: [v1, v2, v3] })
    const err = await migrateOwnedSchema(db, { schema: NS, migrations: [v1, v2] }).catch((e) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect((err as Error).message).toMatch(/Upgrade the package/)
  })

  it('vendored SQL and the runtime converge on the same ledger', async () => {
    const [file1, file2] = ownedSchemaSql({ schema: NS, migrations: [v1, v2] })
    await exec(`begin; ${file1!.sql} commit;`)
    expect(await migrateOwnedSchema(db, { schema: NS, migrations: [v1, v2] })).toStrictEqual({
      from: 1,
      to: 2,
    })
    expect(await ledger()).toStrictEqual(['1:init:1', '2:label:1'])
    // The ledger row of an already-applied version is a no-op; its DDL is not idempotent.
    await expect(exec(`begin; ${file2!.sql} commit;`)).rejects.toThrow()
    await exec('rollback').catch(() => {})
  })
})
