# {{name}}

Scaffolded by `npm create @pg-prime`. Everything here is [the getting-started
guide](https://pg-prime.github.io/pg-prime/guides/getting-started/), file for file.

```
schema.ts            the tables, the relations, and one `defineSchema`
db.ts                `pgPrime({ connection, schema })` — synchronous, opens no socket
index.ts             an insert and a join, typed end to end
pg-prime.config.ts   what the `pg-prime` CLI reads
migrations/          generated SQL, one file per migration, committed
```

## First run

1. Point it at a database. Copy `.env.example` to `.env`, or export the variable:

   ```sh
   export DATABASE_URL=postgres://postgres:postgres@localhost:5432/app
   ```

2. Generate the first migration and apply it:

   ```sh
   {{pmExec}} pg-prime migrate generate --name init
   {{pmExec}} pg-prime migrate apply
   ```

3. Run the query:

   ```sh
   {{pmRun}} build
   {{pmRun}} start
   ```

   It prints `[ { title: 'Hello', author: 'Alice' } ]`.

<!-- testing:start -->
## Tests

```sh
{{pmRun}} test
```

`test/index.test.ts` runs every case inside a transaction that is always rolled back, against
[PGlite](https://pglite.dev) — a real PostgreSQL, in the test process, with no Docker.
`test/setup.ts` starts it, applies `migrations/` to it, and is a `setupFiles` entry rather than a
`globalSetup` one on purpose: PGlite is a single backend, so one instance per test *file* is what
keeps files from seeing each other's temp tables, sequences and session state.

<!-- testing:end -->
## Changing the schema

Edit `schema.ts`, then generate again:

```sh
{{pmExec}} pg-prime migrate generate --name what_changed
```

pg-prime diffs the live catalog against the schema you wrote, proves the migration on a shadow
clone before writing it, and refuses anything it cannot make lock-safe. `migrate status` is
read-only and exits non-zero when something is pending, which is what makes it usable in a deploy
script.

## Where to go next

- [Queries](https://pg-prime.github.io/pg-prime/guides/queries/)
- [Migrations end to end](https://pg-prime.github.io/pg-prime/guides/migrations/)
- [Testing with PGlite](https://pg-prime.github.io/pg-prime/guides/testing/)
