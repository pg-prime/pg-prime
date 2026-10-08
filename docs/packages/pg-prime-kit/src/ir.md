# packages/pg-prime-kit/src/ir/

## Purpose
The schema intermediate representation: stable fact identities (`stable-id.ts`), deterministic hashing (`hash.ts`) and the immutable fact base `SchemaIR` (`fact.ts`). `catalog/extract.ts` and `schema/` build it; `diff/*`, `checkpoint/checkpoint.ts`, `prove/*`, `pull/emit-ts.ts`, `generate.ts` and `plan/plan.ts` (hashing) consume it.

## Public API
- `StableId` — discriminated union keyed by `kind` (`FactKind`: 12 kinds from `schema` to `extension`); a fact's own name lives here, never in its payload (`packages/pg-prime-kit/src/ir/stable-id.ts:25`).
- `FactKind` — `"schema" | "table" | "column" | "default" | "constraint" | "index" | "type" | "enumLabel" | "typeAttribute" | "sequence" | "comment" | "extension"`.
- `encodeId(id): string` — `kind:part.part`, `.` and `\` escaped; the only string encoding (`packages/pg-prime-kit/src/ir/stable-id.ts:99`).
- `parseId(s): StableId` — inverse; throws on missing `:`, unknown kind, or wrong part count (`packages/pg-prime-kit/src/ir/stable-id.ts:105`).
- `idName(id)` — the fact's own name (`schema` for schemas, `target` for comments).
- `idSchema(id)` — schema of the id; `""` for `extension`, and the target's schema for `comment`.
- `parentOf(id)` — derived structural parent, `undefined` for `schema`/`extension`.
- `sameId(a, b)`, `commentId(target)`, `defaultId(column)` — equality by encoding; canonical comment / default ids.
- `Payload`, `PayloadValue` — identity-free JSON stored on a fact.
- `canonicalize(value): string` — JSON with sorted keys and `undefined` members dropped; throws on non-finite numbers and functions/symbols/bigints.
- `Hash` — `"sha256:<hex>"`; `sha256(text)`, `contentHash(payload)` = `sha256(canonicalize(payload))`.
- `Origin`, `Ownership`, `Provenance` — fact metadata; never hashed.
- `Fact` — `{ id, parent?, payload, ordinal?, provenance }`; `ordinal` is presentation-only and unhashed.
- `EdgeKind` (`depends | owner | memberOfExtension | managedBy | evaluates`), `DependencyEdge` `{ from, to, kind }`.
- `SchemaIR.build(facts, edges)` — throws `duplicate fact: <id>` on a repeated id (`packages/pg-prime-kit/src/ir/fact.ts:67`).
- `SchemaIR` readers — `facts()`, `edges()`, `get`, `has`, `childrenOf`, `descendantsOf` (depth-first), `outgoingEdges`, `factsOfKind`; all accept a `StableId` or its encoding.
- `contentHashOf(id)` / `rollupOf(id)` — memoised payload hash / subtree hash; throw `no such fact` for an absent id.
- `orphans()` — facts whose declared `parent` is absent; reported, not thrown.
- `fingerprint` — `sha256` of sorted `rootId=rollup` lines over parentless facts.
- `toCheckpoint(pgMajor)` — `{ formatVersion: 1, pgMajor, fingerprint, facts, edges }`, sorted, without provenance.
- `CATALOG_PROVENANCE` — `{ origin: "catalog", ownership: "managed" }`.

## Flow
1. A producer builds `Fact`s with `StableId`s and `DependencyEdge`s, then calls `SchemaIR.build` (`packages/pg-prime-kit/src/ir/fact.ts:58`).
2. `#add` indexes each fact by `encodeId` and records it under its explicit `parent` key (`packages/pg-prime-kit/src/ir/fact.ts:65-75`); `#addEdge` indexes edges by `from` (`packages/pg-prime-kit/src/ir/fact.ts:77-83`).
3. `contentHashOf` hashes the canonical payload only (`packages/pg-prime-kit/src/ir/fact.ts:128-137`); identity and provenance never enter it.
4. `rollupOf` combines the content hash, each child's `(name, kind, rollup)` sorted, and outgoing non-`owner` edges (`packages/pg-prime-kit/src/ir/fact.ts:156-174`).
5. `fingerprint` hashes `encodeId(root)=rollup` for every fact with no `parent` (`packages/pg-prime-kit/src/ir/fact.ts:177-185`); `apply` and plans compare it.
6. `toCheckpoint` serializes sorted facts and edges for `checkpoint/checkpoint.ts` (`packages/pg-prime-kit/src/ir/fact.ts:194-211`).

## Gotchas
- A fact's own name is in its id, not its payload; a child's name is part of its parent's rollup (`packages/pg-prime-kit/src/ir/fact.ts:162-164`). Renaming a table therefore keeps its rollup, while renaming a column changes the table's rollup.
- `ordinal` is never hashed (`packages/pg-prime-kit/src/ir/fact.ts:26`), so physical column order cannot produce a diff.
- Orphans are not roots and are not reached from any root, so they are absent from `fingerprint` (`packages/pg-prime-kit/src/ir/fact.ts:180`); check `orphans()` after a filter.
- `SchemaIR` uses the explicit `Fact.parent`, not `parentOf`. They differ for indexes: `parentOf` returns the schema (`packages/pg-prime-kit/src/ir/stable-id.ts:153-154`), while `packages/pg-prime-kit/src/catalog/extract.ts:927` parents an index on its table.
- `idSchema` returns `""` for extensions so a misuse fails in `quoteIdent` rather than emitting DDL (`packages/pg-prime-kit/src/ir/stable-id.ts:137-141`).
- A `comment` id stores its target already encoded, so it nests escapes (`comment:column:public\.users\.email`); build it with `commentId`, never by hand.
- `canonicalize` drops `undefined` object members but renders `undefined` array items (and a top-level `undefined`) as `null` (`packages/pg-prime-kit/src/ir/hash.ts:16-17`, `packages/pg-prime-kit/src/ir/hash.ts:27`).
- Memoised hashes are safe only because `SchemaIR` has no public mutator; derive a new IR with `SchemaIR.build` (as `packages/pg-prime-kit/src/diff/rename.ts:359` does).
- `toCheckpoint` is deliberately not `toJSON`: `JSON.stringify` would call it with a property key as `pgMajor` (`packages/pg-prime-kit/src/ir/fact.ts:187-193`).

## Tests
- `packages/pg-prime-kit/test/ir.test.ts` (no database): id encoding round-trips, canonicalization key-order independence, rollup/fingerprint stability, rename-as-hash-join (I1), unhashed `ordinal`.
- `orphans()` is asserted in `test/catalog.test.ts`; `toCheckpoint` in `test/plumbing.test.ts` and `test/shadow/ladder.test.ts` (these need a server).
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/ir.test.ts`. The kit's `globalSetup` builds `dist/` first.
- Uncovered: `parentOf`, `idSchema`, `commentId`, `defaultId`, `descendantsOf` have no direct unit test; `canonicalize` throwing on non-finite numbers is untested.
