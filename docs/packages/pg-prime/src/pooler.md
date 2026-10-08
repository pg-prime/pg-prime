# packages/pg-prime/src/pooler/

## Purpose
Declared pooler profiles as data, plus two read-only diagnostics. `poolerMode` selects a frozen table of
capability toggles that only ever restrict what the runtime emits. `session/config.ts` reads it to refuse
named statements, `session/handles.ts` uses `isTransactionPooled`, `session/gucs.ts` and `session/runner.ts`
consume `PoolerProfile`. `query/run.ts` wires `db.diagnosePooler()`, `db.diagnose()`, the dev-mode startup
probe, and the `alterRoleHint` warning. `src/index.ts` re-exports `POOLER_MODES`, `POOLER_PROFILES`,
`profileOf` and the types. `index.ts` is the internal barrel.

## Public API
- `PoolerMode` — `'none' | 'session' | 'pgbouncer-transaction' | 'transaction'`.
- `PoolerProfile` — `namedPreparedStatements` (`ok`/`shared-lru`/`unsupported`), `sessionGucsAtConnect`,
  `listen`, `sessionAdvisoryLocks`, `withHoldCursors`, `sessionHandle`, `cancelRequest`, `resetQuery: 'never'`.
- `POOLER_PROFILES` — frozen `Record<PoolerMode, PoolerProfile>`, each profile frozen.
- `POOLER_MODES` — frozen list of the four modes in order.
- `profileOf(mode | undefined): PoolerProfile` — `undefined` means `'none'`.
- `isTransactionPooled(mode | undefined): boolean` — true for `'transaction'` and `'pgbouncer-transaction'`.
- `alterRoleHint(settings): string` — the `ALTER ROLE <your_user> SET <first setting> = '…'` advice sentence.
- `diagnosePooler(driver, configured, opts?): Promise<PoolerDiagnosis>` — runs the behavioural probes on
  one acquired connection; never changes configuration.
- `PoolerDiagnosis` — `verdict`, `confidence: 'low' | 'medium'`, `recommendedPoolerMode`,
  `configuredPoolerMode`, `agrees`, `signals`, `warnings`; frozen.
- `DiagnosticSignal` — `name` (six probe names), `result` (`supports-direct` / `-transaction-pooling` /
  `-session-pooling` / `inconclusive`), `detail`.
- `DiagnosePoolerOptions` — `probeSessionState?` (opt-in write probe), `host?` (for the hostname heuristic).
- `diagnose(inputs: DiagnoseInputs): Promise<DbDiagnosis>` — server version, effective GUCs, connection
  arithmetic, plus the caller-supplied pool stats, statement stats, notes and pooler diagnosis.
- `DbDiagnosis`, `DiagnoseInputs` — the report shape and its input bag.

## Flow
1. `diagnosePooler` adds a `hostname-heuristic` signal when `opts.host` is set: `-pooler.` /
   `.pooler.supabase.com`, `:6543`, or an RDS Proxy host (`packages/pg-prime/src/pooler/diagnose.ts:304`).
2. It acquires one connection and records `select version()` as an inconclusive `server-version` signal
   (`packages/pg-prime/src/pooler/diagnose.ts:133`).
3. Probe 1 reads `pg_backend_pid()` twice; if equal, it re-reads while up to three other pooled
   connections run `pg_sleep(0.25)` (`packages/pg-prime/src/pooler/diagnose.ts:151`, `packages/pg-prime/src/pooler/diagnose.ts:259`).
4. Contention: each extra acquire has a 250 ms `AbortSignal.timeout`; failures are dropped; the pid is read
   40 ms after the sleeps start (`packages/pg-prime/src/pooler/diagnose.ts:267`, `packages/pg-prime/src/pooler/diagnose.ts:280`).
5. Probe 2 reads the pid twice inside `begin`/`commit`; a mismatch adds a warning
   (`packages/pg-prime/src/pooler/diagnose.ts:169`).
6. Probe 3 executes a named statement twice in separate exchanges, then closes it with protocol `Close`
   (`packages/pg-prime/src/pooler/diagnose.ts:289`).
