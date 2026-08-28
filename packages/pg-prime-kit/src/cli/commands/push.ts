/**
 * `pg-prime migrate push --dev` — design/06 §6.2, "dev loop only, and loudly labelled".
 *
 * Compute the diff and apply it **directly**, writing no files and no history rows. Four
 * refusals, all of them before a single statement is issued:
 *
 *   1. the literal `--dev` flag is absent — "not a default, not a config key";
 *   2. `PG_PRIME_ENV=production` (or `production: true` in the config);
 *   3. the connection matches `--prod-pattern`;
 *   4. `pgprime.migrations` holds any row that is not `baselined` — i.e. this database is
 *      under versioned management, and `push` is not a way to edit it.
 *
 * §9's line on why this is fenced so hard: "Bypasses history, silently drops columns."
 * Destructive changes need `--allow-data-loss` on **every** invocation; nothing about the
 * acknowledgement is written down, so nothing can remember it.
 */

import { ConfigError, loadSchema, type ResolvedConfig } from "../../config/load.js";
import { withClient } from "../../db/pg.js";
import { generate, GenerateRefusedError } from "../../generate.js";
import { historyPresent } from "../../history/schema.js";
import { readMigrationRows } from "../../history/store.js";
import { applySegments } from "../../runner/apply.js";
import type { SchemaLike } from "../../schema/types.js";
import { OfflineShadowError } from "../../shadow/ladder.js";
import { bool, str, type OptionSpec, type ParseResult } from "../args.js";
import { EXIT, type ExitCode } from "../exit.js";
import { bullets, nowIso, pairs, plural, type CommandOutput } from "../output.js";

export const PUSH_OPTIONS: readonly OptionSpec[] = [
  { name: "dev", type: "boolean", describe: "REQUIRED. There is no config key and no default for this." },
  { name: "allow-data-loss", type: "boolean", describe: "acknowledge destructive changes; never remembered between runs" },
  { name: "prod-pattern", type: "string", placeholder: "regex", describe: "refuse when the connection matches", defaultText: "prod|production|live" },
  { name: "dry-run", type: "boolean", describe: "print the statements that would be applied; apply nothing" },
  { name: "shadow", type: "string", placeholder: "url|temp-schema|createdb", describe: "how the desired state is normalized" },
];

const DEFAULT_PROD = "prod|production|live";

/** ANSI red, but only for a TTY: a CI log full of escape codes helps nobody. */
const banner = (text: string): string =>
  process.stdout.isTTY === true ? `[41;97;1m ${text} [0m` : `!!! ${text} !!!`;

