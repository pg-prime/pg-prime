# 16 — `@pg-prime/outbox`: transactional outbox with ordered relay. Design & Implementation Plan

2026-10-08. Branch `feat/mq`. **Status: PLAN — for revmux review before any code.**
Family rules — the dependency graph, shared helpers, ledgers, packaging, budgets and cross-plan
order — are in [15-events §0](./15-events.md). This plan does not repeat them.

`@pg-prime/outbox` makes "write my data **and** tell the outside world" atomic:
- a record is written in the caller's pg-prime transaction;
- a relay delivers it to a sink, at least once;
- delivery is **in order per key** (per aggregate), with idempotency keys, retries, a parked state
  and cleanup;
- several relay instances run safely side by side.

The package has no runtime dependencies. Sinks are a one-method interface; the built-in ones are a
function sink and a webhook sink (`fetch`). Kafka, NATS, SQS and similar are user code over the
interface, or future packages.

**Goals.**
1. Per-key FIFO delivery that matches commit order.
2. No concurrent delivery of one key by two relays while their leases are valid.
3. Every transition is one statement.
4. Works behind PgBouncer transaction mode (by polling) and on Bun.

**Non-goals.** Exactly-once delivery to external systems — impossible in general. We give
at-least-once plus a stable idempotency key and a fencing epoch.

---

## 1. Decisions

