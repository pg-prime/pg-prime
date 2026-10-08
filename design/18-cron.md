# 18 — `@pg-prime/cron`: scheduled jobs on PostgreSQL. Design & Implementation Plan

2026-10-08. Branch `feat/mq`. **Status: PLAN — for revmux review before any code.**
Family rules (dependency graph, shared helpers, ledgers, packaging, budgets, cross-plan order) are
in [15-events §0](./15-events.md).

`@pg-prime/cron` runs scheduled work across any number of application instances, with the database
as the only coordinator. A schedule is one of:
- a cron pattern with a time zone;
- a fixed interval (`everyMs`);
- a one-shot time (`at`).

Schedules have start/end/limit bounds. Each tick fires **exactly once** across instances. Policies
cover overlap (`skip | queue | allow`) and misfire after downtime (`skip | once | all`). There is a
run history, pause/resume, enable/disable and a manual trigger.

A schedule has one of two targets:
- an **in-process handler**: the tick is claimed in the database, then run under a lease with a
  heartbeat;
- an **`@pg-prime/mq` queue**: the message is sent in the same transaction as the tick claim.

mq is an optional peer, and cron works without it.

**Goals.**
1. A tick is claimed once, by one statement, under any number of instances.
2. The overlap policy is enforced on counters of the locked schedule row.
3. Only DB time is used.
4. PgBouncer transaction mode (by polling), Node and Bun.

**Non-goals (v0)** are listed in §11.

---

## 1. Decisions

| # | Decision | One-line reason |
|---|---|---|
| C-D1 | **Dependencies: `croner` only.** No dependency on `@pg-prime/events`: the wake-up is a ~40-line `db.listen` + poll loop owned here, used only so schedule edits and manual triggers reach other instances quickly | A tick's due time is known in advance, so cron is a timer plus polling and needs no log or channel layer. Minimal install (15 §0.1) |
| C-D2 | **`@pg-prime/mq` is an optional peer, used structurally.** The queue target takes any object matching `CronEnqueuer` (§6); `dist/` never imports `@pg-prime/mq` (a `dist` scan and `check-dts` assert it); a type test pins that `pgMq(...)` satisfies the interface | cron installs and type-checks without mq. A type import from an optional peer would break consumers' `.d.ts` checks when it is absent |
| C-D3 | **croner@10** `[verified 10.0.1, zero deps, 155 KB unpacked]`, **lazy-imported** by the next-tick module | Zero-dep, tz via `Intl`, DST-correct, Bun-compatible. The lazy import keeps croner off the start-up path until a pattern is evaluated (the tree-shake gate counts it, 15 §0.4). Rejected: `cron-parser@5.10.1` (pulls `luxon`) and an in-house parser (DST is the trap) |
| C-D4 | **Exactly once per tick = `unique (schedule, tick_at)` on runs + a CAS on `schedules.next_at` under the row lock.** The CAS compares `$expect` (the `next_at` Q1 read); the run records `$fire` (the tick the misfire policy chose). No advisory lock | The claim statement locks the schedule row, re-checks `next_at = $expect` on the latest version (EPQ), and inserts the run. A loser matches no row, and a duplicate insert is `DO NOTHING`. Counters move only for a run that was actually inserted |
| C-D5 | **Next ticks are computed in TS from DB times.** The due-select returns `next_at` and `now()`; no `Date.now()` is read. The default `tz` is `'UTC'`, never the process zone | Clock skew and host time zones cannot move or double a tick |
| C-D6 | **Overlap is `skip` (default) or `allow`, decided from the `running` counter on the locked schedule row** (15 §0.5 rule 3) | The counter changes in the same statements that change runs. `queue` (run later) needs a promotion path with its own races and is deferred |
| C-D7 | Misfire: within `misfireGraceMs` (default 60 s) a late tick is normal. Beyond it: `skip` (fire none; record one `missed` run) or `once` (default: fire the latest missed tick within `end_at`, fold the rest into `missed`) | The two expectations that need no per-catch-up state. `all` (fire every missed tick, capped) is deferred |
| C-D8 | Handler runs: lease + token + heartbeat on the run row. **A lost lease marks the run `failed` (`lease-expired`) with no automatic re-run.** `retry` re-attempts in-process only | The next tick is the natural retry for periodic work; re-running a crashed tick could double side effects. C-Q2 records the opt-in alternative |
| C-D9 | **An instance claims only schedules it can execute**: handler schedules whose handler it registered, and queue-target schedules whose `QueueDef` it declared (with an `enqueuer`). Maintenance never starts a run itself: it hands work to `pending`, which only an eligible instance picks up (T2) | Several services can share one cron schema without stealing each other's ticks, and a queue tick is always sent with its owner's full queue declaration, never a bare name |
| C-D10 | **Code-declared schedules are synced** by `start()`: definition fields are upserted and changes detected by `spec_hash` (recomputing `next_at`); operational flags (`paused`, `enabled`) are preserved. Schedules created by the API have `source = 'api'` | Config-as-code without clobbering an operator's pause |
| C-D11 | Schema `pgprime_cron` with its own ledger via core's `migrateOwnedSchema`; peer `pg-prime >=0.2.0`; `fixed` group (0.2.0); Bun gated; ≤ 150 KB unpacked, install ≤ 350 KB including croner | family rules (15 §0.4) |

