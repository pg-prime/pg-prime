# packages/pg-prime-kit/src/schema/declared.ts

## Purpose
The declared lane for `definePolicy(...)`, `rls.enable()`/`rls.force()` and `updatedAtTrigger`: renders them into ordinary `sql/` repeatables marked with a `pg-prime:declared sha256:<h>` comment, syncs those files on disk, finds hand files that collide with them, and checks the catalog against their headers. Called by `generate.ts` (render, conflicts, sync, shadow load), `schema/views.ts` (sync), `repeatables/plan.ts` (`healDeclared`), and the `doctor`/`verify` commands (census). `ENABLE ROW LEVEL SECURITY` itself is a table fact emitted by `schema/emit.ts`; this lane only states FORCE.

## Public API
- `POLICIES_DIR` (`"050_policies"`), `TRIGGERS_DIR` (`"070_triggers"`), `PRUNE_FILE` (`"990_declared_prune.sql"`); `DECLARED_PREFIX` (`"-- pg-prime:declared"`), the first line of every lane or view file.
- `DeclaredKind` — `"rls" | "policy" | "trigger" | "function"`. `DeclaredObject` — `{ kind, identity, state }`; `state` is `sha256:<hex>` or `force`/`noforce`.
- `DeclaredFile` — `{ path, sql, objects }`, `path` relative to the repeatables root. `LaneAck` — `{ code, subject, by, reason }`.
- `RenderDeclaredOptions` — `{ defaultSchema?, schemas?, schemaOf?, existingPrune?, acks? }`. `RenderedDeclared` — `{ files, diagnostics }`.
- `renderDeclared(schema, options?)` — renders the lane files sorted by path; never throws, reports `declared_conflict`, `declared_invalid`, `RL104`, `updated_at_on_update_overlap`.
- `parseAcks(directives)` — `LaneAck[]` from `-- pg-prime:acknowledged <code> <subject> by <who>: <reason>` lines.
- `asRepeatable(dir, file)` — a rendered file as a `RepeatableFile`. `isDeclared(file)` — first directive is `declared` on line 1. `scanOrder(a, b)` — `scanRepeatables`' per-level sort.
- `SyncDeclaredOptions` — `{ write, dirs }`. `SyncedDeclared` — `{ written, pruned, diagnostics }`.
- `syncDeclared(dir, files, options)` — writes changed files and deletes stale declared ones under `dirs`, or with `write: false` reports staleness.
- `laneConflicts(hand, declared, defaultSchema?)` — `declared_conflict` and `rls_declared_twice` diagnostics over non-declared repeatables.
- `CatalogMark` — `{ kind, identity, hash | null }`. `readMarks(client, schemas, ids)` — catalog policies, triggers and zero-arg functions named in `ids` or marked in `schemas`.
- `declaredObjects(files)` — the `-- pg-prime:object` headers of the declared files.
- `DeclaredCensus` — `{ findings, heal }`. `declaredCensus(client, files, schemas)` — headers against catalog markers and FORCE flags; `heal` is the set of file paths that fix a finding.