| # | Decision | One-line reason |
|---|---|---|
| X1 | **No dependency on `@pg-prime/events`**, not even an optional peer. The wake-up loop (LISTEN + `gap` + poll timer, ~40 lines) is owned here. An "append to an events topic" sink is a documented recipe. The events log does not use the outbox | The claim models differ (partitioned per-key leases vs a single cursor), so nothing substantive would be shared. Minimal install. Both directions stay independent (15 §0.1) |
| X2 | **Partition leases, not per-row claims.** Each record maps to one of a topic's `P` partitions: `abs(hashtextextended(key, 0) % P)` for keyed records (not `mod(abs(h), P)`: `abs` of the minimum bigint overflows), random for unkeyed ones. A relay leases whole partitions (`FOR UPDATE SKIP LOCKED` on `partitions` rows) and delivers each partition in `id` order | One owner per partition ⇒ one owner per key ⇒ no concurrent delivery of a key. `hashtextextended` is the function hash partitioning relies on, so it is stable across versions and `pg_upgrade`. Per-row `SKIP LOCKED` cannot keep per-key order: skipping a locked head row would hand out the next row of the same key |
| X3 | **Ordered writes:** a keyed write takes `pg_advisory_xact_lock(hashtextextended(topic '/' key, 0))` (keys sorted within a batch, so batches cannot deadlock) before inserting. `ordered: false` opts out | Writers of one key then serialize until commit, so **`id` order equals commit order per key**. Without it, a transaction that took its id earlier but committed later would be delivered after its successor |
| X4 | **The relay re-reads `pending` rows** (no cursor) and marks them after delivery. **A sink call never holds two records of one key**: the relay splits each read into *waves* (wave k = the k-th pending record of every key), delivers wave by wave, and drops a key from later waves after its first failure | A late-committing lower id is simply picked up on the next read, so no xid bookkeeping is needed. Waves keep per-key FIFO without trusting the sink: a later record of a key is never sent before an earlier one has succeeded |
| X5 | **Failure blocks the key, not the partition.** A failed keyed head record sets `blocked(topic, key).until = now() + backoff`; the partition keeps serving other keys. After `maxAttempts` the record is **parked**, and its key stays blocked (strict order) until an operator `replay`s or `discard`s it | Head-of-line blocking stays confined to the aggregate that failed |
| X6 | Each record gets a stable **idempotency key** (`idem`: the caller's, or `gen_random_uuid()` at write), with `unique (topic, idem)` so a duplicate write is a no-op. Each partition lease carries a monotonic **`epoch`**, passed to the sink as a fencing token | Sinks can deduplicate redeliveries and reject a stale relay after a lease steal |
| X7 | Delivered records are **kept as `delivered` for `keepDeliveredMs` (default 24 h)** and then swept, so `unique (topic, idem)` deduplicates writes for that window. `keepDeliveredMs: 0` deletes on delivery and gives up write-side dedup after delivery (documented). Parked records stay until `replay` or `discard` | The idempotency promise must outlive delivery, because a retry after an indeterminate commit can arrive later. Relay reads stay small through the `pending` partial index |
| X8 | **`P` is immutable**, set at topic creation (default 16). W1 reads it from the `topics` row in-statement. A declaration whose `partitions` differs fails `start()`. Changing `P` means a new topic. No `repartition` in v0 | A changing `P` races writers and strands parked records in removed partitions. Immutability removes the problem and the feature that caused it |
| X9 | Fair share is **advisory** and counts **relays, not owners**: every relay heartbeats a `relays` row, leases up to `ceil(P / liveRelays)` partitions, and releases extras (`owner = token = lease_until = null`) when the count grows | A relay that owns nothing is still a member, so incumbents yield to it. Fairness may read unlocked counts; correctness rests on the per-partition lock + lease (15 §0.5 rule 3) |

---

## 2. Data model — migration v1 (`pgprime_outbox`)

```sql
create type pgprime_outbox.record_state as enum ('pending', 'delivered', 'parked');

create table pgprime_outbox.topics (
  name       text primary key,
  partitions smallint not null check (partitions between 1 and 1024),
  paused     boolean not null default false,
  keep_delivered_ms bigint not null default 86400000,
  maint_at   timestamptz not null default '-infinity',
  created_at timestamptz not null default now()
);

create table pgprime_outbox.records (
  id          bigint generated always as identity primary key,
  topic       text not null,
  key         text,
  partition   smallint not null,
  idem        text not null,
  payload     jsonb not null,
  headers     jsonb,
  state       pgprime_outbox.record_state not null default 'pending',
  attempts    int not null default 0,
  next_at     timestamptz not null default '-infinity',   -- unkeyed backoff; keyed records use `blocked`
  error       text,
  created_at  timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  unique (topic, idem)
) with (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.02);
create index records_pending on pgprime_outbox.records (topic, partition, id) where state = 'pending';
create index records_parked  on pgprime_outbox.records (topic, id) where state = 'parked';
create index records_kept    on pgprime_outbox.records (topic, delivered_at) where state = 'delivered';

create table pgprime_outbox.partitions (
  topic       text not null references pgprime_outbox.topics (name) on delete cascade,
  p           smallint not null,
  owner       text,
  token       text,
  epoch       bigint not null default 0,
  lease_until timestamptz,
  served_at   timestamptz not null default '-infinity',
  primary key (topic, p)
) with (fillfactor = 50);

create table pgprime_outbox.relays (
  topic   text not null references pgprime_outbox.topics (name) on delete cascade,
  owner   text not null,
  seen_at timestamptz not null default now(),
  primary key (topic, owner)
);

create table pgprime_outbox.blocked (
  topic    text not null,
  key      text not null,
  until    timestamptz not null,                          -- 'infinity' while a parked head blocks the key
  attempts int not null,
  error    text,
  primary key (topic, key)
);
```

`partitions` rows are created with the topic: `insert … select generate_series(0, P-1)`. The
`blocked` table holds only keys that are currently failing, so it stays tiny.

---

## 3. Statements

### 3.1 Write (W1) — inside the caller's transaction

```sql
with src as (
  select r.* from jsonb_to_recordset($rows) as r(key text, idem text, payload jsonb, headers jsonb)
), lk as (                                            -- X3; keys sorted, so concurrent batches cannot deadlock
  select pg_advisory_xact_lock(hashtextextended($t || '/' || key, 0))
  from (select distinct key from src where key is not null and $ordered order by key) k
), ins as (
  insert into pgprime_outbox.records (topic, key, partition, idem, payload, headers)
  select $t, key,
         case when key is null then floor(random() * p.n)::smallint
              else abs(hashtextextended(key, 0) % p.n)::smallint end,
         coalesce(idem, gen_random_uuid()::text), payload, headers
  from src, (select count(*) from lk) as locked,             -- forces lk to run first
       (select (select partitions from pgprime_outbox.topics where name = $t) as n) as p   -- always one row; n is null for an unknown topic
  on conflict (topic, idem) do nothing
  returning id, idem
)
select ins.*, (select pg_notify($chan, '') where exists (select from ins)) is null as woke from ins
```

- A conflicting `idem` (within `keepDeliveredMs`, X7) returns no row, so the caller sees
  `{ duplicate: true }`.
- **Unknown topic is an error, never a silent no-op.**
  - The scalar sub-select always yields one row. For a topic with no `topics` row, `partition`
    is null, and the insert fails with `23502` on `records.partition`. The client maps that to
    `NotStartedError` naming the topic, and the caller's transaction rolls back.
  - `duplicate: true` is reported only for an input row whose `idem` conflicted. The client
    matches returned `idem`s against the input, so a missing topic can never look like a duplicate.
- Declared topics get their rows from `outbox.start()`. Ad hoc topics need
  `await outbox.topic(def).start()` (15 §0.3).
- PostgreSQL collapses the NOTIFY to one per transaction, delivered on commit only.

### 3.2 Lease (L1), heartbeat and rebalance

```sql
with live as (                                      -- every heartbeating relay, owning or not (X9)
  select count(*) as n from pgprime_outbox.relays where topic = $t and seen_at > now() - $lease * interval '1 ms'
), mine as (
  select count(*) as n from pgprime_outbox.partitions where topic = $t and owner = $me and lease_until > now()
), free as (
  select p from pgprime_outbox.partitions
  where topic = $t and (token is null or lease_until < now())
  order by served_at
  limit greatest(0, ceil($P::numeric / greatest((select n from live), 1))::int - (select n from mine))
  for update skip locked
)
update pgprime_outbox.partitions x set owner = $me, token = gen_random_uuid()::text,
       epoch = x.epoch + 1, lease_until = now() + $lease * interval '1 ms'
from free where x.topic = $t and x.p = free.p
returning x.p, x.token, x.epoch
```

- **Heartbeat** (every `leaseMs / 3`): upsert `relays (topic, owner, seen_at = now())`, then
  `update partitions set lease_until = … where topic = $t and p = any($ps) and token = any($toks)
  returning p`. A missing `p` means the lease was lost: stop that partition and abort its in-flight
  sink call.
- In the same tick, a relay holding more than `ceil(P / live)` finishes the current wave and
  **releases** the excess: `owner = null, token = null, lease_until = null`. L1's `free` predicate
  (`token is null or …`) lets a waiting relay take them at once.

### 3.3 Read (R1) — one partition, under its lease

```sql
select r.id, r.key, r.idem, r.payload, r.headers, r.attempts, r.created_at
from pgprime_outbox.records r
where r.topic = $t and r.partition = $p and r.state = 'pending' and r.next_at <= now()
  and (r.key is null or not exists (
        select from pgprime_outbox.blocked b where b.topic = $t and b.key = r.key and b.until > now()))
  and not (select paused from pgprime_outbox.topics where name = $t)
order by r.id
limit $n
```

No row locks are needed: the partition lease already makes this relay the only reader of `$p`.
Every write below re-checks that lease under the partition row's lock.

### 3.4 Settle — delivered (D1), failed (F1), parked (K1)

```sql
-- D1: mark delivered (X7); keepDeliveredMs: 0 swaps the update for a delete
with l as (
  select 1 from pgprime_outbox.partitions
  where topic = $t and p = $p and token = $tok and lease_until > now()
  for update
), d as (
  update pgprime_outbox.records set state = 'delivered', delivered_at = clock_timestamp()
  where id = any($ids) and state = 'pending' and exists (select from l) returning key
), ub as (
  delete from pgprime_outbox.blocked where topic = $t and key in (select key from d where key is not null)
), sv as (
  update pgprime_outbox.partitions set served_at = clock_timestamp()
  where topic = $t and p = $p and exists (select from l)
)
select count(*) as delivered from d                -- fewer than requested → OutboxLeaseLostError; the rest is redelivered

-- F1: head failure (X5); keyed → a `blocked` row, unkeyed → the record's own next_at
with l as (/* as D1 */), r as (
  update pgprime_outbox.records set attempts = attempts + 1, error = $err,
         next_at = case when key is null then now() + $delay * interval '1 ms' else next_at end
  where id = $id and exists (select from l) returning key, attempts
)
insert into pgprime_outbox.blocked (topic, key, until, attempts, error)
select $t, key, now() + $delay * interval '1 ms', attempts, $err from r where key is not null
on conflict (topic, key) do update set until = excluded.until, attempts = excluded.attempts, error = excluded.error
returning attempts

-- K1: park once attempts are exhausted, or immediately for a non-retryable sink error
with l as (/* as D1 */), r as (
  update pgprime_outbox.records set state = 'parked', attempts = attempts + 1, error = $err
  where id = $id and exists (select from l) returning key
), b as (
  insert into pgprime_outbox.blocked (topic, key, until, attempts, error)
  select $t, key, 'infinity', 0, $err from r where key is not null
  on conflict (topic, key) do update set until = 'infinity', error = excluded.error
)
select count(*) from r
```

**Waves (X4).** R1 returns up to `batchSize` records in `id` order. The relay groups them by key:
- wave 0 holds each key's first record (and every unkeyed record);
- wave 1 holds each key's second record;
- and so on.

`sink.deliver(wave)` therefore never sees two records of one key, and may process a wave in
parallel. After each wave the relay runs D1 for the successes and F1/K1 for the failures. A key
that failed is left out of every later wave, so its later records stay `pending` and nothing of
that key is sent out of order. A hot key costs one sink call per record per read; many keys share
each call.

### 3.5 Admin and retention

| API | Statement |
|---|---|
| `replay(ids)` | parked → pending, `attempts = 0`, delete `blocked` for their keys (one statement) |
| `discard(ids)` | delete parked records; release `blocked` keys whose head was discarded |
| `pause()` / `resume()` | `topics.paused` (read by R1) |
| `stats()` | pending count and oldest `created_at` per partition, parked count, blocked keys, owners |
| retention (CAS on `topics.maint_at`) | batched delete of `delivered` older than `keep_delivered_ms`; parked are never auto-deleted |

---

## 4. Relay loop

```
lease partitions (L1) ─▶ for each owned partition (concurrently, up to `concurrency`):
    loop: R1 → per wave: sink.deliver(wave, { epoch, signal }) → D1 / F1 / K1 → until R1 is empty
  wait on: wake NOTIFY for the topic | `gap` | `pollMs` (default 1 000) | the earliest `blocked.until` / `next_at`
  heartbeat + rebalance every `leaseMs / 3`; L1 again when below fair share
```

- The wake-up loop is local (X1): `db.listen(chan)` when the pooler profile allows it, else pure
  polling with one `onInternal('listen-unavailable')`. `chan` is `ob_` + 24 hex chars of
  `sha256(schema '/' topic)`.
- `close()` stops leasing, finishes in-flight waves (`graceMs`), releases its partitions
  (`owner = token = lease_until = null`) and deletes its `relays` row, so peers take over at once.
  `signal` and `[Symbol.asyncDispose]` do the same.
- Retry delay is the family's local `backoffMs` (15 §0.2; `baseDelayMs × 2^(attempt−1)` capped by
  `maxDelayMs`, `jitter` `'full'`). The sink can mark an error non-retryable
  (`new NonRetryableSinkError()`), and the record parks at once.