---

## 2. Data model — migration v1 (`pgprime_cron`)

```sql
create type pgprime_cron.run_state as enum
  ('pending', 'running', 'cancelling', 'succeeded', 'failed', 'skipped', 'missed', 'enqueued', 'cancelled');

create table pgprime_cron.schedules (
  name           text primary key,
  pattern        text,
  every_ms       bigint check (every_ms >= 1000),
  at             timestamptz,
  tz             text not null default 'UTC',
  start_at       timestamptz,
  end_at         timestamptz,
  max_runs       int,
  runs           int not null default 0,
  overlap        text not null default 'skip' check (overlap in ('skip', 'allow')),
  misfire        text not null default 'once' check (misfire in ('skip', 'once')),
  misfire_grace_ms int not null default 60000,
  target         text not null check (target in ('handler', 'queue')),
  queue          text,
  payload        jsonb,
  timeout_ms     int,
  retry          jsonb,
  keep_runs      int not null default 100,
  keep_runs_ms   bigint not null default 2592000000,      -- 30 days
  enabled        boolean not null default true,
  paused         boolean not null default false,
  next_at        timestamptz,                              -- null: disabled or ended
  running        int not null default 0,                   -- runs in `pending`, `running` or `cancelling`
  source         text not null check (source in ('code', 'api')),
  spec_hash      text not null,
  anchor_at      timestamptz not null default now(),       -- `every` grid origin when start_at is null; reset when the spec changes
  updated_at     timestamptz not null default now(),
  check (num_nonnulls(pattern, every_ms, at) = 1),
  check ((target = 'queue') = (queue is not null))
) with (fillfactor = 50);
create index schedules_due on pgprime_cron.schedules (next_at) where enabled and not paused and next_at is not null;

create table pgprime_cron.runs (
  id          bigint generated always as identity primary key,
  schedule    text not null references pgprime_cron.schedules (name) on delete cascade,
  tick_at     timestamptz,                                 -- null for manual runs
  manual      boolean not null default false,
  state       pgprime_cron.run_state not null,
  attempts    int not null default 0,
  missed      int not null default 0,                      -- ticks folded into this row by the misfire policy
  token       text,
  lease_until timestamptz,
  instance    text,
  message_id  bigint,                                      -- queue target
  payload     jsonb,
  started_at  timestamptz,
  finished_at timestamptz,
  error       text,
  result      jsonb,
  created_at  timestamptz not null default clock_timestamp()
) with (fillfactor = 80);
create unique index runs_tick    on pgprime_cron.runs (schedule, tick_at) where not manual;
create index runs_open           on pgprime_cron.runs (schedule, id) where state in ('pending', 'running', 'cancelling');
create index runs_running        on pgprime_cron.runs (lease_until) where state in ('running', 'cancelling');
create index runs_history        on pgprime_cron.runs (schedule, id desc);

create table pgprime_cron.meta (
  singleton boolean primary key default true check (singleton),
  maint_at  timestamptz not null default '-infinity'
);
```

`runs_running` indexes `lease_until` because the expiry sweep needs it. Heartbeats therefore are
not HOT on that index. That is acceptable: running runs are few, and heartbeats come every
`leaseMs / 3` (default 10 s).

---

## 3. Statements

### 3.1 Due select (Q1) — no locks

```sql
select name, next_at, pattern, every_ms, at, tz, start_at, anchor_at, end_at, max_runs, runs,
       misfire, misfire_grace_ms, target, now() as db_now
from pgprime_cron.schedules
where enabled and not paused and next_at <= now() and name = any($mine)
order by next_at limit 100
```

### 3.2 Planning (TS, pure) — the misfire policy

Inputs: the row and `db_now`. Outputs: `$expect = next_at` (always), and `$fire` (or none),
`$missed`, `$next`.

- **Horizon.** `h = min(db_now, end_at)`. No tick after `end_at` is ever fired, whatever the
  policy. A late tick inside the horizon:
  - `late = db_now − next_at ≤ grace` → `$fire = next_at`.
  - Otherwise, with `missed` = ticks in `[next_at, h]` (counted with croner, capped at 10 000):
    - `skip` → fire none; write one `missed` run with `$fire` = the last tick ≤ `h`;
    - `once` (default) → `$fire` = the last tick ≤ `h`; that run carries `missed − 1`.
- **Next.**
  - Inside grace, `$next` is the first tick > `$fire`, so late loops catch up tick by tick and
    none is dropped.
  - After a misfire, it is the first tick > `db_now`.
  - It is `null` (ended) when past `end_at`, or when `runs + 1 ≥ max_runs`.
- **`limit` counts claimed ticks.** Every K1 claim counts, whatever its decision (`running`,
  `skipped`, `missed`, `enqueued`, or deduplicated by mq), and manual triggers do not count. The
  limit is therefore known before admission, and the planner and K1 always agree. This is
  documented: "a schedule with `limit: 5` claims five ticks".
