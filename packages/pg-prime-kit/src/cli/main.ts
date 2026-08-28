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
import { CHECK_OPTIONS, runCheck } from "./commands/check.js";
import { CHECKPOINT_OPTIONS, runCheckpoint } from "./commands/checkpoint.js";
import { DOCTOR_OPTIONS, runDoctor } from "./commands/doctor.js";
import { GENERATE_OPTIONS, runGenerate } from "./commands/generate.js";
import { LINT_OPTIONS, runLint } from "./commands/lint.js";
import { PULL_OPTIONS, runPull } from "./commands/pull.js";
import { PUSH_OPTIONS, runPush } from "./commands/push.js";
import { SEED_OPTIONS, runSeedCommand } from "./commands/seed.js";
import { STATUS_OPTIONS, runStatus } from "./commands/status.js";
import { UNLOCK_OPTIONS, runUnlock } from "./commands/unlock.js";
import { VERIFY_OPTIONS, runVerify } from "./commands/verify.js";
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
  /**
   * The noun this command hangs off: `migrate <name>`, `db <name>`, or — when it is
   * `null` — the bare `pg-prime <name>`.
   *
   * design/06 §6.2 lists ten commands under `migrate`, `db seed` on its own, and `pull` is
   * the twelfth. `db seed` is not a migration (nothing is recorded) and `pull` is not one
   * either (it reads a database and writes TypeScript), so neither belongs under the
   * `migrate` noun. Defaults to `migrate`.
   */
  readonly noun?: "migrate" | "db" | null;
  /**
   * `false` for the one command that is a pure function of files. `resolveConfig` then
   * returns a placeholder connection and `ResolvedConfig.hasConnection` is false, so
   * `migrate lint db/migrations/0001_x.sql` works in a repository with no `DATABASE_URL`.
   */
  readonly needsConnection?: boolean;
  readonly run: (config: ResolvedConfig, argv: ParseResult) => Promise<CommandOutput>;
}

const COMMANDS: readonly Command[] = [
  {
    name: "generate",
    aliases: [],
    summary: "build a migration from the TypeScript schema: diff, order, lock-safe rewrite, prove, write.",
    options: GENERATE_OPTIONS,
    exits: "0 written or nothing to do · 1 error · 2 a rename or data-loss decision is missing · 3 lint · 7 proof failed",
    run: runGenerate,
  },
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
    name: "check",
    aliases: [],
    summary: "the default CI gate: is the repository consistent with the schema, the checksums and the database? No history writes.",
    options: CHECK_OPTIONS,
    exits: "0 ok · 1 error · 2 missing hints · 3 lint · 4 the schema changed and no migration was generated · 5 pending",
    run: runCheck,
  },
  {
    name: "verify",
    aliases: [],
    summary: "replay every migration from empty into an ephemeral database and assert the result matches the schema.",
    options: VERIFY_OPTIONS,
    exits: "0 verified · 1 error or no ephemeral database available · 4 non-empty diff",
    run: runVerify,
  },
  {
    name: "lint",
    aliases: [],
    summary: "run the design/06 §3.4 rules over generated or hand-written SQL. Defaults to the unapplied migrations.",
    options: LINT_OPTIONS,
    exits: "0 clean · 1 usage · 3 a finding at or above --fail-on",
    needsConnection: false,
    run: runLint,
  },
  {
    name: "push",
    aliases: [],
    summary: "DEV ONLY: apply the diff directly, writing no files and no history rows. Requires the literal --dev.",
    options: PUSH_OPTIONS,
    exits: "0 pushed or nothing to do · 1 refused or failed · 2 a decision is missing",
    run: runPush,
  },
  {
    name: "doctor",
    aliases: [],
    summary: "read-only health report: INVALID indexes, _ccnew leftovers, NOT VALID constraints, drift, stale leases, orphaned repeatables.",
    options: DOCTOR_OPTIONS,
    exits: "0 healthy · 4 findings",
    run: runDoctor,
  },
  {
    name: "unlock",
    aliases: [],
    summary: "inspect or break a stale migration lease.",
    options: UNLOCK_OPTIONS,
    exits: "0 free, stale or released · 6 a live deploy holds it",
    run: runUnlock,
  },
  {
    name: "checkpoint",
    aliases: [],
    summary: "write a full-schema checkpoint a fresh database jumps to; existing ones ignore it. Nothing is deleted.",
    options: CHECKPOINT_OPTIONS,
    exits: "0 written or nothing to do · 1 error",
    run: runCheckpoint,
  },
  {
    name: "seed",
    aliases: [],
    noun: "db",
    summary: "run seeds/*.sql and seeds/*.ts. Never recorded in the migration history; refuses on production.",
    options: SEED_OPTIONS,
    exits: "0 seeded or nothing to do · 1 refused or failed",
    run: runSeedCommand,
  },
  {
    name: "pull",
    aliases: [],
    noun: null,
    summary: "introspect the database and write a deterministic TypeScript schema file plus sql/ repeatables.",
    options: PULL_OPTIONS,
    exits: "0 written · 1 error",
    run: runPull,
  },
];

