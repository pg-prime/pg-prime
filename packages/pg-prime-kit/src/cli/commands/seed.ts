/**
 * `pg-prime db seed [--set <name>] [--force]` — design/06 §6.2's twelfth command, §7 lane 3.
 *
 * A top-level verb (`db seed`), not a `migrate` one, and that is the point: seeds are
 * **not** migration history. Nothing here calls `ensureHistory`, takes the advisory lock or
 * writes a row — a seeded dev database that has never been migrated must not acquire a
 * `pgprime` schema as a side effect, because `migrate baseline` would then refuse it.
 */

import { ConfigError, type ResolvedConfig } from "../../config/load.js";
import { DEFAULT_PROD_PATTERN, runSeeds, seedSets, type SeedResult } from "../../seed/run.js";
import { bool, list, str, type OptionSpec, type ParseResult } from "../args.js";
import { EXIT, type ExitCode } from "../exit.js";
import { bullets, nowIso, pairs, plural, type CommandOutput } from "../output.js";

export const SEED_OPTIONS: readonly OptionSpec[] = [
  {
    name: "set",
    type: "string",
    placeholder: "name",
    repeatable: true,
    describe: "also run seeds/<name>/**; repeatable",
    defaultText: "the base set (seeds/*.sql, seeds/*.ts) only",
  },
  { name: "force", type: "boolean", describe: "seed anyway on a production-tagged environment or a --prod-pattern match" },
  {
    name: "prod-pattern",
    type: "string",
    placeholder: "regex",
    describe: "matched case-insensitively against host:port/database",
    defaultText: DEFAULT_PROD_PATTERN,
  },
  { name: "seeds", type: "string", placeholder: "dir", describe: "the seeds directory", defaultText: "./seeds" },
  { name: "list", type: "boolean", describe: "print the files that would run, and run nothing" },
];

export async function runSeedCommand(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput> {
  const started = Date.now();
  const seedsDir = str(argv.values, "seeds") ?? config.seedsDir;

  const envelope = (status: string, exitCode: ExitCode, extra: Readonly<Record<string, unknown>>, text: string): CommandOutput => ({
    exitCode,
    envelope: {
      command: "db seed",
      status,
      exitCode,
      at: nowIso(),
      durationMs: Date.now() - started,
      database: config.connection.database,
      seedsDir,
      ...extra,
    },
    text,
  });

  if (!config.hasConnection) {
    return envelope(
      "refused",
      EXIT.error,
      { sets: [], applied: [], skipped: [], error: { code: "config", message: "no database connection" } },
      "db seed\n\nREFUSED: no database connection: pass --url, set `url` in pg-prime.config.ts, or export PG_PRIME_DATABASE_URL",
    );
  }

  if (bool(argv.values, "list")) {
    const sets = await seedSets(seedsDir);
    const { scanSeeds } = await import("../../seed/run.js");
    const files = await scanSeeds(seedsDir, list(argv.values, "set") ?? []);
    return envelope(
      "listed",
      EXIT.ok,
      { sets, files: files.map((f) => ({ path: f.path, kind: f.kind, set: f.set })), applied: [], skipped: [], error: null },
      [
        `db seed --list — ${seedsDir}`,
        "",
        pairs([["sets on disk", sets.length === 0 ? "(none)" : sets.join(", ")]]),
        bullets("would run:", files.map((f) => `${f.path}  [${f.kind}${f.set === null ? "" : `, set ${f.set}`}]`)),
      ]
        .filter((l) => l !== "")
        .join("\n"),
    );
  }

  let result: SeedResult;
  try {
    result = await runSeeds({
      seedsDir,
      connection: config.connection,
      sets: list(argv.values, "set") ?? [],
      force: bool(argv.values, "force"),
      production: config.production,
      prodPattern: str(argv.values, "prod-pattern") ?? DEFAULT_PROD_PATTERN,
      schemaPaths: config.schemaPaths,
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      return envelope(
        "refused",
        EXIT.error,
        { sets: list(argv.values, "set") ?? [], applied: [], skipped: [], error: { code: "config", message: err.message } },
        `db seed\n\nREFUSED: ${err.message}`,
      );
    }
    throw err;
  }

  const exitCode: ExitCode = result.status === "seeded" || result.status === "nothing_to_do" ? EXIT.ok : EXIT.error;
  return envelope(
    result.status,
    exitCode,
    {
      sets: result.sets,
      applied: result.applied.map((a) => ({ path: a.path, kind: a.kind, set: a.set, statements: a.statements, durationMs: a.durationMs })),
      skipped: result.skipped,
      error: result.error,
    },
    text(result, seedsDir),
  );
}

function text(r: SeedResult, seedsDir: string): string {
  if (r.status === "refused" || r.status === "failed") {
    return `db seed\n\n${r.status.toUpperCase()}: ${r.error?.message ?? "no detail"}`;
  }
  if (r.status === "nothing_to_do") {
    return `db seed — nothing to do: no .sql or .ts seed under ${seedsDir}${r.sets.length === 0 ? "" : ` for set(s) ${r.sets.join(", ")}`}.`;
  }
  return [
    `db seed — ran ${plural(r.applied.length, "seed")} from ${seedsDir}`,
    "",
    ...r.applied.map((a) => `  ${a.path}  [${a.kind}]  ${plural(a.statements, "statement")}  ${String(a.durationMs)} ms`),
    "",
    "Nothing was recorded in pgprime.migrations — seeds are not migration history (design/06 §7).",
  ].join("\n");
}
