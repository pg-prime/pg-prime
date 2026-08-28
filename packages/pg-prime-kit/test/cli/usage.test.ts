/**
 * argv, help and the exit table — through the binary.
 *
 * The rule this file protects is the one that makes a mis-typed flag safe: an unknown
 * option is an ERROR, never a positional. `pg-prime migrate apply --dryrun` must not
 * apply anything.
 */

import { describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { parseArgs, parseDuration, type OptionSpec } from "../../src/cli/args.js";
import { runCli } from "../support/cli.js";

describe("parseArgs", () => {
  const specs: readonly OptionSpec[] = [
    { name: "to", type: "string", describe: "" },
    { name: "dry-run", type: "boolean", describe: "" },
    { name: "lock-wait", type: "duration", describe: "" },
    { name: "schema", type: "string", repeatable: true, describe: "" },
  ];

  it("takes `--flag value`, `--flag=value`, `--no-flag` and `--`", () => {
    const r = parseArgs(["--to", "0007", "--dry-run", "--lock-wait=45s", "--schema", "a", "--schema", "b", "--", "tail"], specs);
    expect(r.errors).toEqual([]);
    expect(r.values).toEqual({ to: "0007", "dry-run": true, "lock-wait": 45_000, schema: ["a", "b"] });
    expect(r.positionals).toEqual(["tail"]);
    expect(parseArgs(["--no-dry-run"], specs).values).toEqual({ "dry-run": false });
  });

  it("an unknown option is an error, not a positional", () => {
    expect(parseArgs(["--dryrun"], specs).errors).toEqual(["unknown option --dryrun"]);
    expect(parseArgs(["--to"], specs).errors).toEqual(["--to needs a value"]);
    expect(parseArgs(["--lock-wait", "soon"], specs).errors[0]).toContain("is not a duration");
  });

  it("parses the duration spellings the flags document", () => {
    expect([parseDuration("500"), parseDuration("500ms"), parseDuration("30s"), parseDuration("2m"), parseDuration("1h")]).toEqual([
      500, 500, 30_000, 120_000, 3_600_000,
    ]);
    expect(parseDuration("later")).toBeNull();
  });
});

describe("the binary's usage surface", () => {
  it("prints root help on --help and on no arguments, both exit 0", async () => {
    for (const argv of [[], ["--help"]]) {
      const r = await runCli(argv);
      expect(r.code).toBe(EXIT.ok);
      expect(r.stdout).toContain("Usage: pg-prime <command> [options]");
      expect(r.stdout).toContain("Exit codes (design/06 §6.1");
    }
  });

  it("prints a help page for `migrate` and for each of its eleven commands", async () => {
    const migrate = await runCli(["migrate", "--help"]);
    expect(migrate.code).toBe(EXIT.ok);
    for (const name of [
      "generate", "apply", "status", "baseline", "check", "verify", "lint", "push", "doctor", "unlock",
      "checkpoint",
    ]) {
      expect(migrate.stdout).toContain(name);
      const r = await runCli(["migrate", name, "--help"]);
      expect(r.code, r.stderr).toBe(EXIT.ok);
      expect(r.stdout).toContain(`pg-prime migrate ${name}`);
      expect(r.stdout).toContain("Exit:");
      expect(r.stdout).toContain("--output <text|json>");
    }
  });

  it("`db seed` and `pull` are their own verbs, not migrate ones (design/06 §6.2)", async () => {
    const db = await runCli(["db", "--help"]);
    expect(db.code).toBe(EXIT.ok);
    expect(db.stdout).toContain("pg-prime db <command>");
    expect(db.stdout).toContain("seed");

    const seed = await runCli(["db", "seed", "--help"]);
    expect(seed.code, seed.stderr).toBe(EXIT.ok);
    expect(seed.stdout).toContain("pg-prime db seed");
    expect(seed.stdout).toContain("--set <name>");

    const pull = await runCli(["pull", "--help"]);
    expect(pull.code, pull.stderr).toBe(EXIT.ok);
    expect(pull.stdout).toContain("pg-prime pull");
    expect(pull.stdout).toContain("--out <file>");

    // …and neither is reachable under `migrate`, which is what makes them their own verbs.
    const wrong = await runCli(["migrate", "seed"]);
    expect(wrong.code).toBe(EXIT.error);
    expect(wrong.stderr).toContain("unknown command `migrate seed`");
  });

  it("--version prints something semver-shaped", async () => {
    const r = await runCli(["--version"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("lists design/06 §6.2's twelve commands plus `pull`, and no 'not in this release' section", async () => {
    const r = await runCli(["--help"]);
    for (const command of [
      "migrate generate", "migrate apply", "migrate status", "migrate baseline", "migrate check",
      "migrate verify", "migrate lint", "migrate push", "migrate doctor", "migrate unlock",
      "migrate checkpoint", "db seed", "pull",
    ]) {
      expect(r.stdout, `root help should list ${command}`).toContain(command);
    }
    // design/06 §6.4 is twelve of twelve, so the list of what is missing is now empty and
    // the heading that introduced it is gone rather than left over an empty list.
    expect(r.stdout).not.toContain("Not in this release:");
    expect(r.stdout).toContain("migrate generate    build a migration from the TypeScript schema");
  });

  it("a missing or unknown command exits 1", async () => {
    const bare = await runCli(["migrate"]);
    expect(bare.code).toBe(EXIT.error);
    expect(bare.stderr).toContain("needs a command");

    const unknown = await runCli(["migrate", "sprint"]);
    expect(unknown.code).toBe(EXIT.error);
    expect(unknown.stderr).toContain("unknown command `migrate sprint`");

    const wrongNoun = await runCli(["migrations", "apply"]);
    expect(wrongNoun.code).toBe(EXIT.error);
    expect(wrongNoun.stderr).toContain('unknown command "migrations"');
  });

  it("an unknown flag exits 1 and never reaches the database", async () => {
    const r = await runCli(["migrate", "apply", "--dryrun", "--url", "postgres://u:p@127.0.0.1:1/x"]);
    expect(r.code).toBe(EXIT.error);
    expect(r.stderr).toContain("unknown option --dryrun");
  });

  it("--output json puts even a usage error on stdout as an envelope", async () => {
    const r = await runCli(["migrate", "apply", "--dryrun", "--output", "json"]);
    expect(r.code).toBe(EXIT.error);
    const envelope = JSON.parse(r.stdout) as { command: string; status: string; exitCode: number; error: { code: string } };
    expect(envelope).toMatchObject({ command: "migrate apply", status: "error", exitCode: 1, error: { code: "usage" } });
  });

  it("--output json is honoured even when the argv that asked for it names no command", async () => {
    const r = await runCli(["migrate", "--output", "json"]);
    expect(r.code).toBe(EXIT.error);
    expect((JSON.parse(r.stdout) as { error: { code: string } }).error.code).toBe("usage");
  });

  it("`deploy` is an alias for `apply`", async () => {
    const r = await runCli(["migrate", "deploy", "--help"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("pg-prime migrate apply (alias: deploy)");
  });

  it("a bad --output value is a usage error", async () => {
    const r = await runCli(["migrate", "status", "--output", "yaml"]);
    expect(r.code).toBe(EXIT.error);
    expect(r.stderr).toContain("--output must be text or json");
  });
});
