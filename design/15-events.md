# 15 — `@pg-prime/events`: typed channels, a durable event log, pub/sub. Design & Implementation Plan

2026-10-08. Branch `feat/mq`. **Status: PLAN — for revmux review before any code.**

This is the first of four sibling plans:
- **15 events** — the base layer;
- [16 outbox](./16-outbox.md);
- [17 mq](./17-mq.md);
- [18 cron](./18-cron.md).

§0 below holds what is shared by all four: the package graph, the shared helpers, the ledgers and
the cross-plan order. The other plans refer to it rather than repeat it.

`@pg-prime/events` gives a pg-prime application three things:
- **typed channels** (LISTEN/NOTIFY with reconnect and `gap`);
- a **durable event log** (topics) with named **subscriptions** that keep offsets, acknowledge,
  retry, park poison entries and resume from any cursor;
- **ephemeral tails** that heal gaps from the log.

Every write can join the caller's pg-prime transaction. The package has no runtime dependencies,
and a channels-only user never touches a table.

---

## 0. The family (applies to plans 15–18)

### 0.1 Packages and dependency graph

```
                         pg-prime  (peer of every package below)
                            │
        ┌───────────────────┼─────────────────────┬──────────────────────┐
        ▼                   ▼                     ▼                      ▼
 @pg-prime/events     @pg-prime/outbox       @pg-prime/cron ─ ─ ─ ─ ▶ @pg-prime/mq
   (no deps)            (no deps)            dep: croner        optional peer,
        ▲                                                       structural use only
        │ dependency
 @pg-prime/mq
```

| Package | Runtime `dependencies` | Peers | Why this edge |
|---|---|---|---|
| `@pg-prime/events` | — | `pg-prime` | base layer |
| `@pg-prime/outbox` | — | `pg-prime` | Independent of events (16 X1): its claim model (per-key ordering across parallel relays) shares no code with the log, and its 40-line wake-up loop is cheaper to own than a dependency |
| `@pg-prime/mq` | `@pg-prime/events` | `pg-prime` | wake-ups, the history stream and topic→queue bindings come from events (17 D2). A real dependency, so `npm i @pg-prime/mq` is one command |
| `@pg-prime/cron` | `croner` | `pg-prime`; `@pg-prime/mq` **optional** | the queue target takes any object structurally matching `CronEnqueuer`; cron's `dist` never imports mq (18 C-D2) |

**Events and outbox stay independent in both directions.** An outbox *sink* that appends to an
events topic is 10 lines of user code over 16's `OutboxSink`, kept as a docs recipe. The events log
does not use the outbox, because `publish(…, { tx })` is already a single insert in the caller's
transaction and has nothing to relay.

**Package count.** design/08 §1.1 caps the **core** at six packages and exempts add-ons: an add-on
peers `pg-prime`, joins the `fixed` group, keeps minimal deps and has its own budget. These four are
add-ons under that rule.

### 0.2 Shared pieces — where they live

| Piece | Decision | Reason |
|---|---|---|
| Migration ledger + runner | **`migrateOwnedSchema()` / `ownedSchemaSql()` in `pg-prime` core** (S0) | Every package already peers `pg-prime`. A shared internal package cannot be inlined into unbundled `tsc` output, so it would have to be another published package |
| ListenHub per-subscription `gap` | **fixed in core** (S0) | Today the hub keeps one emitter per channel: a second `subscribe` replaces the first one's `gap`/`reconnect`/`error` handlers (`session/listen.ts` ~114, recorded in `listen.md` Gotchas). Every family package has several subscribers per channel |
| Error base | `PgPrimeError` (core); code prefixes `EVENTS_`, `OUTBOX_`, `MQ_`, `CRON_` | already the hierarchy root |
| Schema-name option | `schema?: string`, validated with core's `sql.ident` | nothing to share beyond core |
| DB-clock helpers, backoff formula | **duplicated, deliberately** (each package): `ms(n)`, returning `now()` as `db_now`, and a 6-line `backoffMs({ baseDelayMs, maxDelayMs, jitter }, attempt, random)`, tested against fixed vectors that S0 publishes as a test fixture | core's `retryDelayMs` is private; exporting it for 6 lines is not worth an API. `assertPayloadSize` is not needed: `db.notify` already applies it |
| Wake-up loop (LISTEN + `gap` + poll timer) | exported by events as `waker()`, used by mq; outbox and cron each own a ~40-line copy | keeps outbox and cron free of events |

### 0.3 Schemas, ledgers, start-up

**Each package owns its schema and a ledger table inside it:** `pgprime_events`, `pgprime_outbox`,
`pgprime_mq`, `pgprime_cron`, each with `<schema>.migrations`. Rejected: one shared ledger keyed by
package. It needs a schema some package must own, couples lock keys, and makes uninstalling more
than `drop schema … cascade`. Kit's `schemas` must not list these.

`migrateOwnedSchema(db, { schema, migrations })`:
- runs one transaction per version under `tx.advisoryLock('pgprime-owned:' + schema)` (xact
  family, so it is transaction-pooler safe);
- creates `<schema>.migrations (version int pk, name, min_client, checksum, applied_at)`;
- refuses a checksum mismatch;
- returns `{ from, to }`.

**Transactional versions only.** A `create index concurrently` cannot run under an xact lock, so a
future need for one is a deliberate new decision, not a helper flag.

`ownedSchemaSql()` emits the same SQL with an `insert … on conflict do nothing` ledger row, so a
kit user can vendor it as migration files; both paths converge.

**Start-up rule (all four):** `await x.start()` once at boot does `ensure` (migrate when
`autoMigrate`, default **true**, else `SchemaVersionError`; `max(min_client)` above the client →
"upgrade the package") and the declaration upserts, on the root handle **outside any transaction**.

- A call carrying `{ tx }` before `start()` resolved throws `NotStartedError` (a `UsageError`)
  naming the fix. It never lazily migrates from inside the caller's transaction: that would wait for
  a second pool connection while the caller holds one, which deadlocks `max: 1` pools such as
  `presets.serverless()`, and it would trip pg-prime's dev guard.
- Calls without `tx` may start lazily.

### 0.4 Packaging rules (all four)

- ESM-only, `types@<5.9` gate, `isolatedDeclarations`, `sideEffects: false`, Node ≥ 22.12,
  **Bun 1.4.2 gated in CI**.
- **Peer `pg-prime: ">=0.2.0"`** — the release that ships S0. An open-ended floor never goes out of
  range, so changesets' peer major-bump rule does not trigger.
- **All four join the `fixed` group**; first publish at the group's next version (**0.2.0**).
- RELEASING §1's manual placeholder publish and trusted-publisher setup are needed for each (a
  human step).

**Tree-shake gates measure what the API allows.** The APIs are handle objects
(`pgEvents(…).topic(def).publish`), and design/08 §2.4 already measured that methods on a returned
handle keep every implementation reachable. So the fixtures do **not** claim producer-only
exclusions. Each fixture is the package's typical import:
- `events-basic`: `pgEvents` + a channel + a topic `publish`;
- `outbox-write`: `pgOutbox` + `write`;
- `mq-send`: `pgMq` + `send`;
- `cron-define`: `pgCron` + `defineSchedule`.

Each is gated by a min+gz **delta over pg-prime's own root bundle** and by the module-set golden,
which catches any module that appears. Splitting the API into separately importable functions was
rejected: it doubles the surface for a few KB.

| Package | Unpacked budget | Install footprint (own project: pkg + its deps, excl. pg-prime) | Tree-shake delta (min+gz, over pg-prime) |
|---|---|---|---|
| events | ≤ 150 KB | ≤ 200 KB | ≤ 12 KB |
| outbox | ≤ 120 KB | ≤ 150 KB | ≤ 10 KB |
| mq | ≤ 350 KB | ≤ 600 KB (incl. events) | ≤ 30 KB (incl. events) |
| cron | ≤ 150 KB | ≤ 350 KB (incl. croner ≈ 155 KB) | ≤ 20 KB (incl. croner) |

All numbers are design targets, ratcheted at the first measurement (the `budgets.json` rule).

### 0.5 Cross-plan rules that hold everywhere

1. **DB clock only.** Comparisons use `now()`, recorded times use `clock_timestamp()`, and client
   clocks only time durations.
2. **One statement or one short transaction per transition.** No PL/pgSQL; statements are CTEs
   built in TS on pg-prime's `sql` tag and labelled `<pkg>.<op>`.
