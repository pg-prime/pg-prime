/**
 * `migrate status` — design/06 §6.2. Read-only, and read-only in the strong sense: it
 * never calls `ensureHistory`, so pointing `status` at a database the tool has never
 * touched reports "no history" instead of creating one.
 *
 * "Applied vs pending, current fingerprint, stale locks, partially-applied rows,
 * repeatable drift."
 */

import { extractCatalog, type CatalogClient, type Diagnostic } from "../catalog/extract.js";
import { EXIT, type ExitCode } from "../cli/exit.js";
import { withClient, type ConnInfo } from "../db/pg.js";
import { historyPresent, historyVersion } from "../history/schema.js";
import { currentFingerprint, readMigrationRows, readRepeatableRows, type MigrationRow } from "../history/store.js";
import { inspectLease, NO_REPEATABLES, type LeaseInspection } from "./run.js";
import type { RepeatablesPass } from "../repeatables/index.js";
import { readMigrationsDir } from "./files.js";

export type EntryState = "applied" | "baselined" | "running" | "failed" | "pending" | "orphaned";

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
  /** `fingerprint_to` of the last applied row, whatever `fingerprint` above was read from */
  readonly recordedFingerprint: string | null;
  readonly migrations: readonly StatusEntry[];
  readonly pending: readonly string[];
  readonly partial: readonly StatusEntry[];
  readonly missingFiles: readonly string[];
  readonly checksumDrift: readonly string[];
  readonly lock: LeaseInspection;
  readonly repeatables: { readonly drift: readonly string[]; readonly tracked: number; readonly passImplemented: boolean };
  readonly diagnostics: readonly Diagnostic[];
  readonly durationMs: number;
}

export interface StatusOptions {
  readonly schemas?: readonly string[];
  /** re-extract the catalog instead of reading `fingerprint_to` off the last row */
  readonly verifyFingerprint?: boolean;
  readonly staleLockAfterMs?: number;
  readonly repeatables?: RepeatablesPass;
  readonly repeatablesDir?: string;
}

export async function migrationStatus(conn: ConnInfo, migrationsDir: string, options: StatusOptions = {}): Promise<StatusReport> {
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
        id: row.id, state: "orphaned", txmode: row.txmode,
        statementsTotal: row.statementsTotal, statementsApplied: row.statementsApplied,
        statementUncertain: row.statementUncertain, appliedAt: row.finishedAt, appliedBy: row.appliedBy,
        checksumOk: null,
      });
    }
  }

  for (const file of files) {
    const row = byId.get(file.id);
    const checksumOk = row ? row.checksum === file.checksum : null;
    if (row && !checksumOk && (row.status === "applied" || row.status === "baselined")) checksumDrift.push(file.id);
    const state: EntryState = row
      ? row.status === "superseded"
        ? "applied"
        : row.status
      : "pending";
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

  const pending = migrations.filter((m) => m.state === "pending" || m.state === "running" || m.state === "failed").map((m) => m.id);
  const partial = migrations.filter((m) => m.state === "running" || (m.state === "failed" && m.statementsApplied > 0));

  const recorded = currentFingerprint(rows);
  let fingerprint = recorded;
  let fingerprintSource: StatusReport["fingerprintSource"] = fingerprint === null ? null : "history";
  // Catalog drift is only VISIBLE on the slow path. The fast path reads `fingerprint_to`
  // off the last applied row, which is a statement about what the runner did, not about
  // what the database now contains — so `status` can only report "somebody changed this
  // schema outside the history" when it has actually looked (design/06 §6.2's exit 4).
  let fingerprintDrift = false;
  if (options.verifyFingerprint === true) {
    fingerprint = (await extractCatalog(client, { schemas })).ir.fingerprint;
    fingerprintSource = "catalog";
    fingerprintDrift = recorded !== null && recorded !== fingerprint;
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
    recordedFingerprint: recorded,
    migrations,
    pending,
    partial,
    missingFiles,
    checksumDrift,
    lock,
    repeatables: { drift, tracked: tracked.length, passImplemented: pass !== NO_REPEATABLES },
    diagnostics,
    durationMs: Date.now() - started,
  };
}
