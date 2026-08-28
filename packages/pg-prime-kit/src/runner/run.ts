/**
 * `migrate apply` — design/06 §5.1's nine steps, as one function.
 *
 * Four things in here are decisions rather than transcription, and each is marked at the
 * point it is taken:
 *
 *  - **The history INSERT rides inside the migration's own transaction** (§5.3). It is
 *    appended to the last transactional segment as one more statement, so "applied" and
 *    "recorded" commit together and there is no torn state. The synthetic statement is
 *    at index `n`, which leaves every real statement's index untouched.
 *  - **`txmode none` resume restarts the file when `statement_uncertain` is set**, and
 *    resumes at `statements_applied` when it is not. See `resumeFrom`.
 *  - **Retries are scoped to the unit that rolled back**: the whole file for a
 *    transactional one, the single statement for a bare one.
 *  - **`--dry-run` runs the real code path against a capture client.** There is no second
 *    implementation of the statement stream to drift from the first.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import pg from "pg";
import { extractCatalog, type CatalogClient, type Diagnostic } from "../catalog/extract.js";
import { RUNNER_EXIT, type ExitCode, type RunnerStatus } from "../cli/exit.js";
import { runBatchStatement, type BatchEvent, type LagEvent } from "../data/batch.js";
import type { Segment } from "../diff/order.js";
import { withClient, type ConnInfo } from "../db/pg.js";
import { ensureHistory, historyPresent, HISTORY_SCHEMA } from "../history/schema.js";
import {
  beginRow,
  breakLease,
  currentFingerprint,
  readDataProgress,
  EMPTY_WATERMARK,
  type DataProgress,
  heartbeatLease,
  markApplied,
  markFailed,
  markStatementApplied,
  markUncertain,
  readLease,
  readMigrationRows,
  readRepeatableRows,
  recordAppliedSql,
  releaseLease,
  takeLease,
  upsertRepeatable,
  type LockRow,
  type MigrationRow,
  type NewMigrationRow,
} from "../history/store.js";
import { ENGINE, type PlanStatement } from "../plan/plan.js";
import {
  acquireSessionLock,
  applySegments,
  detectTransactionPooler,
  detectTransactionPoolerStrict,
  releaseSessionLock,
  resetSessionGucs,
  setConfig,
} from "./apply.js";
import { executionPlan, readMigrationsDir, type ExecutionPlan, type MigrationFile, type TxMode } from "./files.js";
import type { AppliedRepeatable, RepeatablesPass, RepeatablesPlan } from "../repeatables/index.js";

/* --------------------------- Tier R, as a seam --------------------------- */

/**
 * design/06 §5.1 step 8. The runner consumes design/11 K3's `RepeatablesPass` (`src/repeatables/`):
 * `plan()` says which `sql/` files changed since `pgprime.repeatables` last recorded them, and the
 * runner applies those in one transaction and records them itself. `NO_REPEATABLES` is the
 * binding the CLI uses until K2b wires `createRepeatablesPass(config.repeatables)` in.
 */
export const NO_REPEATABLES: RepeatablesPass = {
  plan: async (): Promise<RepeatablesPlan> => ({ toApply: [], unchanged: [], orphaned: [] }),
  apply: async (): Promise<AppliedRepeatable[]> => [],
};

/* ------------------------------- the report ------------------------------ */

export interface IssuedQuery {
  readonly text: string;
  readonly values?: readonly unknown[];
}

export interface AppliedMigration {
  readonly id: string;
  readonly txmode: TxMode;
  readonly statements: number;
  readonly durationMs: number;
  /** the statement index a resume started at; null for a first run */
  readonly resumedFrom: number | null;
  readonly retries: number;
  /**
   * design/06 §7 lane 2: the batched data migration's totals, null for every other file.
   * `rowsDone` is cumulative across a resume — it is read back out of
   * `pgprime.data_progress`, not counted from this process's own iterations.
   */
  readonly batch: { readonly rowsDone: number; readonly iterations: number; readonly resumed: boolean } | null;
}

export interface PreflightReport {
  readonly invalidIndexes: readonly string[];
  readonly notValidConstraints: readonly string[];
  readonly ccnewLeftovers: readonly string[];
  /** the subset of the three above that a pending plan names */
  readonly touchedByPending: readonly string[];
}

export interface RepeatablesReport {
  readonly applied: readonly string[];
  readonly unchanged: readonly string[];
}

export interface LockReport {
  readonly acquired: boolean;
  readonly runId: string | null;
  readonly waitedMs: number;
  readonly holder: LockRow | null;
  readonly stale: boolean;
}

export interface RunnerFailure {
  readonly code:
    | "transaction_pooler"
    | "pool_connection"
    | "missing_file"
    | "checksum_drift"
    | "fingerprint_mismatch"
    | "unknown_target"
    | "plan_invalid"
    | "lock_unavailable"
    | "sql_error";
  readonly message: string;
  readonly migration?: string;
  readonly statementIndex?: number;
  readonly sqlState?: string;
  readonly sql?: string;
  readonly attempts?: number;
}