---

## 5. Public API

```ts
import type { Db, Queryable } from 'pg-prime'

export function defineOutbox<T>(topic: string, opts?: {
  partitions?: number                         // 16
  ordered?: boolean                           // true (X3)
  keepDeliveredMs?: number                    // 86_400_000 (X7); 0 = delete on delivery, no dedup afterwards
  schema?: StandardSchemaV1<unknown, T>
  codec?: { encode(v: T): unknown; decode(v: unknown): T }
}): OutboxDef<T>

export interface OutboxConfig<D extends Record<string, OutboxDef<any>>> {
  db: Db
  schema?: string                             // 'pgprime_outbox'
  autoMigrate?: boolean                       // true
  define?: D
  hooks?: OutboxHooks
}
export function pgOutbox<const D extends Record<string, OutboxDef<any>> = {}>(config: OutboxConfig<D>): Outbox<D>

export interface Outbox<D> extends AsyncDisposable {
  readonly topics: { readonly [K in keyof D]: OutboxTopic<PayloadOf<D[K]>> }
  topic<T>(def: OutboxDef<T>): OutboxTopic<T>
  start(): Promise<void>                      // 15 §0.3: ensure + topic rows; required before write()
  migrate(): Promise<{ from: number; to: number }>
  close(): Promise<void>
}

export interface WriteOptions { tx: Queryable<any>; key?: string; idempotencyKey?: string; headers?: Record<string, string> }
export interface OutboxTopic<T> {
  start(): Promise<void>                      // creates this topic's rows (ad hoc topics); declared ones start with outbox.start()
  write(payload: T, opts: WriteOptions): Promise<{ id: bigint; idem: string; duplicate: boolean }>
  writeMany(items: readonly ({ payload: T } & Omit<WriteOptions, 'tx'>)[], opts: { tx: Queryable<any> }): Promise<{ id: bigint; idem: string; duplicate: boolean }[]>
  relay(sink: OutboxSink<T>, opts?: RelayOptions): Relay
  parked(opts?: { limit?: number; after?: bigint }): Promise<OutboxRecord<T>[]>
  replay(ids: readonly bigint[]): Promise<number>
  discard(ids: readonly bigint[]): Promise<number>
  pause(): Promise<void>; resume(): Promise<void>
  stats(): Promise<OutboxStats>
}

export interface OutboxRecord<T> { readonly id: bigint; readonly key: string | null; readonly idem: string; readonly payload: T; readonly headers: Record<string, string> | null; readonly attempts: number; readonly createdAt: Date }
export interface DeliveryContext { readonly signal: AbortSignal; readonly epoch: bigint; readonly partition: number }
export interface OutboxSink<T> {
  // `wave` never holds two records of one key (X4), so a sink may deliver it in parallel
  deliver(wave: readonly OutboxRecord<T>[], ctx: DeliveryContext): Promise<void | { failed: ReadonlyMap<bigint, unknown> }>
}
export interface RelayOptions {
  batchSize?: number                          // 100
  concurrency?: number                        // partitions delivered in parallel by this relay; 4
  leaseMs?: number                            // 30_000
  pollMs?: number                             // 1_000
  retry?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; jitter?: 'full' | 'equal' | 'none' }   // 10, 1_000, 300_000, 'full'
  graceMs?: number                            // 10_000
  owner?: string                              // default `${hostname}:${pid}:${random}`
  signal?: AbortSignal
}
export interface Relay extends AsyncDisposable { readonly partitions: readonly number[]; close(): Promise<void> }

export function functionSink<T>(fn: (batch: readonly OutboxRecord<T>[], ctx: DeliveryContext) => Promise<void | { failed: ReadonlyMap<bigint, unknown> }>): OutboxSink<T>
export function webhookSink<T>(opts: {
  url: string | ((r: OutboxRecord<T>) => string)
  mode?: 'batch' | 'record'                   // 'record'
  headers?: Record<string, string>
  timeoutMs?: number                          // 10_000
  sign?: { secret: string; header?: string }  // HMAC-SHA256 over the body → `X-Signature`
  retryable?: (status: number) => boolean     // default: 408, 425, 429 and 5xx
}): OutboxSink<T>
// sends `Idempotency-Key: <idem>`, `X-Outbox-Epoch: <epoch>`, JSON body; uses global fetch and node:crypto (Bun ok)

export class OutboxLeaseLostError extends PgPrimeError {}   // 'OUTBOX_LEASE_LOST'
export class NonRetryableSinkError extends PgPrimeError {}  // 'OUTBOX_NON_RETRYABLE'
export interface OutboxHooks {
  onWrite?(e: { topic: string; count: number; duplicates: number }): void
  onDeliver?(e: { topic: string; partition: number; count: number; durationMs: number }): void
  onFail?(e: { topic: string; id: bigint; key: string | null; attempt: number; error: unknown }): void
  onPark?(e: { topic: string; id: bigint; key: string | null; error: unknown }): void
  onLease?(e: { topic: string; acquired: readonly number[]; released: readonly number[] }): void
  onInternal?(e: { kind: 'listen-unavailable' | 'heartbeat-failed' | 'hook-failed'; message: string; cause?: unknown }): void
}
```

