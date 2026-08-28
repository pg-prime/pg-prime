/**
 * `pg-prime pull --out <file> [--schema … repeatable] [--sql-dir <dir>]` — design/06 §6.2's
 * twelfth command.
 *
 * A top-level verb, not a `migrate` one: `pull` writes no migration, records nothing, and
 * is the *opposite* direction from everything under `migrate`. It reads a database and
 * writes TypeScript.
 */

import { relative } from "node:path";
import type { ResolvedConfig } from "../../config/load.js";
import { pullSchema, writePull, type PullResult } from "../../pull/pull.js";
import { bool, str, type OptionSpec, type ParseResult } from "../args.js";
import { EXIT, type ExitCode } from "../exit.js";
import { bullets, nowIso, pairs, plural, type CommandOutput } from "../output.js";

export const PULL_OPTIONS: readonly OptionSpec[] = [
  {
    name: "out",
    type: "string",
    placeholder: "file",
    describe: "where the TypeScript schema is written",
    defaultText: "./db/schema.ts",
  },
  {
    name: "sql-dir",
    type: "string",
    placeholder: "dir",
    describe: "where Tier-R objects (views, functions, triggers, policies) are written as repeatables",
    defaultText: "the config's `repeatables`, ./sql",
  },
  {
    name: "no-sql-dir",
    type: "boolean",
    describe: "do not write repeatables; report every Tier-R object as unsupported instead",
  },
  { name: "dry-run", type: "boolean", describe: "print the TypeScript that would be written; write nothing" },
];

export async function runPull(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput> {
  const started = Date.now();
  const out = str(argv.values, "out") ?? config.schemaPaths[0] ?? "db/schema.ts";
  const noSqlDir = bool(argv.values, "no-sql-dir");
  const sqlDir = noSqlDir ? undefined : (str(argv.values, "sql-dir") ?? config.repeatablesDir);

  const envelope = (
    status: string,
    exitCode: ExitCode,
    extra: Readonly<Record<string, unknown>>,
    text: string,
  ): CommandOutput => ({
    exitCode,
    envelope: {
      command: "pull",
      status,
      exitCode,
      at: nowIso(),
      durationMs: Date.now() - started,
      database: config.connection.database,
      schemas: config.schemas,
      out,
      sqlDir: sqlDir ?? null,
      ...extra,
    },
    text,
  });

  if (!config.hasConnection) {
    return envelope(
      "refused",
      EXIT.error,
      { counts: {}, repeatables: [], unsupported: [], error: { code: "config", message: "no database connection" } },
      "pull\n\nREFUSED: no database connection: pass --url, set `url` in pg-prime.config.ts, or export PG_PRIME_DATABASE_URL",
    );
  }

  let result: PullResult;
  try {
    result = await pullSchema({
      connection: config.connection,
      schemas: config.schemas,
      out,
      ...(sqlDir === undefined ? {} : { sqlDir }),
    });
  } catch (err) {
    return envelope(
      "error",
      EXIT.error,
      {
        counts: {},
        repeatables: [],
        unsupported: [],
        error: { code: "pull_failed", message: err instanceof Error ? err.message : String(err) },
      },
      `pull\n\nERROR: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (bool(argv.values, "dry-run")) {
    return envelope(
      "dry_run",
      EXIT.ok,
      {
        counts: result.counts,
        repeatables: result.repeatables.map((r) => ({ kind: r.kind, identity: r.identity, path: r.path })),
        unsupported: result.unsupported,
        written: null,
        report: null,
        error: null,
      },
      result.ts,
    );
  }

  const written = await writePull(
    { connection: config.connection, schemas: config.schemas, out, ...(sqlDir === undefined ? {} : { sqlDir }) },
    result,
  );

  return envelope(
    "written",
    EXIT.ok,
    {
      counts: result.counts,
      repeatables: result.repeatables.map((r) => ({ kind: r.kind, identity: r.identity, path: r.path })),
      unsupported: result.unsupported,
      written: { schema: written.out, report: written.report, repeatables: written.repeatables.length },
      report: written.report,
      error: null,
    },
    [
      `pull — ${config.connection.database} (${config.schemas.join(", ")})`,
      "",
      pairs([
        ["wrote", written.out],
        ["report", written.report],
        ...(sqlDir === undefined
          ? []
          : [["repeatables", `${plural(written.repeatables.length, "file")} under ${sqlDir}`] as const]),
        [
          "objects",
          Object.entries(result.counts)
            .map(([k, v]) => `${String(v)} ${k}`)
            .join(", ") || "none",
        ],
      ]),
      result.unsupported.length === 0 ? "\nNothing was left behind: the `-- pull: unsupported` block is empty." : "",
      bullets(
        `${plural(result.unsupported.length, "object")} the DSL cannot express (also in pull.report.json):`,
        result.unsupported.slice(0, 20).map((u) => `${u.kind}  ${u.name}  — ${u.reason}`),
      ),
      "",
      `Next: point \`schema\` in pg-prime.config.ts at ${relative(process.cwd(), written.out)} and run ` +
        "`pg-prime migrate baseline`, then `pg-prime migrate generate` to see an empty diff.",
    ]
      .filter((l) => l !== "")
      .join("\n"),
  );
}