export interface ApplyPendingResult {
  readonly status: RunnerStatus;
  readonly exitCode: ExitCode;
  readonly applied: readonly AppliedMigration[];
  readonly pending: readonly string[];
  readonly warnings: readonly string[];
  readonly preflight: PreflightReport;
  readonly repeatables: RepeatablesReport;
  readonly lock: LockReport;
  /** the fingerprint of record after this run (design/06 §4.4), or null when unknown */
  readonly fingerprint: string | null;
  readonly durationMs: number;
  /** `--dry-run`: every query the run WOULD have issued, in order */
  readonly dryRun: readonly IssuedQuery[] | null;
  readonly error: RunnerFailure | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ApplyPendingOptions {
  /** the managed schema set — the lock key's scope AND the fingerprint's scope */
  readonly schemas?: readonly string[];
  readonly to?: string;
  readonly dryRun?: boolean;
  /** design/06 §5.6: checksum drift warns instead of failing */
  readonly dev?: boolean;
  readonly lockTimeout?: string;
  readonly statementTimeout?: string;
  readonly lockWaitMs?: number;
  readonly staleLockAfterMs?: number;
  readonly heartbeatMs?: number;
  readonly verifyFingerprint?: boolean;
  readonly repeatables?: RepeatablesPass;
  readonly repeatablesDir?: string;
  /**
   * design/12 decision 13 — the explicit opt-in for `-- pg-prime:batch
   * max-replica-lag=…`. Absent, the ceiling is read primary-side from
   * `pg_stat_replication`; present, each of these is asked for
   * `pg_last_wal_replay_lsn()`, which is design/06 §7's literal shape.
   */
  readonly replicas?: readonly ConnInfo[];
  /** hostname / CI run id recorded on every row */
  readonly appliedFrom?: string;
  readonly engineVersion?: string;
  readonly onEvent?: (event: RunnerEvent) => void;
  /** injected so a retry test does not sleep for real */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly retryBaseMs?: number;
  readonly random?: () => number;
  /**
   * design/06 §5.1 step 2. `applyPending` supplies the strict two-connection probe,
   * because it has the `ConnInfo` needed to open the second one; a caller who owns the
   * connection and calls `applyPendingOn` gets the cheap one unless it passes its own.
   */
  readonly poolerProbe?: (client: CatalogClient) => Promise<boolean>;
  /**
   * Where the 5-second lease heartbeat is written from.
   *
   * design/06 §5.2 says "updated every 5 s **from the same connection**", and that cannot
   * work: the migration connection spends minutes inside one `CREATE INDEX CONCURRENTLY`,
   * `pg.Client` serialises, and a second `query()` while one is in flight is deprecated in
   * `pg@8` and removed in `pg@9`. Queuing the beats behind the CIC means no beat for the
   * whole build — exactly when the lease is the only evidence the runner is alive — and
   * the next deploy would call a healthy run stale. So `applyPending` opens a second
   * connection for the heartbeat and closes it at the end. What the design is protecting
   * is unharmed: the advisory lock still lives on the dedicated connection, and if the
   * *process* dies both connections die with it. Recorded in `06` §5.2 AS BUILT.
   */
  readonly heartbeatConnection?: () => Promise<{ readonly client: CatalogClient; readonly close: () => Promise<void> }>;
}

export type RunnerEvent =
  | { readonly kind: "lock"; readonly state: "waiting" | "acquired" | "unavailable"; readonly waitedMs: number }
  | { readonly kind: "migration"; readonly id: string; readonly state: "start" | "done" | "retry" | "failed"; readonly detail?: string }
  | { readonly kind: "statement"; readonly id: string; readonly index: number; readonly total: number }
  | BatchEvent
  | LagEvent
  | { readonly kind: "warning"; readonly message: string };

/* --------------------------------- defaults ------------------------------- */

const DEFAULTS = {
  lockTimeout: "3s",
  lockWaitMs: 30_000,
  staleLockAfterMs: 60_000,
  heartbeatMs: 5_000,
  retryBaseMs: 100,
  lockPollMs: 250,
} as const;

/**
 * design/06 §5.3 / §5.6. The unit retried is the unit that rolled back: a transactional
 * file is retried whole, a bare statement is retried alone. `attempts` counts the FIRST
 * try, so `1` means "never retried".
 */
const RETRY: Readonly<Record<string, number>> = {
  "55P03": 5, // lock_not_available — fail fast, then retry with backoff
  "40001": 5, // serialization_failure — retry the whole file
  "40P01": 2, // deadlock_detected — retry the whole file ONCE
  "57014": 1, // query_canceled (statement_timeout) — genuinely too slow, never retried
};

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref?.());

/* ------------------------------ capture client ----------------------------- */

class CaptureClient implements CatalogClient {
  readonly issued: IssuedQuery[] = [];
  async query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.issued.push(values === undefined ? { text } : { text, values });
    return { rows: [] };
  }
}

/* --------------------------------- helpers -------------------------------- */

function newRow(file: MigrationFile, total: number, engineVersion: string, appliedFrom: string | null): NewMigrationRow {
  return {
    id: file.id,
    seq: file.seq,
    name: file.name,
    checksum: file.checksum,
    planId: file.plan?.planId ?? null,
    fingerprintFrom: file.plan?.from.fingerprint ?? file.directives.from ?? null,
    fingerprintTo: file.plan?.to.fingerprint ?? file.directives.to ?? null,
    txmode: file.txmode,
    statementsTotal: total,
    statementsApplied: total,
    segmentApplied: 0,
    status: "applied",
    appliedFrom,
    engineVersion,
  };
}