const NOUNS: readonly string[] = ["migrate", "db"];
const bare = (c: Command): boolean => c.noun === null;
const under = (noun: string): Command[] => COMMANDS.filter((c) => (c.noun ?? "migrate") === noun);
const spell = (c: Command): string => (c.noun === null ? c.name : `${c.noun ?? "migrate"} ${c.name}`);

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
  const width = Math.max(...COMMANDS.map((c) => spell(c).length));
  return [
    "pg-prime — PostgreSQL schema migrations",
    "",
    "Usage: pg-prime <command> [options]",
    "",
    "Commands:",
    ...COMMANDS.map((c) => `  ${spell(c).padEnd(width)}  ${c.summary}`),
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
    `pg-prime ${spell(c)}${c.aliases.length ? ` (alias: ${c.aliases.join(", ")})` : ""}`,
    "",
    `  ${c.summary}`,
    "",
    "Options:",
    renderOptions([...c.options, ...GLOBAL_OPTIONS]),
    "",
    `Exit: ${c.exits}`,
  ].join("\n");
}

function nounHelp(noun: string): string {
  const commands = under(noun);
  const width = Math.max(...commands.map((c) => c.name.length));
  return [
    `pg-prime ${noun} <command> [options]`,
    "",
    ...commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    "",
    `Run \`pg-prime ${noun} <command> --help\` for a command's options.`,
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

  // Routing is positional and one token deep: `pull` is a command of its own, `migrate`
  // and `db` are nouns whose next token is the command. A bare command name is checked
  // FIRST so that a future noun and a command can never both claim one word silently.
  let command: Command | undefined;
  let skip = 1;
  const bareMatch = COMMANDS.find((c) => bare(c) && (c.name === noun || c.aliases.includes(noun)));
  if (bareMatch) {
    command = bareMatch;
  } else {
    if (!NOUNS.includes(noun)) {
      return emit(
        fail(
          "pg-prime",
          EXIT.error,
          "usage",
          `unknown command ${JSON.stringify(noun)}: ${[...NOUNS, ...COMMANDS.filter(bare).map((c) => c.name)].join(", ")}. Try \`pg-prime --help\`.`,
        ),
        earlyFormat,
      );
    }
    if (verb === undefined) {
      if (wantsHelp) {
        out(`${nounHelp(noun)}\n`);
        return EXIT.ok;
      }
      return emit(
        fail(noun, EXIT.error, "usage", `pg-prime ${noun} needs a command: ${under(noun).map((c) => c.name).join(", ")}.`),
        earlyFormat,
      );
    }
    command = under(noun).find((c) => c.name === verb || c.aliases.includes(verb));
    if (!command) {
      return emit(
        fail(noun, EXIT.error, "usage", `unknown command \`${noun} ${verb}\`: ${under(noun).map((c) => c.name).join(", ")}.`),
        earlyFormat,
      );
    }
    skip = 2;
  }

  const specs = [...command.options, ...GLOBAL_OPTIONS];
  const parsed = parseArgs(argv.slice(skip), specs);
  const requested = str(parsed.values, "output");
  const format: OutputFormat = requested === "json" ? "json" : "text";
  const label = spell(command);

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
      requireConnection: command.needsConnection !== false,
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