3. **Gate only on counters of rows the statement locks.** At READ COMMITTED a statement's snapshot
   predates its lock wait, and EvalPlanQual re-reads only the locked row. Any check that must see
   *other* rows' latest state runs as lock-then-read: `select … for update` in statement 1, read in
   statement 2 of the same short transaction.
4. **Token-guarded writes** (`WHERE … AND token = $tok`), with `RETURNING` as the check; 0 rows is
   a typed `*LeaseLostError`. **Every side-effect CTE of a guarded statement is driven by the
   guarded `RETURNING`**, because data-modifying CTEs always run.
5. **NOTIFY carries ids or nothing** for engine wake-ups, and **polling is always the fallback**.
   Behind PgBouncer transaction mode, LISTEN needs pg-prime's `directConnection`; otherwise
   everything polls. User channels carry user payloads by definition.
6. **Traps:** an unreferenced `SELECT` CTE is not executed (reference every `pg_notify` CTE from the
   final `SELECT`), and **no statement modifies one row twice**. Updating *different* rows of one
   table is fine; mq's child settle plus parent release (`done` + `pr`) relies on it. A golden test
   per package asserts, for every fragment combination, that no two data-modifying CTEs can target
   the same row. Same-row pairs are identified by their key, e.g. two updates of `queues` keyed by
   the same `$q`.

### 0.6 Cross-plan workstream order

```
S0 core: migrateOwnedSchema + ListenHub per-subscription gap ─┐
F0 tooling (all shared tool/CI/budget/release files, all 4 slots) ─┴─▶ E0 events skeleton + channels + waker
   ├─▶ E1 log + subscriptions + tails ────────────────────────────┐
   ├─▶ M0–M4 mq core (needs E0 only) ─────────────────────────────┼─▶ M5 mq: history + bind (needs E1)
   ├─▶ O0–O3 outbox (needs S0/F0 only) ──────────────────────────┤
   └─▶ C0–C3 cron core (needs S0/F0 only) ────────────────────────┴─▶ C4 cron → mq target (needs M1, M3)
```

- **S0** (core, one agent) does two things. It adds `migrateOwnedSchema`/`ownedSchemaSql` with tier-1
  and tier-2 tests (5 concurrent migrators). It fixes ListenHub to one emitter per subscription:
  `gap`, `reconnect` and `error` fan out to every subscription of a channel, and a subscription's
  emitter is removed on its own close. The tier-2 test is "two subscribers on one channel both get
  `gap` after `pg_terminate_backend`". It ships the `backoffMs` fixed-vector fixture and a
  `pg-prime` minor changeset.
- **F0** (tooling, one agent, before any package skeleton) owns every shared file, so E0/O0/M0/C0
  only touch their own package directory, their own golden and their own docs pages:
  - `tools/treeshake-check.mjs`: multi-package staging (a fixture may resolve sibling packages)
    and delta-over-pg-prime budgets;
  - `tools/pack-smoke.mjs`: **one throwaway project per package**, holding only that tarball, its
    in-repo deps and pg-prime. It runs the footprint assertion there; cron's project is installed
    without mq;
  - `tools/size-budget.mjs`: an exact `dependencies` list and peer checks independent of
    `zeroDependencies`;
  - package lists made data-driven in `api-snapshot`, `check-dts`, `emit-parity`, `docs-coverage`,
    `docs-typecheck`, `docs-signatures`;
  - `knip.json` workspaces;
  - `ci.yml` (bun filters and tier-2 steps for all four, `PG_PRIME_TEST_PGBOUNCER_URL`);
  - `ci-nightly.yml` bench artifacts;
  - `.changeset/config.json` (`fixed` += the four) and RELEASING rows.

  F0 seeds the four packages' entries (empty goldens, design budgets), so no later workstream edits
  these files.
- **Integration order:** S0 → F0 → events → outbox ∥ mq core ∥ cron core → mq M5 → cron C4.

Every agent prompt carries the code-style rule: simple, clean, short; comments only for a
non-obvious reason, workaround or trap; no history or ticket ids in comments.

---

## 1. Decisions for events

| # | Decision | One-line reason |
|---|---|---|
| E-D1 | **Pub/sub lives here, not in mq.** A topic is a log. A **subscription** is a durable named cursor: ack = offset commit, nack = retry with backoff, then park the poison entry, with resume from any `Entry.cursor`. A **tail** is an in-memory cursor | Pub/sub's core *is* the log plus cursors. Putting it in mq would make every pub/sub user install a queue engine. Competing-consumer fan-out (parallel workers per subscription, priorities, groups) is mq's job, reached with `mq.bind()` (17) |
| E-D2 | **One active reader per subscription** (a lease on its row). Parallelism comes from several subscriptions or from an mq binding | Ordered delivery and a single offset need a single reader. Partitioned consumer groups are out of v0 (E-Q3) |
| E-D3 | **Cursor = position `(last_xid, last_id)` plus `pending`: the transactions below the position that were still running at a read, each with its own progress `after_id`** (§3.3). Not a bare `xmin` watermark. The whole cursor is exposed as an opaque `cursor` string on every delivered entry | Exact even with per-entry commits inside a late transaction, and **not delayed by unrelated long transactions**, which an `xmin` watermark is. An opaque cursor is the only correct replay handle, because ids follow neither xid order nor commit order |
| E-D4 | `entries` is **append-only** (never updated); retention is a range delete; no partitioning in v0 | No update bloat; E-Q2 covers time partitions |
| E-D5 | Payload `jsonb`, typed by the declaration (`defineTopic<T>` or inferred from a Standard Schema validator; the interface is copied as a type, no dependency); optional `codec`; default 1 MiB limit; `\u0000` refused with path | typed with zero deps |
| E-D6 | Engine channels `ev_` + 24 hex chars of `sha256(schema '/' kind '/' name)` (same in SQL and TS; topics use kind `t`). **User channels use their literal name** | Fixed-length, schema-isolated engine names; a SQL trigger can `pg_notify('cache-bust', …)` into a typed channel |
| E-D7 | **Building blocks exported for sibling packages**: `waker()`, `engineChannel()`/`engineChannelSql()`, the subscription API. Documented and in the API golden | mq reuses them instead of duplicating (0.1) |

---

## 2. Data model — migration v1 (`pgprime_events`)

Channels need none of this. The schema is created on the first log operation.

```sql
create table pgprime_events.topics (
  name       text primary key,
  keep_ms    bigint,                               -- null: forever
  keep_until_consumed boolean not null default false,
  maint_at   timestamptz not null default '-infinity',
  created_at timestamptz not null default now()
);

create table pgprime_events.entries (
  id      bigint generated always as identity primary key,
  xid     xid8 not null default pg_current_xact_id(),
  topic   text not null,
  type    text,
  key     text,
  payload jsonb not null,
  headers jsonb,
  at      timestamptz not null default clock_timestamp()
);
create index entries_cursor on pgprime_events.entries (topic, xid, id);
create index entries_age    on pgprime_events.entries (topic, at);

create table pgprime_events.subscriptions (
  topic        text not null references pgprime_events.topics (name) on delete cascade,
  name         text not null,
  types        text[],                             -- null: every type
  last_xid     xid8 not null,
  last_id      bigint not null,
  pending      xid8[] not null default '{}',       -- late transactions below the position …
  pending_after bigint[] not null default '{}',    -- … and the last id delivered from each (0: none)
  token        text,
  lease_until  timestamptz,                        -- in no index: heartbeats stay HOT
  head_id      bigint,                             -- first entry of the batch being attempted
  head_size    int not null default 0,             -- its size; > 1 means a batch attempt (never charged)
  head_attempts int not null default 0,            -- written BEFORE each attempt (§3.4)
  head_retry_at timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (topic, name)
) with (fillfactor = 50);

create table pgprime_events.parked (
  topic        text not null,
  subscription text not null,
  entry        bigint not null,
  attempts     int not null,
  error        text,
  parked_at    timestamptz not null default clock_timestamp(),
  primary key (topic, subscription, entry),
  foreign key (topic, subscription) references pgprime_events.subscriptions (topic, name) on delete cascade
);
```

`fillfactor 50` on `subscriptions`: commits and heartbeats are HOT updates. `entries` is
insert-only, so default fillfactor is right. A parked entry keeps its `entries` row alive: topic
retention skips ids present in `parked`.

---

