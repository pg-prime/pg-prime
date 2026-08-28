/**
 * `pg-prime migrate checkpoint` — design/06 §6.2, §4.5, design/12 decision 16.
 *
 * "Write a `-- pg-prime:checkpoint` migration containing the full schema plus
 * `checkpoints/NNNN.ir.json`. Fresh databases jump to it; existing ones ignore it. Nothing
 * is deleted."
 *
 * The command itself is read-only against the database: it introspects, writes three
 * files, and records nothing. The `pgprime.checkpoints` row is written by `apply`, when a
 * fresh database actually jumps to it — a checkpoint that was written but never applied
 * anywhere has no business claiming a row.
 */

import { readdir } from "node:fs/promises";
import type { ResolvedConfig } from "../../config/load.js";
import { buildCheckpoint, listCheckpoints, writeCheckpoint, CHECKPOINT_NAME } from "../../checkpoint/checkpoint.js";
import { withClient } from "../../db/pg.js";
import { MIGRATION_FILE } from "../../runner/files.js";
import { bool, str, type OptionSpec, type ParseResult } from "../args.js";
import { EXIT, type ExitCode } from "../exit.js";
import { bullets, nowIso, pairs, plural, type CommandOutput } from "../output.js";

export const CHECKPOINT_OPTIONS: readonly OptionSpec[] = [
  { name: "seq", type: "string", placeholder: "n", describe: "the checkpoint's number", defaultText: "one past the highest on disk" },
  { name: "by", type: "string", placeholder: "name", describe: "recorded as the plan's author", defaultText: "$USER" },
  { name: "dry-run", type: "boolean", describe: "print what would be written; write nothing" },
];

async function nextSeq(dir: string): Promise<number> {
  let max = -1;
  try {
    for (const entry of await readdir(dir)) {
      const m = MIGRATION_FILE.exec(entry);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
  }
  return max + 1;
}

export async function runCheckpoint(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput> {
  const started = Date.now();

  const envelope = (status: string, exitCode: ExitCode, extra: Readonly<Record<string, unknown>>, text: string): CommandOutput => ({
    exitCode,
    envelope: {
      command: "migrate checkpoint",
      status,
      exitCode,
      at: nowIso(),
      durationMs: Date.now() - started,
      database: config.connection.database,
      migrationsDir: config.migrationsDir,
      schemas: config.schemas,
      ...extra,
    },
    text,
  });

  const refuse = (message: string): CommandOutput =>
    envelope("refused", EXIT.error, { written: null, migration: null, error: { code: "checkpoint_refused", message } },
      `migrate checkpoint\n\nREFUSED: ${message}`);

  if (!config.hasConnection) {
    return refuse("no database connection: pass --url, set `url` in pg-prime.config.ts, or export PG_PRIME_DATABASE_URL");
  }

  const seqRaw = str(argv.values, "seq");
  const seq = seqRaw === undefined ? await nextSeq(config.migrationsDir) : Number(seqRaw);
  if (!Number.isInteger(seq) || seq < 0) {
    return refuse(`--seq ${JSON.stringify(seqRaw)} must be a non-negative integer`);
  }

  const existing = await listCheckpoints(config.migrationsDir);

  try {
    const built = await withClient(config.connection, (client) =>
      buildCheckpoint({
        client,
        schemas: config.schemas,
        seq,
        ...(str(argv.values, "by") === undefined ? {} : { by: str(argv.values, "by")! }),
      }),
    );
    const warnings = built.diagnostics.filter((d) => d.severity !== "info").map((d) => `${d.code}: ${d.message}`);
    const fatal = built.diagnostics.filter((d) => d.severity === "error");
    if (fatal.length > 0) {
      return refuse(
        `the current schema cannot be emitted as a full-schema checkpoint: ${fatal.map((d) => `${d.code} — ${d.message}`).join("; ")}`,
      );
    }

    const id = `${String(seq).padStart(4, "0")}_${CHECKPOINT_NAME}`;
    if (bool(argv.values, "dry-run")) {
      return envelope(
        "dry_run",
        EXIT.ok,
        {
          written: null,
          migration: {
            id,
            planId: built.plan.planId,
            statements: built.plan.statements.length,
            fingerprint: built.plan.to.fingerprint,
            supersedes: existing.map((c) => c.id),
          },
          sql: built.sql,
          warnings,
          error: null,
        },
        `migrate checkpoint --dry-run\n\n${built.sql}`,
      );
    }

    const written = await writeCheckpoint(config.migrationsDir, built);
    return envelope(
      "written",
      EXIT.ok,
      {
        written: { sql: written.sqlPath, plan: written.planPath, ir: written.irPath },
        migration: {
          id,
          planId: built.plan.planId,
          statements: built.plan.statements.length,
          fingerprint: built.plan.to.fingerprint,
          supersedes: existing.map((c) => c.id),
        },
        warnings,
        error: null,
      },
      [
        "migrate checkpoint",
        "",
        pairs([
          ["wrote", written.sqlPath],
          ["plan", written.planPath],
          ["ir", written.irPath],
          ["statements", String(built.plan.statements.length)],
          ["fingerprint", built.plan.to.fingerprint],
        ]),
        "",
        `A FRESH database now applies ${id} and everything after it; an existing one ignores it and`,
        "continues linearly (design/06 §4.5). Nothing was deleted and nothing was recorded.",
        bullets("warnings:", warnings),
      ]
        .filter((l) => l !== "")
        .join("\n"),
    );
  } catch (err) {
    if ((err as { code?: string }).code === "EEXIST") {
      return refuse(
        `${String(seq).padStart(4, "0")}_${CHECKPOINT_NAME} already exists in ${config.migrationsDir}. A checkpoint is ` +
          `history like any other migration; pass --seq to write a new one.`,
      );
    }
    return refuse(err instanceof Error ? err.message : String(err));
  }
}

export const CHECKPOINT_SUMMARY: string = `writes ${plural(3, "file")}: the .sql, the .plan.json and checkpoints/NNNN.ir.json`;