`write` requires `tx` by type: the package exists for transactional writes. The `Db` handle is
accepted too, since a single statement is its own transaction, and the docs say when that is enough.

---

## 6. Failure semantics

| Failure | Outcome | Mechanism |
|---|---|---|
| Caller's tx rolls back | no record, no NOTIFY | W1 in the tx |
| Two writers of one key | serialize until commit; ids in commit order | X3 |
| Duplicate write (same `idempotencyKey`) | no-op, `duplicate: true`, while the first record is pending, parked or within `keepDeliveredMs` of delivery | `unique (topic, idem)` + X7 |
| Relay crashes mid-delivery | lease expires, a peer takes the partition, the batch is redelivered with the **same `idem`** and a **higher `epoch`** | X2, X6 |
| Lease stolen while the old relay's sink call is in flight | possible duplicate delivery; the old relay's D1 returns 0 → stop; per-key order holds for each relay | X6 fencing lets a sink reject the stale epoch |
| Sink fails for key K | K blocked with backoff; other keys continue | X5 |
| Poison record | parked after `maxAttempts`; K stays blocked (`block`) or proceeds (`skip`) | K1 |
| NOTIFY lost or unavailable | `gap` → immediate read; `pollMs` caps latency | §4 |
| Pool exhausted | settles queue in the pool; a heartbeat delayed past `leaseMs` ⇒ lease lost ⇒ redelivery (bounded by `idem`) | heartbeat at `leaseMs / 3` |
| Clock skew | none (DB clock) | 15 §0.5 |