## 3. Statements

### 3.1 Publish (P1) — one statement, works inside the caller's transaction

```sql
with e as (
  insert into pgprime_events.entries (topic, type, key, payload, headers)
  select $t, r.type, r.key, coalesce(r.payload, 'null'::jsonb), r.headers
  from rows from (jsonb_to_recordset($rows) as (type text, key text, payload jsonb, headers jsonb))
       with ordinality as r(type, key, payload, headers, n)
  order by r.n
  returning id
)
select array_agg(id order by id) as ids,
       (select pg_notify($chan, '') where exists (select from e)) is not null as woke
from e
```

- Within one transaction PostgreSQL collapses identical NOTIFYs, so a transaction that publishes
  1 000 entries sends one wake-up.
- Topic rows are upserted by `start()` (§0.3), outside any caller transaction, so P1 never takes a
  lock on `topics`.
- `jsonb_to_recordset` turns a JSON `null` payload into SQL NULL; the `coalesce` stores it as
  `'null'::jsonb`.

### 3.2 Subscription lease (L1), heartbeat (L2), release

```sql
-- L1: take or steal an expired lease; returns the cursor
update pgprime_events.subscriptions set token = gen_random_uuid()::text,
       lease_until = now() + $lease * interval '1 ms'
where topic = $t and name = $s and (token is null or lease_until < now())
returning token, last_xid, last_id, pending, pending_after, types, head_id, head_attempts, head_retry_at, now() as db_now
-- L2: extend; 0 rows → EventsLeaseLostError, the reader stops
update pgprime_events.subscriptions set lease_until = now() + $lease * interval '1 ms'
where topic = $t and name = $s and token = $tok returning 1
```

Standby instances retry L1 every `leaseMs / 2`. `close()` sets `token = null, lease_until = null`,
so a standby takes over at its next attempt rather than after expiry. Once L2 or the handler's C1
(`ctx.commit`, even if the handler catches its error) returns 0 rows, the reader calls the handler
for no further entry of its batch; `close()` still lets a batch finish, since the lease is held
until release.

### 3.3 Read (R1) — the exact cursor (E-D3)

One statement. Its rows and `pg_current_snapshot()` share the statement's snapshot. W-E1 asserts
this on PG 15–18 and falls back to a `repeatable read, read only` transaction if any version
disagrees (E-Q1).

```sql
with late as (                                    -- unread entries of transactions in `pending`
  select e.* from unnest($pending::xid8[], $pending_after::bigint[]) as p(xid, after)
  cross join lateral (
    select * from pgprime_events.entries e
    where e.topic = $t and e.xid = p.xid and e.id > p.after
    order by e.id limit $n
  ) e
  order by e.xid, e.id limit $n
), next as (                                      -- unfiltered, so the position advances past other types
  select * from pgprime_events.entries
  where topic = $t and (xid, id) > ($last_xid, $last_id)
  order by xid, id limit $n - (select count(*) from late)
), pos as (
  select xid, id from next order by xid desc, id desc limit 1
), cut as (                                       -- the last late row, only when `late` is full
  select xid, id from late order by xid, id offset $n - 1
)
select m.pos_xid, m.pos_id, m.late_xid, m.late_id, m.running, x.*
from (select (select xid from pos) as pos_xid, (select id from pos) as pos_id,
             (select xid from cut) as late_xid, (select id from cut) as late_id,
             array(select pg_snapshot_xip(pg_current_snapshot())) as running) m
left join (select * from late union all select * from next) x
  on $types::text[] is null or x.type = any($types)
order by x.xid, x.id
```

There is always exactly one row from `m`; the entry columns are null when nothing matched.
`pg_snapshot_xip` lists only running xids below the snapshot's `xmax`; a running xid at or above it
is above every visible entry, so no position can step over it (as built: verified on PG 15–18).

Entries are delivered in result order: `late` units first, then `next`. Together they return at
most `$n` rows, `late` first, so a large transaction that commits late arrives in batches of `$n`
and an isolating reader (`$n = 1`) reads one row per step. The lateral bounds each pending
transaction's index scan to `$n` rows as well.

**The cursor after acknowledging an entry `e`** is a pure function `advance(cursor, read, e)`
(`log/cursor.ts`, property-tested):
- `e` from `late` → that xid's `after = e.id`.
- `e` from `next` → position = `(e.xid, e.id)`, **and every xid in the read's `running` set below
  `e.xid` that is not already pending is added with `after = 0`**. The addition is part of the
  same step, so every persisted or exposed cursor (C1, K1, `Entry.cursor`) already remembers the
  transactions it stepped over while they were open.
- **Whole-read step `advanceTo(cursor, read)`**, once every delivered entry of the read is
  acknowledged, and **even when the read delivered nothing** (e.g. every entry was filtered out by
  `types`):
  1. position = `(pos_xid, pos_id)` when `next` was non-empty;
  2. add every `running` xid below `pos_xid` that is not pending, with `after = 0`;
  3. prune: a pending xid not in `running` is finished, so all its entries are visible, and `late`
     reads them in `(xid, id)` order. When `late` was not full (`late_xid` null), every such xid had
     all its entries in it and is dropped. When it was full, xids below `late_xid` are dropped,
     `late_xid` keeps `after = late_id`, and xids above it keep their `after` for the next read.
     Pending xids still in `running` keep their `after`.

  The result is persisted with C1, so a filtered-out batch moves the subscription forward without
  stepping over open transactions.

**Fresh cursors** are seeded from one snapshot, `s = pg_current_snapshot()`:
- `from: 'now'` → position `(pg_snapshot_xmax(s), 0)`, and pending = the running xids
  (`pg_snapshot_xip(s)`) with `after = 0`;
- `'beginning'` → position `(0, 0)`, empty pending;
- `{ after: cursor }` → the decoded cursor.

Why nothing is lost or duplicated:
1. A transaction that became visible since the last read either has an xid above the position
   (read by `next`), or was running below it (it is in `pending`; `late` reads what is left of it).
2. A transaction with no xid yet gets one ≥ the snapshot's `xmax` > position′.
3. Per-entry progress (`after`) makes a commit or park in the middle of a late unit exact.
4. Aborted or entry-less transactions leave `pending` once they stop running, so `pending` is
   bounded by the number of concurrent transactions.

**Ordering contract:** each entry is delivered once per cursor. A producer transaction's entries
arrive in insertion order. As built: they do **not** always arrive together — `next`'s limit can
split a transaction, and a late transaction's entries are then delivered between its parts (the
property test found it; the plan's "together" was wrong). There is no total order across concurrent
transactions (none exists before commit). Every delivered `Entry` carries `cursor`: the opaque, serialized cursor
state right after that entry. That is the only valid replay or resume handle.

### 3.4 Commit (C1), retry and park

```sql
-- A1: attempt marker, written BEFORE the handler runs (so a process-killing attempt is still recorded).
-- Only single-entry attempts are charged; a multi-entry batch records itself with head_attempts = 0.
update pgprime_events.subscriptions set head_id = $first, head_size = $size,
       head_attempts = case when $size > 1 then 0
                            when head_id = $first and head_size = 1 then head_attempts + 1
                            else 1 end
where topic = $t and name = $s and token = $tok
returning head_attempts

-- C1: advance; may run inside the handler's own transaction (ctx.commit({ tx }))
update pgprime_events.subscriptions set last_xid = $lx, last_id = $li, pending = $pending,
       pending_after = $pending_after, head_id = null, head_attempts = 0, head_retry_at = null, updated_at = now()
where topic = $t and name = $s and token = $tok
returning 1                                       -- 0 rows → EventsLeaseLostError; the caller's tx rolls back

-- nack (handler threw): only the delay; the attempt was already counted by A1
update pgprime_events.subscriptions set head_retry_at = now() + $delay * interval '1 ms'
where topic = $t and name = $s and token = $tok returning 1

-- K1 park: the parked row is driven by the guarded UPDATE's RETURNING (15 §0.5 rule 4)
with c as (
  update pgprime_events.subscriptions set last_xid = $lx, last_id = $li, pending = $pending,
         pending_after = $pending_after, head_id = null, head_attempts = 0, head_retry_at = null
  where topic = $t and name = $s and token = $tok
  returning topic, name
)
insert into pgprime_events.parked (topic, subscription, entry, attempts, error)
select topic, name, $entry, $attempts, $err from c
on conflict (topic, subscription, entry) do update set attempts = excluded.attempts, error = excluded.error, parked_at = clock_timestamp()
returning 1                                       -- 0 rows only when the lease guard failed
```

