---
'@pg-prime/kit': patch
---

- `--shadow <url>` / `shadow:` naming the target (or admin) database is refused before any statement runs (`ShadowIsTargetError`, `refused`, exit 1); it used to `DROP SCHEMA … CASCADE` the live managed schemas.
- A multi-segment migration no longer replays its committed segments on an in-run retry or on a rerun: progress is recorded per segment (`statements_applied`, `segment_applied`), so a lock timeout in segment 1 retries segment 1 alone, and a failed or crashed run resumes at the first uncommitted segment instead of failing with 42P07 forever.
- A repeatable that fails after the migrations committed is reported as `failed` with a `sql_error` naming the `sql/` file and statement, with `applied`, `lock` and `fingerprint` filled in, instead of an `internal` crash with nothing.
- Connection URLs in config and shadow refusals are echoed without their password.
- History rows are read in the files' code-unit order (`COLLATE "C"`), so a server collation that sorts `_` differently cannot pick the wrong last-applied row for the fingerprint gate.
