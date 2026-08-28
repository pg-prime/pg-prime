/**
 * `pg-prime migrate generate` — design/06 §6.2.
 *
 * "Build IR(desired) from TS + `sql/`, normalize via the shadow ladder, extract
 * IR(current), diff, resolve renames, order, apply lock-safe rewriting, run hazard
 * analysis, **prove on a clone**, and only then write `NNNN_name.sql` + `.plan.json`."
 *
 * Exit codes are §6.1's, and the mapping is the interesting part: an unresolved rename or
 * an unacknowledged *data loss* is **2** (a human decision is missing), any other
 * error-severity hazard is **3** (the lint gate), a plan that does not converge is **7**,
 * and a write that was refused for any other reason is **1**. Nothing is written on a
 * non-zero exit — that is `writePlan`'s D6 gate, not this command's politeness.
 */

import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { ConfigError, loadSchema, type ResolvedConfig } from "../../config/load.js";
import {
  dataMigrationSql,
  emptyMigrationSql,
  generate,
  readHintsFile,
  GenerateRefusedError,
  type GenerateResult,
  type Unresolved,
} from "../../generate.js";
import { renameDiff } from "../interactive.js";
import { RepeatableApplyError } from "../../repeatables/index.js";
import { DesiredLoadError } from "../../schema/load.js";
import { MIGRATION_FILE } from "../../runner/files.js";
import type { RenameHint } from "../../diff/delta.js";
import type { DumpOracleMode } from "../../prove/pg-dump.js";
import type { SchemaLike } from "../../schema/types.js";
import type { ShadowStrategy } from "../../shadow/ladder.js";
import { OfflineShadowError } from "../../shadow/ladder.js";
import { bool, str, type OptionSpec, type ParseResult } from "../args.js";
import { EXIT, type ExitCode } from "../exit.js";
import { bullets, nowIso, pairs, plural, type CommandOutput } from "../output.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const GENERATE_OPTIONS: readonly OptionSpec[] = [
  { name: "name", type: "string", placeholder: "slug", describe: "the migration's name; [a-z0-9_]+", defaultText: "auto" },
  { name: "seq", type: "string", placeholder: "n", describe: "the migration number", defaultText: "one past the highest on disk" },
  { name: "interactive", type: "boolean", describe: "TTY only: show rename candidates and print the annotation to add" },
  { name: "hints-file", type: "string", placeholder: "path", describe: "JSON array of { from, to } rename hints" },
  { name: "allow-data-loss", type: "boolean", describe: "acknowledge every destructive change in this plan (design/06 §3.6)" },
  { name: "reason", type: "string", placeholder: "text", describe: "recorded beside the acknowledgement in the plan" },
  { name: "by", type: "string", placeholder: "name", describe: "recorded as the plan's author", defaultText: "$USER" },
  {
    name: "shadow",
    type: "string",
    placeholder: "url|temp-schema|createdb|none",
    describe: "how the desired state is normalized (design/06 §3.2)",
    defaultText: "auto",
  },
  { name: "offline", type: "boolean", describe: "shadow tier 4; refused with a sentence in this release" },
  { name: "no-safe-rewrite", type: "boolean", describe: "emit the literal diff instead of design/06 §3.5's lock-safe forms" },
  { name: "no-prove", type: "boolean", describe: "dev only: stamp proof.status = skipped and write anyway" },
  { name: "strict-unmodeled", type: "boolean", describe: "a non-empty Tier-U census becomes an error (design/06 §2.2)" },
  { name: "dump-oracle", type: "string", placeholder: "off|warn|strict", describe: "the D10 pg_dump witness", defaultText: "warn" },
  { name: "dry-run", type: "boolean", describe: "print the SQL that would be written; write nothing" },
  { name: "empty", type: "boolean", describe: "write a blank hand-written migration and touch no database" },
  { name: "data", type: "boolean", describe: "write a data-migration template (design/06 §7 lane 2)" },
];

const NAME = /^[a-z0-9_]+$/;

/** One past the highest `NNNN` on disk. design/06 §4.1: duplicates are legal, gaps are fine. */
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

