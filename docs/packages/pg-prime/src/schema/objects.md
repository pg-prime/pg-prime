# packages/pg-prime/src/schema/objects.ts

## Purpose
Declares standalone schema objects that are not tables: domains, sequences and extensions, as frozen, non-generic metadata objects.
Users export them from schema modules; the kit's `packages/pg-prime-kit/src/config/load.ts:289` collects them by `kind` from the module exports, and `packages/pg-prime-kit/src/pull/emit-ts.ts` writes them when pulling a database. `exclude().requires()` in `extras.ts` accepts a `PgExtension`. Calls `checkName` from `column.ts`.

## Public API
- `pgDomain(name, baseType, options?)` — returns a frozen `PgDomain`; throws `SchemaError` on a bad name, empty base type, bad check name or non-string comment.
- `PgDomainOptions` — `schema`, `notNull`, `default` (DDL text), `collation`, `checks` (`{ name, expression }[]`, text), `renamedFrom`, `comment`.
- `PgDomain` — `kind: 'domain'` plus every option resolved (`notNull` defaults `false`, `checks` defaults `[]`).
- `pgSequence(name, options?)` — returns a frozen `PgSequence`; validates the name, schema, `renamedFrom` and `ownedBy` parts.
- `PgSequenceOptions` / `PgSequence` — `schema`, `dataType`, `start`, `increment`, `minValue`, `maxValue`, `cache` (all strings), `cycle`, `ownedBy`, `renamedFrom`; `kind: 'sequence'`.
- `pgExtension(name, options?)` — returns a frozen `PgExtension` `{ kind: 'extension', name, schema }`.
- `PgExtensionOptions` — `{ schema? }`, rendered as `CREATE EXTENSION … SCHEMA`.

## Flow
1. Each factory validates identifiers through `checkName` (`packages/pg-prime/src/schema/objects.ts:66`, `:134`, `:182`).
2. `pgDomain` additionally requires a non-blank `baseType` and a string `comment` (`packages/pg-prime/src/schema/objects.ts:67`, `:77`).
3. `pgSequence` validates `ownedBy.table`, `ownedBy.column` and optional `ownedBy.schema` (`packages/pg-prime/src/schema/objects.ts:138`–`:143`).
4. Each returns `Object.freeze({ kind, … })`; nested `checks` and `ownedBy` are copied and frozen (`packages/pg-prime/src/schema/objects.ts:90`, `:156`).

## Gotchas
- Not validated: domain `default`, `collation`, check `expression`, and every sequence numeric field are passed through as text.
- Domain checks are text, not `sql` fragments, because they reference `VALUE`, which has no `Ref` (`packages/pg-prime/src/schema/objects.ts:35`).
- `pgExtension` has no version option; extensions are declared-only (created if absent, never dropped) (`packages/pg-prime/src/schema/objects.ts:177`).
- These objects are found only if exported from the schema module; `defineSchema` does not take them.
- `citext()` / `vector()` columns need a matching `pgExtension('citext')` / `pgExtension('vector')` export (`packages/pg-prime/src/schema/column.ts:733`).

## Tests
- `packages/pg-prime/test/schema/k4-additions.test.ts` (describe "the standalone declarations") — frozen output, `kind` discriminants, identifier refusals.
- `packages/pg-prime/test/schema/g14-ddl-closeout.test.ts` — `comment` on `pgDomain`, non-string refusal.
- Kit: `packages/pg-prime-kit/test/schema-emit/emit.test.ts`, `test/pull/roundtrip.test.ts`, `test/generate/annotations.test.ts` exercise emission; some kit cases need a PostgreSQL server (`packages/pg-prime-kit/test/support/db.ts`).
- Run: `pnpm --filter pg-prime exec vitest run test/schema/k4-additions.test.ts`.
