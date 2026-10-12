import type { OwnedMigration } from 'pg-prime'

export const MIGRATIONS: readonly OwnedMigration[] = [
  {
    version: 1,
    name: 'events log',
    up: (s) => [
      `create table ${s}.topics (
        name text primary key,
        keep_ms bigint,
        keep_until_consumed boolean not null default false,
        maint_at timestamptz not null default '-infinity',
        created_at timestamptz not null default now()
      )`,
      `create table ${s}.entries (
        id bigint generated always as identity primary key,
        xid xid8 not null default pg_current_xact_id(),
        topic text not null,
        type text,
        key text,
        payload jsonb not null,
        headers jsonb,
        at timestamptz not null default clock_timestamp()
      )`,
      `create index entries_cursor on ${s}.entries (topic, xid, id)`,
      `create index entries_age on ${s}.entries (topic, at)`,
      `create table ${s}.subscriptions (
        topic text not null references ${s}.topics (name) on delete cascade,
        name text not null,
        types text[],
        last_xid xid8 not null,
        last_id bigint not null,
        pending xid8[] not null default '{}',
        pending_after bigint[] not null default '{}',
        token text,
        lease_until timestamptz,
        head_id bigint,
        head_size int not null default 0,
        head_attempts int not null default 0,
        head_retry_at timestamptz,
        updated_at timestamptz not null default now(),
        primary key (topic, name)
      ) with (fillfactor = 50)`,
      `create table ${s}.parked (
        topic text not null,
        subscription text not null,
        entry bigint not null,
        attempts int not null,
        error text,
        parked_at timestamptz not null default clock_timestamp(),
        primary key (topic, subscription, entry),
        foreign key (topic, subscription) references ${s}.subscriptions (topic, name) on delete cascade
      )`,
    ],
  },
]
