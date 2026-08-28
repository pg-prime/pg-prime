/**
 * `migrate status` — design/06 §6.2. Read-only, and read-only in the strong sense: it
 * never calls `ensureHistory`, so pointing `status` at a database the tool has never
 * touched reports "no history" instead of creating one.
 *
 * "Applied vs pending, current fingerprint, stale locks, partially-applied rows,
 * repeatable drift."
 */

import { extractCatalog, type CatalogClient, type Diagnostic } from "../catalog/extract.js";
import { describeDrift, driftSentence, type DriftReport } from "../checkpoint/checkpoint.js";
import { EXIT, type ExitCode } from "../cli/exit.js";
import { withClient, type ConnInfo } from "../db/pg.js";
import { historyPresent, historyVersion } from "../history/schema.js";
import {
  currentFingerprint,
  readAllDataProgress,
  readMigrationRows,
  readRepeatableRows,
  type DataProgress,
  type MigrationRow,
} from "../history/store.js";
import { inspectLease, NO_REPEATABLES, type LeaseInspection } from "./run.js";
import type { RepeatablesPass } from "../repeatables/index.js";
import { readMigrationsDir } from "./files.js";

export type EntryState =
  | "applied"
  | "baselined"
  /** design/06 §4.5: recorded, never executed here — a checkpoint an existing database
   * ignored, or a file a fresh one jumped over. Not pending, and not applied. */
  | "superseded"
  | "running"
  | "failed"
  | "pending"
  | "orphaned";

export interface StatusEntry {
  readonly id: string;
  readonly state: EntryState;
  readonly txmode: string;
  readonly statementsTotal: number;
  readonly statementsApplied: number;
  readonly statementUncertain: number | null;
  readonly appliedAt: string | null;
  readonly appliedBy: string | null;
  /** null when there is nothing recorded to compare the file against */
  readonly checksumOk: boolean | null;
}

export interface StatusReport {
  readonly status: "up_to_date" | "pending" | "drift";
  readonly exitCode: ExitCode;
  readonly historyPresent: boolean;
  readonly historyVersion: string | null;
  readonly fingerprint: string | null;
  readonly fingerprintSource: "history" | "catalog" | null;
  /** the live catalog disagrees with `pgprime.migrations` — only ever set under `--verify-fingerprint` */
  readonly fingerprintDrift: boolean;
  /**
   * design/12 decision 16 — WHICH objects drifted, by diffing the live IR against the
   * newest checkpoint's IR at or before the recorded position. `null` when there is no
   * drift, when `--verify-fingerprint` was not asked for, or when no checkpoint exists.
   */
  readonly drift: DriftReport | null;
  /** `fingerprint_to` of the last applied row, whatever `fingerprint` above was read from */
  readonly recordedFingerprint: string | null;
  readonly migrations: readonly StatusEntry[];
  readonly pending: readonly string[];
  readonly partial: readonly StatusEntry[];
  readonly missingFiles: readonly string[];
  readonly checksumDrift: readonly string[];
  readonly lock: LeaseInspection;
  readonly repeatables: {
    readonly drift: readonly string[];
    readonly tracked: number;
    readonly passImplemented: boolean;
  };
  /**
   * design/06 §7: "`status` shows a running backfill's `rows_done`."
   *
   * Every `pgprime.data_progress` row, with the state of the migration it belongs to
   * beside it — a backfill whose migration is still `running` is the one an operator is
   * asking about, and a finished one's total is the evidence that it did the work.
   */
  readonly data: readonly DataProgressEntry[];
  readonly diagnostics: readonly Diagnostic[];
  readonly durationMs: number;
}

export interface DataProgressEntry extends DataProgress {
  /** the state of the migration this progress belongs to, or `orphaned` when there is none */
  readonly migrationState: EntryState;
}

export interface StatusOptions {
  readonly schemas?: readonly string[];
  /** re-extract the catalog instead of reading `fingerprint_to` off the last row */
  readonly verifyFingerprint?: boolean;
  readonly staleLockAfterMs?: number;
  readonly repeatables?: RepeatablesPass;
  readonly repeatablesDir?: string;
}

export async function migrationStatus(
  conn: ConnInfo,
  migrationsDir: string,
  options: StatusOptions = {},
): Promise<StatusReport> {
  return withClient(conn, (client) => migrationStatusOn(client, migrationsDir, options));
}

