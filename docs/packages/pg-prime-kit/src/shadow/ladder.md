# packages/pg-prime-kit/src/shadow/ladder.ts

## Purpose
The shadow ladder: provisions a place to load the desired schema DDL so it can be read back through the catalog. Tier 1 is a caller-supplied database, tier 2 a fresh `pgprime_shadow_<hex>` database (needs `CREATEDB`), tier 3 temp schemas inside the target database; tier 4 (`offline`) is refused.
Callers: `packages/pg-prime-kit/src/generate.ts:241` and `src/cli/commands/verify.ts` (`provisionShadow`), `packages/pg-prime-kit/src/prove/temp-schema.ts:121` (`provisionShadow(target, target, …)`), `src/config/load.ts` and `src/cli/commands/generate.ts` (`parseShadowStrategy`), CLI `check`/`generate`/`push` (`OfflineShadowError`), `src/schema/load.ts` and `src/config/define.ts` (types); partly re-exported from `src/index.ts`.
Callees: `db/pg.ts` (`withClient`, `withDatabase`, `dropDatabase`, `isObjectInUse`, `SHADOW_PREFIX`), `sql/ident.ts` (`quoteIdent`), `pg`.

## Public API
- `provisionShadow(admin, target, options)` → `Shadow` — picks and prepares a tier. Throws `OfflineShadowError`, `ShadowStrategyError`, `ShadowIsTargetError`, `ShadowNameTooLongError`, or a plain `Error` for an empty schema list.
- `ProvisionShadowOptions` — `shadow` (default `"auto"`), `schemas` (user names), `token` (test-only name suffix).
- `Shadow` — `conn` (where to load and extract), `target`, `schemaMap` (user schema → shadow schema; identity for tiers 1–2), `tier`, `reason`, `diagnostics`, `dispose()`.
- `ShadowStrategy` — `"auto" | "temp-schema" | "createdb" | "offline"`, a `postgres://`/`postgresql://` string, or `{ url }`.
- `parseShadowStrategy(raw)` — keyword passthrough, `none` → `offline`, `docker` refused, otherwise must parse as a postgres URL → `{ url }`.
- `parseShadowUrl(url)` → `ConnInfo` — host through `hostOf` (bare IPv6, empty → `127.0.0.1`), port defaults to 5432, user to `postgres`; refuses non-postgres protocols and URLs without a database.
- `OfflineShadowError` (`PG_PRIME_SHADOW_OFFLINE`), `ShadowStrategyError` (`PG_PRIME_SHADOW_STRATEGY`, carries `value`; its message has the URL's password removed), `ShadowIsTargetError` (`PG_PRIME_SHADOW_IS_TARGET`, carries `role`), `ShadowNameTooLongError` (`PG_PRIME_SHADOW_NAME_TOO_LONG`, carries `schema`, `candidate`).

## Flow
1. Dedupe and sort `schemas`; refuse empty and `offline` (`packages/pg-prime-kit/src/shadow/ladder.ts:269-271`).
2. `{ url }` or any non-keyword string → tier 1 via `parseShadowUrl` (`:273-275`, `:280-286`); `temp-schema` → tier 3; `createdb` → tier 2 (`:276-279`).
3. `auto`: if the admin role has `rolcreatedb OR rolsuper`, try tier 2; a 55006 error demotes to tier 3; no `CREATEDB` → tier 3 (`:289-304`).
4. Tier 1 first refuses a URL that names the target or the admin database (same host:port and database; loopback spellings count as one host), then drops and recreates every managed schema in the given database, with a `shadow_url_reset` warning; `dispose` resets again.
5. Tier 2 reads the target's encoding, collation, ctype and ICU/builtin locale (`:212-231`), then on the admin connection runs `DROP DATABASE IF EXISTS` and `CREATE DATABASE … TEMPLATE template0` with that locale (`:345-352`). `dispose` calls `dropDatabase` (`:361-369`).
6. Tier 3 maps each schema to `pgprime_shadow_<token>_<name>`, else `…_s<i>`, else throws `ShadowNameTooLongError`; it drops and creates those schemas in the target (`:389-405`).
7. Tier 3 `dispose` drops them `CASCADE` and throws if any survives (`:424-441`).

## Gotchas
- Tier 1 is destructive: the managed schemas in the shadow URL's database are dropped `CASCADE` on provision and on dispose. The guard against the target/admin database compares `host:port/database` after `hostOf` (brackets stripped, empty host = `127.0.0.1`), lower-casing and loopback folding; a DNS alias of the target is not caught.
- A non-keyword string never falls through to `auto`; it is a tier-1 URL or a `ShadowStrategyError` (`:280-286`).
- Only `auto` demotes on 55006; an explicit `createdb` rethrows (`:277-279`, `:295`).
- Tier 2 creates its database directly on the admin client, outside `db/pg.ts`'s provision lock (`:348-349`); only `dispose` goes through `dropDatabase`.
- Tier 2's `conn` is the target's credentials with the shadow database name (`:353`).
- Tier 3 runs inside the user's database; objects with a fixed schema (extensions, event triggers, roles) are not normalized (`:414-421`).
- Shadow names are limited to 63 UTF-8 bytes; the positional fallback index follows the sorted schema order (`:28`, `:391-396`).
- `docker` is refused with a dedicated message (`:176-183`).

## Tests
- `packages/pg-prime-kit/test/shadow/ladder.test.ts` (server): `auto` picks tier 2 and dispose drops it; tier 2 copies encoding/collation; URL and bare-string tier 1 with schema reset; a URL naming the target or admin database refused before any statement; typo refused; positional and too-long names; `parseShadowStrategy`/`parseShadowUrl` (no server); a role without `CREATEDB` demotes to tier 3 and its IR fingerprint equals tier 2's.
- `packages/pg-prime-kit/test/provisioning.test.ts` — bystander sessions survive shadow provisioning.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/shadow/ladder.test.ts` (`PG_PRIME_TEST_URL` or localhost port 54329 (`packages/pg-prime-kit/test/support/db.ts:42`)).
- Uncovered: the 55006 demotion path, the tier-3 survivor assertion in `dispose`.