- **Ticks:**
  - **pattern**: `new Cron(pattern, { timezone: tz }).nextRun(after)`, with 5- or 6-field
    patterns, `L W # ?` and nicknames;
  - **every**: anchored at `start_at ?? anchor_at`, `anchor + k × every_ms`;
  - **at**: a single tick.

### 3.3 Claim (K1) — exactly once per tick, overlap decided on the locked row

```sql
with s as (
  select name, overlap, running from pgprime_cron.schedules
  where name = $name and next_at = $expect and enabled and not paused
  for update                                               -- EPQ: a concurrent claimer already moved next_at → no row
), d as (
  select name, case when $decided is not null then $decided          -- 'missed' (skip policy) or 'enqueued' (queue target)
                    when running = 0 or overlap = 'allow' then 'running'
                    else 'skipped' end as st
  from s
), r as (
  insert into pgprime_cron.runs (schedule, tick_at, state, missed, token, lease_until, instance, started_at, payload)
  select d.name, $fire, d.st::pgprime_cron.run_state, $missed,
         case when d.st = 'running' then gen_random_uuid()::text end,
         case when d.st = 'running' then now() + $lease * interval '1 ms' end,
         $instance, case when d.st = 'running' then clock_timestamp() end, $payload
  from d
  on conflict (schedule, tick_at) where not manual do nothing
  returning id, state, token
), u as (                                                  -- next_at always advances; counters only for an inserted run
  update pgprime_cron.schedules x set
    next_at = $next, updated_at = now(),
    runs    = x.runs    + (select count(*) from r),                                   -- `limit` counts claimed ticks
    running = x.running + (select count(*) from r where state = 'running')
  from d where x.name = d.name
)
select * from r
```

- A queue-target schedule passes `$decided = 'enqueued'` when the planner fires, and `'missed'`
  when the misfire policy skips. Its overlap is delegated to mq (§6), and `running` stays 0.
- The `skip` policy passes `$decided = 'missed'` with no token.
- `$expect ≠ $fire` is the normal case after downtime: the CAS matches the stored `next_at`, and the
  run records the tick actually fired.
- Locks: K1 locks the schedule row and inserts a new run row, never waiting on an existing run.

### 3.4 Heartbeat and finish (F1) — one statement each

```sql
-- heartbeat (every leaseMs / 3); 0 rows → CronLeaseLostError; 'cancelling' → abort the handler
update pgprime_cron.runs set lease_until = now() + $lease * interval '1 ms'
where id = $id and token = $tok and state in ('running', 'cancelling') returning state

-- F1: finish (token-guarded, or state-guarded from maintenance) and free the slot; locks run → schedule
with f as (
  update pgprime_cron.runs set state = $st,                -- 'succeeded' | 'failed' | 'cancelled' (operator cancel)
         finished_at = clock_timestamp(), error = $err, result = $res,
         attempts = $attempts, token = null, lease_until = null
  where id = $id and token = $tok and state in ('running', 'cancelling')
  returning schedule
)
update pgprime_cron.schedules x set running = x.running - 1
from f where x.name = f.schedule
returning 1
```

There is no queued state to promote (`overlap: 'queue'` is deferred), so finishing never starts
another run. That holds during `close()` too.

### 3.5 Manual trigger (T1) and pickup (T2)

- **Handler schedules.**
  - **T1** (`cron.trigger(name, { payload })`) runs K1's shape against `name` alone: no
    `next_at` condition, `manual = true`, `tick_at = null`.
  - The decided state is `pending` instead of `running`, still counted in `running`, so overlap
    holds.
  - It then sends `pg_notify('cron_' + hash(schema), name)`. When the calling instance can
    execute the schedule, it picks the run up at once.
  - **T2** (handler schedules only) is a pickup by an instance that registered the handler:
    `update runs set state = 'running', token, lease_until, instance, started_at where id in
    (select id from runs where state = 'pending' and schedule = any($myHandlers) order by id
    limit $n for update skip locked) returning …`.
- **Queue-target schedules.**
  - T1 runs §6's transaction directly: K1's manual shape with `$decided = 'enqueued'`, then
    `send` keyed by §6's overlap mapping (`cron:<name>:manual:<runId>` under `allow`), so overlap
    holds as for a handler trigger.
  - It never creates a `pending` run, so T2 never sees one.
  - It must be called on an instance that declared the target queue; elsewhere it throws a
    `UsageError` (C-D9).

### 3.6 Cancel (X1) — short transaction

1. Lock the run, then its schedule: `select … from runs where id = $run for update`, then
   `select … from schedules where name = $schedule for update`. This is F1's order (run →
   schedule), so a concurrent finish and cancel cannot deadlock.
2. One statement on the run:
   - `pending` → `cancelled`, `running − 1`;
   - `running` → **`cancelling`** (still counted).

   The owner's next heartbeat returns `cancelling` and aborts the handler, and its F1 records
   `cancelled` and frees the slot. Until then `overlap: 'skip'` still sees the slot as taken, so a
   second run cannot start while the cancelled handler is still running.

### 3.7 Maintenance (gated by a CAS on `meta.maint_at`, every `maintenanceMs`, default 15 s)

