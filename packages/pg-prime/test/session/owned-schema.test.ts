import { describe, expect, it } from 'vitest'
import { UsageError } from '../../src/errors/index.js'
import { InvalidIdentifierError } from '../../src/sql/index.js'
import { ownedSchemaSql } from '../../src/session/owned-schema.js'
import type { OwnedMigration } from '../../src/session/owned-schema.js'
import { advisoryKey } from '../../src/session/transaction.js'

const migrations: OwnedMigration[] = [
  { version: 1, name: 'init', up: (s) => [`create table ${s}.t (id int primary key)`] },
  { version: 2, name: "it's", minClient: 2, up: (s) => [`alter table ${s}.t add column v text`] },
]

describe('ownedSchemaSql', () => {
  it('emits lock, bootstrap, the DDL and an idempotent ledger row per version', () => {
    const files = ownedSchemaSql({ schema: 'pgprime_x', migrations })
    expect(files.map((f) => [f.version, f.name])).toStrictEqual([
      [1, 'init'],
      [2, "it's"],
    ])
    const lines = files[1]!.sql.trimEnd().split('\n')
    expect(lines[0]).toBe(
      `select pg_catalog.pg_advisory_xact_lock(${advisoryKey('pgprime-owned:pgprime_x')});`,
    )
    expect(lines[1]).toBe('create schema if not exists "pgprime_x";')
    expect(lines[2]).toMatch(
      /^create table if not exists "pgprime_x"\.migrations \(version int primary key/,
    )
    expect(lines[3]).toBe('alter table "pgprime_x".t add column v text;')
    expect(lines[4]).toMatch(
      /^insert into "pgprime_x"\.migrations \(version, name, min_client, checksum\) values \(2, 'it''s', 2, '[0-9a-f]+'\) on conflict do nothing;$/,
    )
  })

  it('checksums depend on the DDL, so an edited migration is detectable', () => {
    const sum = (up: OwnedMigration['up']): string =>
      /'([0-9a-f]+)'\) on conflict/.exec(
        ownedSchemaSql({ schema: 's', migrations: [{ version: 1, name: 'a', up }] })[0]!.sql,
      )![1]!
    expect(sum(() => ['select 1'])).toBe(sum(() => ['select 1']))
    expect(sum(() => ['select 1'])).not.toBe(sum(() => ['select 2']))
  })

  it('quotes the schema and refuses one that is not an identifier', () => {
    const [f] = ownedSchemaSql({ schema: 'we"ird', migrations: migrations.slice(0, 1) })
    expect(f!.sql).toContain('create table "we""ird".t')
    expect(() => ownedSchemaSql({ schema: '', migrations })).toThrow(InvalidIdentifierError)
  })

  it('refuses versions that are not strictly increasing integers', () => {
    const bad = (versions: number[]) => () =>
      ownedSchemaSql({
        schema: 's',
        migrations: versions.map((version) => ({ version, name: 'm', up: () => [] })),
      })
    expect(bad([1, 1])).toThrow(UsageError)
    expect(bad([2, 1])).toThrow(UsageError)
    expect(bad([0])).toThrow(UsageError)
    expect(bad([1.5])).toThrow(UsageError)
    expect(bad([1, 3])()).toHaveLength(2)
  })
})
