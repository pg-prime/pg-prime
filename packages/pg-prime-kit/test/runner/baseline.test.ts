/**
 * `migrate baseline` — design/06 §6.2 and design/11 §1.9.
 *
 * The claim worth proving is §1.9's: "A baselined database is therefore reproducible from
 * the repo." So the test does not stop at "a file was written"; it applies the written
 * baseline to a *different, empty* database and asserts the two fingerprints are equal.
 * That is `verify`'s replay property, one migration early, and PostgreSQL is the oracle
 * on both sides.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { withClient } from "../../src/db/pg.js";
import { readMigrationRows } from "../../src/history/store.js";
import { applyPending } from "../../src/runner/run.js";
import { migrationStatus } from "../../src/runner/status.js";
import { emptyMigrations } from "../cli/_fixture.js";
import { envelopeOf, runCli, urlOf } from "../support/cli.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { fingerprintOf, generateChain, type Chain } from "../support/migrations.js";

const T = 180_000;

describe("baseline", () => {
  const databases: string[] = [];

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
  }, T);

  afterAll(async () => {
    for (const d of databases) await destroyDatabase(d).catch(() => undefined);
  });

  const fresh = async (name: string, fixture?: string): Promise<string> => {
    const database = `pgprime_k1_bl_${name}`;
    databases.push(database);
    await makeDatabase(database, fixture);
    return database;
  };

  it(
    "the written 0000_baseline reproduces the adopted schema on an empty database",
    async () => {
      const adopted = await fresh("adopted", "evolve/desired.sql");
      const replayed = await fresh("replayed");
      const dir = (await emptyMigrations("bl-out")).dir;

      const r = await runCli([
        "migrate",
        "baseline",
        "--url",
        urlOf(dbConn(adopted)),
        "--migrations",
        dir,
        "--output",
        "json",
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.ok);
      const envelope = envelopeOf(r);
      const migration = envelope["migration"] as {
        statements: number;
        fingerprint: string;
        proof: { status: string; reason: string };
      };
      expect(migration.proof).toMatchObject({ status: "skipped", reason: "baseline" });
      expect(migration.statements).toBeGreaterThan(0);

      /* It was recorded, not executed: the row is `baselined` and nothing changed. */
      const rows = await withClient(dbConn(adopted), readMigrationRows);
      expect(rows.map((x) => [x.id, x.status, x.statementsApplied === x.statementsTotal])).toEqual([
        ["0000_baseline", "baselined", true],
      ]);
      expect(rows[0]!.fingerprintTo).toBe(migration.fingerprint);
      expect(await fingerprintOf(dbConn(adopted))).toBe(migration.fingerprint);

      /* The plan's `from` is the empty IR, so the file replays from empty. */
      const plan = JSON.parse(await readFile(join(dir, "0000_baseline.plan.json"), "utf8")) as {
        from: { fingerprint: string };
        proof: { status: string; reason: string };
      };
      expect(plan.proof).toEqual({
        status: "skipped",
        reason: "baseline",
        at: expect.any(String) as unknown as string,
      });

      /* Replay: apply it to an empty database and compare catalogs. */
      const applied = await applyPending(dbConn(replayed), dir);
      expect(applied.error, JSON.stringify(applied.error)).toBeNull();
      expect(applied.status).toBe("applied");
      expect(await fingerprintOf(dbConn(replayed))).toBe(migration.fingerprint);

      /* And `status` on the adopted database has nothing pending. */
      const report = await migrationStatus(dbConn(adopted), dir);
      expect(report.status).toBe("up_to_date");
      expect(report.migrations.map((m) => [m.id, m.state, m.checksumOk])).toEqual([
        ["0000_baseline", "baselined", true],
      ]);
    },
    T,
  );

  it(
    "refuses a database that already has history, unless --force",
    async () => {
      const database = await fresh("occupied");
      const dir = (await emptyMigrations("bl-occupied")).dir;
      const url = urlOf(dbConn(database));

      expect((await runCli(["migrate", "baseline", "--url", url, "--migrations", dir, "--output", "json"])).code).toBe(
        EXIT.ok,
      );

      const refused = await runCli(["migrate", "baseline", "--url", url, "--migrations", dir, "--output", "json"]);
      expect(refused.code).toBe(EXIT.error);
      const envelope = envelopeOf(refused);
      expect(envelope["status"]).toBe("refused");
      expect((envelope["error"] as { message: string }).message).toContain("0000_baseline");

      // --force gets past the history check and then hits the OTHER refusal that matters:
      // a migration file is immutable, so `writePlan` will not overwrite one.
      const forced = await runCli([
        "migrate",
        "baseline",
        "--url",
        url,
        "--migrations",
        dir,
        "--force",
        "--output",
        "json",
      ]);
      expect(forced.code).toBe(EXIT.error);
      expect((envelopeOf(forced)["error"] as { message: string }).message).toContain("refusing to overwrite");
    },
    T,
  );

  it(
    "--at marks a directory adopted, up to and including the named migration, without running it",
    async () => {
      const chain = await generateChain("blat", [
        { name: "step_one", fixture: "evolve/current.sql" },
        { name: "step_two", fixture: "evolve/desired.sql" },
      ]);
      chains.push(chain);
      // The database is at step one already, applied by "another tool" (here: the fixture).
      const database = await fresh("at", "evolve/current.sql");
      const url = urlOf(dbConn(database));

      const r = await runCli([
        "migrate",
        "baseline",
        "--url",
        url,
        "--migrations",
        chain.dir,
        "--at",
        "0001",
        "--output",
        "json",
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.ok);
      const envelope = envelopeOf(r);
      expect(envelope["status"]).toBe("marked");
      expect(envelope["marked"]).toEqual(["0001_step_one"]);
      expect(envelope["written"]).toBeNull();

      const rows = await withClient(dbConn(database), readMigrationRows);
      expect(rows.map((x) => [x.id, x.status])).toEqual([["0001_step_one", "baselined"]]);

      /* The point of adopting: the REST of the chain now applies cleanly. */
      const report = await migrationStatus(dbConn(database), chain.dir);
      expect(report.pending).toEqual(["0002_step_two"]);
      const applied = await applyPending(dbConn(database), chain.dir);
      expect(applied.error, JSON.stringify(applied.error)).toBeNull();
      expect(applied.applied.map((a) => a.id)).toEqual(["0002_step_two"]);
      expect(await fingerprintOf(dbConn(database))).toBe(chain.finalFingerprint);
    },
    T,
  );

  const chains: Chain[] = [];
  afterAll(async () => {
    for (const c of chains) await c.dispose().catch(() => undefined);
  });
});