1. **Expired leases.** Each run with `state in ('running', 'cancelling') and lease_until < now()`
   (`for update skip locked`) gets F1 with `$st = 'failed'` and `error = 'lease-expired'` (a
   `cancelling` run gets `cancelled`), guarded by state instead of token.
2. **Counter reconcile, lock-then-count** (15 §0.5 rule 3). A short transaction locks schedules with
   `running > 0` or an open run (`for update skip locked`, ≤ 500 rows). Its second statement (a fresh snapshot)
   sets `running = count(pending, running, cancelling)`. Every statement that moves the counter
   holds the same row lock, so the count cannot race them.
3. **Retention.** Per schedule, delete finished runs beyond `keep_runs` or older than
   `keep_runs_ms` (batched, ≤ 1 000 rows).

---

## 4. Instance loop

```
start(): migrate/ensure → upsert declared schedules (15 §0.3) → await enqueuer.queue(def).start?.() for each
         queue target (so its `{ tx }` sends are allowed) → listen on 'cron_<hash>' (or poll) → loop:
  Q1 → plan each → K1 (handler: run it; queue: §6) → T2 pickups (handler schedules)
  sleep until min(next_at of $mine) − db_now, capped by pollMs (10 000), woken by NOTIFY or gap
  every leaseMs/3: heartbeats for running runs; every maintenanceMs: §3.7 (gated)
close(): stop claiming; let running handlers finish within graceMs, else abort + mark `cancelling`; F1 only when a handler settles
```

- **Abort is not finish.** On `timeoutMs`, or `close()` after `graceMs`:
  1. the instance aborts the handler's signal;
  2. it marks the run `cancelling` (still counted in `running`) with a token-guarded update;
  3. it keeps heartbeating it;
  4. it runs F1 (`failed`/`'timeout'`, or `cancelled`) only when the handler's promise settles.

  A handler that ignores its signal therefore keeps the `overlap: 'skip'` slot until it really
  stops. If the process exits first, the lease expires and maintenance finishes it (§3.7).
- **Handler execution.**
  `retry: { maxAttempts, baseDelayMs, maxDelayMs, jitter }` re-attempts in-process with the
  family's local `backoffMs` (15 §0.2), keeping the lease. The attempt count is persisted at F1.
- **Concurrency per instance.** Handlers run concurrently, each with its own lease. `maxConcurrent`
  (default unlimited) caps them; ticks over the cap are not claimed, so another instance takes them.

---

## 5. Public API

```ts
import type { Db, Queryable } from 'pg-prime'

export type ScheduleWhen =
  | { cron: string; tz?: string }                 // 5- or 6-field; tz default 'UTC'
  | { everyMs: number }                           // ≥ 1 000
  | { at: Date }

export interface ScheduleOptions<P> {
  startAt?: Date; endAt?: Date; limit?: number
  overlap?: 'skip' | 'allow'                      // 'skip'
  misfire?: 'skip' | 'once'                       // 'once'
  misfireGraceMs?: number                         // 60_000
  payload?: P | ((tick: { tickAt: Date | null; manual: boolean }) => P)
  timeoutMs?: number
  retry?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; jitter?: 'full' | 'equal' | 'none' }
  history?: { keep?: number; ageMs?: number }     // 100, 30 days
}
export interface RunContext<P> {
  readonly schedule: string; readonly tickAt: Date | null; readonly manual: boolean
  readonly payload: P; readonly attempt: number; readonly missed: number; readonly signal: AbortSignal
}
export function defineSchedule<P = undefined>(
  name: string,
  when: ScheduleWhen,
  target: { handler: (run: RunContext<P>) => Promise<unknown> } | { queue: { readonly name: string } },
  opts?: ScheduleOptions<P>,
): ScheduleDef<P>

export interface CronEnqueuer {                   // structurally satisfied by @pg-prime/mq's `pgMq(...)`
  queue(def: { readonly name: string }): {
    start?(): Promise<void>                       // mq's QueueHandle.start(); awaited by cron.start() for every queue target
    send(payload: any, opts: { tx: Queryable<any>; key: string; dedup?: 'until-done' }): Promise<{ id: bigint; deduplicated: boolean }>
  }
}

export interface CronConfig {
  db: Db
  schema?: string                                 // 'pgprime_cron'
  autoMigrate?: boolean                           // true
  schedules?: readonly ScheduleDef<any>[]
  enqueuer?: CronEnqueuer
  instance?: string                               // default `${hostname}:${pid}:${random}`
  pollMs?: number                                 // 10_000
  leaseMs?: number                                // 30_000
  maintenanceMs?: number                          // 15_000
  maxConcurrent?: number
  graceMs?: number                                // 10_000
  signal?: AbortSignal
  hooks?: CronHooks
}
export function pgCron(config: CronConfig): Cron

export interface Cron extends AsyncDisposable {
  start(): Promise<void>
  close(): Promise<void>
  create<P>(def: ScheduleDef<P>): Promise<void>                       // source 'api'
  update(name: string, patch: Partial<{ when: ScheduleWhen } & ScheduleOptions<unknown>>): Promise<void>
  remove(name: string, opts?: { force?: boolean }): Promise<boolean>
  pause(name: string): Promise<void>; resume(name: string): Promise<void>
  enable(name: string): Promise<void>; disable(name: string): Promise<void>
  trigger(name: string, opts?: { payload?: unknown }): Promise<{ runId: bigint; state: RunState }>
  cancel(runId: bigint): Promise<boolean>                             // §3.6: pending → cancelled; running → cancelling → aborted at next heartbeat
  get(name: string): Promise<ScheduleInfo | undefined>
  list(): Promise<ScheduleInfo[]>
  runs(name: string, opts?: { limit?: number; before?: bigint }): Promise<RunInfo[]>
  preview(when: ScheduleWhen, opts?: { count?: number; from?: Date }): Promise<Date[]>   // next ticks, from DB now
  prune(keep: readonly string[]): Promise<string[]>                   // remove code schedules no longer declared
}

export class CronLeaseLostError extends PgPrimeError {}  // 'CRON_LEASE_LOST'
export class ScheduleError extends PgPrimeError {}       // 'CRON_SCHEDULE' — invalid pattern/tz/bounds, with the field
export interface CronHooks {
  onTick?(e: { schedule: string; tickAt: Date; decision: RunState; missed: number; lateMs: number }): void
  onRunStart?(e: { schedule: string; runId: bigint; manual: boolean }): void
  onRunEnd?(e: { schedule: string; runId: bigint; state: RunState; durationMs: number; error?: unknown }): void
  onMisfire?(e: { schedule: string; policy: 'skip' | 'once'; missed: number }): void
  onInternal?(e: { kind: 'listen-unavailable' | 'heartbeat-failed' | 'pending-unclaimed' | 'hook-failed' | 'loop-failed'; message: string; cause?: unknown }): void
}
```