7. Probe 4 (only with `probeSessionState`) sets `application_name` via `set_config(..., false)` and reads it
   back (`packages/pg-prime/src/pooler/diagnose.ts:203`).
8. The connection is released with `{ dispose: true }` (`packages/pg-prime/src/pooler/diagnose.ts:217`).
9. Verdict: differing pids or a failed named statement means `likely-transaction-pooled`, else `direct`;
   recommendation is `none`, `pgbouncer-transaction` or `transaction` (`packages/pg-prime/src/pooler/diagnose.ts:220`).
10. `agrees` is true when equal, when the recommendation is `none`, or when `pgbouncer-transaction` is
    recommended and `transaction` configured (`packages/pg-prime/src/pooler/diagnose.ts:244`).
11. `diagnose` acquires a connection, reads eight GUCs from `pg_catalog.pg_settings`, then
    `max_connections`, `superuser_reserved_connections` and the `pg_stat_activity` count
    (`packages/pg-prime/src/pooler/diagnose.ts:350`).
12. `headroom = maxConnections - inUse - (superuserReserved ?? 0)`; the result is frozen
    (`packages/pg-prime/src/pooler/diagnose.ts:374`).

## Gotchas
- A profile only restricts; `resetQuery` is `'never'` in every mode (`packages/pg-prime/src/pooler/profiles.ts:41`).
- The two transaction profiles differ only in `namedPreparedStatements` (`shared-lru` vs `unsupported`)
  (`packages/pg-prime/src/pooler/profiles.ts:68`, `packages/pg-prime/src/pooler/profiles.ts:78`).
- `confidence` is `'low'` only when probe 3 did not run, but any earlier probe failure throws, so a returned
  diagnosis is always `'medium'` (`packages/pg-prime/src/pooler/diagnose.ts:230`).
- `verdict` never takes the values `'likely-session-pooled'` or `'inconclusive'`, though the type allows them
  (`packages/pg-prime/src/pooler/diagnose.ts:220`).
- Probe 3 treats any error as "named statements unusable", not only `26000`
  (`packages/pg-prime/src/pooler/diagnose.ts:295`).
- The hostname heuristic and probe 4 do not feed the verdict; only pid difference and probe 3 do.
- `diagnosePooler` disposes its connection, so it costs a fresh backend; it also needs a pool with spare
  capacity to produce contention, otherwise probe 1 reports the original pid (`packages/pg-prime/src/pooler/diagnose.ts:274`).
- `effectiveSettings` holds `pg_settings.setting` values in each GUC's base unit (timeouts in ms), not
  `SHOW` output, despite the comments at `packages/pg-prime/src/pooler/diagnose.ts:65` and `packages/pg-prime/src/pooler/diagnose.ts:329`.
- `max_connections` is not in the `EFFECTIVE` list, so it always comes from a separate `show max_connections`
  (`packages/pg-prime/src/pooler/diagnose.ts:366`).
- `inUse` counts every row in `pg_stat_activity`, including background workers.

## Tests
- `packages/pg-prime/test/session/session.test.ts` (unit): `POOLER_PROFILES is data, and a profile only ever
  restricts` at line 1087 — one profile per mode, no reset query, the LISTEN/NOTIFY asymmetry, the one-field
  difference, `ConfigError` for `statement: 'named'` under `'transaction'`, skipped GUCs naming `ALTER ROLE`.
- `packages/pg-prime/test/live/session.test.ts` (live): `db.diagnose()` at line 449.
- `packages/pg-prime/test/pg/session-pooler.test.ts` (pg): `diagnosePooler()` at line 66 — `direct` on a real
  server, `likely-transaction-pooled` through PgBouncer, the one-time dev startup warning; needs
  `PG_PRIME_TEST_PGBOUNCER_URL` and skips loudly without it.
- Run: `pnpm --filter pg-prime exec vitest run test/session/session.test.ts`; pg: set `PG_PRIME_TEST_URL`
  and run `test/pg/session-pooler.test.ts`.
- Uncovered: `hostnameHeuristic` patterns, the `probeSessionState` probe and the `agrees` matrix have no
  direct unit test.
