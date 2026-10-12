# packages/pg-prime-kit/src/schema/remap.ts

## Purpose
Rewrites schema names in an extracted IR, its diagnostics and its Tier-O observations, so a desired state loaded into `pgprime_shadow_<token>_<schema>` reads back in the user's schema names. Used by `loadDesired` (`packages/pg-prime-kit/src/schema/load.ts:127`) in the shadow → user direction and by `proveInTempSchemas` (`packages/pg-prime-kit/src/prove/temp-schema.ts:130`) in both directions. Re-exported from `packages/pg-prime-kit/src/index.ts:262`.

## Public API
- `Remapper` — `{ text(s), id(id) }`: rewrites server-produced SQL text and `StableId`s.
- `makeRemapper(reverse)` — builds a `Remapper` from a `from schema → to schema` map.
- `remapIr(ir, reverse)` — returns a new `SchemaIR` with every fact id, parent, payload string and edge endpoint rewritten; `provenance` and `ordinal` are kept.
- `remapDiagnostics(diagnostics, reverse)` — rewrites `message` and `subject`.
- `remapObserved(observed, reverse)` — rewrites `name` and `detail` of each `ObservedObject`.

## Flow
1. `makeRemapper` drops identity pairs and sorts the rest longest-`from` first (`packages/pg-prime-kit/src/schema/remap.ts:63`).
2. Per pair it adds a quoted rule (`"from"`) and a bare whole-identifier rule with look-around excluding `[A-Za-z0-9_$"]`; the replacement is quoted with `quoteIdent` unless it is a bare identifier (`packages/pg-prime-kit/src/schema/remap.ts:65`).
3. `text` applies all rules in order using a function replacement (`packages/pg-prime-kit/src/schema/remap.ts:79`).
4. `id` remaps `schema` on ids that have one; a `comment` id is parsed, its target remapped and re-encoded; `extension` ids are unchanged (`packages/pg-prime-kit/src/schema/remap.ts:83`).
5. `remapIr` recursively rewrites every string in each payload (`remapValue`), then re-encodes `SequencePayload.ownedBy` through `id` (`packages/pg-prime-kit/src/schema/remap.ts:107`).
6. Edges are remapped endpoint by endpoint and the IR is rebuilt with `SchemaIR.build` (`packages/pg-prime-kit/src/schema/remap.ts:133`).

## Gotchas
- Every payload string is rewritten, not an enumerated field list, so new payload fields are covered automatically (`packages/pg-prime-kit/src/schema/remap.ts:36`).
- Payload text is hashed: a missed schema name produces a content hash that never matches and a phantom rewrite.
- The "safe by construction" argument holds for shadow → user, since only freshly minted shadow names are replaced. In the user → shadow direction (`temp-schema.ts`) a bare user schema name such as `public` is replaced wherever it appears as a whole identifier in payload text, including inside string literals.
- Longest-first ordering prevents `pgprime_shadow_ab` from half-matching `pgprime_shadow_ab_public`.
- A function replacement is used because `$` is legal in identifiers and would otherwise be read as a capture reference.
- `extension` ids carry no schema; `ExtensionPayload.schema` is rewritten as payload text.

## Tests
- No spec imports this module directly. Its completeness is pinned by fingerprint equality through the tier-3 map: `packages/pg-prime-kit/test/shadow/ladder.test.ts` ("the IR from tier 3 and the IR from tier 2 have the same fingerprint") and `packages/pg-prime-kit/test/schema-emit/roundtrip.test.ts` ("the same corpus through the tier-3 schema map").
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/shadow/ladder.test.ts test/schema-emit/roundtrip.test.ts` (needs a real server, `PG_PRIME_TEST_URL`).
- Uncovered: `remapDiagnostics`, `remapObserved`, quoted-identifier replacement and the user → shadow direction have no direct assertions.