**A throw after `ctx.commit({ tx })`.** The handler's transaction may have committed (a later
throw, or an `IndeterminateCommitError` whose COMMIT landed) or rolled back. The reader cannot tell
from memory, so it reads the stored cursor under its token with `for share`, which waits for that
transaction to end. If the stored cursor is one of the attempt's per-entry cursors, everything up to
it counts as acknowledged; it is not redelivered and the cursor is never rewound. A failure on an
entry that is already acknowledged this way is not retried.

**Finding the poison entry.** A failure is never charged to a whole batch:
- **Isolation.** A multi-entry attempt that throws, or whose marker is found still set at the next
  read or lease takeover (it crashed), switches the reader to **isolation**. That means batch size
  1 for the next `head_size` entries. Nothing is charged for the batch failure.
- As built: a marker found at takeover isolates `head_size` entries **whatever its size** (also 1),
  and a failed single-entry attempt keeps the reader isolated until that entry succeeds or is
  parked. Otherwise the next, larger batch re-marks `head_size > 1`, resets `head_attempts`, and the
  entry is never parked.
- **Charging.** In isolation each entry gets its own A1 (`$size = 1`), so `head_attempts` counts
  real attempts of that one entry, crashes included. Before invoking, the reader parks the entry
  (K1) instead when the count A1 returns exceeds `maxAttempts`. With `maxAttempts: 1`, an innocent
  head entry is therefore re-run once by itself and never parked unseen. An entry re-delivered after a `reset` that fails again re-parks over its existing row
(`do update`), so the only 0-row case is a lost lease.

### 3.5 Retention (gated per topic by a `topics.maint_at` CAS; batched)

```sql
delete from pgprime_events.entries where id in (
  select id from pgprime_events.entries e
  where e.topic = $t and e.at < now() - $keep_ms * interval '1 ms'
    and not exists (select from pgprime_events.parked p where p.topic = $t and p.entry = e.id)
    and (not $until_consumed or not exists (
          select from pgprime_events.subscriptions s
          where s.topic = $t and ((e.xid, e.id) > (s.last_xid, s.last_id) or e.xid = any(s.pending))))
  order by id limit 1000)
```

A subscription whose position fell behind plain `keepMs` retention reports
`onInternal('subscription-behind-retention')` and continues from the oldest surviving entry.

---

## 4. Channels

- `defineChannel<T>(name, { schema?, codec? })`: `name` is the literal NOTIFY channel, validated as
  ≤ 63 UTF-8 bytes.
- `channel.notify(payload, { tx })` encodes and validates, then calls pg-prime's `db.notify` /
  `tx.notify`, which enforces the < 8000 B limit itself.
- `channel.listen(handler, { signal, onGap })` runs pg-prime's `db.listen`, then decodes and
  validates each payload. An invalid payload goes to the `error` hook, not the handler. `gap`
  reaches `onGap({ downMs })`.
- Delivery is live only, which is the contract: anything that must survive a disconnect is a topic.
- **`waker(db, chan, { pollMs, signal })`** (exported) is an async iterable that yields
  `'notify' | 'gap' | 'poll'`. It listens on `chan` when the pooler profile allows and degrades to
  pure polling with one `onInternal('listen-unavailable')` otherwise. mq's workers and events'
  subscriptions/tails all use it, often several per channel in one process. Each one gets its own
  `gap` thanks to S0's ListenHub fix (§0.6).

---

## 5. Public API

```ts
import type { Db, Queryable, Subscription as PgSubscription } from 'pg-prime'

export interface PayloadOptions<T> {
  schema?: StandardSchemaV1<unknown, T>
  codec?: { encode(v: T): unknown; decode(v: unknown): T }
}
export function defineChannel<T>(name: string, opts?: PayloadOptions<T>): ChannelDef<T>
export function defineTopic<T>(name: string, opts?: PayloadOptions<T> & { keepMs?: number | null; keepUntilConsumed?: boolean }): TopicDef<T>
export function defineSubscription<T>(topic: TopicDef<T>, name: string, opts?: {
  types?: readonly string[]
  from?: 'beginning' | 'now'                                       // first creation only
  retry?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; jitter?: 'full' | 'equal' | 'none' }
}): SubscriptionDef<T>

export interface EventsConfig<D extends EventsDefinitions> {
  db: Db
  schema?: string                                                  // 'pgprime_events'
  autoMigrate?: boolean                                            // true
  define?: D                                                       // { channels?, topics?, subscriptions? }
  hooks?: EventsHooks
}
export function pgEvents<const D extends EventsDefinitions = {}>(config: EventsConfig<D>): Events<D>

export interface Events<D extends EventsDefinitions> extends AsyncDisposable {
  readonly channels: { readonly [K in keyof D['channels']]: ChannelHandle<PayloadOf<D['channels'][K]>> }
  readonly topics: { readonly [K in keyof D['topics']]: TopicHandle<PayloadOf<D['topics'][K]>> }
  readonly subscriptions: { readonly [K in keyof D['subscriptions']]: SubscriptionHandle<PayloadOf<D['subscriptions'][K]>> }
  channel<T>(def: ChannelDef<T>): ChannelHandle<T>
  topic<T>(def: TopicDef<T>): TopicHandle<T>
  subscription<T>(def: SubscriptionDef<T>): SubscriptionHandle<T>
  start(): Promise<void>                                           // §0.3: ensure + upserts; required before any `{ tx }` call
  migrate(): Promise<{ from: number; to: number }>
  observe(hooks: EventsHooks): () => void
  close(): Promise<void>
}

export interface ChannelHandle<T> {
  notify(payload: T, opts?: { tx?: Queryable<any> }): Promise<void>
  listen(handler: (payload: T) => void, opts?: { signal?: AbortSignal; onGap?: (e: { downMs: number }) => void }): Promise<PgSubscription>
}

export interface PublishOptions { tx?: Queryable<any>; type?: string; key?: string; headers?: Record<string, string> }
export interface Entry<T> { readonly id: bigint; readonly topic: string; readonly type: string | null; readonly key: string | null; readonly payload: T; readonly headers: Record<string, string> | null; readonly at: Date; readonly cursor: string }   // cursor: opaque state just after this entry
export interface TopicHandle<T> {
  publish(payload: T, opts?: PublishOptions): Promise<{ id: bigint }>
  publishMany(items: readonly ({ payload: T } & Omit<PublishOptions, 'tx'>)[], opts?: { tx?: Queryable<any> }): Promise<{ id: bigint }[]>
  tail(handler: (e: Entry<T>) => void, opts?: { from?: 'now' | { after: string }; signal?: AbortSignal }): Promise<PgSubscription>
  read(opts?: { afterId?: bigint; limit?: number }): Promise<Omit<Entry<T>, 'cursor'>[]>   // admin browse by id; not a resume handle
}

export interface SubscriptionHandle<T> {
  run(handler: EntryHandler<T> | BatchHandler<T>, opts?: { batchSize?: number; leaseMs?: number; pollMs?: number; signal?: AbortSignal }): Reader
  reset(to: 'beginning' | 'now' | { after: string }): Promise<void>                 // `after`: an Entry.cursor
  lag(): Promise<{ entries: number; oldestAt: Date | null }>
  parked(opts?: { limit?: number }): Promise<{ entry: Entry<T>; attempts: number; error: string | null }[]>
  discard(entryIds: readonly bigint[]): Promise<number>
  remove(): Promise<void>
}
export type EntryHandler<T> = (e: Entry<T>, ctx: ReadContext) => Promise<void>
export type BatchHandler<T> = { batch: (es: readonly Entry<T>[], ctx: ReadContext) => Promise<void> }
export interface ReadContext { readonly signal: AbortSignal; readonly attempt: number; commit(opts: { tx: Queryable<any> }): Promise<void> }
export interface Reader extends AsyncDisposable { readonly active: boolean; close(): Promise<void> }

// building blocks for sibling packages (E-D7)
export function waker(db: Db, channel: string, opts: { pollMs: number; signal?: AbortSignal }): AsyncIterable<'notify' | 'gap' | 'poll'>
export function engineChannel(schema: string, kind: string, name: string): string
export function engineChannelSql(schema: string, kind: string, name: Fragment): Fragment   // same name, built in SQL (sha256)
export type { StandardSchemaV1 }                                                        // the copied interface, re-exported for siblings

export class EventsLeaseLostError extends PgPrimeError {}   // 'EVENTS_LEASE_LOST'
export class PayloadError extends PgPrimeError {}           // 'EVENTS_PAYLOAD'
export class SchemaVersionError extends PgPrimeError {}     // 'EVENTS_SCHEMA_VERSION'
export class NotStartedError extends UsageError {}          // 'EVENTS_NOT_STARTED' — a `{ tx }` call before start()
export interface EventsHooks {
  onPublish?(e: { topic: string; count: number; inTx: boolean }): void
  onDeliver?(e: { topic: string; subscription: string; count: number; durationMs: number }): void
  onRetry?(e: { topic: string; subscription: string; entry: bigint; attempt: number; error: unknown }): void
  onPark?(e: { topic: string; subscription: string; entry: bigint; error: unknown }): void
  onInternal?(e: { kind: 'listen-unavailable' | 'heartbeat-failed' | 'subscription-behind-retention' | 'hook-failed'; message: string; cause?: unknown }): void
}
```