Hooks are sync and isolated, as across the family.

---

## 6. Queue target (`@pg-prime/mq`, optional)

A queue-target tick is one **short transaction**:

```ts
await db.transaction(async (tx) => {
  const run = await claim(tx)                                  // K1 with $decided = 'enqueued' (or 'missed')
  if (run?.state !== 'enqueued') return                        // a misfire-skipped tick is recorded, never sent
  const r = await enqueuer.queue(def).send(payload, { tx, key: `cron:${name}:${tickMs}`, ...overlapOpts })   // def: this instance's own QueueDef (C-D9)
  await setRun(tx, run.id, r.deduplicated ? 'skipped' : 'enqueued', r.id)
})
```

Overlap maps onto mq (the job runs there, so cron cannot see it run):

| `overlap` | mq send options | Effect |
|---|---|---|
| `allow` | `key` per tick | one message per tick |
| `skip` | `key: 'cron:<name>'`, `dedup: 'until-done'` | a tick while the previous message is unfinished is deduplicated → run `skipped` |

Exactly one message per tick, even under crashes: claim and send commit together, and a retried
claim is refused by `runs_tick` and the CAS. mq's dedup key also makes a resend after an
`IndeterminateCommitError` harmless.

`def` is always the `QueueDef` the claiming instance declared. An instance that did not declare the
target queue never claims that schedule (C-D9), so mq never sees a bare queue name, and the queue's
declared retry, retention and limits are never overwritten.

---

## 7. Failure semantics

| Failure | Outcome | Mechanism |
|---|---|---|
| N instances wake for one tick | one claims; the others match no row (CAS) or hit `DO NOTHING` | C-D4 |
| Instance crashes mid-handler | lease expires → run `failed` (`lease-expired`); the slot is freed; the next tick is unaffected | §3.7, C-D8 |
| Cancel of a running run | `cancelling` keeps the slot until the handler stops (heartbeat → abort → F1) or its lease expires | §3.6 |
| A counter drifts (bug) | recomputed by the lock-then-count reconcile within `maintenanceMs` | §3.7 |
| Crash between claim and handler start | same as above (the run is `running` with a lease) | |
| Queue target: crash mid-transaction | nothing committed; the tick is claimed again on the next loop (grace permitting) | §6 |
| All instances down for an hour | misfire policy on restart; `onMisfire` with the count | C-D7 |
| Clock skew / host time zone | none: ticks from DB times, `tz` explicit, default UTC | C-D5 |
| DST gap or overlap | croner semantics: a nonexistent local time fires one hour later (02:30 → 03:30) at most once, a repeated hour fires once (pinned by unit goldens) | C-D3 |
| NOTIFY unavailable | edits and triggers reach other instances within `pollMs`; due ticks are unaffected (timer-driven) | §4 |
| Rolling deploy with two code versions of one schedule | `spec_hash` flip-flops until the deploy finishes; `next_at` is recomputed each time (C-Q3) | C-D10 |

**PgBouncer transaction mode:** every statement and the F1/queue-target transactions work. LISTEN
needs `directConnection`; otherwise there is pure polling with one
`onInternal('listen-unavailable')`.

---

## 8. Test plan

**Tier 0:**
- Planner as a pure function: every misfire policy × grace × limit × `end_at` (no fired tick is
  ever after `end_at`, including after downtime that spans it). Inside grace, a loop 5 periods late
  fires 5 consecutive ticks and none is dropped. `limit` counts claimed ticks, including skipped and
  deduplicated ones; `every`
  anchoring; one-shot `at`.