**Guarantee:** at-least-once delivery; per-key FIFO in commit order (with `ordered: true`); never
two concurrent deliveries of one key while both leases are valid; stable idempotency key and
fencing epoch for every delivery.

**PgBouncer transaction mode:** W1, the relay statements and `migrate` all work (xact advisory
locks, single statements). Wake-ups need `directConnection`; otherwise the relay polls.

---

## 7. Test plan

**Tier 0:**
- Golden SQL for W1 (with and without keys, `ordered: false`), L1, R1, D1 (both variants), F1, K1,
  admin.
- Wave split (no wave holds a key twice; a failed key is excluded from later waves).
- Fair-share math counting non-owning relays; `backoffMs` against 15 §0.2's fixed vectors.
- `webhookSink` against a local `node:http` server: headers, HMAC, timeout, retryable status
  matrix.
- Waker on a fake listen; hook isolation; registry type probes.

**Tier 1 (PGlite, sequential):**
- `migrate` idempotence and vendored SQL.
- Write in a rolled-back tx leaves nothing; duplicate `idem`.
- Relay delivers in id order per partition; failure blocks one key while others flow.
- Write to an ad hoc topic before its `start()` throws `NotStartedError` and rolls the caller's
  transaction back.
- Park blocks the key; `replay`, `discard` (both unblock it), `pause`; `keepDeliveredMs` retention; a duplicate
  `idem` after delivery is still a no-op within the window; `start()` refuses a declaration whose
  `partitions` differs; `write` before `start()` throws `NotStartedError`.
