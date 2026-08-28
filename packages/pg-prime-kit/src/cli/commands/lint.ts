/**
 * `pg-prime migrate lint [<file>…]` — design/06 §6.2.
 *
 * A thin shell over `lintPlan`, which is a pure function of a `Plan` plus the bytes of its
 * `.sql` (design/11 §3 K3.6). Everything interesting — the severity table, the `nolint`
 * grammar, the acknowledgement rule — lives there and is unit-tested without a database.
 *
 * Two things this file decides:
 *
 *  - **It runs without a database when you name files.** `migrate lint db/migrations/*.sql`
 *    is a pure function of the filesystem, and requiring a `DATABASE_URL` to lint SQL text
 *    is the kind of friction that gets a linter deleted from CI. With no positional
 *    arguments it needs the history to know which migrations are unapplied, which is the
 *    documented default target.
 *  - **`--format sarif` is refused, with a sentence.** §6.2 lists it and §8 puts it in
 *    v1.1. A `--format` that silently produced JSON instead would break the GitHub
 *    code-scanning upload it exists for, at the point where nobody is looking.
 */

import { resolve } from "node:path";
import type { ResolvedConfig } from "../../config/load.js";
import { historyPresent } from "../../history/schema.js";
import { readMigrationRows } from "../../history/store.js";
import { withClient } from "../../db/pg.js";
import { formatFindings, lintPlan, unusedDirectives, type LintFinding, type LintOptions } from "../../lint/lint.js";
import { buildPlan, type Plan } from "../../plan/plan.js";
import { readMigrationsDir, type MigrationFile } from "../../runner/files.js";
import { list, str, type OptionSpec, type ParseResult } from "../args.js";
import { EXIT, type ExitCode } from "../exit.js";
import { nowIso, plural, type CommandOutput } from "../output.js";

export const LINT_OPTIONS: readonly OptionSpec[] = [
  { name: "fail-on", type: "string", placeholder: "error|warn|off", describe: "the severity that makes this command exit 3", defaultText: "error" },
  { name: "rules", type: "string", placeholder: "codes", repeatable: true, describe: "only these hazard codes; repeatable or comma-separated" },
  { name: "format", type: "string", placeholder: "text|json", describe: "output format for the findings", defaultText: "text" },
  { name: "style", type: "boolean", describe: "run the ST101–ST106 style family, whose default is off" },
  { name: "all", type: "boolean", describe: "lint every migration on disk, not only the unapplied ones" },
];

/**
 * A hand-written `.sql` has no plan. `lintPlan` needs one, so a minimal plan is built from
 * the file's own directives and statement markers — which is exactly what the runner does
 * to execute it (`executionPlan`), so the linter and the runner see the same file.
 */
function planFor(file: MigrationFile): Plan {
  if (file.plan) return file.plan;
  const transactional = file.txmode !== "none";
  return buildPlan({
    seq: file.seq,
    name: file.name,
    statements: file.statements.map((s) => ({
      sql: s.sql,
      verb: "alter" as const,
      kind: "unknown",
      produces: [],
      consumes: [],
      destroys: [],
      releases: [],
      transactionality: transactional ? ("transactional" as const) : ("nonTransactional" as const),
      lockClass: s.lockClass,
      idempotent: s.idempotent,
      dataLoss: "none" as const,
      rewrite: false,
      hazards: s.hazards,
      phase: 0,
    })),
    segments: [{ index: 0, transactional, statements: file.statements.map((s) => s.index) }],
    fromFingerprint: file.directives.from ?? "",
    toFingerprint: file.directives.to ?? "",
    pgVersionNum: file.directives.requiresPg ?? 150000,
    renames: [],
    diagnostics: [],
  });
}