The registry types map names to declarations exactly as `db.h` maps tables (one mapped type per
member; `bench/types` fixture with 100 topics).

**Handler semantics:**
- Entry handlers run sequentially, in order. A resolve acknowledges the entry: offsets are
  committed per batch, or inside the handler's transaction through `ctx.commit({ tx })`, which gives
  exactly-once effects for same-database sinks.
- A throw is a nack: retry with backoff. The attempt was counted by A1 before the call, so a
  process crash counts too. After `maxAttempts` the entry is parked (§3.4).
- A batch handler acknowledges or retries the batch as a unit, and drops to single entries after
  a failed attempt so the poison entry can be isolated.
- Parked entries are inspected with `parked()` and removed with `discard()`. Re-processing one is
  user code (`read` it, handle it, `discard` it); a built-in replay is deferred (§10).

---

## 6. Failure semantics

| Failure | Outcome | Mechanism |
|---|---|---|
| Producer tx rolls back | no entry, no wake-up | P1 in the caller's tx |
| Reader crashes mid-batch | redelivered from the last commit (at-least-once) unless committed in the handler's tx | C1 |
| Handler throws after its `ctx.commit({ tx })` transaction committed | what it committed is not redelivered | stored cursor read under `for share` (§3.4) |
| Poison entry crashes the process repeatedly | `head_attempts` survives restarts → parked after `maxAttempts` | §3.4 |
| Two instances, one subscription | one lease; the other's commit or park returns 0 rows → `EventsLeaseLostError`, and nothing is parked | L1/C1/K1 |
| Long producer tx open during reads | its entries arrive at the first read after commit; nothing else waits on it | E-D3 |
| Long unrelated tx (report) open | no effect | E-D3 |
| NOTIFY lost | `gap` → immediate read; `pollMs` caps discovery | `waker` |
| Retention passes a slow reader | `subscription-behind-retention`, continues at the oldest entry; avoided with `keepUntilConsumed` | §3.5 |
| Clock skew | none (DB clock) | 0.5 |