## Flow
1. `renderDeclared` walks table extras: `rls` sets FORCE (any `force()` wins), `updatedAtTrigger` adds a column (`packages/pg-prime-kit/src/schema/declared.ts:108`).
2. `schema.policies` are grouped by table; a policy on a table `schema.tables` does not declare is `declared_invalid`, a repeated `schema.table.name` is `declared_conflict`, and both are skipped. A lane table outside `schemas` is `declared_invalid`: a shadow maps only managed schemas (`packages/pg-prime-kit/src/schema/declared.ts:129`).
3. A table with policies or `rls.*()` renders `050_policies/<schema>__<table>.sql`: `[NO] FORCE ROW LEVEL SECURITY`, then per policy, by name, `DROP POLICY IF EXISTS`, its `$.ddl`, and the marker `COMMENT` (`packages/pg-prime-kit/src/schema/declared.ts:156`).
4. A table with `updatedAtTrigger` renders `070_triggers/<schema>__<table>.sql` with one `pgprime_set_<column>` trigger per column; the shared functions go to `070_triggers/000_functions.sql` (`packages/pg-prime-kit/src/schema/declared.ts:210`, `:237`).
5. Each file header lists `-- pg-prime:object <kind> <identity> <state>` lines; the marker hash is `sha256` of the CREATE statement.
6. When anything is rendered or `existingPrune` is set, `renderPrune` adds a `DO` block dropping marked policies, triggers and functions in `schemas` that are not in the keep-list, with acks in its header (`packages/pg-prime-kit/src/schema/declared.ts:306`).
7. `syncDeclared` reads `.sql` files under `dirs` plus the prune file, refuses if a wanted path holds a non-declared file, then writes changed files and unlinks unwanted declared ones; an unlink that fails other than with `ENOENT` throws (`packages/pg-prime-kit/src/schema/declared.ts:429`).
8. With `write: false`, stale `020_views/` paths become `declared_views_stale` and the rest `declared_lane_stale` (`packages/pg-prime-kit/src/schema/declared.ts:467`).
9. `laneConflicts` matches each hand file's path, `-- pg-prime:object` directives and `CREATE POLICY|TRIGGER|FUNCTION` statements against declared identities (`packages/pg-prime-kit/src/schema/declared.ts:516`).
10. `declaredCensus` reads marks and `relforcerowsecurity`, then reports `declared_missing` (absent, other hash, wrong FORCE), `declared_unmarked` (no marker) and `declared_orphan` (marked, no longer declared; healed by the prune file) (`packages/pg-prime-kit/src/schema/declared.ts:635`).

## Gotchas
- The marker comment scopes the prune and the census: hand-written objects never carry it and are never dropped.
- The prune file is rendered once it exists, even with nothing declared, and `syncDeclared` never deletes it; only a human does.
- `schemaOf` remaps schemas for a shadow, and identities and SQL use the remapped name; the prune is still rendered, so callers loading a shadow must leave it out (`generate.ts`'s `shadowRepeatables` does).
- `renderDeclared` only reports errors; `generate` turns error diagnostics into a refusal.
- `syncDeclared` with a conflict writes nothing at all, not even the non-conflicting files.
- Re-applying a policy file takes `ACCESS EXCLUSIVE` on its table (`DROP POLICY` + `CREATE POLICY`).
- Unquoted identifiers in hand files are lowercased before matching; an unqualified name takes `defaultSchema`.
- An `rls` object is only checked when the table exists; a missing table is not a census finding.
- Not re-exported from `packages/pg-prime-kit/src/index.ts`: `DECLARED_PREFIX`, `parseAcks`, `asRepeatable`, `isDeclared`, `scanOrder`, `laneConflicts`, `readMarks`, `declaredObjects`, `CatalogMark`.

## Tests
- `packages/pg-prime-kit/test/schema-emit/declared.test.ts` — golden files, TX201-clean output, marker hashes, stable order, NO FORCE and RL104, empty keep-lists, acks round trip, shadow remap, duplicate policy, `laneConflicts`, `syncDeclared` write/idempotence/prune/failed delete/`write: false`/hand-file refusal, `scanOrder`. No database needed.
- `packages/pg-prime-kit/test/generate/declared-rls.test.ts` — generate → apply → edit → prune → heal, tier-3 target safety, and lane hazards (real server with role creation).
- `packages/pg-prime-kit/test/cli/verify-declared.test.ts` — `verify`, `doctor` and `check` over the lane; `packages/pg-prime-kit/test/pull/rls-roundtrip.test.ts` — `pull` round trip with a green `declaredCensus` (needs `pg_dump`).
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/schema-emit/declared.test.ts test/generate/declared-rls.test.ts` (`PG_PRIME_TEST_URL` for the database specs).
- Uncovered: no spec asserts `declared_orphan`; `declared_unmarked` is asserted only through `doctor`.
