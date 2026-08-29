/**
 * R17 — CLI tests go through `bin`, not through the command functions.
 *
 * Every case here spawns `node dist/cli.js …`, asserts the exit code against design/06
 * §6.1's table, and matches the parsed `--output json` envelope against a committed
 * golden with `test/cli/_mask.ts`'s documented field list applied. Nothing calls
 * `runApply` / `runStatus` / … directly: argv parsing, config resolution, envelope
 * rendering and the exit code are all part of the contract and all of them live between
 * a command function and a shell.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { withClient } from "../../src/db/pg.js";
import { readMigrationRows, takeLease } from "../../src/history/store.js";
import { ensureHistory } from "../../src/history/schema.js";
import { osUser } from "../../src/plan/plan.js";
import { envelopeOf, runCli, urlOf } from "../support/cli.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { emptyMigrations, migrationsFixture } from "./_fixture.js";
import { golden } from "./_mask.js";

const T = 120_000;

const expectGolden = async (name: string, envelope: unknown): Promise<void> => {
  await expect(golden(envelope)).toMatchFileSnapshot(`./golden/${name}.json`);
};

describe("the JSON envelope, through the binary", () => {
  const databases: string[] = [];
  let dir = "";
  let empty = "";

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    dir = (await migrationsFixture("env")).dir;
    empty = (await emptyMigrations("env-empty")).dir;
  }, T);

  afterAll(async () => {
    for (const d of databases) await destroyDatabase(d).catch(() => undefined);
  }, T);

  const fresh = async (name: string): Promise<string> => {
    const database = `pgprime_k1_cli_${name}`;
    databases.push(database);
    await makeDatabase(database);
    return urlOf(dbConn(database));
  };

  it(
    "status against an empty database with no migrations: exit 0",
    async () => {
      const url = await fresh("status_empty");
      const r = await runCli(["migrate", "status", "--url", url, "--migrations", empty, "--output", "json"]);
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.ok);
      const envelope = envelopeOf(r);
      expect(envelope["status"]).toBe("up_to_date");
      expect((envelope["history"] as { present: boolean }).present).toBe(false);
      await expectGolden("status.empty", envelope);

      // design/12 F2 item i — the human-readable line said "0 pendings". `pending` is the
      // state a migration is in, not a countable noun, and no count makes it one.
      const text = await runCli(["migrate", "status", "--url", url, "--migrations", empty]);
      expect(text.code).toBe(EXIT.ok);
      expect(text.stdout).toContain("0 files, 0 pending");
      expect(text.stdout).not.toContain("pendings");
    },
    T,
  );

  it(
    "status with two pending migrations: exit 5",
    async () => {
      const url = await fresh("status_pending");
      const r = await runCli(["migrate", "status", "--url", url, "--migrations", dir, "--output", "json"]);
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.pending);
      const envelope = envelopeOf(r);
      expect(envelope["status"]).toBe("pending");
      await expectGolden("status.pending", envelope);
    },
    T,
  );

  it(
    "apply --dry-run prints the exact statement stream and writes nothing",
    async () => {
      const url = await fresh("dry_run");
      const r = await runCli([
        "migrate",
        "apply",
        "--url",
        url,
        "--migrations",
        dir,
        "--applied-from",
        "k1-golden",
        "--dry-run",
        "--output",
        "json",
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.ok);
      const envelope = envelopeOf(r);
      expect(envelope["status"]).toBe("dry_run");
      // The framing design/06 §6.2 asks for, verbatim in the golden: BEGIN/COMMIT, the
      // set_config calls, the history INSERT inside the transaction, and the §5.4
      // statement_uncertain bookkeeping for the `txmode none` file.
      const stream = (envelope["stream"] as { text: string }[]).map((q) => q.text);
      // 1 for the transactional file (which carries its own history INSERT), and 4 for
      // the two bookkeeping transactions §5.4 wraps around each of the bare file's two
      // statements.
      expect(stream.filter((t) => t === "BEGIN")).toHaveLength(5);
      expect(stream.filter((t) => t === "COMMIT")).toHaveLength(5);
      expect(stream.some((t) => t.startsWith("INSERT INTO pgprime.migrations"))).toBe(true);
      expect(stream.some((t) => t.includes("statement_uncertain = $2"))).toBe(true);
      await expectGolden("apply.dry-run", envelope);

      // Nothing was created, not even the history schema, and no lock was taken.
      const after = await runCli(["migrate", "status", "--url", url, "--migrations", dir, "--output", "json"]);
      expect((envelopeOf(after)["history"] as { present: boolean }).present).toBe(false);
      expect((envelope["lock"] as { acquired: boolean }).acquired).toBe(false);
    },
    T,
  );

  it(
    "apply, then status, then apply again",
    async () => {
      const url = await fresh("apply");
      const applied = await runCli([
        "migrate",
        "apply",
        "--url",
        url,
        "--migrations",
        dir,
        "--applied-from",
        "k1-golden",
        "--output",
        "json",
      ]);
      expect(applied.code, applied.stdout + applied.stderr).toBe(EXIT.ok);
      const first = envelopeOf(applied);
      expect(first["status"]).toBe("applied");
      await expectGolden("apply.applied", first);

      const status = await runCli(["migrate", "status", "--url", url, "--migrations", dir, "--output", "json"]);
      expect(status.code).toBe(EXIT.ok);
      await expectGolden("status.applied", envelopeOf(status));

      const again = await runCli([
        "migrate",
        "apply",
        "--url",
        url,
        "--migrations",
        dir,
        "--applied-from",
        "k1-golden",
        "--output",
        "json",
      ]);
      expect(again.code).toBe(EXIT.ok);
      const second = envelopeOf(again);
      expect(second["status"]).toBe("up_to_date");
      await expectGolden("apply.up-to-date", second);
    },
    T,
  );

  it(
    "unlock on a free lock, and on a stale lease",
    async () => {
      const url = await fresh("unlock");
      const conn = dbConn(`pgprime_k1_cli_unlock`);

      const free = await runCli(["migrate", "unlock", "--url", url, "--output", "json"]);
      expect(free.code).toBe(EXIT.ok);
      expect(envelopeOf(free)["status"]).toBe("no_lock");
      await expectGolden("unlock.free", envelopeOf(free));

      await withClient(conn, async (c) => {
        await ensureHistory(c);
        await takeLease(c, "00000000-0000-4000-8000-000000000001", "ghost:1");
      });

      // A lease that is fresh but whose backend is gone reads as "held" — the runner has
      // no way to tell those apart until it goes stale, and saying so is the point.
      const held = await runCli(["migrate", "unlock", "--url", url, "--output", "json"]);
      expect(held.code).toBe(EXIT.locked);
      expect(envelopeOf(held)["status"]).toBe("held");

      const stale = await runCli(["migrate", "unlock", "--url", url, "--stale-lock-after", "0ms", "--output", "json"]);
      expect(stale.code).toBe(EXIT.ok);
      expect(envelopeOf(stale)["status"]).toBe("stale");

      const broken = await runCli(["migrate", "unlock", "--url", url, "--force", "--output", "json"]);
      expect(broken.code).toBe(EXIT.ok);
      const envelope = envelopeOf(broken);
      expect(envelope["status"]).toBe("released");
      expect(envelope["released"]).toBe(true);
      await expectGolden("unlock.released", envelope);

      const after = await runCli(["migrate", "unlock", "--url", url, "--output", "json"]);
      expect(envelopeOf(after)["status"]).toBe("no_lock");
    },
    T,
  );

  it(
    "baseline writes 0000_baseline and records it without executing it",
    async () => {
      const url = await fresh("baseline");
      const conn = dbConn("pgprime_k1_cli_baseline");
      const outDir = (await emptyMigrations("baseline-out")).dir;
      await withClient(conn, (c) =>
        c.query("CREATE TABLE public.adopted (id bigint PRIMARY KEY, tag text NOT NULL DEFAULT 'x')"),
      );

      const r = await runCli([
        "migrate",
        "baseline",
        "--url",
        url,
        "--migrations",
        outDir,
        "--by",
        "k1",
        "--output",
        "json",
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.ok);
      const envelope = envelopeOf(r);
      expect(envelope["status"]).toBe("baselined");
      await expectGolden("baseline.baselined", envelope);

      const rows = await withClient(conn, readMigrationRows);
      expect(rows.map((x) => [x.id, x.status])).toEqual([["0000_baseline", "baselined"]]);

      // Nothing pending afterwards, and a second baseline is refused.
      const status = await runCli(["migrate", "status", "--url", url, "--migrations", outDir, "--output", "json"]);
      expect(status.code).toBe(EXIT.ok);
      const refused = await runCli(["migrate", "baseline", "--url", url, "--migrations", outDir, "--output", "json"]);
      expect(refused.code).toBe(EXIT.error);
      const refusal = envelopeOf(refused);
      expect(refusal["status"]).toBe("refused");
      // design/12 F2 item i: exactly one row, and the verb agrees with it. `error.message`
      // is masked in the golden (it embeds paths), so the sentence is asserted here.
      expect((refusal["error"] as { message: string }).message).toContain("1 row already exists in pgprime.migrations");
      await expectGolden("baseline.refused", refusal);

      // …and the plan records the author the flag named.
      const plan = JSON.parse(await readFile(join(outDir, "0000_baseline.plan.json"), "utf8")) as {
        generated: { by: string };
      };
      expect(plan.generated.by).toBe("k1");
    },
    T,
  );

  /**
   * design/12 F2 item g. Every `--by` in the CLI has advertised `default $USER` since K1 and
   * nothing read it: `buildPlan` recorded the literal `"spike"`, so every acknowledgement in
   * every repository was signed by a word from a spike branch.
   */
  it(
    "--by defaults to the OS user, which is what the help text has always claimed",
    async () => {
      const url = await fresh("by");
      const outDir = (await emptyMigrations("by-out")).dir;
      await withClient(dbConn("pgprime_k1_cli_by"), (c) =>
        c.query("CREATE TABLE public.signed (id bigint PRIMARY KEY)"),
      );

      const r = await runCli(["migrate", "baseline", "--url", url, "--migrations", outDir, "--output", "json"], {
        USER: "f2-os-user",
        USERNAME: "f2-os-user",
      });
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.ok);
      const plan = JSON.parse(await readFile(join(outDir, "0000_baseline.plan.json"), "utf8")) as {
        generated: { by: string };
      };
      expect(plan.generated.by).toBe("f2-os-user");
    },
    T,
  );

  it("osUser: the environment, then the passwd entry, then `unknown` — never a placeholder", () => {
    expect(osUser({ USER: "shell-user", USERNAME: "windows-user" })).toBe("shell-user");
    expect(osUser({ USERNAME: "windows-user" })).toBe("windows-user");
    // No environment at all: this process has a passwd entry, so the answer is a real name
    // and it is never the empty string or the old `"spike"`.
    const fromPasswd = osUser({});
    expect(fromPasswd).not.toBe("");
    expect(fromPasswd).not.toBe("spike");
    // An empty variable is not an answer — it is an unset one that got exported.
    expect(osUser({ USER: "  " })).toBe(fromPasswd);
  });
});
