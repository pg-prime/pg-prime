/**
 * `pg-prime` — argv in, exit code out.
 *
 * The binary is named after the product and `migrate` is the noun (design/11 §3 K1.4).
 * `main` never calls `process.exit`: it returns the code and `src/cli.ts` assigns it to
 * `process.exitCode`, so stdout is flushed before the process ends. That is the
 * difference between a golden test that reads the envelope and one that reads nothing.
 *
 * `--output json` "is always non-interactive and always emits `{ status, exitCode, … }`"
 * (design/06 §6.1) — including for a usage error, a config error and an unexpected throw.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ConfigError, loadConfig, resolveConfig, STRIP_TYPES_MARKER, type ResolvedConfig } from "../config/load.js";
import { ENGINE } from "../plan/plan.js";
import { bool, list, parseArgs, renderOptions, str, type OptionSpec, type ParseResult } from "./args.js";
import { APPLY_OPTIONS, runApply } from "./commands/apply.js";
import { BASELINE_OPTIONS, runBaseline } from "./commands/baseline.js";
import { STATUS_OPTIONS, runStatus } from "./commands/status.js";
import { UNLOCK_OPTIONS, runUnlock } from "./commands/unlock.js";
import { EXIT, type ExitCode } from "./exit.js";
import { nowIso, render, type CommandOutput, type OutputFormat } from "./output.js";

export interface CliIo {
  readonly stdout: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** the script path a type-stripping re-exec must re-run */
  readonly entry: string;
}

const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  { name: "config", type: "string", placeholder: "path", describe: "path to pg-prime.config.ts", defaultText: "the nearest one at or above the cwd" },
  { name: "url", type: "string", placeholder: "url", describe: "postgres:// connection URL; overrides the config file" },
  { name: "migrations", type: "string", placeholder: "dir", describe: "the migrations directory", defaultText: "./migrations" },
  { name: "schema", type: "string", placeholder: "name", repeatable: true, describe: "a managed schema; repeatable", defaultText: "public" },
  { name: "output", type: "string", placeholder: "text|json", describe: "output format", defaultText: "text" },
  { name: "help", type: "boolean", describe: "print this help" },
  { name: "version", type: "boolean", describe: "print the version" },
];

interface Command {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  readonly options: readonly OptionSpec[];
  readonly exits: string;
  readonly run: (config: ResolvedConfig, argv: ParseResult) => Promise<CommandOutput>;
}

const COMMANDS: readonly Command[] = [
  {
    name: "apply",
    aliases: ["deploy"],
    summary: "apply pending migrations (design/06 §5). Never generates, never introspects the desired state.",
    options: APPLY_OPTIONS,
    exits: "0 applied or nothing to do · 1 error · 4 drift · 6 lock unavailable",
    run: runApply,
  },
  {
    name: "status",
    aliases: [],
    summary: "applied vs pending, current fingerprint, stale locks, partially-applied rows. Read-only.",
    options: STATUS_OPTIONS,
    exits: "0 up to date · 4 drift · 5 pending",
    run: runStatus,
  },
  {
    name: "baseline",
    aliases: [],
    summary: "adopt an existing database: write 0000_baseline.sql + .plan.json and record it without executing it.",
    options: BASELINE_OPTIONS,
    exits: "0 · 1",
    run: runBaseline,
  },
  {
    name: "unlock",
    aliases: [],
    summary: "inspect or break a stale migration lease.",
    options: UNLOCK_OPTIONS,
    exits: "0 free, stale or released · 6 a live deploy holds it",
    run: runUnlock,
  },
];

/** Round 2 of design/11. Named here so `--help` does not pretend they do not exist. */
const LATER: readonly (readonly [string, string])[] = [
  ["generate", "K2b — build a migration from the TypeScript schema"],
  ["check", "K2b — the default CI gate"],
  ["verify", "K2b — replay from empty and assert an empty diff"],
  ["lint", "K2b — run the design/06 §3.4 rules"],
  ["push --dev", "K2b — apply the diff directly, dev loop only"],
  ["doctor", "K2b — read-only health report"],
  ["checkpoint", "K4 — write a full-schema checkpoint"],
];

function version(): string {
  try {
    const text = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(text) as { version?: unknown };
    if (typeof parsed.version === "string") return parsed.version;
  } catch {
    /* running from a tree without a package.json beside dist/ */
  }
  return ENGINE.version;
}

function rootHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    "pg-prime — PostgreSQL schema migrations",
    "",
    "Usage: pg-prime migrate <command> [options]",
    "",
    "Commands:",
    ...COMMANDS.map((c) => `  migrate ${c.name.padEnd(width)}  ${c.summary}`),
    "",
    "Not in this release:",
    ...LATER.map(([n, why]) => `  migrate ${n.padEnd(width)}  ${why}`),
    "",
    "Global options:",
    renderOptions(GLOBAL_OPTIONS),
    "",
    "Exit codes (design/06 §6.1, uniform across every command):",
    "  0 success or nothing to do   1 error   2 missing hints   3 lint",
    "  4 drift                      5 pending 6 lock unavailable  7 proof failed",
    "",
    `Version ${version()}`,
  ].join("\n");
}

