# @pg-prime/kit

Migration engine for [pg-prime](https://github.com/pg-prime/pg-prime) — catalog diffing, plan
generation, prove-on-shadow-clone, apply.

> **Status: pre-alpha.** The package builds and installs — ESM-only, TypeScript ≥ 5.9, `pg` as its
> one runtime dependency — but it is still `0.0.0` and the API will change. Four commands ship:
> `migrate apply`, `migrate status`, `migrate baseline`, `migrate unlock`. `generate`, `check`,
> `verify`, `lint`, `push` and `doctor` do not exist yet and `pg-prime --help` says so.
> Follow progress at <https://github.com/pg-prime/pg-prime>.

```
npm i -D @pg-prime/kit
npx pg-prime migrate status
```

## The four commands

| Command | What it does | Exit codes |
|---|---|---|
| `pg-prime migrate apply` (alias `deploy`) | Applies pending migrations from `migrations/`. Never generates, never introspects the desired state, never reads your TypeScript — a production image does not need to ship schema code. | `0` applied or nothing to do · `1` error · `4` drift · `6` lock unavailable |
| `pg-prime migrate status` | Applied vs pending, the current fingerprint, stale locks, partially-applied rows. Read-only, and read-only in the strong sense: it will not create the history schema. | `0` up to date · `4` drift · `5` pending |
| `pg-prime migrate baseline` | Adopts an existing database: writes `0000_baseline.sql` + `.plan.json` holding the whole current schema and records it **without executing it**. `--at <id>` instead marks an already-migrated directory adopted up to `<id>`. | `0` · `1` |
| `pg-prime migrate unlock` | Inspects the migration lease; `--force` breaks a stale one. | `0` free, stale or released · `6` a live deploy holds it |

Every command takes `--output json` and then always prints one envelope with `status` and
`exitCode`, on stdout, including for a usage error. Exit codes are
[design/06 §6.1](../../design/06-migrations.md)'s table and are the same for every command:

```
0 success or nothing to do   1 error   2 missing hints   3 lint
4 drift                      5 pending 6 lock unavailable  7 proof failed
```

Run `pg-prime migrate <command> --help` for the flags.

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

The CLI is a thin shell over exported functions; `applyPending`, `migrationStatus`, `ensureHistory`,
`readMigrationsDir` and the `EXIT` table are all on the root barrel.

```ts
import { applyPending, EXIT } from '@pg-prime/kit'

const result = await applyPending(
  { host: '127.0.0.1', port: 5432, user: 'postgres', password: '', database: 'app' },
  './migrations',
  { schemas: ['public'] },
)
if (result.exitCode !== EXIT.ok) throw new Error(result.error?.message)
```
