/**
 * `pg-prime migrate apply` (alias `deploy`) — design/06 §6.2.
 *
 * "Never generates. Never introspects the desired state. Never needs the TS schema — it
 * needs only the `migrations/` directory and a connection, so the production image does
 * not ship your schema code." This command therefore does not import `generate`, the
 * shadow ladder, or anything that reads a schema module, and that is load-bearing rather
 * than incidental.
 */

import type { ResolvedConfig } from "../../config/load.js";
import { createRepeatablesPass } from "../../repeatables/index.js";
import { applyPending, type ApplyPendingOptions, type ApplyPendingResult } from "../../runner/run.js";
import { bool, ms, str, type OptionSpec, type ParseResult } from "../args.js";
import { EXIT } from "../exit.js";
import { bullets, nowIso, pairs, plural, type CommandOutput } from "../output.js";

export const APPLY_OPTIONS: readonly OptionSpec[] = [
  { name: "to", type: "string", placeholder: "id", describe: "stop after this migration (0007 or 0007_add_orders)" },
  { name: "dry-run", type: "boolean", describe: "print the exact statement stream, including BEGIN/COMMIT and set_config; write nothing" },
  { name: "lock-timeout", type: "string", placeholder: "duration", describe: "PostgreSQL lock_timeout for every statement", defaultText: "3s" },
  { name: "statement-timeout", type: "string", placeholder: "duration", describe: "PostgreSQL statement_timeout, except for intentionally long builds" },
  { name: "lock-wait", type: "duration", placeholder: "duration", describe: "how long to wait for a concurrent deploy's lock", defaultText: "30s" },
  { name: "stale-lock-after", type: "duration", placeholder: "duration", describe: "a lease whose heartbeat is older than this is reported stale", defaultText: "60s" },
  { name: "heartbeat", type: "duration", placeholder: "duration", describe: "how often the lease is refreshed; must be well under --stale-lock-after", defaultText: "5s" },
  { name: "verify-fingerprint", type: "boolean", describe: "re-extract the catalog instead of trusting the recorded fingerprint_to" },
  { name: "dev", type: "boolean", describe: "downgrade checksum drift from an error to a warning" },
  { name: "yes", type: "boolean", describe: "accepted for forward compatibility; apply never prompts" },
  {
    name: "applied-from",
    type: "string",
    placeholder: "id",
    describe: "recorded in pgprime.migrations.applied_from (design/06 §4.4: hostname / CI run id)",
    defaultText: "<hostname>:<pid>",
  },
];