- Next-tick goldens with croner for `America/New_York` and `Europe/Berlin` across both DST
  transitions; seconds patterns; `L W #`; invalid patterns and zones → `ScheduleError` with the
  field.
- Golden SQL for Q1, K1 (handler/missed/manual/enqueued), heartbeat, F1, T2, X1, maintenance.
- Planner output for downtime: `$expect` is the stored `next_at` and `$fire` the chosen tick, for
  each policy.
- `CronEnqueuer` type test against `@pg-prime/mq` (devDependency).
- Hook isolation; no `@pg-prime/mq` specifier in `dist` (checked by a test over the built output).

**Tier 1 (PGlite, sequential):**
- `migrate`; sync of code schedules (insert, change → recompute, operational flags preserved).
- Claim and run a handler; history and retention; pause/resume (misfire on resume), disable/enable.
- Trigger + pickup; trigger of a queue-target schedule sends one message and creates no `pending`
  run; cancel of pending and running runs (counter returns to 0); overlap `skip`/`allow` with a
  handler longer than the period.
- Queue target with a bare `pgMq({ db })` (no `define`): `cron.start()` starts the queue, so ticks
  enqueue instead of throwing `NotStartedError`.
- Queue target with `misfire: 'skip'` after downtime: one `missed` run, no message sent.
- `timeoutMs` with a handler that ignores its signal: the run stays `cancelling` (slot held, no
  second `skip` run) until the handler settles, then `failed`/`'timeout'`.
- Misfire scenarios via `next_at` moved into the past: `once` claims the latest tick and advances
  `next_at` (no stuck loop); an `every` schedule keeps its grid (`anchor_at`) across restarts.
- A `{ tx }` call before `start()` throws `NotStartedError`.
- Queue target with mq on PGlite (overlap mapping included).

**Tier 2 (`requiresConcurrency`):**

| Test | Oracle |
|---|---|
| **tick fires once across 5 instances** — `everyMs: 1000` and `*/1 * * * * *`, 20 s | runs per schedule = ticks elapsed (±1 at the edges); `runs_tick` has no gaps; no duplicate handler invocation |
| **overlap under 3 instances** — handler 2.5 × period | `skip`: never two running; `allow`: concurrent runs |
| **instance SIGKILL mid-run** | run `failed` (`lease-expired`) within `leaseMs + maintenanceMs`; `running` back to 0; the next tick fires on time |
| **manual run picked only by a handler owner** — service A owns S, service B triggers it | the `pending` run is picked up and run by A; B never starts it |
| **cancel under `skip`** — cancel a long running run, ticks keep coming | no second run starts until the cancelled handler has stopped; `running` returns to 0 |
| **manual trigger picked by exactly one instance** | one `running`, others see nothing |
| **queue target: one message per tick** — 3 instances, kill mid-transaction | mq messages with key `cron:<name>:*` = ticks; none twice |
| **misfire `once` after 10 ticks of downtime** | one run with `missed = 9`, next tick in the future |
| **misfire past `end_at`** — hourly, `endAt` 12:00, all instances down 11:00–15:30 | the fired tick is ≤ 12:00 (or none for `skip`); the schedule ends |
| **PgBouncer transaction mode** | all of the above by polling |

**Bun:** the unit tier plus the "tick fires once" tier-2 test on Bun 1.4.2.

---

## 9. Gates, CI, docs

**Gates and CI.**
- All shared wiring is F0's (15 §0.6): budgets ≤ 150 KB, exact `dependencies: ['croner']`,
  `requiredPeers: ['pg-prime']`, `optionalPeers: ['@pg-prime/mq']`.
- C-workstreams touch only:
  - `tools/api-snapshot/pg-prime-cron.json`;
  - the `cron-define` golden (≤ 20 KB delta including croner; it measures the whole `pgCron`
    handle, so no exclusion claims). croner stays a lazy `import()` for start-up cost, not for the
    gate;
  - the pack-smoke consumer body. Cron's own project is installed **without** mq; a handler
    schedule is compiled and run over `createMockPool`; footprint ≤ 350 KB;
  - a check that `dist` contains no `@pg-prime/mq` specifier.

**Docs.**
- README.
- `guides/cron.mdx`: declaring, targets, overlap, misfire, history, manual trigger, running in
  several services.
- `operations/cron.mdx`: time zones and DST, downtime behaviour, PgBouncer.
- `reference/cron.mdx`.
- Module docs + `docs/INDEX.md` lines. C-D4/C-D6's locking argument goes in `src/sql/claim.md`
  Gotchas.
- Examples run on PGlite. Multi-instance examples are `no-run` and name their tier-2 test.

---

## 10. Workstreams

