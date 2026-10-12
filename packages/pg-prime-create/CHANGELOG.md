# @pg-prime/create

## 0.2.1

### Patch Changes

- [#5](https://github.com/pg-prime/pg-prime/pull/5) [`e997a0a`](https://github.com/pg-prime/pg-prime/commit/e997a0afbe0707451aabb088939581bad6fdac7a) Thanks [@YohoCX](https://github.com/YohoCX)! - **`shadow` config: shadow database or shadow schemas, and where temp schemas go wrong.**
  
  - `migrate verify` replays into the `shadow` URL from `pg-prime.config.ts` when there is one, and uses `CREATE DATABASE` otherwise. It resets the `pgprime` history schema along with the managed schemas, so the same shadow URL can be verified again.
  - A tier-1 shadow keeps each schema's comment when it is reset, so a replay into a URL no longer reports drift on `public`.
  - The tier-3 proof keeps `index().concurrently(false)`; before this it re-derived a different plan and failed.
  - The scaffolded `pg-prime.config.ts` sets `shadow: 'auto'`, with a comment listing the choices.
  - Docs: a new section, "When temp schemas get it wrong", covers policy expressions, view bodies, `sql/` files and casts to your own types, which are not renamed and read the live schema.

## 0.2.0

### Patch Changes

- [#3](https://github.com/pg-prime/pg-prime/pull/3) [`98ad069`](https://github.com/pg-prime/pg-prime/commit/98ad069d689b69d4ad76a3c159bda5820341bf80) Thanks [@YohoCX](https://github.com/YohoCX)! - The package READMEs no longer claim `0.0.0` or "nothing is usable yet". `@pg-prime/testing`'s README now lists what it ships — `createMockPool`, `expectSql`, `startPglite`, `startPostgres`, `scratchDatabase` and the skip guards — with a minimal `startPglite` example, and `pg-prime`'s README names `pg` as the optional peer the `connection:` form needs.

## 0.1.0

### Minor Changes

- [`f047494`](https://github.com/pg-prime/pg-prime/commit/f047494a0646bc58157ec778b6d523679faa5e13) Thanks [@YohoCX](https://github.com/YohoCX)! - First release of the scaffolder: `npm create @pg-prime@latest my-app` writes a working pg-prime
  project — `schema.ts`, `db.ts`, `pg-prime.config.ts`, a first query, an empty `migrations/`, and a
  transaction-per-test fixture on PGlite unless you pass `--no-testing`.
  
  What it writes **is** the getting-started guide: every template with a code block on that page is
  byte-equal to it, and a test in this repository fails if they drift. The project is then installed
  from the release's own tarballs and migrated against a real PostgreSQL on every CI run, so the
  transcripts on the page are what the commands actually print.
  
  Zero dependencies (four questions through `node:readline/promises`), and the versions it pins are
  generated at build time from the release it ships in — which is why `@pg-prime/create` is now in
  the same fixed version group as `pg-prime` and `@pg-prime/kit`.