- Function sink; examples.

**Tier 2 (`requiresConcurrency`):**

| Test | Oracle |
|---|---|
| **per-key order under 4 relays and 8 writers** — 200 keys × 100 records, each writer updates an aggregate row then writes | the sink log per key is strictly increasing in the writer's sequence; nothing is lost |
| **ordered writes serialize one key across concurrent txs** — writer A holds its tx 2 s, B writes the same key | B's record is delivered after A's; with `ordered: false` the test demonstrates the inversion (documents why X3 exists) |
| **no concurrent delivery of one partition** | sink-side interval log per partition: no overlap within valid epochs |
| **head failure keeps receiver order** — a recording sink fails K#1 once; K#2 and K#3 are pending in the same read | the receiver's applied order for K is 1, 2, 3; K#2 is never sent before K#1 succeeds |
| **relay SIGKILL** | the batch is redelivered with the same `idem` and a higher `epoch`; the deduplicating sink count equals the record count |
| **rebalance** — 1 → 4 → 2 relays, a newcomer starting while the incumbent owns all P | the newcomer gets its share within one heartbeat; shares within ±1; a released partition is re-leased within one L1 cycle, not after `leaseMs` |
| **wake latency** | p95 < 100 ms with `pollMs: 5000` |
| **PgBouncer transaction mode** | writes plus a polling relay deliver everything |