| WS | Deliverable | Depends | Exit gate |
|---|---|---|---|
| **C0** | Skeleton, migration v1, `defineSchedule`/`pgCron`/`start`, upsert + `spec_hash` + `anchor_at`, next-tick module (lazy croner), planner (`$expect`/`$fire`), frozen §5 types | S0, F0 (15) | planner + DST goldens; `cron-define` golden; chain green |
| **C1** | Loop: Q1, K1, heartbeat, F1, T2, handler execution (timeout, retry, `maxConcurrent`), local listen/poll, maintenance (expiry, reconcile) | C0 | "tick once across 5", overlap, SIGKILL, manual-pickup tests |
| **C2** | Admin: create/update/remove/pause/resume/enable/disable/trigger/cancel (X1)/runs/preview/prune, retention | C1 | tier-1 admin suite; manual-trigger and cancel tier-2 |
| **C3** | Docs, bun step, footprint assertion | C1, C2 | `docs:check` green; coverage 100 % |
| **C4** | **Queue target** (§6): `CronEnqueuer`, overlap mapping, short-tx claim + send | C1 + **mq M1 and M3 (17)** | "one message per tick" tier-2; type test against mq |

**Rounds:** C0 → C1 → C2 ∥ C3 → C4 last. C0–C3 run in parallel with the events, outbox and mq
rounds after S0 and F0 (15 §0.6).

---

## 11. Not in v0, open questions

**Not in v0:** sub-second intervals; calendars or holiday exclusions; per-schedule distributed
rate limits; a UI.

**Open questions:**
1. **C-Q1** — Defaults `overlap: 'skip'` and `misfire: 'once'`. Are they the least surprising pair?
2. **C-Q2** — Should a crashed run be re-run automatically? The plan says no (C-D8); the
   alternative is `retryOnLeaseLoss: true`, which re-queues the same tick once.
3. **C-Q3** — Rolling deploys with changed schedule specs flip-flop until done. Alternatives: a
   `version` field (newest wins), or making code sync an explicit deploy step.
4. **C-Q4** — `pending` manual runs for a schedule no live instance can execute wait forever. They
   are reported by `onInternal('pending-unclaimed')` after `leaseMs`; should they expire?
5. **C-Q5** — Should the queue target live in mq (`mq.schedule(...)`) instead, keeping cron
   handler-only? The plan keeps it in cron so one place owns tick semantics and mq stays
   schedule-agnostic.

**Deferred from v0 (cron):**
- `overlap: 'queue'` — needs a queued state, a promotion path, and its own races in finish, cancel, maintenance and shutdown; `skip`/`allow` remain.
- `misfire: 'all'` with `maxCatchUp` — needs per-catch-up state the stateless planner cannot hold; `skip`/`once` remain.
- The mq group mapping for queue-target overlap (followed `overlap: 'queue'` out).

#### A4 — RESULT (2026-10-08)

Branch `worktree-agent-ab6853aa5a4785be8`, from `f2d0a36`. Commits: `d5c6e49` core (C0–C2),
`b82e1db` tier-2 suite, `8322f42` per-schedule isolation + format, `c246ef2`/`eb76d5e` goldens and
pack-smoke consumer, `6d60d81` docs, `e42f257` inlined SIGKILL victim, plus this RESULT.

**As built.** `defineSchedule`, `pgCron` (`start`, `close`, `create`, `update`, `remove`, `pause`,
`resume`, `enable`, `disable`, `trigger`, `cancel`, `get`, `list`, `runs`, `preview`, `prune`,
async dispose), `CronLeaseLostError`, `ScheduleError` (with `field`), `SchemaVersionError`, and the
§5 types. Migration v1 as §2. Statements Q1, K1, `advance`, T1, T2, heartbeat, F1, X1, maintenance
(gate, expire, reconcile, retain, pending-unclaimed) in `src/sql/*`, golden-tested. croner is
`import()`ed on the first pattern. `src/target/queue.ts` is the seam (`startQueues`, `queueTick`,
`queueTrigger`), wired into `start()`, `tick()` and `trigger()`; each rejects with
`UsageError('queue target not implemented')`.

**Gates.** All green on PG 17.11:
- cron: unit 59; live 78 (unit + 19 tier 1); pg 94 (adds 8 tier-2 × direct and PgBouncer
  transaction mode by polling). Bun 1.4.2: unit 59, pg 8 (direct).
- Full chain, test:pg on a temporary `postgres:17` + `edoburu/pgbouncer` (transaction mode):
  - unit: pg-prime 1 122, create 35, testing 23, cron 59, 3 × 1 slot;
  - live: pg-prime 1 949 (+12 skipped), testing 28, cron 78, 3 × 1;
  - pg: pg-prime 2 031 (+29 skipped), kit 461, create 42, testing 36, cron 94, 3 × 1;
  - package:check 27/27 size gates; tree-shake ok; pack smoke ok;
  - docs:check: 654 blocks, 106 examples; docs:examples:pg 10; bench:types, bench:compile.
- `dist`/`src` hold no `@pg-prime/mq` specifier (`test/unit/package.test.ts`); cron's pack-smoke
  project installs without mq and runs `preview` over `createMockPool`.

**Measured (for `tools/budgets.json`):** unpacked 141.4 KB (144 794 B) in 71 files, tarball
34.6 KB; install footprint 306.6 KB of 350 KB; `cron-define` 17 832 B min+gz delta over pg-prime
(design 20 480), 27 modules, croner included.

**Deviations and plan corrections** (plan text fixed where marked):
- §3.2 misfire count is over `[next_at, h]`, so 10 overdue ticks give `missed = 9` as the §8 oracle
  states (fixed). `onMisfire.missed` = ticks not run.