export async function migrationStatusOn(
  client: CatalogClient,
  migrationsDir: string,
  options: StatusOptions = {},
): Promise<StatusReport> {
  const started = Date.now();
  const schemas = options.schemas ?? ["public"];
  const { files, diagnostics: dirDiagnostics } = await readMigrationsDir(migrationsDir);
  const diagnostics: Diagnostic[] = [...dirDiagnostics, ...files.flatMap((f) => f.diagnostics)];

  const present = await historyPresent(client);
  const rows: MigrationRow[] = present ? await readMigrationRows(client) : [];
  const version = present ? await historyVersion(client) : null;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const fileIds = new Set(files.map((f) => f.id));

  const migrations: StatusEntry[] = [];
  const missingFiles: string[] = [];
  const checksumDrift: string[] = [];

  for (const row of rows) {
    if (!fileIds.has(row.id)) {
      missingFiles.push(row.id);
      migrations.push({
        id: row.id,
        state: "orphaned",
        txmode: row.txmode,
        statementsTotal: row.statementsTotal,
        statementsApplied: row.statementsApplied,
        statementUncertain: row.statementUncertain,
        appliedAt: row.finishedAt,
        appliedBy: row.appliedBy,
        checksumOk: null,
      });
    }
  }

  for (const file of files) {
    const row = byId.get(file.id);
    const checksumOk = row ? row.checksum === file.checksum : null;
    if (row && !checksumOk && (row.status === "applied" || row.status === "baselined")) checksumDrift.push(file.id);
    const state: EntryState = row ? row.status : "pending";
    migrations.push({
      id: file.id,
      state,
      txmode: row?.txmode ?? file.txmode,
      statementsTotal: row?.statementsTotal ?? file.statements.length,
      statementsApplied: row?.statementsApplied ?? 0,
      statementUncertain: row?.statementUncertain ?? null,
      appliedAt: row?.finishedAt ?? null,
      appliedBy: row?.appliedBy ?? null,
      checksumOk,
    });
  }
  migrations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const pending = migrations
    .filter((m) => m.state === "pending" || m.state === "running" || m.state === "failed")
    .map((m) => m.id);
  const partial = migrations.filter((m) => m.state === "running" || (m.state === "failed" && m.statementsApplied > 0));

  const recorded = currentFingerprint(rows);
  let fingerprint = recorded;
  let fingerprintSource: StatusReport["fingerprintSource"] = fingerprint === null ? null : "history";
  // Catalog drift is only VISIBLE on the slow path. The fast path reads `fingerprint_to`
  // off the last applied row, which is a statement about what the runner did, not about
  // what the database now contains — so `status` can only report "somebody changed this
  // schema outside the history" when it has actually looked (design/06 §6.2's exit 4).
  let fingerprintDrift = false;
  // design/12 decision 16 — when the fingerprints disagree, NAME the objects. A hash names
  // nothing; a checkpoint's `.ir.json` is an IR of the expected state, so the difference is
  // a diff of the live catalog against the newest checkpoint at or before the recorded
  // position. Only computed when there is drift and only under `--verify-fingerprint`:
  // the fast path has not looked at the catalog at all.
  let driftReport: DriftReport | null = null;
  if (options.verifyFingerprint === true) {
    fingerprint = (await extractCatalog(client, { schemas })).ir.fingerprint;
    fingerprintSource = "catalog";
    fingerprintDrift = recorded !== null && recorded !== fingerprint;
    if (fingerprintDrift) {
      driftReport = await describeDrift({
        client,
        migrationsDir,
        schemas,
        appliedIds: rows.filter((r) => r.status === "applied" || r.status === "baselined").map((r) => r.id),
      }).catch(() => null);
      if (driftReport !== null) {
        const sentence = driftSentence(driftReport);
        if (sentence !== null) diagnostics.push({ code: "fingerprint_drift", severity: "error", message: sentence });
      }
    }
  }

  const lock = await inspectLease(client, options.staleLockAfterMs);

  const pass = options.repeatables ?? NO_REPEATABLES;
  const tracked = present ? await readRepeatableRows(client) : [];
  const hashes = new Map(tracked.map((r) => [r.path, r.checksum]));
  // `toApply` IS the drift: every `sql/` file whose hash differs from the recorded one (or was never recorded).
  const drift =
    options.repeatablesDir === undefined
      ? []
      : (await pass.plan(options.repeatablesDir, hashes)).toApply.map((f) => f.path);

  const byMigrationId = new Map(migrations.map((m) => [m.id, m]));
  const data: DataProgressEntry[] = (present ? await readAllDataProgress(client) : []).map((p) => ({
    ...p,
    migrationState: byMigrationId.get(p.migrationId)?.state ?? "orphaned",
  }));

  const status: StatusReport["status"] =
    missingFiles.length > 0 || checksumDrift.length > 0 || fingerprintDrift
      ? "drift"
      : pending.length > 0
        ? "pending"
        : "up_to_date";

  return {
    status,
    exitCode: status === "drift" ? EXIT.drift : status === "pending" ? EXIT.pending : EXIT.ok,
    historyPresent: present,
    historyVersion: version,
    fingerprint,
    fingerprintSource,
    fingerprintDrift,
    drift: driftReport,
    recordedFingerprint: recorded,
    migrations,
    pending,
    partial,
    missingFiles,
    checksumDrift,
    lock,
    repeatables: { drift, tracked: tracked.length, passImplemented: pass !== NO_REPEATABLES },
    data,
    diagnostics,
    durationMs: Date.now() - started,
  };
}