**Bun:** unit tier plus the tier-2 order test and `webhookSink` on Bun 1.4.2.

**Bench** (`bench/outbox`, nightly): writes/s with ordered vs unordered keys; relay records/s at
P = 16 with 1 and 4 relays.

---

## 8. Gates, CI, docs

**Gates and CI.** All shared wiring is F0's (15 §0.6). O-workstreams touch only:
- `tools/api-snapshot/pg-prime-outbox.json`;
- the `outbox-write` golden (15 §0.4: ≤ 10 KB delta; it measures the whole handle — no exclusion
  claims);
- the pack-smoke consumer body (`write` over `createMockPool`; own project, footprint ≤ 150 KB).

**Docs.**
- README.
- `guides/outbox.mdx`: writing in a transaction, choosing keys, sinks, writing a Kafka/NATS sink
  (recipe), idempotency and fencing on the receiving side, the events-topic sink recipe.
- `operations/outbox.mdx`: partitions, parking, `stats`, PgBouncer.
- `reference/outbox.mdx`.
- Module docs + `docs/INDEX.md` lines. X2/X3's ordering argument goes in `src/sql/write.md` and
  `src/relay/lease.md` Gotchas.

---

## 9. Workstreams

| WS | Deliverable | Depends | Exit gate |
|---|---|---|---|
| **O0** | Skeleton, migration v1, `defineOutbox`/`pgOutbox`/`start`, W1, frozen §5 types | S0, F0 (15) | tier 0–1 write tests; `outbox-write` golden |
| **O1** | Relay: `relays` heartbeat, L1/release/rebalance, R1, waves, D1/F1/K1, local waker, admin, retention | O0 | tier-2 order, head-failure, partition and rebalance tests |
| **O2** | Sinks: `functionSink`, `webhookSink` | O0 (types) | sink unit matrix, Bun run |
| **O3** | Docs, bench, bun step | O1, O2 | `docs:check` green; coverage 100 % |

O1 ∥ O2 after O0. The family order is in 15 §0.6: outbox is independent of events, mq and cron,
and runs in parallel with them after S0 and F0.

---

## 10. Open questions

1. **X-Q1** — resolved: a parked head always blocks its key (strict order); `skip` is deferred.
2. **X-Q2** — `ordered: true` by default. It costs one advisory xact lock per distinct key per
   write transaction and serializes same-key writers until commit.
3. **X-Q3** — Ship `webhookSink` in the package or as a docs recipe? It adds ~4 KB and no deps.
4. **X-Q4** — Default `P = 16`, immutable (X8). Relay parallelism is capped at `P` per topic;
   changing it means a new topic.

**Deferred from v0 (outbox):**
- `onPark: 'skip'` — a second park mode that releases a key past a lost record; strict order plus operator `replay`/`discard` is one mechanism.
- `repartition` — changing `P` races writers and strands parked records (X8).
