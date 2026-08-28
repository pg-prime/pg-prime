/**
 * Checkpoints — design/06 §4.5, design/12 decision 16, through the binary (R17).
 *
 * The four claims, each with the catalog or `pgprime.migrations` as the oracle (R14):
 *
 *  1. a **fresh** database applies the newest checkpoint and everything after it, and
 *     lands on the same fingerprint a linear replay does;
 *  2. an **existing** database ignores the checkpoint and continues linearly — and records
 *     the file it ignored as `superseded`, so `status` does not report it pending for ever;
 *  3. `verify --from-checkpoint` replays from the checkpoint, and plain `verify` still
 *     replays everything (the flag is the difference, not the default);
 *  4. a fingerprint mismatch NAMES the drifted objects, which is what design/11 K1 could
 *     not do and what the checkpoint's `.ir.json` is for.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { extractCatalog } from "../../src/catalog/extract.js";
import { withClient } from "../../src/db/pg.js";
import { readCheckpointRows, readMigrationRows } from "../../src/history/store.js";
import { envelopeOf, runCli, urlOf } from "../support/cli.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { golden } from "../cli/_mask.js";
import { makeProject, BASE_SCHEMA, type Project } from "../cli/_project.js";

const expectGolden = async (name: string, envelope: unknown): Promise<void> => {
  await expect(golden(envelope)).toMatchFileSnapshot(`../cli/golden/${name}.json`);
};

const T = 300_000;
const SOURCE = "pgprime_k4_ckpt";
const FRESH = "pgprime_k4_ckpt_fresh";

/** BASE_SCHEMA plus a second table, so there is a real "after the checkpoint" migration. */
const EVOLVED = `${BASE_SCHEMA.replace("export default defineSchema({ widgets })", "")}
export const gizmos = pgTable('gizmos', (t) => ({
  id: t.bigint().generatedAlways().primaryKey(),
  label: t.text(),
}))

export default defineSchema({ widgets, gizmos })
`;

const AFTER = `${EVOLVED.replace("export default defineSchema({ widgets, gizmos })", "")}
export const doodads = pgTable('doodads', (t) => ({
  id: t.bigint().generatedAlways().primaryKey(),
  note: t.text().nullable(),
}))

export default defineSchema({ widgets, gizmos, doodads })
`;

const fingerprintOf = async (database: string): Promise<string> =>
  withClient(dbConn(database), async (c) => (await extractCatalog(c, { schemas: ["public"] })).ir.fingerprint);