/**
 * Where a resumed `txmode none` file restarts.
 *
 * `statement_uncertain IS NULL` means the crash landed on a clean boundary — every
 * statement below `statements_applied` committed and nothing was in flight — so resume
 * there. `statement_uncertain = i` means statement `i` was in flight and its residue is
 * unknown: it may have committed, it may have left an INVALID index behind. design/06
 * §5.4 answers that with TX201 ("every statement in a `txmode none` file MUST be
 * idempotent") and with the observation that "the `DROP INDEX CONCURRENTLY IF EXISTS`
 * prefix simultaneously cleans up the INVALID index left by the crashed CIC" — and that
 * prefix is an EARLIER statement, already counted in `statements_applied`. So the only
 * restart point under which the design's own sentence is true is the top of the file,
 * which the idempotence invariant makes safe. Recorded as a divergence in `06` §5.4
 * AS BUILT: the design says "re-execute statement_uncertain", which would wedge on the
 * duplicate-index error the prefix exists to prevent.
 */
export function resumeFrom(row: MigrationRow | undefined): number {
  if (!row) return 0;
  if (row.status === "applied" || row.status === "baselined") return row.statementsTotal;
  return row.statementUncertain === null ? row.statementsApplied : 0;
}

const segmentOf = (segments: readonly Segment[], i: number): number =>
  segments.find((s) => s.statements.includes(i))?.index ?? 0;

/** `0007` or `0007_add_orders` both name the same file. */
function matchesTarget(file: MigrationFile, target: string): boolean {
  return file.id === target || String(file.seq).padStart(4, "0") === target || file.name === target;
}

/* --------------------------------- the run -------------------------------- */

export class PoolRefusedError extends Error {
  readonly code = "PG_PRIME_POOL_REFUSED";
  constructor() {
    super(
      "applyPending needs a DEDICATED direct connection (design/06 §5.1 step 1): pass a ConnInfo, " +
        "not a pg.Pool or pg.Client. A session advisory lock taken on a pooled connection is released " +
        "when the connection returns to the pool, and the migration then runs unprotected.",
    );
    this.name = "PoolRefusedError";
  }
}

/** design/06 §5.1 steps 1–9. Opens its own connection and closes it. */
export async function applyPending(
  conn: ConnInfo,
  migrationsDir: string,
  options: ApplyPendingOptions = {},
): Promise<ApplyPendingResult> {
  // Step 1, made real rather than documented: the one argument shape that would silently
  // break the lock is a pool, and it is exactly what a caller reaches for first.
  const suspect = conn as unknown as { query?: unknown; connect?: unknown };
  if (typeof suspect?.query === "function" || typeof suspect?.connect === "function") throw new PoolRefusedError();
  return withClient(conn, (client) =>
    applyPendingOn(client, migrationsDir, {
      poolerProbe: (c) => detectTransactionPoolerStrict(c, () => pinOneConnection(conn)),
      heartbeatConnection: () => openHeartbeatConnection(conn),
      ...options,
    }),
  );
}

async function openHeartbeatConnection(
  conn: ConnInfo,
): Promise<{ readonly client: CatalogClient; readonly close: () => Promise<void> }> {
  const client = new pg.Client({ ...conn });
  await client.connect();
  return {
    client: client as unknown as CatalogClient,
    close: async (): Promise<void> => {
      await client.end().catch(() => undefined);
    },
  };
}

/**
 * Open a second connection and leave a transaction open on it, so the pooler — if there
 * is one — has to move our first connection to a different backend.
 */
async function pinOneConnection(conn: ConnInfo): Promise<() => Promise<void>> {
  const client = new pg.Client({ ...conn });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT 1");
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
  return async (): Promise<void> => {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  };
}

/**
 * The same run, on a connection the caller owns.
 *
 * Exported for embedders and for the tests that need to see the wire: the caller is then
 * responsible for step 1 (this connection must be dedicated and direct).
 */