- §7 DST: croner 10.0.1 fires a nonexistent local time one hour later (02:30 → 03:30), at most
  once; it does not skip it (fixed). Pinned by goldens for New York and Berlin.
- §3.7 reconcile also locks schedules with an open run, so a counter that drifted low is repaired
  (fixed). Expiry groups by schedule: `update … from f` with two expired runs of one schedule
  would decrement once.
- `onInternal` gained `'loop-failed'` (fixed in §5): a failing iteration, or one schedule's failing
  tick (e.g. a throwing payload function), is reported and the other schedules continue.
- Q1 also returns `overlap`, `payload`, `timeout_ms`, `retry`; T2 joins them, so the database is the
  source of truth for everything but the handler and a payload function.
- K1 sets `finished_at` on `skipped`/`missed` rows and returns `payload`; handlers get the stored
  JSON for ticks and manual runs alike. T1 matches only `target = 'handler'` and
  `coalesce`s the schedule's payload.
- The heartbeat is one statement for all live runs (`unnest` of ids and tokens).
- Sync recomputes `next_at`/`anchor_at` only when the timing (pattern, every, at, tz, start, end,
  limit) changed; other definition changes keep `next_at`. A one-shot `at` in the past is stored, so
  the misfire policy decides it. The `every` grid extends in both directions from its anchor.
- `SchemaVersionError` (code `CRON_SCHEMA_VERSION`) added per 15 §0.3. No `NotStartedError`: no cron
  API takes `{ tx }`, so §8's tier-1 bullet does not apply.
- `Cron extends AsyncDisposable_` (core's), not the lib type: the build has no `esnext.disposable`.
- The default instance is `$HOSTNAME:pid:random` read from `globalThis.process`: the build has no
  Node types, so `node:os` is not imported.
- `remove({ force: true })` deletes schedule → runs, the reverse of F1's lock order; a concurrent
  finish can deadlock (40P01). Documented, not fixed.

**For A6.** `QueueContext` is `{ db, t, enqueuer, instance }`; `queueTick(c, def, row, plan, payload)`
gets the Q1 row (with `overlap`) and the planner's `{ expect, fire, decided, missed, next }`; call
`claim()` from `src/sql/claim.ts` with `decided: plan.decided ?? 'enqueued'` inside your transaction,
and return `{ runId, state }` so `tick()` emits `onTick`/`onMisfire`. `queueTrigger` must return
`{ runId, state }`. `startQueues` receives the declared queue-target defs and runs only when an
`enqueuer` is set; without one, queue schedules are synced but never claimed (C-D9). Replace the
test "a queue target is a seam until the mq target lands" in `test/live/cron.test.ts`.

**INDEX lines (integrator):**
- `- docs/packages/pg-prime-cron/src/cron.md — pgCron instance: start-up, claim loop, maintenance cadence, admin methods — read when changing cron start/close, the loop or admin calls.`
- `- docs/packages/pg-prime-cron/src/define.md — defineSchedule validation, schedule columns, spec hash — read when a ScheduleError field or code-schedule sync looks wrong.`
- `- docs/packages/pg-prime-cron/src/index.md — @pg-prime/cron exports, errors and public types — read when finding which cron export to use.`
- `- docs/packages/pg-prime-cron/src/migrations.md — pgprime_cron migration v1 tables, indexes, runs_tick — read when changing the cron schema.`
- `- docs/packages/pg-prime-cron/src/planner.md — misfire planner: grace, once/skip, endAt, limit — read when a late or missed tick fires wrongly.`
- `- docs/packages/pg-prime-cron/src/runner.md — handler runs: lease, heartbeat, timeout, retry, cancel, drain — read when a run stays running, cancelling or times out wrongly.`
- `- docs/packages/pg-prime-cron/src/sql/claim.md — Q1, K1 claim, T1 trigger, T2 pickup; exactly-once argument — read when a tick runs twice or never.`
- `- docs/packages/pg-prime-cron/src/sql/maintenance.md — lease expiry, counter reconcile, retention, maintenance gate — read when running counters drift or history grows.`
- `- docs/packages/pg-prime-cron/src/sql/runs.md — heartbeat, F1 finish, X1 cancel statements — read when finishing or cancelling a run misbehaves.`
- `- docs/packages/pg-prime-cron/src/sql/schedules.md — schedule upsert/sync, admin statements, row decoders — read when sync or admin calls write the wrong row.`
- `- docs/packages/pg-prime-cron/src/target/queue.md — queue-target seam for the mq target (C4) — read when implementing or calling the cron queue target.`
- `- docs/packages/pg-prime-cron/src/ticks.md — next-tick module: croner patterns, every grid, at, DST — read when a pattern, time zone or DST tick is wrong.`
- `- docs/packages/pg-prime-cron/src/wake.md — LISTEN-or-poll sleep for the cron loop — read when cron reacts slowly to triggers or behind PgBouncer.`

**Integrator also:** knip's `ignoreDependencies` for cron (`croner`, `pg-prime`, `@pg-prime/testing`)
can be dropped; the cron tier-2 test bundles a child process with the root `esbuild`.
