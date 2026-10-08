import { ownedSchemaSql } from 'pg-prime'
import type { OwnedMigration, OwnedSchemaFile } from 'pg-prime'

export const DEFAULT_SCHEMA = 'pgprime_outbox'

export const MIGRATIONS: readonly OwnedMigration[] = [
  {
    version: 1,
    name: 'outbox',
    up: (s) => [
      `create type ${s}.record_state as enum ('pending', 'delivered', 'parked')`,
      `create table ${s}.topics (
        name text primary key,
        partitions smallint not null check (partitions between 1 and 1024),
        paused boolean not null default false,
        keep_delivered_ms bigint not null default 86400000,
        maint_at timestamptz not null default '-infinity',
        created_at timestamptz not null default now()
      )`,
      `create table ${s}.records (
        id bigint generated always as identity primary key,
        topic text not null,
        key text,
        partition smallint not null,
        idem text not null,
        payload jsonb not null,
        headers jsonb,
        state ${s}.record_state not null default 'pending',
        attempts int not null default 0,
        next_at timestamptz not null default '-infinity',
        error text,
        created_at timestamptz not null default clock_timestamp(),
        delivered_at timestamptz,
        unique (topic, idem)
      ) with (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.02)`,
      `create index records_pending on ${s}.records (topic, partition, id) where state = 'pending'`,
      `create index records_parked on ${s}.records (topic, id) where state = 'parked'`,
      `create index records_kept on ${s}.records (topic, delivered_at) where state = 'delivered'`,
      `create table ${s}.partitions (
        topic text not null references ${s}.topics (name) on delete cascade,
        p smallint not null,
        owner text,
        token text,
        epoch bigint not null default 0,
        lease_until timestamptz,
        served_at timestamptz not null default '-infinity',
        primary key (topic, p)
      ) with (fillfactor = 50)`,
      `create table ${s}.relays (
        topic text not null references ${s}.topics (name) on delete cascade,
        owner text not null,
        seen_at timestamptz not null default now(),
        primary key (topic, owner)
      )`,
      `create table ${s}.blocked (
        topic text not null,
        key text not null,
        until timestamptz not null,
        attempts int not null,
        error text,
        primary key (topic, key)
      )`,
    ],
  },
]

/** The migrations as SQL files, for vendoring into a kit migrations directory. */
export function migrationSql(opts: { schema?: string } = {}): OwnedSchemaFile[] {
  return ownedSchemaSql({ schema: opts.schema ?? DEFAULT_SCHEMA, migrations: MIGRATIONS })
}