export async function applyPendingOn(
  client: CatalogClient,
  migrationsDir: string,
  options: ApplyPendingOptions = {},
): Promise<ApplyPendingResult> {
  const started = Date.now();
  const schemas = options.schemas ?? ["public"];
  const dryRun = options.dryRun === true;
  const capture = new CaptureClient();
  const engineVersion = options.engineVersion ?? ENGINE.version;
  const appliedFrom = options.appliedFrom ?? `${hostname()}:${process.pid}`;
  const staleAfter = options.staleLockAfterMs ?? DEFAULTS.staleLockAfterMs;
  const sleep = options.sleep ?? defaultSleep;
  const emit = options.onEvent ?? ((): void => undefined);
  const warnings: string[] = [];
  const diagnostics: Diagnostic[] = [];

  const empty: PreflightReport = { invalidIndexes: [], notValidConstraints: [], ccnewLeftovers: [], touchedByPending: [] };
  const noLock: LockReport = { acquired: false, runId: null, waitedMs: 0, holder: null, stale: false };
  const noRepeatables: RepeatablesReport = { applied: [], unchanged: [] };
  const done = (
    status: RunnerStatus,
    extra: Partial<ApplyPendingResult> = {},
  ): ApplyPendingResult => ({
    status,
    exitCode: RUNNER_EXIT[status],
    applied: [],
    pending: [],
    warnings,
    preflight: empty,
    repeatables: noRepeatables,
    lock: noLock,
    fingerprint: null,
    durationMs: Date.now() - started,
    dryRun: null,
    error: null,
    diagnostics,
    ...extra,
  });

  /* 2. Detect transaction pooling. */
  if (await (options.poolerProbe ?? detectTransactionPooler)(client)) {
    const r = await client.query("SELECT current_setting('port', true) AS port, current_database() AS db");
    const port = r.rows[0]?.["port"];
    return done("refused", {
      error: {
        code: "transaction_pooler",
        message:
          "this connection is behind a transaction-mode pooler: two transactions on it reported different " +
          "pg_backend_pid()s. A session advisory lock taken here is silently broken — the unlock no-ops on " +
          "the wrong backend and the original one returns to the pool still holding it. Point `apply` at the " +
          `direct PostgreSQL port instead (the server behind this pooler reports port ${String(port ?? "unknown")}; ` +
          "PgBouncer is commonly 6432 in front of 5432, Supabase 6543 in front of 5432).",
      },
    });
  }

  /* 3. Ensure the history schema. Read-only under --dry-run. */
  if (!dryRun) await ensureHistory(client);
  else if (!(await historyPresent(client))) {
    warnings.push(`${HISTORY_SCHEMA}.migrations does not exist yet; --dry-run reports the run against an empty history`);
  }
  const present = dryRun ? await historyPresent(client) : true;

  const { files, diagnostics: dirDiagnostics } = await readMigrationsDir(migrationsDir);
  diagnostics.push(...dirDiagnostics, ...files.flatMap((f) => f.diagnostics));

  const readRows = async (): Promise<MigrationRow[]> => (present ? readMigrationRows(client) : []);
  const pendingIdsOf = (rows: readonly MigrationRow[]): string[] => {
    const settled = new Set(rows.filter((r) => r.status === "applied" || r.status === "baselined").map((r) => r.id));
    return files.filter((f) => !settled.has(f.id)).map((f) => f.id);
  };

  /* 4. Advisory lock + lease. Skipped under --dry-run: it writes nothing. */
  const runId = randomUUID();
  let lock: LockReport = noLock;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let heartbeatConn: { readonly client: CatalogClient; readonly close: () => Promise<void> } | null = null;
  const database = String(
    (await client.query("SELECT current_database() AS db")).rows[0]?.["db"] ?? "",
  );

  if (!dryRun) {
    const deadline = started + (options.lockWaitMs ?? DEFAULTS.lockWaitMs);
    let acquired = await acquireSessionLock(client, database, schemas);
    if (!acquired) emit({ kind: "lock", state: "waiting", waitedMs: 0 });
    while (!acquired && Date.now() < deadline) {
      await sleep(Math.min(DEFAULTS.lockPollMs, Math.max(0, deadline - Date.now())));
      acquired = await acquireSessionLock(client, database, schemas);
    }
    const waitedMs = Date.now() - started;
    const lease = await readLease(client);
    if (!acquired) {
      emit({ kind: "lock", state: "unavailable", waitedMs });
      // design/06 §5.5: the loser re-reads history. Nothing pending ⟹ the winner did the
      // work, and exiting non-zero because somebody else deployed is wrong.
      const pending = pendingIdsOf(await readRows());
      const stale = lease !== null && lease.heartbeatAgeMs > staleAfter;
      const report: LockReport = { acquired: false, runId: null, waitedMs, holder: lease, stale };
      if (pending.length === 0) return done("up_to_date", { lock: report });
      return done("locked", {
        lock: report,
        pending,
        error: {
          code: "lock_unavailable",
          message: stale
            ? `the migration lock is held by ${lease?.holder ?? "?"} (run ${lease?.runId ?? "?"}), whose lease last ` +
              `beat ${Math.round((lease?.heartbeatAgeMs ?? 0) / 1000)}s ago — that is stale (> ${Math.round(staleAfter / 1000)}s). ` +
              `Inspect it with \`pg-prime migrate unlock\` and break it with \`pg-prime migrate unlock --force\`.`
            : `another deploy holds the migration lock${lease ? ` (${lease.holder}, run ${lease.runId})` : ""}; ` +
              `waited ${waitedMs} ms and ${pending.length} migration(s) are still pending`,
        },
      });
    }
    if (lease !== null && lease.heartbeatAgeMs <= staleAfter) {
      warnings.push(
        `took over a lease from ${lease.holder} whose heartbeat is only ${lease.heartbeatAgeMs} ms old; its session ` +
          `lock is gone, so its backend is too`,
      );
    }
    await takeLease(client, runId, appliedFrom);
    emit({ kind: "lock", state: "acquired", waitedMs });
    lock = { acquired: true, runId, waitedMs, holder: lease, stale: lease !== null && lease.heartbeatAgeMs > staleAfter };
    heartbeatConn = options.heartbeatConnection ? await options.heartbeatConnection().catch(() => null) : null;
    if (options.heartbeatConnection && heartbeatConn === null) {
      warnings.push("could not open a second connection for the lease heartbeat; beating from the migration connection instead");
    }
    const beatOn = heartbeatConn?.client ?? client;
    heartbeat = setInterval(() => {
      void heartbeatLease(beatOn, runId).catch(() => undefined);
    }, options.heartbeatMs ?? DEFAULTS.heartbeatMs);
    heartbeat.unref?.();
  }

  const release = async (): Promise<void> => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    if (heartbeatConn) await heartbeatConn.close().catch(() => undefined);
    heartbeatConn = null;
    if (!dryRun && lock.acquired) {
      await releaseLease(client, runId).catch(() => undefined);
      await releaseSessionLock(client, database, schemas).catch(() => undefined);
    }
  };

  const finish = async (result: ApplyPendingResult): Promise<ApplyPendingResult> => {
    await release();
    return { ...result, durationMs: Date.now() - started };
  };

  try {
    /* 5. Reconcile. */
    const rows = await readRows();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const byFile = new Map(files.map((f) => [f.id, f]));
    for (const row of rows) {
      const file = byFile.get(row.id);
      if (!file) {
        return await finish(
          done("drift", {
            lock,
            error: {
              code: "missing_file",
              message:
                `${row.id} is recorded in ${HISTORY_SCHEMA}.migrations (status ${row.status}) but there is no ` +
                `${row.id}.sql in ${migrationsDir}. History is append-only; restore the file or run ` +
                `\`pg-prime migrate baseline --force\` if this database is being adopted.`,
              migration: row.id,
            },
          }),
        );
      }
      if (row.checksum !== file.checksum && (row.status === "applied" || row.status === "baselined")) {
        const text =
          `${row.id}.sql has changed since it was applied: recorded ${row.checksum}, on disk ${file.checksum}. ` +
          `A migration file is immutable history.`;
        if (options.dev === true) warnings.push(text);
        else {
          return await finish(
            done("drift", { lock, error: { code: "checksum_drift", message: text, migration: row.id } }),
          );
        }
      }
    }

    /* 7 (selection). */
    const settled = new Set(rows.filter((r) => r.status === "applied" || r.status === "baselined").map((r) => r.id));
    let pending = files.filter((f) => !settled.has(f.id));
    if (options.to !== undefined) {
      const target = pending.concat(files).find((f) => matchesTarget(f, options.to!));
      if (!target) {
        return await finish(
          done("failed", {
            lock,
            pending: pending.map((f) => f.id),
            error: { code: "unknown_target", message: `--to ${JSON.stringify(options.to)} names no migration in ${migrationsDir}` },
          }),
        );
      }
      pending = pending.filter((f) => f.seq < target.seq || (f.seq === target.seq && f.name <= target.name));
    }

    /* 6. Pre-flight sweep. */
    const preflight = await sweep(client, schemas, pending);
    for (const finding of preflight.touchedByPending) {
      warnings.push(`pre-flight: ${finding} is invalid or unvalidated and a pending plan names it`);
    }

    const applied: AppliedMigration[] = [];
    let fingerprint = currentFingerprint(rows);
    let verified = false;

    for (const file of pending) {
      emit({ kind: "migration", id: file.id, state: "start" });
      const exec = executionPlan(file);
      diagnostics.push(...exec.diagnostics);
      const fatal = exec.diagnostics.find((d) => d.severity === "error");
      if (fatal) {
        return await finish(
          done("failed", {
            lock, applied, preflight,
            pending: pending.map((f) => f.id),
            error: { code: "plan_invalid", message: fatal.message, migration: file.id },
          }),
        );
      }

      /* 7a. The file's own checksum against its plan. */
      if (file.plan && file.plan.migration.sha256 !== file.checksum) {
        const text =
          `${file.id}.sql does not match its plan: the plan records ${file.plan.migration.sha256}, the file hashes ` +
          `to ${file.checksum}. Regenerate the migration rather than editing it.`;
        if (options.dev === true) warnings.push(text);
        else {
          return await finish(
            done("drift", { lock, applied, preflight, pending: pending.map((f) => f.id), error: { code: "checksum_drift", message: text, migration: file.id } }),
          );
        }
      }

      /* 7a-bis. The managed schema set (design/11 K1 open item 1).
       *
       * The set scopes the diff, the fingerprint AND the lock key, so a runner pointed at
       * a different one used to fail the fingerprint gate — with a message about hashes,
       * for a mistake that is a `--schema` flag. Now the plan records the set and the
       * refusal names both sides. Plans written before `Plan.schemas` existed carry
       * `undefined` and are not gated: an absent claim is not a disagreement. */
      const planSchemas = file.plan?.schemas;
      if (planSchemas !== undefined) {
        const want = [...planSchemas].sort().join(", ");
        const have = [...schemas].sort().join(", ");
        if (want !== have) {
          return await finish(
            done("drift", {
              lock, applied, preflight,
              pending: pending.map((f) => f.id),
              error: {
                code: "fingerprint_mismatch",
                message:
                  `${file.id} was generated for the managed schema set [${want}] and this run manages ` +
                  `[${have}]. The set scopes the diff, the fingerprint and the advisory lock key, so the ` +
                  `two are not comparable. Point \`apply\` at the same --schema set the migration was ` +
                  `generated with (or fix \`schemas\` in pg-prime.config.ts).`,
                migration: file.id,
              },
            }),
          );
        }
      }

      /* 7b. The fingerprint gate. */
      const expected = file.plan?.from.fingerprint ?? null;
      if (expected !== null) {
        const needsExtract = fingerprint === null || (options.verifyFingerprint === true && !(dryRun && verified));
        const live = needsExtract ? (await extractCatalog(client, { schemas })).ir.fingerprint : fingerprint;
        verified = true;
        if (live !== expected) {
          return await finish(
            done("drift", {
              lock, applied, preflight,
              pending: pending.map((f) => f.id),
              fingerprint: live,
              error: {
                code: "fingerprint_mismatch",
                message:
                  `${file.id} expects the schema to be at ${expected} but ${needsExtract ? "the live catalog is" : "the last applied row records"} ` +
                  `${String(live)} (schemas: ${schemas.join(", ")}). Someone changed the database outside the migration ` +
                  `history, or the runner's --schema set differs from the one the plan was generated with. ` +
                  `Run \`pg-prime migrate status --verify-fingerprint\` to re-extract.`,
                migration: file.id,
              },
            }),
          );
        }
      } else {
        warnings.push(`${file.id} has no plan; applying it without a fingerprint gate`);
      }

      /* 7c. Dispatch on txmode. */
      const target: CatalogClient = dryRun ? capture : client;
      // design/06 §7: a batched file's position lives in `pgprime.data_progress`, keyed by
      // migration id, and it is read BEFORE the file runs — that read is the whole of
      // "a killed backfill continues from its watermark, never restarts" (R15).
      const progress =
        file.directives.batch !== null && present && !dryRun ? await readDataProgress(client, file.id) : null;
      const outcome = await runFile(target, file, exec, byId.get(file.id), {
        engineVersion, appliedFrom, sleep, emit,
        lockTimeout: options.lockTimeout ?? DEFAULTS.lockTimeout,
        ...(options.statementTimeout === undefined ? {} : { statementTimeout: options.statementTimeout }),
        retryBaseMs: options.retryBaseMs ?? DEFAULTS.retryBaseMs,
        random: options.random ?? Math.random,
        dataProgress: progress,
        ...(options.replicas === undefined ? {} : { replicas: options.replicas }),
        onInfo: (m: string): void => void warnings.push(m),
      });
      if (outcome.failure) {
        emit({ kind: "migration", id: file.id, state: "failed", detail: outcome.failure.message });
        return await finish(
          done("failed", {
            lock, applied, preflight, fingerprint,
            pending: pending.map((f) => f.id).filter((id) => !applied.some((a) => a.id === id)),
            dryRun: dryRun ? capture.issued : null,
            error: outcome.failure,
          }),
        );
      }
      emit({ kind: "migration", id: file.id, state: "done" });
      applied.push(outcome.record);
      fingerprint = file.plan?.to.fingerprint ?? file.directives.to ?? fingerprint;
    }

    /* 8. Repeatables. */
    const repeatables = await runRepeatables(
      client,
      dryRun ? capture : client,
      options.repeatables ?? NO_REPEATABLES,
      options.repeatablesDir ?? null,
      present,
    );

    const status: RunnerStatus = dryRun ? "dry_run" : applied.length > 0 ? "applied" : "up_to_date";
    return await finish(
      done(status, {
        lock, applied, preflight, fingerprint, repeatables,
        pending: [],
        dryRun: dryRun ? capture.issued : null,
      }),
    );
  } catch (err) {
    await release();
    throw err;
  }
}

