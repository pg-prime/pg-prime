# @pg-prime/kit

Migration engine for [pg-prime](https://github.com/pg-prime/pg-prime) — catalog diffing, plan
generation, prove-on-shadow-clone, apply.

> **Status: pre-alpha.** The package builds and installs — ESM-only, TypeScript ≥ 5.9, `pg` as its
> one runtime dependency — but it is still `0.0.0` and the API will change. All twelve of
> [design/06 §6.2](../../design/06-migrations.md)'s commands ship.
> Follow progress at <https://github.com/pg-prime/pg-prime>.

```
npm i -D @pg-prime/kit
npx pg-prime migrate generate --name init
npx pg-prime migrate apply
```

## Quickstart

Three files. `pg-prime.config.ts` in your project root:

```ts
import { defineConfig } from '@pg-prime/kit'

export default defineConfig({
  url: process.env.DATABASE_URL,
  schema: './db/schema.ts',      // your pgTable declarations
  migrations: './db/migrations',  // NNNN_name.sql + .plan.json land here
  repeatables: './db/sql',        // views, functions, triggers — re-applied on change
  schemas: ['public'],
})
```

`db/schema.ts` — ordinary `pg-prime`:

```ts
import { defineSchema, index, pgTable } from 'pg-prime'

export const widgets = pgTable(
  'widgets',
  (t) => ({
    id: t.bigint().generatedAlways().primaryKey(),
    name: t.text().unique(),
    createdAt: t.timestamptz().defaultSql('now()'),
  }),
  (t) => [index('widgets_created_at_idx').on(t.createdAt)],
)

export default defineSchema({ widgets })
```

Then the loop:

```console
$ pg-prime migrate generate --name init
migrate generate — app (shadow tier 2: the admin role has CREATEDB)

  0000_init.sql  main  4 statements  txmode transactional

  proof    passed
  witness  passed

$ pg-prime migrate apply
applied 1 migration in 41 ms:
  0000_init  transactional  4 statements  38 ms

$ pg-prime migrate status
  history       present (v1)
  fingerprint   sha256:5f0e… (history)
  migrations    1 file, 0 pending
  lock          free

$ pg-prime migrate verify        # replay the whole repo from empty, into a throwaway database
migrate verify — replayed 1 migration into pgprime_shadow_9c1a4f22
  verdict   verified
```

`generate` writes nothing until the plan has been **proved** on a shadow clone and witnessed by
`pg_dump` — that is not a flag, it is the design (`design/06` D6/D10). It also needs no `CREATEDB`:
with a restricted role the shadow is a temp schema inside your own database, and so is the proof.

## The commands

| Command | What it does | Exit codes |
|---|---|---|
| `pg-prime migrate generate` | Builds IR(desired) from your TypeScript + `sql/`, normalises it through the shadow ladder, diffs it against the live catalog, resolves renames from `.renamedFrom(…)`, applies the lock-safe rewrites, **proves the plan on a clone**, and only then writes `NNNN_name.sql` + `.plan.json`. May write a `_concurrently` companion file at the same number. | `0` written or nothing to do · `1` error · `2` a rename or data-loss decision is missing · `3` lint · `7` proof failed |
| `pg-prime migrate apply` (alias `deploy`) | Applies pending migrations from `migrations/`. Never generates, never introspects the desired state, never reads your TypeScript — a production image does not need to ship schema code. | `0` applied or nothing to do · `1` error · `4` drift · `6` lock unavailable |
| `pg-prime migrate status` | Applied vs pending, the current fingerprint, stale locks, partially-applied rows, repeatable drift. Read-only, and read-only in the strong sense: it will not create the history schema. | `0` up to date · `4` drift · `5` pending |
| `pg-prime migrate check` | The CI gate. Is the repository consistent with the schema, with its own checksums, and with the database? No history writes. | `0` · `2` · `3` · `4` · `5` |
| `pg-prime migrate verify` | Provisions an ephemeral database, **replays every migration from empty through the real runner**, and asserts the result matches your schema. Catches "the committed file does not do what the schema says", which drift detection cannot. | `0` verified · `1` error, or no ephemeral database available · `4` non-empty diff |
| `pg-prime migrate lint [<file>…]` | The `design/06` §3.4 rules over generated or hand-written SQL. Defaults to the unapplied migrations; needs no database when you name files. | `0` clean · `1` usage · `3` a finding at or above `--fail-on` |
| `pg-prime migrate baseline` | Adopts an existing database: writes `0000_baseline.sql` + `.plan.json` holding the whole current schema and records it **without executing it**. `--at <id>` instead marks an already-migrated directory adopted up to `<id>`. | `0` · `1` |
| `pg-prime migrate push --dev` | Dev loop only: applies the diff straight to the database, writing no files and no history rows. Refuses without the literal `--dev`, under `PG_PRIME_ENV=production`, on a `--prod-pattern` match, and against any database under versioned management. | `0` · `1` · `2` |
| `pg-prime migrate doctor` | Read-only health report: INVALID indexes, `_ccnew%` leftovers, NOT VALID constraints, catalog-vs-history drift, stale leases, orphaned repeatables, the Tier-O and Tier-U census. | `0` healthy · `4` findings |
| `pg-prime migrate unlock` | Inspects the migration lease; `--force` breaks a stale one. | `0` free, stale or released · `6` a live deploy holds it |
| `pg-prime migrate checkpoint` | Writes `NNNN_checkpoint.sql` holding the whole current schema, plus `NNNN_checkpoint.plan.json` and `checkpoints/NNNN.ir.json`. A **fresh** database then applies that file and everything after it instead of replaying four hundred; an **existing** one records it as `superseded` and continues linearly. Nothing is deleted, and the `.ir.json` is what lets `apply` and `status` NAME the objects that drifted. | `0` · `1` |
| `pg-prime db seed [--set <name>]` | Runs `seeds/*.sql` and `seeds/*.ts` in filename order, each file in its own transaction. **Never recorded in `pgprime.migrations`** — it does not even create the history schema. A `.ts` seed gets a real, typed `Db`. Refuses under `PG_PRIME_ENV=production` or a `--prod-pattern` match without `--force`. | `0` seeded or nothing to do · `1` refused or failed |
| `pg-prime pull --out <file>` | Introspects the database and writes a deterministic TypeScript schema file in the DSL's own spelling, with views/functions/triggers/policies going to `sql/` as repeatables and anything the DSL cannot express into a `-- pull: unsupported` header block and `pull.report.json`. A second `pull` over the result is byte-identical, and `migrate generate` against the same database reports an empty diff. | `0` · `1` |

Every command takes `--output json` and then always prints one envelope with `status` and
`exitCode`, on stdout, including for a usage error. Exit codes are
[design/06 §6.1](../../design/06-migrations.md)'s table and are the same for every command:

```
0 success or nothing to do   1 error   2 missing hints   3 lint
4 drift                      5 pending 6 lock unavailable  7 proof failed
```

Run `pg-prime migrate <command> --help` for the flags. `db seed` and `pull` are their own verbs
rather than `migrate` ones, and that is the point: neither writes a migration.

## Backfills are a runner feature, not a documentation page

A data migration is a hand-written file in the same ordered history as the DDL, tagged
`-- pg-prime:data` and `-- pg-prime:batch` (design/06 §7 lane 2). `migrate generate --data --name
backfill_country` scaffolds one, and the directive is interpreted by the **runner**:

```sql
-- pg-prime:txmode    none
-- pg-prime:batch     size=1000 pause=100ms max-replica-lag=10s
```

Every statement in the file is re-executed, **each in its own transaction**, until it reports zero
rows. Between iterations the runner sleeps `pause` and waits while replica lag exceeds
`max-replica-lag` — read from `pg_stat_replication` on the primary by default, or from
`pg_last_wal_replay_lsn()` on each URL in the config's `replicas`. After every batch it writes
`{ rows_done, watermark }` to `pgprime.data_progress` **inside the batch's own transaction**, so a
backfill killed at 3 000 of 50 000 rows resumes at row 3 001 rather than starting again, and
`migrate status` shows how far it got.

The statement talks to the runner through two settings and two columns:

```sql
-- pg-prime:stmt 0 lock=rowExclusive idempotent
WITH batch AS (
  SELECT id FROM public.users
   WHERE country IS NULL
     AND (nullif(current_setting('pgprime.watermark', true), '') IS NULL
          OR id > nullif(current_setting('pgprime.watermark', true), '')::bigint)
   ORDER BY id
   LIMIT current_setting('pgprime.batch_size')::int
), updated AS (
  UPDATE public.users AS t SET country = DEFAULT
    FROM batch AS b WHERE t.id = b.id RETURNING t.id AS id
)
SELECT count(*)::bigint AS rows_done, max(id)::text AS watermark FROM updated;
```

A statement that reports no `rows_done` falls back to its command tag's row count, which is the
simpler `WHERE id IN (SELECT … LIMIT n)` shape — it works, but it re-scans from the top of the
table on every iteration and has nothing to resume from. The template writes the keyset form.

## Renames are annotations, never guesses

Deleting `first_name` and adding `name` is a `DROP COLUMN` unless you say otherwise, and saying
otherwise lives in your repository:

```ts
name: t.text().renamedFrom('first_name'),
```

It fires only when `first_name` exists and `name` does not, so it is safe to leave in the file for
ever and safe to delete once the migration has shipped. Without it, `generate` **stops** — exit 2,
with the pair it suspected and the exact line to add:

```console
$ pg-prime migrate generate --name rename
1 decision needs a human (design/06 §3.3). Nothing was written.

  rename?  column:public.users.first_name -> column:public.users.name  [unambiguous]
           first_name and name have identical content hashes — every attribute except the name agrees
           fix: add .renamedFrom("first_name") to name in your schema, or pass --hints-file with …
```

`--interactive` shows the same candidates on a TTY and prints the edit as a `patch -p0` diff.

## Lock-safe DDL, and the second file

`design/06` §3.5's rewrites are on by default. Adding an index to a populated table does **not**
produce `CREATE INDEX`; it produces a `txmode none` companion migration at the same number:

```
db/migrations/
  0001_evolve.sql               -- transactional: ALTER TABLE … ADD COLUMN, RENAME COLUMN
  0001_evolve.plan.json
  0001_evolve_concurrently.sql  -- txmode none: DROP INDEX CONCURRENTLY IF EXISTS + CREATE … CONCURRENTLY
  0001_evolve_concurrently.plan.json
```

Duplicate numbers are legal and files apply in `(seq, name)` order, so the two run in the order
they were written. The second file's `from` fingerprint is *measured* on the clone during the
proof, which is why `--no-prove` is refused for a plan that spans two files. `--no-safe-rewrite`
turns the whole layer off and gives you the literal diff in one file.

## Configuration

`pg-prime.config.ts` in your project root (or any ancestor of the working directory). It is
`import()`ed with **Node's own type stripping** — no `jiti`, no `tsx`, no build step. On Node
< 22.18 the CLI re-executes itself once with `--experimental-strip-types`; if that is not available
either, rename the file to `pg-prime.config.mjs` and write it in JavaScript.

```ts
import { defineConfig } from '@pg-prime/kit'

export default defineConfig({
  // postgres:// URL. `--url` overrides it; PG_PRIME_DATABASE_URL and then DATABASE_URL
  // are consulted only when neither is set.
  url: process.env.DATABASE_URL,

  // Where NNNN_name.sql + .plan.json live. Relative to THIS FILE, not the cwd.
  migrations: './db/migrations',

  // Repeatable objects — views, functions, triggers (design/06 §3.8). Applied after the
  // versioned files, in one transaction, when their hash changes.
  repeatables: './db/sql',

  // The managed schema set. It scopes the diff, the fingerprint AND the advisory lock key,
  // so `apply` must be given the same set the migration was generated with.
  schemas: ['public'],

  // `db seed`'s directory. Files at the top level are the base set; a subdirectory is a
  // named set, run only when `--set <name>` asks for it.
  seeds: './db/seeds',

  // Standby URLs for `-- pg-prime:batch max-replica-lag=…`. Without them the ceiling is
  // read primary-side from pg_stat_replication, which needs no second credential but is
  // invisible to a role outside pg_monitor.
  replicas: [],

  // design/06 §5.2's defaults, if you need to move them.
  lockTimeout: '3s',
  lockWaitMs: 30_000,
  staleLockAfterMs: 60_000,
})
```

`PG_PRIME_ENV=production` sets the production tag that `push --dev` will refuse to run under.

## Applying migrations, in one paragraph

`apply` opens **one dedicated direct connection** and refuses a pool. It refuses a
transaction-mode pooler too, actively: it makes the pooler try to move it to another backend and
names the direct port if it succeeds — a session advisory lock taken behind PgBouncer in
`pool_mode=transaction` is silently broken, and that is a class of production corruption rather
than an inconvenience. Then it takes the advisory lock plus a heartbeat lease, reconciles the
files on disk against `pgprime.migrations`, checks each file's sha256 against its plan and the live
schema fingerprint against the plan's `from`, and applies each file on its own: a transactional
file commits its DDL **and its history row in the same transaction**, a `txmode none` file records
`statement_uncertain` before every statement and `statements_applied` after it so a crash can be
resumed. `--dry-run` prints the exact statement stream, including the `BEGIN`/`COMMIT` framing and
the `set_config` calls, and touches nothing.

## Programmatic API

The CLI is a thin shell over exported functions; `generate`, `applyPending`, `migrationStatus`,
`ensureHistory`, `readMigrationsDir` and the `EXIT` table are all on the root barrel.

```ts
import { applyPending, EXIT } from '@pg-prime/kit'

const result = await applyPending(
  { host: '127.0.0.1', port: 5432, user: 'postgres', password: '', database: 'app' },
  './migrations',
  { schemas: ['public'] },
)
if (result.exitCode !== EXIT.ok) throw new Error(result.error?.message)
```