export async function runPush(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput> {
  const started = Date.now();
  const refuse = (message: string, code: ExitCode = EXIT.error): CommandOutput => ({
    exitCode: code,
    envelope: {
      command: "migrate push",
      status: "refused",
      exitCode: code,
      at: nowIso(),
      durationMs: Date.now() - started,
      database: config.connection.database,
      schemas: config.schemas,
      applied: 0,
      statements: [],
      error: { code: "push_refused", message },
    },
    text: `migrate push\n\nREFUSED: ${message}`,
  });

  if (!bool(argv.values, "dev")) {
    return refuse(
      "push needs the literal --dev flag. It applies the diff straight to the database, writes no " +
        "migration file and records no history row, so it is a development-loop tool and there is " +
        "deliberately no config key that can turn it on (design/06 §6.2, §9).",
    );
  }
  if (config.production) {
    return refuse(
      `this environment is tagged production (PG_PRIME_ENV=${config.env ?? "production"}${config.config.production === true ? ", and `production: true` is set in the config" : ""}). ` +
        "push never runs against production.",
    );
  }
  const pattern = str(argv.values, "prod-pattern") ?? DEFAULT_PROD;
  const subject = `${config.connection.host}:${String(config.connection.port)}/${config.connection.database}`;
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    return refuse(`--prod-pattern ${JSON.stringify(pattern)} is not a regular expression`);
  }
  if (re.test(subject)) {
    return refuse(
      `the target ${subject} matches --prod-pattern /${pattern}/i. Pass --prod-pattern with a ` +
        "narrower expression if this really is a development database.",
    );
  }
  if (config.schemaPaths.length === 0) {
    return refuse("pg-prime.config.ts names no `schema`: push has nothing to compute a diff against.");
  }

  const managed = await withClient(config.connection, async (client) => {
    if (!(await historyPresent(client))) return [];
    const rows = await readMigrationRows(client);
    return rows.filter((r) => r.status !== "baselined").map((r) => r.id);
  });
  if (managed.length > 0) {
    return refuse(
      `${config.connection.database} is under versioned management: pgprime.migrations holds ` +
        `${plural(managed.length, "row")} that is not baselined (${managed.slice(0, 3).join(", ")}` +
        `${managed.length > 3 ? ", …" : ""}). Use \`migrate generate\` and \`migrate apply\`.`,
    );
  }

  let statements: readonly { readonly sql: string }[] = [];
  let segments: readonly { index: number; transactional: boolean; statements: number[] }[] = [];
  let hazards: { code: string; subject: string }[] = [];
  try {
    const schema = (await loadSchema(config.schemaPaths, process.cwd())).schema as SchemaLike;
    const result = await generate({
      target: config.connection,
      schema,
      repeatablesDir: config.repeatablesDir,
      schemas: config.schemas,
      seq: 0,
      name: "push",
      // One statement stream, applied here: a `CONCURRENTLY` companion file has nowhere to
      // go when nothing is written, and `applySegments` runs a bare segment anyway.
      multiFile: false,
      prove: false,
      ...(bool(argv.values, "allow-data-loss")
        ? { acknowledge: { allowDataLoss: true, reason: "migrate push --dev --allow-data-loss" } }
        : {}),
      ...(() => {
        const raw = str(argv.values, "shadow");
        if (raw === undefined) return config.config.shadow === undefined ? {} : { shadow: config.config.shadow };
        if (raw.startsWith("postgres://") || raw.startsWith("postgresql://")) return { shadow: { url: raw } };
        if (raw === "temp-schema" || raw === "createdb" || raw === "auto") return { shadow: raw };
        throw new GenerateRefusedError(`--shadow ${JSON.stringify(raw)} is not a url, createdb or temp-schema`);
      })(),
    });
    if (result.status === "up_to_date") {
      return {
        exitCode: EXIT.ok,
        envelope: {
          command: "migrate push",
          status: "up_to_date",
          exitCode: EXIT.ok,
          at: nowIso(),
          durationMs: Date.now() - started,
          database: config.connection.database,
          schemas: config.schemas,
          applied: 0,
          statements: [],
          error: null,
        },
        text: `${banner(`push --dev → ${subject}`)}\n\nnothing to do — the database already matches the schema.`,
      };
    }
    if (result.unresolved.length > 0) {
      return refuse(
        `${plural(result.unresolved.length, "decision")} need a human first: ` +
          result.unresolved.map((u) => u.fix).join("; "),
        EXIT.missingHints,
      );
    }
    const plan = result.files[0]?.plan;
    if (!plan) return refuse("the diff produced no plan");
    hazards = plan.hazards.filter((h) => h.severity === "error" && !h.acknowledged).map((h) => ({ code: h.code, subject: h.subject }));
    statements = plan.statements;
    segments = plan.segments.map((s) => ({ ...s, statements: [...s.statements] }));
    if (hazards.length > 0) {
      return refuse(
        `${plural(hazards.length, "destructive change")} is unacknowledged (${hazards.map((h) => `${h.code} ${h.subject}`).join(", ")}). ` +
          "Pass --allow-data-loss. push never remembers it: you will pass it again next time.",
        EXIT.missingHints,
      );
    }
    if (bool(argv.values, "dry-run")) {
      return {
        exitCode: EXIT.ok,
        envelope: {
          command: "migrate push",
          status: "dry_run",
          exitCode: EXIT.ok,
          at: nowIso(),
          durationMs: Date.now() - started,
          database: config.connection.database,
          schemas: config.schemas,
          applied: 0,
          statements: statements.map((s) => s.sql),
          error: null,
        },
        text: [
          banner(`push --dev → ${subject}  (DRY RUN)`),
          "",
          ...statements.map((s) => `${s.sql};`),
        ].join("\n"),
      };
    }

    const report = await withClient(config.connection, (c) => applySegments(c, plan.statements, plan.segments));
    if (report.status === "failed") {
      return {
        exitCode: EXIT.error,
        envelope: {
          command: "migrate push",
          status: "failed",
          exitCode: EXIT.error,
          at: nowIso(),
          durationMs: Date.now() - started,
          database: config.connection.database,
          schemas: config.schemas,
          applied: report.appliedStatements,
          statements: statements.map((s) => s.sql),
          error: {
            code: "sql_error",
            message: `statement ${String(report.error?.statementIndex)}: ${report.error?.message ?? "unknown"}`,
          },
        },
        text:
          `${banner(`push --dev → ${subject}`)}\n\nFAILED after ${plural(report.appliedStatements, "statement")}: ` +
          `${report.error?.message ?? "unknown"}\n  ${report.error?.sql ?? ""}`,
      };
    }
    return {
      exitCode: EXIT.ok,
      envelope: {
        command: "migrate push",
        status: "pushed",
        exitCode: EXIT.ok,
        at: nowIso(),
        durationMs: Date.now() - started,
        database: config.connection.database,
        schemas: config.schemas,
        applied: report.appliedStatements,
        statements: statements.map((s) => s.sql),
        error: null,
      },
      text: [
        banner(`push --dev → ${subject}`),
        "",
        `applied ${plural(report.appliedStatements, "statement")} DIRECTLY. No migration file was written`,
        "and no history row was recorded — this database is now ahead of your repository.",
        "",
        pairs([["schemas", config.schemas.join(", ")]]),
        bullets("statements:", statements.slice(0, 20).map((s) => s.sql)),
      ]
        .filter((l) => l !== "")
        .join("\n"),
    };
  } catch (err) {
    if (err instanceof OfflineShadowError || err instanceof GenerateRefusedError || err instanceof ConfigError) {
      return refuse(err.message);
    }
    throw err;
  }
}