/* ------------------------------ the file loop ----------------------------- */

interface FileContext {
  readonly engineVersion: string;
  readonly appliedFrom: string;
  readonly lockTimeout: string;
  readonly statementTimeout?: string;
  readonly retryBaseMs: number;
  readonly random: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly emit: (event: RunnerEvent) => void;
  /** `pgprime.data_progress` as it stood before this file ran; null when there is none */
  readonly dataProgress?: DataProgress | null;
  readonly replicas?: readonly ConnInfo[];
  readonly onInfo?: (message: string) => void;
}

interface FileOutcome {
  readonly record: AppliedMigration;
  readonly failure: RunnerFailure | null;
}

type Execution = Pick<ExecutionPlan, "statements" | "segments">;

async function runFile(
  client: CatalogClient,
  file: MigrationFile,
  exec: Execution,
  row: MigrationRow | undefined,
  ctx: FileContext,
): Promise<FileOutcome> {
  const startedAt = Date.now();
  const total = exec.statements.length;
  const record = newRow(file, total, ctx.engineVersion, ctx.appliedFrom);
  const outcome = (
    durationMs: number,
    resumedFrom: number | null,
    retries: number,
    failure: RunnerFailure | null,
    batch: AppliedMigration["batch"] = null,
  ): FileOutcome => ({
    record: { id: file.id, txmode: file.txmode, statements: total, durationMs, resumedFrom, retries, batch },
    failure,
  });

  if (file.txmode === "none") {
    const from = resumeFrom(row);
    const result = await runBare(client, file, exec, record, from, ctx);
    return outcome(Date.now() - startedAt, row ? from : null, result.retries, result.failure, result.batch);
  }

  // Transactional / segmented. The history INSERT is appended to the LAST transactional
  // segment as statement `total`, so "applied" and "recorded" commit together (§5.3).
  const history: PlanStatement = {
    index: total,
    sql: recordAppliedSql(record),
    verb: "alter",
    kind: "history",
    produces: [], consumes: [], destroys: [], releases: [],
    transactionality: "transactional",
    lockClass: "rowExclusive",
    idempotent: true,
    timeouts: { lock: ctx.lockTimeout, statement: "30s" },
    dataLoss: "none",
    rewrite: false,
    hazards: [],
  };
  const statements = [...exec.statements, history];
  const segments = exec.segments.map((s) => ({ ...s, statements: [...s.statements] }));
  const last = [...segments].reverse().find((s) => s.transactional);
  const atomic = last !== undefined;
  if (last) last.statements.push(total);
  else segments.push({ index: segments.length, transactional: true, statements: [total] });

  let retries = 0;
  for (;;) {
    const report = await applySegments(client, statements, segments, {
      lockTimeout: ctx.lockTimeout,
      ...(ctx.statementTimeout === undefined ? {} : { statementTimeout: ctx.statementTimeout }),
    });
    if (report.status === "applied") {
      // The synthetic history statement is not part of the migration.
      return outcome(Date.now() - startedAt, null, retries, null);
    }
    const state = report.error?.sqlState;
    const budget = RETRY[state ?? ""] ?? 1;
    if (retries + 1 < budget) {
      retries += 1;
      ctx.emit({ kind: "migration", id: file.id, state: "retry", detail: `SQLSTATE ${state ?? "?"} attempt ${retries + 1}/${budget}` });
      await ctx.sleep(backoff(retries, ctx.retryBaseMs, ctx.random));
      continue;
    }
    const applied = Math.min(report.appliedStatements, total);
    await markFailed(client, { ...record, status: "failed" }, {
      code: "sql_error",
      message: report.error?.message ?? "unknown failure",
      ...(state === undefined ? {} : { sqlState: state }),
      ...(report.error === undefined ? {} : { statementIndex: report.error.statementIndex, sql: report.error.sql }),
      attempts: retries + 1,
    }, atomic ? 0 : applied).catch(() => undefined);
    return outcome(Date.now() - startedAt, null, retries, {
      code: "sql_error",
      message: `${file.id} failed: ${report.error?.message ?? "unknown failure"}`,
      migration: file.id,
      ...(report.error === undefined ? {} : { statementIndex: report.error.statementIndex, sql: report.error.sql }),
      ...(state === undefined ? {} : { sqlState: state }),
      attempts: retries + 1,
    });
  }
}