| Concern | Direct / session pooler | PgBouncer transaction mode |
|---|---|---|
| publish, read, commit, migrate | ✓ | ✓ |
| `channel.notify` | ✓ | ✓ |
| `channel.listen` | ✓ | only with `directConnection`; otherwise `UnsupportedInPoolerModeError` (pg-prime's) |
| subscription/tail wake-ups | ✓ | poll (`pollMs`) unless `directConnection` |

---

## 7. Test plan

**Tier 0 (unit, < 5 s):**
- Golden SQL for P1, L1/L2, R1, A1, C1, nack, K1 and retention.
- **`advance` and fresh-cursor seeding as pure functions, property-tested** (fast-check) against
  simulated interleavings of transactions (begin/xid/insert/commit/abort). For any interleaving,
  batch size, crash point and park point, no entry is lost or duplicated. This includes:
  - acknowledging or parking *inside* a late transaction;
  - committing a `next` entry and crashing while a lower-xid transaction is still open (it must be
    delivered after it commits);
  - `types` filters, including reads whose whole batch is filtered out (the cursor must advance via
    `advanceTo` and still deliver a later-committing, lower-xid matching entry);
  - a batch failure with `maxAttempts: 1` never parks an entry that did not fail on its own;
  - resuming from any `Entry.cursor`;
  - `from: 'now'` with transactions open at seeding time.
- Channel-name parity between TS and SQL; payload codec, Standard Schema validation, size and NUL
  errors with path.
- `waker` on a fake listen (notify/gap/poll/listen-unavailable).
- Hook isolation; registry type probes.

**Tier 1 (PGlite; one backend, so sequential only):**
- `migrate` idempotence, custom schema, `ownedSchemaSql` + `migrate` convergence.
- Publish/read/commit/resume after restart; `types` filter advancing past non-matching entries;
  `from: 'beginning'`.
- Retry → park → `discard`; re-park after `reset` (the K1 conflict path).
- `reset`, `lag`, retention with and without `keepUntilConsumed`; tail from `now` and from an
  `Entry.cursor`.
- Channels: encode/validate and schema rejection only. PGlite delivers a NOTIFY only to the
  publishing socket, so delivery is tested in tier 2 and in tier 0 via `createMockPool`'s
  `emit('notification')`.
- Publish in a rolled-back tx leaves nothing.

**Tier 2 (`requiresConcurrency`):**

| Test | Oracle |
|---|---|
| **cursor exact under concurrent producers** — 8 producers in random-length txs (some aborted, one held open 20 s), reader restarted 10 × | every committed entry delivered exactly once, aborted never; the held-open tx's entries arrive after its commit; no read waits for it |
| **unrelated long transaction does not delay readers** | entry-to-handler latency p95 < 200 ms while a `select pg_sleep(30)` tx is open |
| **one reader per subscription** — 3 instances, the handler commits its log row with `ctx.commit({ tx })` | the log shows each entry once and no overlap, even when a stall costs a reader its lease; after a crash the next entry is handled within 2 × `leaseMs` + 500 ms (the dead lease lasts ≤ `leaseMs`, standbys retry every `leaseMs / 2`) |
| **lease lost mid-batch** — the lease is taken while a per-entry handler runs, found by the heartbeat (no `ctx.commit`) or by a `ctx.commit` whose error the handler swallows | the old reader hands it no further entry of the batch, commits nothing and charges no retry |
| **exactly-once sink** — `ctx.commit({ tx })`, reader killed mid-tx | sink rows = entries |
| **throw after `ctx.commit({ tx })`** — per-entry and batch handlers throw after their commit committed, or inside it | sink rows = entries; nothing committed is redelivered, the rolled-back ones are retried |
| **late transaction larger than `batchSize`** — 50 entries commit after a newer entry was read | every batch ≤ `batchSize`; each entry once, in order |
| **channel across sessions + gap** — two listeners on one channel, `pg_terminate_backend` the ListenHub backend | both `onGap`s fire (S0 fix); later notifies reach both |
| **process-killing poison entry** — the handler calls `process.exit` on one entry; the reader is restarted by the test | entry parked after `maxAttempts` restarts; every other entry delivered once |
| **stale reader cannot park** — steal the lease, then the old reader runs K1 | 0 rows, no `parked` row |
| **subscription wake latency** | commit-to-handler p95 < 100 ms with `pollMs: 5000` |
| **PgBouncer transaction mode** | publish/subscribe by polling; `listen` refused with pg-prime's error |
| **pg_current_snapshot ≡ statement snapshot** (E-Q1) on PG 15–18 | asserted directly |

**Bun:** the unit tier plus `cursor.test.ts` and `channel-gap.test.ts` on Bun 1.4.2 must not skip.

**Bench** (`bench/events`, nightly): publish/s (1 and 100 per tx), reader entries/s, cursor
`pending` size under 200 concurrent producers.

---

## 8. Gates, CI, docs

**Gates and CI.** All tool, CI, budget and release wiring is F0's (§0.6). E-workstreams touch only:
- `tools/api-snapshot/pg-prime-events.json` (regenerated);
- the `events-basic` tree-shake golden (§0.4: ≤ 12 KB delta, `zeroDependencies: true`);
- the pack-smoke consumer body (`notify` over `createMockPool`; own project, footprint ≤ 200 KB);
- a `bench/types` fixture.

The integrator adds design/00's doc-map rows.

**Docs.**
- README (channels, then topics and subscriptions in 30 lines; guarantees).
- `guides/channels.mdx` (supersedes the event half of `guides/listen-notify.mdx`, which keeps the
  raw API) · `guides/event-log.mdx` (publish, subscriptions, tails, resume, parking) ·
  `concepts/event-cursor.mdx` (§3.3 with the interleaving diagram) · `operations/events.mdx`
  (retention, lag, PgBouncer) · `reference/events.mdx`.
- Module docs per source file plus `docs/INDEX.md` lines (doc-writer skill). §3.3's argument goes
  in `src/log/cursor.md` Gotchas.
- Examples run on PGlite with polling. Two-session examples are `no-run` and name their tier-2 test.

---

## 9. Workstreams

| WS | Deliverable | Depends | Exit gate |
|---|---|---|---|
| **S0** | Core: `migrateOwnedSchema`/`ownedSchemaSql` (`src/session/owned-schema.ts`); the ListenHub per-subscription emitter fix; the `backoffMs` fixed-vector fixture; api-snapshot, docs entries, `pg-prime` minor changeset | — | tier 1 + tier 2 ("5 concurrent migrators", "two subscribers both get `gap`"); full chain |
| **F0** | Tooling for the whole family (§0.6 list) with all four package slots seeded | S0 | `package:check`, `docs:check` green with four empty skeletons |
| **E0** | Package skeleton, `define.ts`, `payload.ts`, errors, hooks, `start()`/`NotStartedError`, **channels**, **`waker`**, `engineChannel(Sql)`, frozen §5 types | S0, F0 | channel tests tiers 0–2; `events-basic` golden; chain green |
| **E1** | Log: migration v1, P1, L1/L2, R1 + `advance` + fresh-cursor seeding, A1/C1/nack/K1, retention, tails, subscription admin | E0 | §7 cursor property test + tier-2 table |
| **E2** | Docs + bench + bun step | E1 | `docs:check`, `docs:examples:pg` green; coverage 100 % |

Handover per design/14 decision 10 (branch from the plan commit, RESULT appended here, chain green,
own `pg-dev` database). Package-wide order: §0.6.

---

## 10. Open questions

1. **E-Q1** — The single-statement R1 relies on `pg_current_snapshot()` returning the statement's
   active snapshot at READ COMMITTED. The fallback, a read-only RR transaction, costs 2 round
   trips. Verified first in E1.
2. **E-Q2** — Time-partition `entries` (append-only, so no row movement): retention becomes
   `DROP PARTITION`, but partitions must be created at runtime by DDL.
3. **E-Q3** — Partitioned consumer groups (N readers per subscription, by `hash(key) % P`) vs
   "use an mq binding for parallelism". The plan defers them.
4. **E-Q4** — resolved: park only; `block` is deferred.
5. **E-Q5** — `autoMigrate: true` by default across the family (zero setup) vs explicit `migrate()`.
6. **E-Q6** — resolved by the owner: design/08 §1.1 now caps the core at six and exempts add-ons
   that peer `pg-prime` and join the `fixed` group.

**Deferred from v0 (events):**
- `onFail: 'block'` with `skip`/`unblock` — a second failure mode that doubles the reader's states; park covers liveness.
- Built-in `replay(ids)` of parked entries — a re-delivery path crossing the cursor and the parked table; user code can `read` + `discard`.
- Partitioned consumer groups and time-partitioned `entries` (E-Q2, E-Q3).

---

## 11. Implementation order & agent briefs

Six agents, each in its own git worktree, branched from the plan commit. Ownership is disjoint
between agents that run at the same time. A file is touched by a later agent only after the earlier
one is merged.

```
A1 (F0+S0) ─▶ A2 events ∥ A3 outbox ∥ A4 cron core ─▶ (A2 merged) A5 mq ─▶ (A4 + A5 merged) A6 cron mq-target
```

### Rules for every agent

- **Never edit:** `docs/INDEX.md`, `tools/budgets.json`, `pnpm-lock.yaml`, any `package.json`
  dependency field, `.changeset/config.json`, `.github/**`, `tools/*.mjs`, another package's
  directory, or another plan file.
  - Put new INDEX lines and measured sizes in your RESULT section; the integrator applies them.
  - Need a dependency or a tool change? Stop and report it.
- **Regenerators** (`pnpm api-snapshot`, `pnpm treeshake:update`) rewrite every golden. Commit only
  your own golden and fixture, and `git checkout --` the rest.
- **Database:** your own PG 17 database, from the local-postgres skill (`~/.agents/bin/pg-dev`,
  shared server on :5417). Export it as `PG_PRIME_TEST_URL`; export `PG_PRIME_TEST_PGBOUNCER_URL`
  when a transaction-mode PgBouncer is available, otherwise record the PgBouncer test as not run.
- **Code style:** simple, clean, short; comments only for a non-obvious reason, workaround or trap;
  no history or ticket ids in comments.
- **Done** = your package's tier commands below are green, plus the full chain (design/14 §2), and
  `#### <agent> — RESULT` is appended to your plan file. The full chain is:
  `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm test:live && pnpm test:pg && pnpm build && pnpm package:check && pnpm bench:types && pnpm bench:compile && pnpm docs:check && pnpm docs:examples:pg`
- **Tier commands for package `<p>`:**
  - `pnpm --filter @pg-prime/<p> test`
  - `pnpm --filter @pg-prime/<p> test:live`
  - `pnpm --filter @pg-prime/<p> test:pg`
  - `(cd packages/pg-prime-<p> && bunx --bun vitest run --project unit && PG_PRIME_EXPECT_BUN=1 bunx --bun vitest run --project pg)`

### A1 — F0 + S0: tooling, release wiring, package slots, core changes (runs first, alone)

**Owns:**
- **Core:**
  - `packages/pg-prime/src/session/owned-schema.ts` (new);
  - `packages/pg-prime/src/session/listen.ts` (one emitter per subscription; `gap`/`reconnect`/
    `error` fan out; removal on close);
  - `packages/pg-prime/src/index.ts` (exports);
  - their tests under `packages/pg-prime/test/{session,live,pg}/`;
  - `tools/api-snapshot/pg-prime.json`;
  - their module docs `docs/packages/pg-prime/src/session/{owned-schema,listen}.md`;
  - the reference entries in `docs/src/content/docs/reference/pg-prime.mdx`.
- **Shared fixtures:** `fixtures/backoff/vectors.json` (the 15 §0.2 fixed vectors).
- **Tooling** (15 §0.6 F0 list):
  - `tools/*.mjs`, `tools/budgets.json` (design numbers for all four);
  - `tools/api-snapshot/pg-prime-{events,outbox,mq,cron}.json` (empty goldens);
  - `fixtures/treeshake/{events-basic,outbox-write,mq-send,cron-define}/` (entry + placeholder
    golden);
  - `knip.json`, `.github/workflows/{ci,ci-nightly}.yml` (bun filters and tier-2 steps for all
    four), `.changeset/config.json` (`fixed` += four) plus one changeset per package,
    `RELEASING.md`, `pnpm-lock.yaml`.
- **Package slots** `packages/pg-prime-{events,outbox,mq,cron}/`:
  - `package.json`: name, version, exports, `files`, peer `pg-prime >=0.2.0`; deps (mq →
    `@pg-prime/events: workspace:^`, cron → `croner@^10`); devDeps (`pg-prime`, `@pg-prime/testing`,
    `vitest`, cron also `@pg-prime/mq`);
  - `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts` (unit/live/pg projects, pg-prime
    aliased to source);
  - `src/index.ts` (`export {}`), `src/unsupported-typescript.d.ts`, `README.md` stub, one passing
    `test/unit/slot.test.ts`.
- **Docs site shell:** `docs/astro.config.mjs` sidebar entries, plus stub pages for every page
  named in plans 15–18 §docs.

**Inputs:** plans 15 §0, 16 §8, 17 §11, 18 §9.

**Done:**
- `pnpm --filter pg-prime exec vitest run test/session` green;
- `PG_PRIME_TEST_URL=… pnpm --filter pg-prime exec vitest run --project pg test/pg/session-listen.test.ts test/pg/owned-schema.test.ts`
  green ("two subscribers both get `gap`", "5 concurrent migrators");
- `pnpm build && pnpm package:check && pnpm docs:check` green with four empty slots;
- full chain green.

### A2 — events (E0, E1, E2)

**Owns:**
- `packages/pg-prime-events/**` (except dependency fields);
- `docs/packages/pg-prime-events/**`;
- `docs/src/content/docs/{guides/channels,guides/event-log,concepts/event-cursor,operations/events,reference/events}.mdx`;
- `tools/api-snapshot/pg-prime-events.json`;
- `fixtures/treeshake/events-basic/expected-modules.json`;
- `bench/events/**`;
- the RESULT section of this file.

**Never touches:** `packages/pg-prime/**` and the other three packages.

**Inputs:** A1 merged; this plan §1–§10.

**Done:** events tier commands; the §7 cursor property test (fast-check, including `types`
filters, crash points and fresh cursors); the §7 tier-2 table; the full chain.

### A3 — outbox (O0–O3) — parallel with A2 and A4

**Owns:**
- `packages/pg-prime-outbox/**`, `docs/packages/pg-prime-outbox/**`;
- `docs/src/content/docs/{guides/outbox,operations/outbox,reference/outbox}.mdx`;
- `tools/api-snapshot/pg-prime-outbox.json`, `fixtures/treeshake/outbox-write/expected-modules.json`;
- `bench/outbox/**`;
- the RESULT section of 16.

**Inputs:** A1 merged; plan 16.

**Done:** outbox tier commands, including the 16 §7 tier-2 table ("per-key order under 4 relays",
"head failure keeps receiver order", "rebalance"); the full chain.

### A4 — cron core, handler targets (C0–C3) — parallel with A2 and A3

**Owns:**
- `packages/pg-prime-cron/**` except `src/target/queue.ts` and `test/**/queue-target*.test.ts`.
  A4 creates `src/target/queue.ts` as a seam that throws `UsageError('queue target not implemented')`
  and wires it into the loop.
- `docs/packages/pg-prime-cron/**`;
- `docs/src/content/docs/{guides/cron,operations/cron,reference/cron}.mdx` (with a stub "Queue
  target" section);
- `tools/api-snapshot/pg-prime-cron.json`, `fixtures/treeshake/cron-define/expected-modules.json`;
- the RESULT section of 18.

**Inputs:** A1 merged; plan 18 §1–§5, §7–§9.

**Done:** cron tier commands without queue-target tests (18 §8: planner/DST goldens, "tick fires
once across 5 instances", overlap, SIGKILL, manual pickup, cancel); a check that `dist` contains
no `@pg-prime/mq` specifier; the full chain.

### A5 — mq (M0–M7, including `bind`) — after A2 is merged

**Owns:**
- `packages/pg-prime-mq/**`, `docs/packages/pg-prime-mq/**`;
- `docs/src/content/docs/{guides/queues,concepts/work-queues,operations/queues,reference/mq}.mdx`;
- `tools/api-snapshot/pg-prime-mq.json`, `fixtures/treeshake/mq-send/expected-modules.json`;
- `bench/mq/**`;
- the RESULT section of 17.

**Never touches:** `packages/pg-prime-events/**`. A needed events change is a report to the
integrator, not an edit.

**Inputs:** A1 and A2 merged (`waker`, `engineChannel(Sql)`, subscriptions); plan 17.

**Done:** mq tier commands, including the 17 §10 tier-2 table ("two consumers never both own a
message", "expired lease recovered once", "parent released once", group/global limits, "bind
exactly-once", "active parent vs failing `fail` child", "indeterminate in-tx completion"); M3's
first step is verifying M-Q4 on PG 15–18; the full chain.

### A6 — cron queue target (C4) — last, after A4 and A5 are merged

**Owns:**
- `packages/pg-prime-cron/src/target/queue.ts`, `packages/pg-prime-cron/test/**/queue-target*.test.ts`;
- the "Queue target" section of `docs/src/content/docs/guides/cron.mdx`;
- an appended `#### C4 — RESULT` in 18.

**Inputs:** plan 18 §3.5 (queue-target trigger), §6; mq's `QueueHandle.start`/`send`.

**Done:**
- `pnpm --filter @pg-prime/cron test` (including the `CronEnqueuer` ⇐ `pgMq` type test);
- `PG_PRIME_TEST_URL=… pnpm --filter @pg-prime/cron test:pg` ("queue target: one message per
  tick", misfire-skip sends nothing, `cron.start()` starts the queue);
- `pnpm build && pnpm package:check` (cron's own pack-smoke project still installs **without**
  mq);
- the full chain.

### Integrator (between rounds)

- Merge in the order above, keeping both sides of `src/index.ts` if any agent touched another
  package's barrel by mistake.
- Apply INDEX lines and ratchet `tools/budgets.json` from the RESULT numbers.
- Re-run the full chain on the merged tree; then push and watch CI and the nightly.

#### A1 — RESULT (2026-10-08)

Branch `worktree-agent-ab93be06a181d48f6`, from `4fcd413`. Commits: `6a7ed8e` S0 core, `ab7b6b4`
package slots, `a7447bf` tooling, `ac516ec` CI, `451efc4` docs shell.

**S0 as built.**
- `migrateOwnedSchema(db, { schema, migrations, apply? })` → `{ from, to }`. A migration is
  `{ version, name, minClient?, up(quotedSchema) => string[] }`: one statement per element, because
  pg-prime runs extended protocol. Each missing version runs in its own transaction under
  `tx.advisoryLock('pgprime-owned:' + schema)`. A checksum mismatch or a ledger `min_client` above
  the client's latest version throws `ConfigError`; packages wrap it in their `SchemaVersionError`.
  `apply: false` only reads and checks (`to === from`), which is what `autoMigrate: false` needs.
  The checksum is the 64-bit FNV-1a (`advisoryKey`) of the rendered statements.
- `ownedSchemaSql({ schema, migrations })` → `{ version, name, sql }[]`: lock, bootstrap, DDL and an
  `on conflict do nothing` ledger row. It converges with the runtime path when vendored first.
- ListenHub: one `{ handler, emitter }` per subscription. `gap`, `reconnect` and `error` fan out,
  a throwing handler reports to its own subscription, and close removes only its own entry.
- `fixtures/backoff/vectors.json`: 15 vectors `{ policy, attempt, random, delayMs }`, exact, checked
  against core's `retryDelayMs`.

**Gates.** All green on PG 17.11:
- `vitest run test/session`: 180 tests.
- tier 2 listen + owned-schema: 9 tests, on Node and on Bun 1.4.2.
- full chain, with test:pg on a temporary `postgres:17-alpine` plus `edoburu/pgbouncer` in
  transaction mode, so the PgBouncer tests ran:
  - unit: pg-prime 1 122, create 35, testing 23, 4 × 1 slot;
  - live: pg-prime 1 943 (+18 skipped), testing 28;
  - pg: pg-prime 2 031 (+29 skipped), kit 461, create 42, testing 36, 4 × 1;
  - package:check 27/27 size gates; tree-shake: 4 core ok, 4 add-ons pending; pack smoke ok;
    create smoke ok;
  - bench:types, bench:compile;
  - docs:check: 633 blocks, 103 examples; docs:examples:pg: 10.

**Re-baselined** (core grew, ceil-to-1 KB): pg-prime jsBytes 993 280 → 997 376; treeshake
`root-import-all` 87 040 → 88 064, golden +`session/owned-schema.js`; bench/types packageDtsBytes
612 352 → 613 376.

**Empty-slot measurements:**
- unpacked: 3.7–3.9 KB;
- install footprint (pnpm pack adds the 16 KB LICENSE): events 20.1 KB, outbox 20.1 KB, mq 40.3 KB
  (events included), cron 171.3 KB (croner included).

**Deviations and decisions:**
- The tree-shake delta is the fixture bundled with `pg-prime` external.
- A golden of `{ "modules": null }` reports "pending" while the entry fails to bundle. Once the
  entry bundles, the golden must be recorded.
- Add-on pack-smoke projects install with `--legacy-peer-deps`: the peer `>=0.2.0` is not met by
  the in-tree 0.1.0, and size-budget asserts peers instead. `changeset status` logs "must depend on
  the current version" for those peers and exits 0 (RELEASING notes it).
- `fast-check` added to events' devDependencies for E1's property test.
- `@pg-prime/{events,outbox,mq,cron}` added to `docs/package.json` devDependencies.
- knip `ignoreDependencies` lists each slot's dependencies until code uses them. The integrator
  drops them.

**INDEX lines (integrator):**
- `- docs/packages/pg-prime/src/session/owned-schema.md — versioned DDL for an add-on's own schema: migrateOwnedSchema (advisory-locked ledger, checksum, min_client) and vendorable ownedSchemaSql — read when changing add-on migrations or the ledger rules.`
- Replace the listen line with: `- docs/packages/pg-prime/src/session/listen.md — dedicated LISTEN connection hub, one emitter per subscription, reconnect with gap event, NOTIFY limit — read when changing db.listen, reconnect behaviour or payload checks.`

**For A2–A4:**
- Your pack-smoke consumer body is `packages/pg-prime-<p>/test/pack-smoke.ts`.
- To record a golden, run `node tools/treeshake-check.mjs --update --case <fixture>` and commit
  only that golden.
- `installBytes` and the tree-shake `{ delta }` are in `tools/budgets.json`.
- Tests go in `test/{unit,live,pg}`. `passWithNoTests` is on.

#### A2 — RESULT (2026-10-08)

Branch `worktree-agent-aa8e1eb546293dbda`, from `f2d0a36`. Commits: `11bd6ed` source, `ec67391`
tier 0/1 tests, `6a77def` isolation fix, `5473c80` tier 2, `45f9632` goldens + pack smoke, `e86d5ec`
bench, `2a2d402` docs, `df2ce52` plan corrections.

**Built.** `@pg-prime/events` per §1–§6: `defineChannel`, `defineTopic`, `defineSubscription`,
`pgEvents` (`channels`/`topics`/`subscriptions` registries, `channel`/`topic`/`subscription`,
`start`, `migrate`, `observe`, `close`), `ChannelHandle`, `TopicHandle` (`publish`, `publishMany`,
`tail`, `read`), `SubscriptionHandle` (`run`, `reset`, `lag`, `parked`, `discard`, `remove`),
`Reader`, `ReadContext.commit({ tx })`, `EventsHooks`, the four errors, and the building blocks
`waker`, `engineChannel`, `engineChannelSql`, `StandardSchemaV1`.

**Gates** (PG 17.11, temporary `postgres:17` + `edoburu/pgbouncer` transaction mode, so the
PgBouncer test ran). Full chain green. Events: unit 33, live 49 (PGlite), pg 59 (all tiers on a
real server, incl. the §7 tier-2 table). The tier-2 files also passed on PG 15.19, 16.15 and 18.6
(E-Q1 holds on all four). Bun 1.4.2: unit 33, pg 10, none skipped. Cursor property test: 3 000
runs of up to 150 ops (lazy xids, aborts, `types`, prefix acks, per-entry commits, crashes,
`Entry.cursor` resumes, `from: 'now'`); four mutations of `cursor.ts` each fail it. docs:check
(110 examples), docs:examples:pg (10). package:check: 27/27 size gates.

**Measured.** Unpacked 132.3 KB (budget 150 KB); install footprint 148.7 KB (200 KB); tree-shake
`events-basic` delta 8 403 B min+gz (12 288 B), 25 modules. Bench (shared laptop PG 17, noisy):
publish 977/s single, 20 632/s at 100 per tx; reader 39 979 entries/s at batch 1000; max `pending`
29 under 200 producers on a 40-connection pool.

**Deviations.**
- Plan bugs fixed in code and text: P1's `woke` was inverted (`is not null`) and insert order is
  now `rows from … with ordinality`; "a transaction's entries arrive together" is false (a read
  limit splits a transaction and a late one can land between its parts), contract corrected;
  `pg_snapshot_xip` omits running xids ≥ `xmax` (harmless, documented); isolation now also applies
  to a size-1 marker at takeover and persists after a failed single entry, else a poison entry was
  never parked (found by the tier-2 crash test).
- API supersets: `waker()` returns `Waker` (`AsyncIterable` + `wait(ms)` + `close()`) and takes
  `onInternal`; `tail` takes `pollMs`; `InternalKind` adds `reader-failed`; `PayloadError.path`;
  `parked()` returns `Omit<Entry, 'cursor'>` (a parked entry has no cursor). Subscription `from`
  defaults to `'now'`; retry defaults `{ 3, 1000, 60 000, 'full' }`.
- `engineChannel` hashes `schema/kind/name` with `node:crypto`; `tsconfig.build.json` types `node`.
- Retention runs from readers (once a minute per topic, CAS-gated); unread topics are not trimmed.
- The process-killing poison test simulates the kill by ending the reader's pool inside the handler
  (no statement after the crash point, lease left to expire), not a child process.
- No vendorable events SQL is exported (`MIGRATIONS` is internal); `migrate()` is the path.

**For A5 (mq).** `waker(db, engineChannel(schema, 'q', queue), { pollMs, signal, onInternal })`;
use `wait(Math.min(pollMs, timerMs))` to race your own timers; the first reason is `'gap'` once
LISTEN is up. `engineChannelSql(schema, kind, sql\`m.queue\`)` binds the prefix and splices the
name. `bind`: `events.subscription(def).run({ batch }, …)` with `ctx.commit({ tx })` in the same
transaction as `sendMany`; a `{ tx }` publish needs `events.start()` first (`NotStartedError`).

**For the integrator.**
- `bench/events` is a deps-free workspace package; `pnpm install` adds `bench/events: {}` to
  `pnpm-lock.yaml` (frozen install still passes). Please add it.
- knip hints: drop events' `ignoreDependencies`.
- `@pg-prime/testing` bridge bug: a non-owner socket's exempt `Sync`/`Terminate` reassigns
  `txOwner`, and that socket's close then rolls back the real owner's transaction (seen as tier-1
  migrations vanishing while earlier tests' pools were still open). Events' tier 1 ends its pools
  after each test and polls (`poolerMode: 'transaction'`) to stay clear of it.
- Ratchet: events `unpackedBytes` 136 KB, `installBytes` 153 KB, `events-basic` delta 9 216.

**INDEX lines:**
- `- docs/packages/pg-prime-events/src/channel.md — typed LISTEN/NOTIFY channels and the engineChannel/engineChannelSql name scheme — read when changing channel encoding, listen errors or engine channel names.`
- `- docs/packages/pg-prime-events/src/define.md — defineChannel/defineTopic/defineSubscription declarations, defaults and PayloadOf — read when adding a declaration option or changing defaults.`
- `- docs/packages/pg-prime-events/src/errors.md — EventsLeaseLostError, PayloadError, SchemaVersionError, NotStartedError codes — read when an events error code or message changes.`
- `- docs/packages/pg-prime-events/src/events.md — pgEvents registries, schema ensure, declaration upserts, start/migrate/close — read when changing start-up, autoMigrate or NotStartedError behaviour.`
- `- docs/packages/pg-prime-events/src/hooks.md — EventsHooks bus, InternalKind values, hook-failed isolation — read when adding a hook or an onInternal kind.`
- `- docs/packages/pg-prime-events/src/index.md — @pg-prime/events entry exports and the building blocks mq uses — read when adding or renaming an events export.`
- `- docs/packages/pg-prime-events/src/log/cursor.md — exact (position + pending) cursor, advance/advanceTo, seeding, correctness argument — read when changing cursor logic or delivery is lost or duplicated.`
- `- docs/packages/pg-prime-events/src/log/migrations.md — events schema v1: topics, entries, subscriptions, parked — read when changing the events schema or adding a migration.`
- `- docs/packages/pg-prime-events/src/log/sql.md — every log statement: publish, lease, read, marker, commit, park, retention — read when editing events SQL or a guarded write returns 0 rows.`
- `- docs/packages/pg-prime-events/src/log/subscription.md — leased reader, retry, isolation, parking, ctx.commit, subscription admin — read when a reader stalls, redelivers, or never parks an entry.`
- `- docs/packages/pg-prime-events/src/log/topic.md — publish in the caller's transaction, tails, admin browse — read when changing publish or tail behaviour.`
- `- docs/packages/pg-prime-events/src/payload.md — Standard Schema validation, codec, NUL and size checks — read when a payload is refused or schema validation misbehaves.`
- `- docs/packages/pg-prime-events/src/util.md — sleep, ASYNC_DISPOSE and backoffMs fixed-vector copy — read when retry delays differ from the family vectors.`
- `- docs/packages/pg-prime-events/src/waker.md — NOTIFY/gap/poll wake-up loop with pooler fallback — read when wake-ups are late or LISTEN is unavailable.`