export async function runLint(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput> {
  const started = Date.now();
  const format = str(argv.values, "format") ?? "text";
  if (format === "sarif") {
    return refusal(
      config,
      started,
      "--format sarif is not built in this release (design/06 §8 puts it in v1.1). It needs a rule " +
        "catalogue with help URIs, and emitting JSON under the sarif name would break the GitHub " +
        "code-scanning upload it exists for. Use --format json.",
    );
  }
  if (format !== "text" && format !== "json") {
    return refusal(config, started, `--format ${JSON.stringify(format)} is not one of text, json`);
  }
  const failOnRaw = str(argv.values, "fail-on") ?? "error";
  if (failOnRaw !== "error" && failOnRaw !== "warn" && failOnRaw !== "off") {
    return refusal(config, started, `--fail-on ${JSON.stringify(failOnRaw)} is not one of error, warn, off`);
  }
  const rules = (list(argv.values, "rules") ?? []).flatMap((r) => r.split(",")).map((r) => r.trim()).filter(Boolean);

  const { files } = await readMigrationsDir(config.migrationsDir);

  let targets: MigrationFile[];
  // `main.ts` routes positionally and hands the command `argv.slice(2)`, so every
  // positional here is a file the user named.
  const positionals = argv.positionals;
  if (positionals.length > 0) {
    const wanted = new Set(positionals.map((p) => resolve(process.cwd(), p)));
    targets = files.filter((f) => wanted.has(resolve(f.path)) || wanted.has(resolve(config.migrationsDir, `${f.id}.sql`)));
    const missing = [...wanted].filter((w) => !targets.some((t) => resolve(t.path) === w));
    if (missing.length > 0) {
      return refusal(config, started, `not a migration in ${config.migrationsDir}: ${missing.join(", ")}`);
    }
  } else if (argv.values["all"] === true || !config.hasConnection) {
    targets = [...files];
  } else {
    // The documented default: the unapplied ones. Reading history is the only reason this
    // command ever opens a connection.
    const applied = await withClient(config.connection, async (client) => {
      if (!(await historyPresent(client))) return new Set<string>();
      const rows = await readMigrationRows(client);
      return new Set(rows.filter((r) => r.status === "applied" || r.status === "baselined").map((r) => r.id));
    });
    targets = files.filter((f) => !applied.has(f.id));
  }

  const options: LintOptions = {
    failOn: failOnRaw,
    ...(rules.length > 0 ? { rules } : {}),
    ...(argv.values["style"] === true ? { style: true } : {}),
  };

  const perFile = targets.map((file) => {
    const result = lintPlan(planFor(file), file.text, options);
    return { file, result };
  });

  const findings: (LintFinding & { migration: string })[] = perFile.flatMap(({ file, result }) =>
    result.findings.map((f) => ({ ...f, migration: file.id })),
  );
  const directiveErrors = perFile.flatMap(({ file, result }) =>
    result.directiveErrors.map((e) => ({ ...e, migration: file.id })),
  );
  const unused = perFile.flatMap(({ file, result }) =>
    unusedDirectives(result).map((d) => ({ ...d, migration: file.id })),
  );
  const exitCode: ExitCode = perFile.some(({ result }) => result.exitCode === 3) ? EXIT.lint : EXIT.ok;

  const body =
    format === "json"
      ? JSON.stringify({ findings, directiveErrors, unused }, null, 2)
      : perFile
          .map(({ file, result }) => {
            const text = formatFindings(result, "text");
            return text === "" ? `${file.id}: clean` : `${file.id}:\n${text.split("\n").map((l) => `  ${l}`).join("\n")}`;
          })
          .join("\n");

  return {
    exitCode,
    envelope: {
      command: "migrate lint",
      status: exitCode === EXIT.ok ? "clean" : "failed",
      exitCode,
      at: nowIso(),
      durationMs: Date.now() - started,
      database: config.hasConnection ? config.connection.database : null,
      migrationsDir: config.migrationsDir,
      schemas: config.schemas,
      linted: targets.map((f) => f.id),
      failOn: failOnRaw,
      rules,
      findings,
      directiveErrors,
      unusedDirectives: unused,
      error: null,
    },
    text: [
      `migrate lint — ${plural(targets.length, "migration")}, ${plural(findings.length, "finding")}`,
      "",
      body,
    ]
      .filter((l) => l !== "")
      .join("\n"),
  };
}

function refusal(config: ResolvedConfig, started: number, message: string): CommandOutput {
  return {
    exitCode: EXIT.error,
    envelope: {
      command: "migrate lint",
      status: "refused",
      exitCode: EXIT.error,
      at: nowIso(),
      durationMs: Date.now() - started,
      database: config.hasConnection ? config.connection.database : null,
      migrationsDir: config.migrationsDir,
      schemas: config.schemas,
      linted: [],
      findings: [],
      error: { code: "usage", message },
    },
    text: `migrate lint\n\nREFUSED: ${message}`,
  };
}
