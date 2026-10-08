/**
 * Versioned DDL for a schema an add-on package owns (`pgprime_events`, `pgprime_mq`, …), with its
 * ledger in `<schema>.migrations`. Two paths that converge on the same ledger rows: the runtime
 * `migrateOwnedSchema`, and `ownedSchemaSql` for vendoring as kit migration files.
 */

import { ConfigError, UsageError } from '../errors/index.js'
import type { AnySchema } from '../schema/index.js'
import type { Db, Tx } from '../query/types.js'
import { sql } from '../sql/fragment.js'
import { quoteIdentPart, quoteStringLiteral } from '../sql/ident.js'
import { advisoryKey } from './transaction.js'

export interface OwnedMigration {
  /** 1, 2, 3, … strictly increasing. */
  readonly version: number
  readonly name: string
  /** The oldest client (by its latest known version) that still works on this schema. Default 1. */
  readonly minClient?: number
  /** One DDL statement per element; `schema` arrives quoted. */
  readonly up: (schema: string) => readonly string[]
}

export interface OwnedSchemaOptions {
  readonly schema: string
  readonly migrations: readonly OwnedMigration[]
}

export interface OwnedSchemaFile {
  readonly version: number
  readonly name: string
  readonly sql: string
}

interface Step {
  readonly version: number
  readonly name: string
  readonly minClient: number
  readonly statements: readonly string[]
  readonly checksum: string
}

interface LedgerRow {
  readonly version: number
  readonly min_client: number
  readonly checksum: string
}

/**
 * Applies every missing version, one transaction each, under `pg_advisory_xact_lock` (pooler
 * safe). With `apply: false` it only reads and checks the ledger: `to === from`.
 */
export async function migrateOwnedSchema<Sc extends AnySchema>(
  db: Db<Sc>,
  opts: OwnedSchemaOptions & { readonly apply?: boolean },
): Promise<{ from: number; to: number }> {
  const { q, key, steps } = plan(opts)
  const apply = opts.apply !== false
  let from: number | undefined
  for (;;) {
    const r = await db.transaction(async (tx) => {
      await tx.advisoryLock(key)
      const rows = await ledger(tx, q, apply)
      check(opts.schema, rows, steps)
      const have = rows.reduce((v, row) => Math.max(v, row.version), 0)
      const missing = apply
        ? steps.filter((s) => !rows.some((row) => row.version === s.version))
        : []
      const next = missing[0]
      if (next !== undefined) {
        for (const s of next.statements) await tx.sql`${sql.unsafeRaw(s)}`.execute()
        await tx.sql`insert into ${sql.unsafeRaw(q)}.migrations (version, name, min_client, checksum)
          values (${next.version}, ${next.name}, ${next.minClient}, ${next.checksum})`.execute()
      }
      return { have, to: Math.max(have, next?.version ?? 0), done: missing.length <= 1 }
    })
    from ??= r.have
    if (r.done) return { from, to: r.to }
  }
}

/** The same versions as SQL files; re-running one after the runtime applied it is a no-op ledger insert. */
export function ownedSchemaSql(opts: OwnedSchemaOptions): OwnedSchemaFile[] {
  const { q, key, steps } = plan(opts)
  return steps.map((s) => ({
    version: s.version,
    name: s.name,
    sql: [
      `select pg_catalog.pg_advisory_xact_lock(${key})`,
      ...bootstrap(q),
      ...s.statements,
      `insert into ${q}.migrations (version, name, min_client, checksum) values (${s.version}, ` +
        `${quoteStringLiteral(s.name)}, ${s.minClient}, '${s.checksum}') on conflict do nothing`,
    ]
      .map((t) => `${t};\n`)
      .join(''),
  }))
}

function plan(opts: OwnedSchemaOptions): { q: string; key: bigint; steps: Step[] } {
  const q = quoteIdentPart(opts.schema)
  let prev = 0
  const steps = opts.migrations.map((m) => {
    if (!Number.isInteger(m.version) || m.version <= prev) {
      throw new UsageError(
        `pg-prime: owned schema ${q}: migration versions must be integers, strictly increasing ` +
          `from 1; got ${m.version} after ${prev}.`,
      )
    }
    prev = m.version
    const statements = m.up(q)
    const checksum = BigInt.asUintN(64, advisoryKey(statements.join(';\n'))).toString(16)
    return { version: m.version, name: m.name, minClient: m.minClient ?? 1, statements, checksum }
  })
  return { q, key: advisoryKey(`pgprime-owned:${opts.schema}`), steps }
}

function bootstrap(q: string): string[] {
  return [
    `create schema if not exists ${q}`,
    `create table if not exists ${q}.migrations (version int primary key, name text not null, ` +
      `min_client int not null, checksum text not null, ` +
      `applied_at timestamptz not null default clock_timestamp())`,
  ]
}

async function ledger<Sc extends AnySchema>(
  tx: Tx<Sc>,
  q: string,
  create: boolean,
): Promise<readonly LedgerRow[]> {
  const [t] = await tx.sql`select to_regclass(${`${q}.migrations`}) is not null as ok`.execute()
  if ((t as { ok: boolean }).ok !== true) {
    if (!create) return []
    for (const s of bootstrap(q)) await tx.sql`${sql.unsafeRaw(s)}`.execute()
  }
  const rows = await tx.sql`select version, min_client, checksum
    from ${sql.unsafeRaw(q)}.migrations order by version`.execute()
  return rows as unknown as readonly LedgerRow[]
}

function check(schema: string, rows: readonly LedgerRow[], steps: readonly Step[]): void {
  const latest = steps.at(-1)?.version ?? 0
  for (const row of rows) {
    const s = steps.find((x) => x.version === row.version)
    if (s !== undefined && s.checksum !== row.checksum) {
      throw new ConfigError(
        `pg-prime: ${schema}.migrations version ${row.version} has checksum ${row.checksum}, but ` +
          `this client's "${s.name}" is ${s.checksum}. The applied DDL differs from the package's; ` +
          `restore it or rebuild the schema.`,
      )
    }
    if (row.min_client > latest) {
      throw new ConfigError(
        `pg-prime: schema ${schema} is at a version that needs a client of version ` +
          `${row.min_client} or later, and this one knows up to ${latest}. Upgrade the package.`,
      )
    }
  }
}
