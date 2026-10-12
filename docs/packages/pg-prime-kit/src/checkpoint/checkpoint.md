# packages/pg-prime-kit/src/checkpoint/checkpoint.ts

## Purpose
Checkpoints: a `NNNN_checkpoint.sql` holding the full schema DDL plus `checkpoints/NNNN.ir.json` holding its IR. Builds and writes them, lists them on disk, reads the IR back, and names drifted objects by diffing the live catalog against the newest applicable checkpoint.
Callers: `src/cli/commands/checkpoint.ts` (`buildCheckpoint`, `writeCheckpoint`, `listCheckpoints`, `CHECKPOINT_NAME`), `src/cli/commands/verify.ts` (`listCheckpoints`), `src/runner/run.ts` (`listCheckpoints`, `describeDrift`, `driftSentence`), `src/runner/status.ts` (`describeDrift`, `driftSentence`). Not re-exported from `src/index.ts`.
Callees: `catalog/extract.ts`, `diff/diff.ts` (`diffIR`), `diff/ddl.ts` (`buildStatements`), `diff/order.ts` (`orderStatements`), `plan/plan.ts` (`buildPlan`, `renderSql`), `ir/fact.ts` (`SchemaIR`), `ir/stable-id.ts`, `runner/files.ts` (`MIGRATION_FILE`).

## Public API
- `CHECKPOINT_DIR` — `"checkpoints"`, relative to the migrations directory.
- `CHECKPOINT_NAME` — `"checkpoint"`, the migration name every checkpoint file carries.
- `CheckpointFile` — `{ id, seq, name, irPath, hasIr }`.
- `CheckpointFormatError` — `code = "PG_PRIME_CHECKPOINT_FORMAT"`; bad JSON or not `formatVersion: 1`.
- `irFromCheckpoint(json)` — inverse of `SchemaIR.toCheckpoint()`; facts get `baseline`/`managed` provenance. Throws `CheckpointFormatError`.
- `listCheckpoints(migrationsDir)` — every `NNNN_checkpoint.sql`, oldest first, with whether its `.ir.json` exists; `[]` for a missing directory.
- `newestCheckpoint(list, seq?)` — newest entry with `seq <= seq`, or newest overall.
- `readCheckpointIr(file)` — reads and parses `irPath` into a `SchemaIR`.
- `freshDatabaseIR(client, current, schemas)` — the IR of a just-created database: managed schemas and extensions whose OID is below 16384, plus their schema comments.
- `buildCheckpoint(input)` / `BuildCheckpointInput` / `BuiltCheckpoint` — extract, diff fresh → current, build an ordered plan with `checkpoint: true` and a `skipped` proof.
- `checkpointSql(plan)` — the `.sql` via `renderSql` with the `-- pg-prime:checkpoint` header.
- `writeCheckpoint(migrationsDir, built)` / `WrittenCheckpoint` — writes `.sql`, `.plan.json`, `.ir.json` with flag `wx`.
- `describeDrift(input)` / `DescribeDriftInput` / `DriftReport` — `{ checkpoint, deltas, exact, since }`.
- `driftSentence(report)` — a one-sentence summary (first 12 deltas), or null when there is no checkpoint or no delta.

## Flow
1. `buildCheckpoint` extracts the catalog for the schemas (`packages/pg-prime-kit/src/checkpoint/checkpoint.ts:204`) and computes `freshDatabaseIR` as the `from` side (`:205`).
2. `diffIR` → `buildStatements` → `orderStatements` produce the full DDL (`:206-208`).
3. `buildPlan` stamps seq, name `checkpoint`, fingerprints, schemas, `checkpoint: true` and proof status `skipped` (`:211-227`); `checkpointSql` renders the file (`:239-251`).
4. `writeCheckpoint` creates `checkpoints/` and writes the three files, failing if any exists (`:266-279`).
5. At apply time the runner calls `listCheckpoints` and, for an empty history, jumps to the newest one (see `packages/pg-prime-kit/src/runner/run.ts:639-645`).
6. On a fingerprint mismatch, `describeDrift` takes the last applied id's seq, picks the newest checkpoint with an IR at or before it, reads it, extracts the live catalog with `observe: false`, and diffs (`packages/pg-prime-kit/src/checkpoint/checkpoint.ts:314-331`).
7. `exact` is true when no applied migration comes after the checkpoint; otherwise `since` lists them and `driftSentence` says the list is a superset (`:324-342`).

## Gotchas
- `describeDrift` parses seq with `id.slice(0, 4)` (`packages/pg-prime-kit/src/checkpoint/checkpoint.ts:316`, `:324`), while `MIGRATION_FILE` allows more than four digits; five-digit ids yield wrong seqs.
- `listCheckpoints` matches only files whose name part is exactly `checkpoint` (`:117`).
- `freshDatabaseIR` asks the server which schemas and extensions are built in (OID < 16384) instead of assuming `public` (`:168-174`). `packages/pg-prime-kit/src/cli/commands/baseline.ts:229` has its own private copy of this function.
- The IR file drops provenance; read-back facts are all `baseline`/`managed` (`packages/pg-prime-kit/src/checkpoint/checkpoint.ts:56`).
- `writeCheckpoint` is not atomic across its three files: a failure after the first write leaves partial output.
- Checkpoints that lack an `.ir.json` are skipped by `describeDrift` (`:317`) but still jumped to by the runner.

## Tests
- `packages/pg-prime-kit/test/checkpoint/checkpoint.test.ts` (needs a server, drives the CLI binary): writes the three files and records nothing; an existing database records the checkpoint `superseded`; a fresh database jumps and lands on the linear fingerprint; `verify` vs `verify --from-checkpoint`; a fingerprint mismatch names drifted objects (`exact: false` at `packages/pg-prime-kit/test/checkpoint/checkpoint.test.ts:242`).
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/checkpoint/checkpoint.test.ts` (`PG_PRIME_TEST_URL` or localhost port 54329 (`packages/pg-prime-kit/test/support/db.ts:42`)).
- Uncovered: `CheckpointFormatError` paths, the `wx` refusal on an existing file, ids with more than four seq digits.
