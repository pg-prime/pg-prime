---
'@pg-prime/create': minor
---

First release of the scaffolder: `npm create @pg-prime@latest my-app` writes a working pg-prime
project — `schema.ts`, `db.ts`, `pg-prime.config.ts`, a first query, an empty `migrations/`, and a
transaction-per-test fixture on PGlite unless you pass `--no-testing`.

What it writes **is** the getting-started guide: every template with a code block on that page is
byte-equal to it, and a test in this repository fails if they drift. The project is then installed
from the release's own tarballs and migrated against a real PostgreSQL on every CI run, so the
transcripts on the page are what the commands actually print.

Zero dependencies (four questions through `node:readline/promises`), and the versions it pins are
generated at build time from the release it ships in — which is why `@pg-prime/create` is now in
the same fixed version group as `pg-prime` and `@pg-prime/kit`.
