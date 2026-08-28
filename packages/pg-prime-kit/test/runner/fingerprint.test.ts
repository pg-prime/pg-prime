/**
 * The drift guard — design/06 §4.3 ("`apply` refuses when the live fingerprint ≠
 * `from.fingerprint` — this is simultaneously the drift guard and the concurrent-deploy
 * guard") and §5.6's failure table.
 *
 * Four refusals, all exit 4, each with its own error code, and each paired with the
 * control that shows the run succeeding when the condition is absent (R4).
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { withClient } from "../../src/db/pg.js";
import { readMigrationRows } from "../../src/history/store.js";
import { applyPending } from "../../src/runner/run.js";
import { migrationStatus } from "../../src/runner/status.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { generateChain, type Chain } from "../support/migrations.js";

const T = 180_000;

describe("the fingerprint and checksum gates", () => {
  let chain: Chain;
  const databases: string[] = [];

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    chain = await generateChain("fp", [
      { name: "step_one", fixture: "evolve/current.sql" },
      { name: "step_two", fixture: "evolve/desired.sql" },
    ]);
  }, T);

  afterAll(async () => {
    for (const d of databases) await destroyDatabase(d).catch(() => undefined);
    await chain.dispose().catch(() => undefined);
  });

  const fresh = async (name: string, fixture?: string): Promise<ReturnType<typeof dbConn>> => {
    const database = `pgprime_k1_fp_${name}`;
    databases.push(database);
    await makeDatabase(database, fixture);
    return dbConn(database);
  };

  it(
    "control: from an empty database the chain applies",
    async () => {
      const conn = await fresh("ok");
      const r = await applyPending(conn, chain.dir);
      expect(r.error).toBeNull();
      expect(r.status).toBe("applied");
      expect(r.exitCode).toBe(EXIT.ok);
    },
    T,
  );

  it(
    "the first migration refuses a database that is not empty, and names both fingerprints",
    async () => {
      // No history row exists, so the fast path is unavailable and the runner extracts —
      // design/06 §5.1 step 7b's "slow path (…or fast path unavailable)".
      const conn = await fresh("dirty", "evolve/current.sql");
      const r = await applyPending(conn, chain.dir);
      expect(r.status).toBe("drift");
      expect(r.exitCode).toBe(EXIT.drift);
      expect(r.error?.code).toBe("fingerprint_mismatch");
      expect(r.error?.migration).toBe("0001_step_one");
      expect(r.error?.message).toContain(chain.plans[0]!.from.fingerprint);
      expect(r.error?.message).toContain("public");
      // Nothing ran.
      const rows = await withClient(conn, readMigrationRows);
      expect(rows).toEqual([]);
    },
    T,
  );

  it(
    "--verify-fingerprint catches an out-of-band change the fast path cannot see",
    async () => {
      const conn = await fresh("oob");
      expect((await applyPending(conn, chain.dir, { to: "0001" })).status).toBe("applied");
      await withClient(conn, (c) => c.query("ALTER TABLE public.customers ADD COLUMN rogue integer"));

      // The fast path trusts the recorded fingerprint_to and proceeds; that is the
      // documented trade-off in design/06 §5.1 step 7b, and `status` still reports the
      // recorded value rather than the truth.
      const fast = await migrationStatus(conn, chain.dir);
      const slow = await migrationStatus(conn, chain.dir, { verifyFingerprint: true });
      expect(fast.fingerprint).not.toBe(slow.fingerprint);
      expect(fast.fingerprintSource).toBe("history");
      expect(slow.fingerprintSource).toBe("catalog");

      const r = await applyPending(conn, chain.dir, { verifyFingerprint: true });
      expect(r.status).toBe("drift");
      expect(r.exitCode).toBe(EXIT.drift);
      expect(r.error?.code).toBe("fingerprint_mismatch");
      expect(r.error?.migration).toBe("0002_step_two");
    },
    T,
  );

  it(
    "an edited migration file is checksum drift — exit 4 in apply, a warning under --dev",
    async () => {
      const conn = await fresh("checksum");
      expect((await applyPending(conn, chain.dir)).status).toBe("applied");

      const path = join(chain.dir, "0001_step_one.sql");
      const original = await readFile(path, "utf8");
      await writeFile(path, `${original}\n-- a comment added after the fact\n`, "utf8");
      try {
        const strict = await applyPending(conn, chain.dir);
        expect(strict.status).toBe("drift");
        expect(strict.exitCode).toBe(EXIT.drift);
        expect(strict.error?.code).toBe("checksum_drift");
        expect(strict.error?.migration).toBe("0001_step_one");

        const report = await migrationStatus(conn, chain.dir);
        expect(report.status).toBe("drift");
        expect(report.exitCode).toBe(EXIT.drift);
        expect(report.checksumDrift).toEqual(["0001_step_one"]);

        const dev = await applyPending(conn, chain.dir, { dev: true });
        expect(dev.status).toBe("up_to_date");
        expect(dev.exitCode).toBe(EXIT.ok);
        expect(dev.warnings.join("\n")).toContain("0001_step_one.sql has changed since it was applied");
      } finally {
        await writeFile(path, original, "utf8");
      }
    },
    T,
  );

  it(
    "an applied migration whose file has vanished is exit 4, not a silent re-plan",
    async () => {
      const conn = await fresh("missing");
      expect((await applyPending(conn, chain.dir)).status).toBe("applied");

      const path = join(chain.dir, "0002_step_two.sql");
      const original = await readFile(path, "utf8");
      await rm(path);
      try {
        const r = await applyPending(conn, chain.dir);
        expect(r.status).toBe("drift");
        expect(r.exitCode).toBe(EXIT.drift);
        expect(r.error?.code).toBe("missing_file");
        expect(r.error?.migration).toBe("0002_step_two");

        const report = await migrationStatus(conn, chain.dir);
        expect(report.missingFiles).toEqual(["0002_step_two"]);
        expect(report.exitCode).toBe(EXIT.drift);
      } finally {
        await writeFile(path, original, "utf8");
      }
    },
    T,
  );

  it(
    "--to stops where it is told, and an unknown target is an error rather than a no-op",
    async () => {
      const conn = await fresh("to");
      const first = await applyPending(conn, chain.dir, { to: "0001" });
      expect(first.applied.map((a) => a.id)).toEqual(["0001_step_one"]);
      expect(first.pending).toEqual([]);

      const report = await migrationStatus(conn, chain.dir);
      expect(report.pending).toEqual(["0002_step_two"]);
      expect(report.exitCode).toBe(EXIT.pending);

      const bogus = await applyPending(conn, chain.dir, { to: "0099_nope" });
      expect(bogus.status).toBe("failed");
      expect(bogus.exitCode).toBe(EXIT.error);
      expect(bogus.error?.code).toBe("unknown_target");

      const rest = await applyPending(conn, chain.dir);
      expect(rest.applied.map((a) => a.id)).toEqual(["0002_step_two"]);
    },
    T,
  );
});