function shadowStrategy(raw: string | undefined, offline: boolean): ShadowStrategy | undefined {
  if (offline) return "offline";
  if (raw === undefined) return undefined;
  if (raw.startsWith("postgres://") || raw.startsWith("postgresql://")) return { url: raw };
  if (raw === "temp-schema" || raw === "createdb" || raw === "auto") return raw;
  if (raw === "none" || raw === "offline") return "offline";
  if (raw === "docker") {
    throw new GenerateRefusedError(
      "--shadow docker is not built in this release: the kit has no testcontainers dependency " +
        "(design/08 §1.1's dependency budget). Pass a postgres:// URL, or use --shadow createdb / " +
        "--shadow temp-schema, both of which need no Docker.",
    );
  }
  throw new GenerateRefusedError(
    `--shadow ${JSON.stringify(raw)} is not one of: a postgres:// url, createdb, temp-schema, none`,
  );
}

function oracleMode(raw: string | undefined): DumpOracleMode | undefined {
  if (raw === undefined) return undefined;
  if (raw === "off" || raw === "warn" || raw === "strict") return raw;
  throw new GenerateRefusedError(`--dump-oracle ${JSON.stringify(raw)} is not one of off, warn, strict`);
}

export async function runGenerate(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput> {
  const started = Date.now();
  const name = str(argv.values, "name") ?? "auto";
  if (!NAME.test(name)) {
    return refusal(started, "usage", `--name ${JSON.stringify(name)} must match ${String(NAME)}`);
  }
  const seqRaw = str(argv.values, "seq");
  const seq = seqRaw === undefined ? await nextSeq(config.migrationsDir) : Number(seqRaw);
  if (!Number.isInteger(seq) || seq < 0) {
    return refusal(started, "usage", `--seq ${JSON.stringify(seqRaw)} must be a non-negative integer`);
  }

  /* ---- the two file-only forms: no database, no shadow, no plan ---- */
  if (bool(argv.values, "empty") || bool(argv.values, "data")) {
    const data = bool(argv.values, "data");
    const id = `${String(seq).padStart(4, "0")}_${name}`;
    const sql = data ? dataMigrationSql({ seq, name }) : emptyMigrationSql(seq, name);
    if (bool(argv.values, "dry-run")) {
      return envelope(started, "dry_run", EXIT.ok, { files: [{ id, stage: data ? "data" : "main", written: null, sql }] }, sql);
    }
    const path = join(config.migrationsDir, `${id}.sql`);
    await mkdir(config.migrationsDir, { recursive: true });
    try {
      await writeFile(path, sql, { encoding: "utf8", flag: "wx" });
    } catch (err) {
      if ((err as { code?: string }).code === "EEXIST") {
        return refusal(started, "exists", `refusing to overwrite ${path}`);
      }
      throw err;
    }
    return envelope(
      started,
      "generated",
      EXIT.ok,
      { files: [{ id, stage: data ? "data" : "main", written: path, sql }] },
      `migrate generate --${data ? "data" : "empty"}\n\n${pairs([["wrote", path]])}`,
    );
  }

  if (!config.hasConnection) {
    return refusal(
      started,
      "config",
      "no database connection: pass --url, set `url` in pg-prime.config.ts, or export PG_PRIME_DATABASE_URL",
    );
  }
  if (config.schemaPaths.length === 0) {
    return refusal(
      started,
      "config",
      "pg-prime.config.ts names no `schema`. `generate` builds the desired state from your " +
        "TypeScript schema module(s); point `schema` at the file that exports them " +
        "(e.g. schema: './db/schema.ts').",
    );
  }

  let result: GenerateResult;
  let schema: SchemaLike;
  try {
    schema = (await loadSchema(config.schemaPaths, process.cwd())).schema as SchemaLike;
    const hintsFile = str(argv.values, "hints-file");
    const hints: RenameHint[] = hintsFile === undefined ? [] : await readHintsFile(hintsFile);
    const dryRun = bool(argv.values, "dry-run");
    result = await generate({
      target: config.connection,
      schema,
      repeatablesDir: config.repeatablesDir,
      schemas: config.schemas,
      seq,
      name,
      hints,
      ...(dryRun ? {} : { outDir: config.migrationsDir }),
      ...(bool(argv.values, "interactive") ? { interactive: true } : {}),
      ...(bool(argv.values, "no-prove") ? { prove: false } : {}),
      ...(bool(argv.values, "no-safe-rewrite") ? { noSafeRewrite: true } : {}),
      ...(bool(argv.values, "strict-unmodeled") ? { strictUnmodeled: true } : {}),
      ...(() => {
        // `--shadow` is a STRING on the command line and a `ShadowStrategy` in the config
        // file, where it is already typed. The flag wins; neither is guessed at.
        const flag = shadowStrategy(str(argv.values, "shadow"), bool(argv.values, "offline"));
        const s = flag ?? config.config.shadow;
        return s === undefined ? {} : { shadow: s };
      })(),
      ...(() => {
        const o = oracleMode(str(argv.values, "dump-oracle"));
        return o === undefined ? {} : { dumpOracle: o };
      })(),
      ...(str(argv.values, "by") === undefined ? {} : { by: str(argv.values, "by")! }),
      ...(bool(argv.values, "allow-data-loss")
        ? {
            acknowledge: {
              allowDataLoss: true,
              ...(str(argv.values, "by") === undefined ? {} : { by: str(argv.values, "by")! }),
              ...(str(argv.values, "reason") === undefined ? {} : { reason: str(argv.values, "reason")! }),
            },
          }
        : {}),
    });
  } catch (err) {
    if (err instanceof OfflineShadowError || err instanceof GenerateRefusedError || err instanceof ConfigError) {
      return refusal(started, "refused", err.message);
    }
    // The desired state did not load into the shadow. That is design/06 §3.8's whole
    // point — "a view that references a to-be-dropped column makes the plan fail at author
    // time" — and it deserves the file's name, not an `internal` stack trace.
    if (err instanceof DesiredLoadError) {
      return refusal(started, "desired_load", err.message);
    }
    if (err instanceof RepeatableApplyError) {
      return refusal(
        started,
        "repeatable_failed",
        `${err.message}: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}. ` +
          `The repeatable was loaded into the shadow beside the desired schema (design/06 §3.8), so ` +
          `this is the plan failing at author time rather than at apply time. Either the file or the ` +
          `schema has to change.`,
      );
    }
    throw err;
  }

  /* ---- design/06 §3.3: --interactive shows the candidates and writes the EDIT ---- */
  if (result.status === "missing_hints" || (bool(argv.values, "interactive") && result.unresolved.length > 0)) {
    if (bool(argv.values, "interactive") && process.stdin.isTTY === true && process.stdout.isTTY === true) {
      const diff = await interactiveRenames(result, config.schemaPaths);
      return envelope(
        started,
        "missing_hints",
        EXIT.missingHints,
        { unresolved: result.unresolved, candidates: result.candidates, patch: diff },
        diff,
      );
    }
    return envelope(
      started,
      "missing_hints",
      EXIT.missingHints,
      { unresolved: result.unresolved, candidates: result.candidates, patch: null },
      text(result, config),
    );
  }

  const status = result.status;
  const code: ExitCode =
    status === "generated" || status === "up_to_date"
      ? EXIT.ok
      : status === "proof_failed"
        ? EXIT.proof
        : status === "hazards"
          ? EXIT.lint
          : EXIT.error;

  return envelope(
    started,
    bool(argv.values, "dry-run") && status === "generated" ? "dry_run" : status,
    code,
    {
      files: result.files.map((f) => ({
        id: f.id,
        stage: f.stage,
        written: f.sqlPath ?? null,
        plan: f.planPath ?? null,
        statements: f.plan?.statements.length ?? 0,
        txmode: f.plan?.txmode ?? "none",
        from: f.plan?.from.fingerprint ?? null,
        to: f.plan?.to.fingerprint ?? null,
        planId: f.plan?.planId ?? null,
        sql: bool(argv.values, "dry-run") ? f.sql : undefined,
      })),
      shadow: result.shadow,
      proof: result.proof,
      renames: result.diff.renames,
      candidates: result.candidates,
      unresolved: result.unresolved,
      repeatables: result.repeatables.map((r) => ({ path: r.path, sha256: r.sha256 })),
      hazards: result.files.flatMap((f) => f.plan?.hazards ?? []),
      diagnostics: result.diagnostics.map((d) => ({ code: d.code, severity: d.severity, subject: d.subject ?? null, message: d.message })),
      writeRefusal: result.writeRefusal ?? null,
    },
    text(result, config),
  );

  function envelope(
    at: number,
    envStatus: string,
    exitCode: ExitCode,
    extra: Readonly<Record<string, unknown>>,
    body: string,
  ): CommandOutput {
    return {
      exitCode,
      envelope: {
        command: "migrate generate",
        status: envStatus,
        exitCode,
        at: nowIso(),
        durationMs: Date.now() - at,
        database: config.connection.database,
        migrationsDir: config.migrationsDir,
        schemas: config.schemas,
        ...extra,
        error: null,
      },
      text: body,
    };
  }

  function refusal(at: number, kind: string, message: string): CommandOutput {
    return {
      exitCode: EXIT.error,
      envelope: {
        command: "migrate generate",
        status: "refused",
        exitCode: EXIT.error,
        at: nowIso(),
        durationMs: Date.now() - at,
        database: config.connection.database,
        migrationsDir: config.migrationsDir,
        schemas: config.schemas,
        files: [],
        error: { code: kind, message },
      },
      text: `migrate generate\n\nREFUSED: ${message}`,
    };
  }
}

function text(result: GenerateResult, config: ResolvedConfig): string {
  const head = `migrate generate — ${config.connection.database} (shadow tier ${String(result.shadow.tier)}: ${result.shadow.reason})`;
  if (result.status === "up_to_date") return `${head}\n\nnothing to do — the database already matches the schema.`;
  if (result.status === "missing_hints") {
    return [
      head,
      "",
      `${plural(result.unresolved.length, "decision")} need a human (design/06 §3.3). Nothing was written.`,
      "",
      ...result.unresolved.map((u) =>
        u.type === "rename_or_recreate"
          ? `  rename?  ${u.from} -> ${u.to}  [${u.confidence ?? "?"}]\n           ${u.reason ?? ""}\n           fix: ${u.fix}`
          : `  data loss  ${u.entity ?? "?"}  (${u.kind})\n           ${u.reason ?? ""}\n           fix: ${u.fix}`,
      ),
    ].join("\n");
  }
  const lines = [head, ""];
  for (const f of result.files) {
    lines.push(
      `  ${f.id}.sql  ${f.stage}  ${plural(f.plan?.statements.length ?? 0, "statement")}  txmode ${f.plan?.txmode ?? "none"}` +
        (f.sqlPath === undefined ? "  (not written)" : ""),
    );
  }
  if (result.proof) {
    lines.push(
      "",
      pairs([
        ["proof", `${result.proof.status}${result.proof.error ? ` — ${result.proof.error}` : ""}`],
        ["witness", `${result.proof.dumpOracle?.status ?? "n/a"}${result.proof.dumpOracle?.reason ? ` (${result.proof.dumpOracle.reason})` : ""}`],
      ]),
    );
  }
  const warn = result.diagnostics.filter((d) => d.severity !== "info").map((d) => `${d.code}: ${d.message}`);
  lines.push(bullets("diagnostics:", warn));
  if (result.writeRefusal) lines.push("", `REFUSED: ${result.writeRefusal}`);
  return lines.filter((l) => l !== "").join("\n");
}

/**
 * design/06 §3.3's third input — and the honest version of it.
 *
 * "`--interactive` shows candidates and, on confirmation, **writes the annotation into the
 * source file**." The DSL does not record where a column was declared: `ColumnDdl` carries
 * `renamedFrom`, `dbName`, types and modifiers, and no `sourceRef`. Editing a file we
 * located by *grepping* for a column key would be a heuristic write into somebody's source
 * — the one thing §3.3 is written to prevent. So the confirmation produces a **unified
 * diff on stdout** and exit 2: the same edit, reviewable, applyable with `patch -p0`, and
 * never applied behind the author's back. Recorded as a divergence in design/06 §3.3.
 */
async function interactiveRenames(result: GenerateResult, schemaPaths: readonly string[]): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const accepted: Unresolved[] = [];
  try {
    for (const u of result.unresolved) {
      if (u.type !== "rename_or_recreate") continue;
      const answer = await rl.question(
        `rename ${u.from} -> ${u.to}? [${u.confidence ?? "?"}]\n  ${u.reason ?? ""}\n  (y/N) `,
      );
      if (/^y(es)?$/i.test(answer.trim())) accepted.push(u);
    }
  } finally {
    rl.close();
  }
  if (accepted.length === 0) {
    return "no renames confirmed; nothing to apply. Nothing was written.";
  }
  return renameDiff(accepted, schemaPaths);
}