export async function runApply(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput> {
  const options: ApplyPendingOptions = {
    schemas: config.schemas,
    // Tier R (design/06 §3.8, §5.1 step 8). K1 left `NO_REPEATABLES` here as the seam and
    // K3 shipped the pass; this is the binding. A missing `sql/` directory is an empty
    // pass, not a failure — `scanRepeatables` answers `[]` for ENOENT and nothing else.
    repeatables: createRepeatablesPass(),
    repeatablesDir: config.repeatablesDir,
    ...(str(argv.values, "to") === undefined ? {} : { to: str(argv.values, "to")! }),
    ...(str(argv.values, "applied-from") === undefined ? {} : { appliedFrom: str(argv.values, "applied-from")! }),
    ...(bool(argv.values, "dry-run") ? { dryRun: true } : {}),
    ...(bool(argv.values, "dev") ? { dev: true } : {}),
    ...(bool(argv.values, "verify-fingerprint") ? { verifyFingerprint: true } : {}),
    ...(str(argv.values, "lock-timeout") ?? config.config.lockTimeout
      ? { lockTimeout: str(argv.values, "lock-timeout") ?? config.config.lockTimeout! }
      : {}),
    ...(str(argv.values, "statement-timeout") ?? config.config.statementTimeout
      ? { statementTimeout: str(argv.values, "statement-timeout") ?? config.config.statementTimeout! }
      : {}),
    ...(ms(argv.values, "lock-wait") ?? config.config.lockWaitMs
      ? { lockWaitMs: ms(argv.values, "lock-wait") ?? config.config.lockWaitMs! }
      : {}),
    ...(ms(argv.values, "stale-lock-after") ?? config.config.staleLockAfterMs
      ? { staleLockAfterMs: ms(argv.values, "stale-lock-after") ?? config.config.staleLockAfterMs! }
      : {}),
    ...(ms(argv.values, "heartbeat") === undefined ? {} : { heartbeatMs: ms(argv.values, "heartbeat")! }),
  };

  const result = await applyPending(config.connection, config.migrationsDir, options);
  return envelope(config, result);
}

function envelope(config: ResolvedConfig, r: ApplyPendingResult): CommandOutput {
  const stream = r.dryRun === null ? null : r.dryRun.map((q) => (q.values === undefined ? { text: q.text } : { text: q.text, values: q.values }));
  return {
    exitCode: r.exitCode,
    envelope: {
      command: "migrate apply",
      status: r.status,
      exitCode: r.exitCode,
      at: nowIso(),
      durationMs: r.durationMs,
      database: config.connection.database,
      migrationsDir: config.migrationsDir,
      schemas: config.schemas,
      lock: {
        acquired: r.lock.acquired,
        runId: r.lock.runId,
        waitedMs: r.lock.waitedMs,
        stale: r.lock.stale,
        holder: r.lock.holder,
      },
      applied: r.applied.map((a) => ({
        id: a.id,
        txmode: a.txmode,
        statements: a.statements,
        durationMs: a.durationMs,
        resumedFrom: a.resumedFrom,
        retries: a.retries,
      })),
      pending: r.pending,
      fingerprint: r.fingerprint,
      preflight: {
        invalidIndexes: r.preflight.invalidIndexes,
        notValidConstraints: r.preflight.notValidConstraints,
        ccnewLeftovers: r.preflight.ccnewLeftovers,
        touchedByPending: r.preflight.touchedByPending,
      },
      repeatables: { applied: r.repeatables.applied, unchanged: r.repeatables.unchanged },
      warnings: r.warnings,
      diagnostics: r.diagnostics.map((d) => ({ code: d.code, severity: d.severity, subject: d.subject ?? null, message: d.message })),
      stream,
      error: r.error,
    },
    text: text(config, r),
  };
}

function text(config: ResolvedConfig, r: ApplyPendingResult): string {
  const head = `migrate apply — ${config.connection.database} @ ${config.connection.host}:${String(config.connection.port)}`;
  const lines: string[] = [head, ""];

  if (r.dryRun !== null) {
    lines.push(`--dry-run: ${plural(r.dryRun.length, "statement")} would be issued, in this order.`, "");
    for (const q of r.dryRun) {
      lines.push(q.values === undefined ? `${q.text};` : `${q.text};  -- ${JSON.stringify(q.values)}`);
    }
    lines.push("", "Nothing was executed and no lock was taken.");
    return lines.join("\n");
  }

  switch (r.status) {
    case "applied":
      lines.push(`applied ${plural(r.applied.length, "migration")} in ${String(r.durationMs)} ms:`);
      for (const a of r.applied) {
        lines.push(
          `  ${a.id}  ${a.txmode}  ${plural(a.statements, "statement")}  ${String(a.durationMs)} ms` +
            (a.resumedFrom === null ? "" : `  (resumed at statement ${String(a.resumedFrom)})`) +
            (a.retries === 0 ? "" : `  (${plural(a.retries, "retry", "retries")})`),
        );
      }
      break;
    case "up_to_date":
      lines.push(r.lock.acquired ? "nothing to do — the database is up to date." : "nothing to do — another deploy already applied everything.");
      break;
    case "locked":
    case "drift":
    case "failed":
    case "refused":
      lines.push(`${r.status.toUpperCase()}: ${r.error?.message ?? "no detail"}`);
      break;
    default:
      break;
  }

  if (r.fingerprint) lines.push("", pairs([["fingerprint", r.fingerprint]]));
  const findings = [...r.preflight.invalidIndexes, ...r.preflight.notValidConstraints, ...r.preflight.ccnewLeftovers];
  lines.push(bullets("pre-flight findings:", findings));
  lines.push(bullets("warnings:", r.warnings));
  lines.push(bullets("pending:", r.pending));
  return lines.filter((l) => l !== "").join("\n") || "nothing to do.";
}

export const APPLY_EXIT_NOTE: string = `Exit: ${String(EXIT.ok)} applied or nothing to do · ${String(EXIT.error)} error · ${String(EXIT.drift)} drift · ${String(EXIT.locked)} lock unavailable`;
