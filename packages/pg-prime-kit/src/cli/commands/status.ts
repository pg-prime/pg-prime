/** `pg-prime migrate status` — design/06 §6.2. Exit 0 up to date · 5 pending · 4 drift. */

import type { ResolvedConfig } from "../../config/load.js";
import { createRepeatablesPass } from "../../repeatables/index.js";
import { migrationStatus, type StatusReport } from "../../runner/status.js";
import { bool, ms, type OptionSpec, type ParseResult } from "../args.js";
import { bullets, nowIso, pairs, plural, type CommandOutput } from "../output.js";

export const STATUS_OPTIONS: readonly OptionSpec[] = [
  {
    name: "verify-fingerprint",
    type: "boolean",
    describe: "re-extract the catalog instead of reading fingerprint_to off the last applied row",
  },
  {
    name: "stale-lock-after",
    type: "duration",
    placeholder: "duration",
    describe: "a lease whose heartbeat is older than this is reported stale",
    defaultText: "60s",
  },
];

export async function runStatus(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput> {
  const report = await migrationStatus(config.connection, config.migrationsDir, {
    schemas: config.schemas,
    // The same one-line binding as `apply` (design/11 §3 K3.4): with it, `repeatables.drift`
    // is the real answer rather than the stub's empty one, and `passImplemented` says true.
    repeatables: createRepeatablesPass(),
    repeatablesDir: config.repeatablesDir,
    ...(bool(argv.values, "verify-fingerprint") ? { verifyFingerprint: true } : {}),
    ...((ms(argv.values, "stale-lock-after") ?? config.config.staleLockAfterMs)
      ? { staleLockAfterMs: ms(argv.values, "stale-lock-after") ?? config.config.staleLockAfterMs! }
      : {}),
  });
  return {
    exitCode: report.exitCode,
    envelope: envelope(config, report),
    text: text(config, report),
  };
}

function envelope(config: ResolvedConfig, r: StatusReport): Readonly<Record<string, unknown>> {
  return {
    command: "migrate status",
    status: r.status,
    exitCode: r.exitCode,
    at: nowIso(),
    durationMs: r.durationMs,
    database: config.connection.database,
    migrationsDir: config.migrationsDir,
    schemas: config.schemas,
    history: { present: r.historyPresent, version: r.historyVersion },
    fingerprint: r.fingerprint,
    fingerprintSource: r.fingerprintSource,
    fingerprintDrift: r.fingerprintDrift,
    drift: r.drift,
    recordedFingerprint: r.recordedFingerprint,
    migrations: r.migrations.map((m) => ({
      id: m.id,
      state: m.state,
      txmode: m.txmode,
      statementsTotal: m.statementsTotal,
      statementsApplied: m.statementsApplied,
      statementUncertain: m.statementUncertain,
      appliedAt: m.appliedAt,
      appliedBy: m.appliedBy,
      checksumOk: m.checksumOk,
    })),
    pending: r.pending,
    partial: r.partial.map((m) => ({
      id: m.id,
      statementsApplied: m.statementsApplied,
      statementsTotal: m.statementsTotal,
      statementUncertain: m.statementUncertain,
    })),
    missingFiles: r.missingFiles,
    checksumDrift: r.checksumDrift,
    lock: {
      held: r.lock.lease !== null,
      stale: r.lock.stale,
      staleAfterMs: r.lock.staleAfterMs,
      holder: r.lock.lease,
    },
    repeatables: {
      tracked: r.repeatables.tracked,
      drift: r.repeatables.drift,
      passImplemented: r.repeatables.passImplemented,
    },
    data: r.data.map((d) => ({
      migrationId: d.migrationId,
      migrationState: d.migrationState,
      rowsDone: d.rowsDone,
      statement: d.statement,
      iterations: d.iterations,
      watermark: d.values,
      done: d.done,
      updatedAt: d.updatedAt,
    })),
    diagnostics: r.diagnostics.map((d) => ({
      code: d.code,
      severity: d.severity,
      subject: d.subject ?? null,
      message: d.message,
    })),
    error: null,
  };
}

function text(config: ResolvedConfig, r: StatusReport): string {
  const lines: string[] = [
    `migrate status — ${config.connection.database} @ ${config.connection.host}:${String(config.connection.port)}`,
    "",
    pairs([
      [
        "history",
        r.historyPresent
          ? `present (v${r.historyVersion ?? "?"})`
          : "absent — this database has never been migrated by pg-prime",
      ],
      [
        "fingerprint",
        r.fingerprint === null
          ? "unknown"
          : `${r.fingerprint} (${r.fingerprintSource ?? "?"})${r.fingerprintDrift ? ` — DRIFT, history records ${r.recordedFingerprint ?? "?"}` : ""}`,
      ],
      // "0 pending", never "0 pendings": `pending` is the state, not a countable noun.
      ["migrations", `${plural(r.migrations.length, "file")}, ${String(r.pending.length)} pending`],
      [
        "lock",
        r.lock.lease === null
          ? "free"
          : `${r.lock.stale ? "STALE " : ""}held by ${r.lock.lease.holder} (run ${r.lock.lease.runId}, beat ${String(r.lock.lease.heartbeatAgeMs)} ms ago)`,
      ],
    ]),
    "",
  ];
  for (const m of r.migrations) {
    lines.push(
      `  ${m.state.padEnd(9)} ${m.id}` +
        (m.state === "running" || m.state === "failed"
          ? `  ${String(m.statementsApplied)}/${String(m.statementsTotal)} statements${m.statementUncertain === null ? "" : `, statement ${String(m.statementUncertain)} uncertain`}`
          : "") +
        (m.checksumOk === false ? "  CHECKSUM DRIFT" : ""),
    );
  }
  lines.push(
    bullets(
      "data migrations (design/06 §7):",
      r.data.map(
        (d) =>
          `${d.migrationId}  ${d.migrationState}  ${plural(d.rowsDone, "row")} in ${plural(d.iterations, "batch", "batches")}` +
          `${d.done ? "" : `, statement ${String(d.statement)} in flight`}` +
          `${d.values[String(d.statement)] == null ? "" : `, watermark ${String(d.values[String(d.statement)])}`}`,
      ),
    ),
  );
  lines.push(bullets("missing files (recorded but not on disk):", r.missingFiles));
  lines.push(bullets("checksum drift:", r.checksumDrift));
  lines.push(bullets("repeatable drift:", r.repeatables.drift));
  return lines.filter((l) => l !== "").join("\n");
}