function commandHelp(c: Command): string {
  return [
    `pg-prime migrate ${c.name}${c.aliases.length ? ` (alias: ${c.aliases.join(", ")})` : ""}`,
    "",
    `  ${c.summary}`,
    "",
    "Options:",
    renderOptions([...c.options, ...GLOBAL_OPTIONS]),
    "",
    `Exit: ${c.exits}`,
  ].join("\n");
}

function migrateHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    "pg-prime migrate <command> [options]",
    "",
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    "",
    "Run `pg-prime migrate <command> --help` for a command's options.",
  ].join("\n");
}

function fail(command: string, code: ExitCode, errCode: string, message: string): CommandOutput {
  return {
    exitCode: code,
    envelope: {
      command,
      status: "error",
      exitCode: code,
      at: nowIso(),
      durationMs: 0,
      error: { code: errCode, message },
    },
    text: `${message}`,
  };
}

export async function main(argv: readonly string[], io: Partial<CliIo> = {}): Promise<number> {
  const out = io.stdout ?? ((s: string): void => void process.stdout.write(s));
  const err = io.stderr ?? ((s: string): void => void process.stderr.write(s));
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const entry = io.entry ?? process.argv[1] ?? "";

  // Routing is POSITIONAL and happens before parsing: the command words are the leading
  // tokens (`pg-prime migrate apply --flags`, the git/docker/npm convention). Sniffing
  // them out of the whole argv instead would read `--url postgres://x` as a command.
  const noun = argv[0]?.startsWith("-") === false ? argv[0] : undefined;
  const verb = noun !== undefined && argv[1]?.startsWith("-") === false ? argv[1] : undefined;
  const wantsHelp = argv.includes("--help") || argv.includes("-h");
  // The one flag that has to be read before the parser exists: an envelope on stdout is
  // the contract even when the argv that asked for it was itself wrong.
  const outputAt = argv.indexOf("--output");
  const earlyFormat: OutputFormat =
    argv.includes("--output=json") || (outputAt !== -1 && argv[outputAt + 1] === "json") ? "json" : "text";
  const emit = (o: CommandOutput, format: OutputFormat): number => {
    if (format === "json") out(render(o, "json"));
    else if (o.exitCode === EXIT.ok) out(render(o, "text"));
    else err(render(o, "text"));
    return o.exitCode;
  };

  if (argv.includes("--version")) {
    out(`${version()}\n`);
    return EXIT.ok;
  }
  if (noun === undefined) {
    if (argv.length === 0 || wantsHelp) {
      out(`${rootHelp()}\n`);
      return EXIT.ok;
    }
    return emit(fail("pg-prime", EXIT.error, "usage", `expected a command before ${JSON.stringify(argv[0])}. Try \`pg-prime --help\`.`), earlyFormat);
  }
  if (noun !== "migrate") {
    return emit(fail("pg-prime", EXIT.error, "usage", `unknown command ${JSON.stringify(noun)}. Try \`pg-prime --help\`.`), earlyFormat);
  }
  if (verb === undefined) {
    if (wantsHelp) {
      out(`${migrateHelp()}\n`);
      return EXIT.ok;
    }
    return emit(fail("migrate", EXIT.error, "usage", `pg-prime migrate needs a command: ${COMMANDS.map((c) => c.name).join(", ")}.`), earlyFormat);
  }

  const command = COMMANDS.find((c) => c.name === verb || c.aliases.includes(verb));
  if (!command) {
    return emit(fail("migrate", EXIT.error, "usage", `unknown command \`migrate ${verb}\`: ${COMMANDS.map((c) => c.name).join(", ")}.`), earlyFormat);
  }

  const specs = [...command.options, ...GLOBAL_OPTIONS];
  const parsed = parseArgs(argv.slice(2), specs);
  const requested = str(parsed.values, "output");
  const format: OutputFormat = requested === "json" ? "json" : "text";
  const label = `migrate ${command.name}`;

  if (bool(parsed.values, "help")) {
    out(`${commandHelp(command)}\n`);
    return EXIT.ok;
  }
  if (parsed.errors.length > 0) {
    return emit(fail(label, EXIT.error, "usage", parsed.errors.join("; ")), format);
  }
  if (requested !== undefined && requested !== "text" && requested !== "json") {
    return emit(fail(label, EXIT.error, "usage", `--output must be text or json, received ${JSON.stringify(requested)}`), format);
  }

  try {
    const loaded = await loadConfig(str(parsed.values, "config"), cwd);
    const config = resolveConfig({
      config: loaded.config,
      configFile: loaded.file,
      url: str(parsed.values, "url"),
      migrations: str(parsed.values, "migrations"),
      schemas: list(parsed.values, "schema"),
      cwd,
      env,
    });
    return emit(await command.run(config, parsed), format);
  } catch (error) {
    if (error instanceof ConfigError && error.retryWithStripTypes && env[STRIP_TYPES_MARKER] === undefined) {
      // design/11 §1.4: ONE guarded re-exec. The marker is what guards it — without it a
      // Node that cannot strip types at all would fork forever.
      const child = spawnSync(process.execPath, ["--experimental-strip-types", entry, ...argv], {
        stdio: "inherit",
        env: { ...env, [STRIP_TYPES_MARKER]: "1" },
      });
      return child.status ?? EXIT.error;
    }
    return emit(
      fail(
        label,
        EXIT.error,
        error instanceof ConfigError ? "config" : "internal",
        error instanceof Error ? error.message : String(error),
      ),
      format,
    );
  }
}