describe("migrate checkpoint", () => {
  let project: Project;
  let linear = "";

  const cli = (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    runCli([...args, "--config", project.config, "--output", "json"]);

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    await makeDatabase(SOURCE);
    project = await makeProject("checkpoint", { url: urlOf(dbConn(SOURCE)), schema: BASE_SCHEMA });

    // 0000_init, 0001_evolve — the history a checkpoint will later stand in for.
    expect((await cli("migrate", "generate", "--name", "init")).code).toBe(EXIT.ok);
    expect((await cli("migrate", "apply")).code).toBe(EXIT.ok);
    await project.writeSchema(EVOLVED);
    expect((await cli("migrate", "generate", "--name", "evolve")).code).toBe(EXIT.ok);
    expect((await cli("migrate", "apply")).code).toBe(EXIT.ok);
    linear = await fingerprintOf(SOURCE);
  }, T);

  afterAll(async () => {
    await project?.dispose().catch(() => undefined);
    for (const d of [SOURCE, FRESH]) await destroyDatabase(d).catch(() => undefined);
  });

  it(
    "writes the .sql, the .plan.json and checkpoints/NNNN.ir.json, and records nothing",
    async () => {
      const before = await withClient(dbConn(SOURCE), readMigrationRows);
      const r = await cli("migrate", "checkpoint");
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.ok);
      const e = envelopeOf(r);
      expect(e["status"]).toBe("written");
      const migration = e["migration"] as { id: string; statements: number; supersedes: string[] };
      expect(migration.id).toBe("0002_checkpoint");
      expect(migration.statements).toBeGreaterThan(0);
      expect(migration.supersedes).toEqual([]);
      await expectGolden("checkpoint.written", e);

      const files = await readdir(project.migrations);
      expect(files).toContain("0002_checkpoint.sql");
      expect(files).toContain("0002_checkpoint.plan.json");
      expect(await readdir(join(project.migrations, "checkpoints"))).toEqual(["0002.ir.json"]);

      // The directive is in the FILE, which is what the runner reads (design/06 §4.5).
      const sql = await readFile(join(project.migrations, "0002_checkpoint.sql"), "utf8");
      expect(sql).toContain("-- pg-prime:checkpoint");
      expect(sql).toContain("CREATE TABLE");

      // The IR file is the whole schema at this point, in §2.3's checkpoint form.
      const ir = JSON.parse(await readFile(join(project.migrations, "checkpoints", "0002.ir.json"), "utf8")) as {
        formatVersion: number;
        fingerprint: string;
        facts: unknown[];
      };
      expect(ir.formatVersion).toBe(1);
      expect(ir.fingerprint).toBe(linear);
      expect(ir.facts.length).toBeGreaterThan(0);

      // `migrate checkpoint` is read-only against the database: the row is written by
      // `apply`, when a fresh database actually jumps to it.
      expect(await withClient(dbConn(SOURCE), readMigrationRows)).toEqual(before);
      expect(await withClient(dbConn(SOURCE), readCheckpointRows)).toEqual([]);
    },
    T,
  );

  it(
    "an EXISTING database ignores the checkpoint, records it superseded, and continues linearly",
    async () => {
      await project.writeSchema(AFTER);
      expect((await cli("migrate", "generate", "--name", "after")).code).toBe(EXIT.ok);

      const applied = await cli("migrate", "apply");
      expect(applied.code, applied.stdout + applied.stderr).toBe(EXIT.ok);
      const e = envelopeOf(applied);
      // ONLY the tail ran. The checkpoint's DDL would have failed on the existing tables.
      expect((e["applied"] as { id: string }[]).map((a) => a.id)).toEqual(["0003_after"]);
      expect((e["warnings"] as string[]).join(" ")).toContain("superseded");

      const rows = await withClient(dbConn(SOURCE), readMigrationRows);
      expect(rows.map((r) => [r.id, r.status])).toEqual([
        ["0000_init", "applied"],
        ["0001_evolve", "applied"],
        ["0002_checkpoint", "superseded"],
        ["0003_after", "applied"],
      ]);
      // Nothing jumped to it, so nothing recorded it in `pgprime.checkpoints`.
      expect(await withClient(dbConn(SOURCE), readCheckpointRows)).toEqual([]);

      // …and `status` is up to date rather than reporting the checkpoint pending for ever.
      const status = await cli("migrate", "status");
      expect(status.code).toBe(EXIT.ok);
      const s = envelopeOf(status);
      expect(s["status"]).toBe("up_to_date");
      expect(s["pending"]).toEqual([]);
      expect((s["migrations"] as { id: string; state: string }[]).find((m) => m.id === "0002_checkpoint")?.state).toBe(
        "superseded",
      );
      linear = await fingerprintOf(SOURCE);
    },
    T,
  );

  it(
    "a FRESH database applies the checkpoint and the tail, and lands on the linear fingerprint",
    async () => {
      await makeDatabase(FRESH);
      const url = urlOf(dbConn(FRESH));
      const r = await runCli([
        "migrate", "apply", "--config", project.config, "--url", url, "--output", "json",
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.ok);
      const e = envelopeOf(r);
      expect((e["applied"] as { id: string }[]).map((a) => a.id)).toEqual(["0002_checkpoint", "0003_after"]);
      expect((e["warnings"] as string[]).join(" ")).toContain("jumped to checkpoint 0002_checkpoint");

      /* Oracle 1 — the catalog. A jump is only correct if it lands in the same place. */
      expect(await fingerprintOf(FRESH)).toBe(linear);

      /* Oracle 2 — the rows. */
      const rows = await withClient(dbConn(FRESH), readMigrationRows);
      expect(rows.map((row) => [row.id, row.status])).toEqual([
        ["0000_init", "superseded"],
        ["0001_evolve", "superseded"],
        ["0002_checkpoint", "applied"],
        ["0003_after", "applied"],
      ]);
      // The jumped files are recorded as never executed, which is the truth.
      expect(rows.filter((row) => row.status === "superseded").every((row) => row.statementsApplied === 0)).toBe(true);

      /* Oracle 3 — design/06 §4.4's `pgprime.checkpoints`. */
      const checkpoints = await withClient(dbConn(FRESH), readCheckpointRows);
      expect(checkpoints.map((c) => c.id)).toEqual(["0002_checkpoint"]);

      /* And a second apply does nothing at all. */
      const noop = await runCli(["migrate", "apply", "--config", project.config, "--url", url, "--output", "json"]);
      expect(noop.code).toBe(EXIT.ok);
      expect(envelopeOf(noop)["status"]).toBe("up_to_date");
    },
    T,
  );

  it(
    "verify replays everything; --from-checkpoint replays from the checkpoint; both converge",
    async () => {
      const full = await cli("migrate", "verify");
      expect(full.code, full.stdout + full.stderr).toBe(EXIT.ok);
      const f = envelopeOf(full);
      expect(f["status"]).toBe("verified");
      expect(f["fromCheckpoint"]).toBe(false);
      // The LINEAR history: 0000 → 0001 → 0003. `checkpoints: "ignore"` is the
      // existing-database rule applied unconditionally, and a checkpoint's
      // `from.fingerprint` is a fresh database's — running it after the history it stands
      // in for would fail its own gate. "Replay every migration" therefore means every
      // migration of the linear history, which is the one a checkpoint is an alternative
      // to rather than a member of.
      expect((f["replay"] as { applied: string[] }).applied).toEqual([
        "0000_init", "0001_evolve", "0003_after",
      ]);

      const jumped = await cli("migrate", "verify", "--from-checkpoint");
      expect(jumped.code, jumped.stdout + jumped.stderr).toBe(EXIT.ok);
      const j = envelopeOf(jumped);
      expect(j["status"]).toBe("verified");
      expect(j["fromCheckpoint"]).toBe(true);
      expect((j["replay"] as { applied: string[] }).applied).toEqual(["0002_checkpoint", "0003_after"]);
      expect(j["deltas"]).toEqual([]);
    },
    T,
  );

  it(
    "a fingerprint mismatch NAMES the drifted objects (design/11 K1's open item (a))",
    async () => {
      await withClient(dbConn(SOURCE), async (c) => {
        await c.query("ALTER TABLE public.doodads DROP COLUMN note");
      });

      const status = await cli("migrate", "status", "--verify-fingerprint");
      expect(status.code).toBe(EXIT.drift);
      const s = envelopeOf(status);
      expect(s["fingerprintDrift"]).toBe(true);
      const drift = s["drift"] as { checkpoint: string; deltas: string[]; exact: boolean; since: string[] };
      expect(drift.checkpoint).toBe("0002_checkpoint");
      // 0003_after landed after the checkpoint, so ITS objects are in the list too and the
      // report says so rather than presenting a superset as if it were exact.
      expect(drift.exact).toBe(false);
      expect(drift.since).toEqual(["0003_after"]);
      expect(drift.deltas).toContain("create table:public.doodads");
      // The sentence a human reads names the checkpoint and the objects.
      const sentence = (s["diagnostics"] as { code: string; message: string }[]).find(
        (d) => d.code === "fingerprint_drift",
      );
      expect(sentence?.message).toContain("0002_checkpoint");
      expect(sentence?.message).toContain("table:public.doodads");
    },
    T,
  );
});