/**
 * design/06 §5.4 verbatim: mark uncertain, run bare, mark applied. The retry unit here is
 * the single statement, because a bare statement is the only thing that rolled back.
 */
async function runBare(
  client: CatalogClient,
  file: MigrationFile,
  exec: Execution,
  record: NewMigrationRow,
  from: number,
  ctx: FileContext,
): Promise<{ retries: number; failure: RunnerFailure | null; batch: AppliedMigration["batch"] }> {
  const total = exec.statements.length;
  await beginRow(client, { ...record, statementsApplied: from, status: "running" });
  await setConfig(client, "lock_timeout", ctx.lockTimeout, false);
  await setConfig(client, "search_path", "pg_catalog", false);

  /* design/06 §7 lane 2. `batch` is a property of the FILE, so every statement in it is
   * re-executed until it reports zero rows; a statement whose command tag carries no row
   * count (a DDL one) reports zero on its first execution and therefore runs exactly once.
   * The whole file shares one `pgprime.data_progress` row — the table is keyed by
   * migration id (§4.4) — and the runner threads the state through. */
  const directive = file.directives.batch;
  let progress: Omit<DataProgress, "updatedAt" | "migrationId"> =
    ctx.dataProgress === null || ctx.dataProgress === undefined
      ? { ...EMPTY_WATERMARK }
      : {
          rowsDone: ctx.dataProgress.rowsDone,
          statement: ctx.dataProgress.statement,
          iterations: ctx.dataProgress.iterations,
          values: ctx.dataProgress.values,
          done: ctx.dataProgress.done,
        };
  const resumedBatch = directive !== null && (ctx.dataProgress?.iterations ?? 0) > 0;

  let retries = 0;
  for (let i = from; i < total; i++) {
    const s = exec.statements[i]!;
    ctx.emit({ kind: "statement", id: file.id, index: i, total });
    await markUncertain(client, file.id, i);
    // Intentionally long-running builds (CIC, VALIDATE, REINDEX) carry `statement: null`
    // and run without a statement_timeout; lock_timeout still applies (§5.4).
    await setConfig(client, "statement_timeout", s.timeouts.statement ?? ctx.statementTimeout ?? "0", false);
    let attempt = 0;
    for (;;) {
      try {
        if (directive !== null) {
          const done = await runBatchStatement(client, s.sql, i, progress, {
            migrationId: file.id,
            directive,
            sleep: ctx.sleep,
            onEvent: ctx.emit,
            lockTimeout: ctx.lockTimeout,
            ...(ctx.onInfo === undefined ? {} : { onInfo: ctx.onInfo }),
            ...(ctx.replicas === undefined ? {} : { replicas: ctx.replicas }),
            ...(s.timeouts.statement === null
              ? ctx.statementTimeout === undefined
                ? {}
                : { statementTimeout: ctx.statementTimeout }
              : { statementTimeout: s.timeouts.statement }),
          });
          progress = {
            rowsDone: done.rowsDone,
            statement: i,
            iterations: done.iterations,
            values: { ...progress.values, [String(i)]: done.watermark },
            done: true,
          };
          break;
        }
        await client.query(s.sql);
        break;
      } catch (err) {
        const state = sqlState(err);
        const budget = RETRY[state ?? ""] ?? 1;
        attempt += 1;
        if (attempt < budget) {
          retries += 1;
          ctx.emit({ kind: "migration", id: file.id, state: "retry", detail: `statement ${i}: SQLSTATE ${state ?? "?"} attempt ${attempt + 1}/${budget}` });
          await ctx.sleep(backoff(attempt, ctx.retryBaseMs, ctx.random));
          continue;
        }
        await resetSessionGucs(client).catch(() => undefined);
        await markFailed(client, { ...record, status: "failed" }, {
          code: "sql_error",
          message: message(err),
          ...(state === undefined ? {} : { sqlState: state }),
          statementIndex: i,
          sql: s.sql,
          attempts: attempt,
        }, i).catch(() => undefined);
        return {
          retries,
          batch: directive === null ? null : { rowsDone: progress.rowsDone, iterations: progress.iterations, resumed: resumedBatch },
          failure: {
            code: "sql_error",
            message: `${file.id} failed at statement ${i}: ${message(err)}`,
            migration: file.id,
            statementIndex: i,
            sql: s.sql,
            ...(state === undefined ? {} : { sqlState: state }),
            attempts: attempt,
          },
        };
      }
    }
    await markStatementApplied(client, file.id, i, segmentOf(exec.segments, i));
  }
  await resetSessionGucs(client);
  await markApplied(client, file.id, total);
  return {
    retries,
    failure: null,
    batch: directive === null ? null : { rowsDone: progress.rowsDone, iterations: progress.iterations, resumed: resumedBatch },
  };
}

