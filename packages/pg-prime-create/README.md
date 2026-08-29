# @pg-prime/create

Project scaffolder for [pg-prime](https://github.com/pg-prime/pg-prime) — one command, a working
project, no dependency tree of its own.

> **Status: pre-alpha.** It builds, installs and scaffolds, but it is still `0.0.0` and what it
> writes will change with the packages it pins. Follow progress at
> <https://github.com/pg-prime/pg-prime>.

```
npm  create @pg-prime@latest my-app
pnpm create @pg-prime my-app
yarn create @pg-prime my-app
bun  create @pg-prime my-app
```

## What you get

```
my-app/
  schema.ts            the tables, the relations, one defineSchema
  db.ts                pgPrime({ connection, schema }) — synchronous, opens no socket
  index.ts             an insert and a join, typed end to end
  pg-prime.config.ts   what the `pg-prime` CLI reads
  migrations/          empty; `pg-prime migrate generate` fills it
  tsconfig.json  package.json  .env.example  .gitignore  README.md
  test/                a transaction-per-test fixture on PGlite (unless --no-testing)
```

Then:

```
cd my-app
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/app
npx pg-prime migrate generate --name init
npx pg-prime migrate apply
npm run build && npm start        # [ { title: 'Hello', author: 'Alice' } ]
```

## Options

```
create-pg-prime [directory] [options]

  --yes, -y         accept every default and ask nothing (implied when stdin is not a TTY)
  --pm <manager>    npm | pnpm | yarn | bun (default: the one that ran this command)
  --testing         write the vitest + PGlite fixture (default)
  --no-testing      leave the tests out
  --install         install dependencies when the files are written (default)
  --no-install      write the files and stop
  --git             run `git init` in the new directory (default)
  --no-git          do not initialise a repository
  --help, -h        print this help
  --version         print the version
```

A directory that already has files in it is refused, with the entries it found in the message.
`.git` and `.DS_Store` do not count.

## It is the getting-started guide

Every template with a code block on
[the getting-started page](https://pg-prime.github.io/pg-prime/guides/getting-started/) is
**byte-equal to that block**, and a test in the pg-prime repository fails if they drift — the page
wins. The scaffold is then installed from the release's own tarballs and migrated against a real
PostgreSQL on every CI run, so the terminal transcripts on that page are what the commands print.

The versions in the generated `package.json` are pinned at build time from the release this
scaffolder shipped in, which is why `@latest` is the spelling to use.

## Zero dependencies

Four questions through `node:readline/promises`. No prompt library, no colour library, nothing to
audit. Node ≥ 22.12.

Full reference: <https://pg-prime.github.io/pg-prime/reference/create/>.

## License

MPL-2.0