/** Exponential with full jitter, capped. `attempt` is 1-based. */
export function backoff(attempt: number, base: number, random: () => number): number {
  const ceiling = Math.min(base * 2 ** (attempt - 1), 5_000);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/* ------------------------------- step 6 & 8 -------------------------------- */

async function sweep(
  client: CatalogClient,
  schemas: readonly string[],
  pending: readonly MigrationFile[],
): Promise<PreflightReport> {
  const list = [...schemas];
  const invalid = await client.query(
    `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT i.indisvalid AND n.nspname = ANY($1) ORDER BY 1`,
    [list],
  );
  const notValid = await client.query(
    `SELECT n.nspname || '.' || t.relname || '.' || c.conname AS name
       FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE NOT c.convalidated AND n.nspname = ANY($1) ORDER BY 1`,
    [list],
  );
  const ccnew = await client.query(
    `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'i' AND c.relname LIKE '%\\_ccnew%' AND n.nspname = ANY($1) ORDER BY 1`,
    [list],
  );
  const names = (r: { rows: Record<string, unknown>[] }): string[] => r.rows.map((x) => String(x["name"]));
  const invalidIndexes = names(invalid);
  const notValidConstraints = names(notValid);
  const ccnewLeftovers = names(ccnew);

  // design/06 §5.1 step 6 says "touched by pending plans". A plan names its subjects as
  // encoded StableIds (`index:public.orders_status_idx`), so a substring test over the
  // union of produces/consumes/destroys/releases is exact enough to be useful and cannot
  // false-negative on an id spelling this release does not know.
  const subjects = new Set<string>();
  for (const f of pending) {
    for (const s of f.plan?.statements ?? []) {
      for (const id of [...s.produces, ...s.consumes, ...s.destroys, ...s.releases]) subjects.add(id);
    }
  }
  const touched = [...invalidIndexes, ...notValidConstraints, ...ccnewLeftovers].filter((name) =>
    [...subjects].some((id) => id.endsWith(name) || id.includes(`${name}`)),
  );
  return { invalidIndexes, notValidConstraints, ccnewLeftovers, touchedByPending: touched };
}

/** design/06 §5.1 step 8 — changed `sql/` files, re-applied in ONE transaction. */
async function runRepeatables(
  reader: CatalogClient,
  client: CatalogClient,
  pass: RepeatablesPass,
  dir: string | null,
  historyReadable: boolean,
): Promise<RepeatablesReport> {
  if (dir === null) return { applied: [], unchanged: [] };
  const rows = historyReadable ? await readRepeatableRows(reader) : [];
  const hashes = new Map(rows.map((r) => [r.path, r.checksum]));
  const plan = await pass.plan(dir, hashes);
  const changed = plan.toApply;
  const unchanged = plan.unchanged.map((f) => f.path);
  if (changed.length === 0) return { applied: [], unchanged };

  const startedAt = Date.now();
  await client.query("BEGIN");
  try {
    for (const f of changed) {
      for (const sql of f.statements) await client.query(sql);
      await upsertRepeatable(client, f.path, f.sha256, Date.now() - startedAt);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
  return { applied: changed.map((f) => f.path), unchanged };
}

/* ------------------------------ unlock, status ----------------------------- */

export interface LeaseInspection {
  readonly lease: LockRow | null;
  readonly stale: boolean;
  readonly staleAfterMs: number;
}

export async function inspectLease(client: CatalogClient, staleAfterMs: number = DEFAULTS.staleLockAfterMs): Promise<LeaseInspection> {
  if (!(await historyPresent(client))) return { lease: null, stale: false, staleAfterMs };
  const lease = await readLease(client);
  return { lease, stale: lease !== null && lease.heartbeatAgeMs > staleAfterMs, staleAfterMs };
}

/** `migrate unlock --force`. Cannot release the winner's SESSION lock — only its lease. */
export async function forceUnlock(client: CatalogClient): Promise<boolean> {
  if (!(await historyPresent(client))) return false;
  return breakLease(client);
}
