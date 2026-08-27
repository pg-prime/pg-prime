/**
 * What stops a plan reaching disk.
 *
 * `writePlan` used to check exactly one thing — `proof.status` — and then join a caller
 * string into a path and overwrite whatever was there. Three separate holes:
 * `name: "../../escaped"` wrote outside `outDir`; re-running `generate` silently rewrote
 * a migration someone may already have applied; and design/06 §3.6's destructive
 * acknowledgement gate did not exist, so a plan full of `DS103` reached disk with every
 * hazard sitting at `acknowledged: false`.
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate } from "../src/generate.js";
import {
  ProofRequiredError,
  UnacknowledgedHazardError,
  UnsafePlanPathError,
  writePlan,
} from "../src/plan/emit.js";
import { buildPlan, hazardSeverity, migrationId, InvalidMigrationIdError, renderSql } from "../src/plan/plan.js";
import { PHASE, type Statement } from "../src/diff/statement.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "./support/db.js";

const PASSED = { status: "passed" as const, at: "2026-08-26T00:00:00.000Z" };

const DROP_COLUMN: Statement = {
  sql: 'ALTER TABLE "public"."users" DROP COLUMN IF EXISTS "legacy_id"',
  verb: "drop",
  kind: "column",
  produces: [],
  consumes: ["table:public.users"],
  destroys: ["column:public.users.legacy_id"],
  releases: [],
  transactionality: "transactional",
  lockClass: "accessExclusive",
  idempotent: true,
  dataLoss: "destructive",
  rewrite: false,
  hazards: ["DS103"],
  phase: PHASE.dropColumn,
};

const CREATE_INDEX: Statement = {
  sql: 'CREATE INDEX "users_email_idx" ON "public"."users" USING btree (email)',
  verb: "create",
  kind: "index",
  produces: ["index:public.users_email_idx"],
  consumes: ["table:public.users"],
  destroys: [],
  releases: [],
  transactionality: "transactional",
  lockClass: "shareUpdateExclusive",
  idempotent: false,
  dataLoss: "none",
  rewrite: false,
  hazards: ["LK101"],
  phase: PHASE.createIndex,
};

const base = {
  seq: 7,
  name: "drop_legacy",
  segments: [{ index: 0, transactional: true, statements: [0] }],
  fromFingerprint: "sha256:aaa",
  toFingerprint: "sha256:bbb",
  pgVersionNum: 170011,
  renames: [],
  diagnostics: [],
  proof: PASSED,
};

describe("migration ids are validated before they become filenames", () => {
  it("rejects a name that is not [a-z0-9_]+, and a negative or fractional seq", () => {
    expect(migrationId(7, "drop_legacy")).toBe("0007_drop_legacy");
    expect(() => migrationId(7, "../../escaped")).toThrow(InvalidMigrationIdError);
    expect(() => migrationId(7, "Drop Legacy")).toThrow(InvalidMigrationIdError);
    expect(() => migrationId(7, "")).toThrow(InvalidMigrationIdError);
    expect(() => migrationId(-1, "ok")).toThrow(InvalidMigrationIdError);
    expect(() => migrationId(1.5, "ok")).toThrow(InvalidMigrationIdError);
    expect(() => buildPlan({ ...base, statements: [CREATE_INDEX], name: "../../escaped" })).toThrow(
      InvalidMigrationIdError,
    );
  });

  it("refuses to write outside outDir even when handed a doctored plan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pgorm-gate-"));
    const plan = buildPlan({ ...base, statements: [CREATE_INDEX] });
    const doctored = { ...plan, migration: { ...plan.migration, name: "../../escaped" } };
    await expect(writePlan(dir, doctored)).rejects.toBeInstanceOf(UnsafePlanPathError);
    // and nothing was created on the way out
    await expect(readFile(join(dir, "0007_../../escaped.sql"), "utf8")).rejects.toThrow();
  });

  it("never overwrites an existing migration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pgorm-gate-"));
    const plan = buildPlan({ ...base, statements: [CREATE_INDEX] });
    const first = await writePlan(dir, plan);
    await writeFile(first.sqlPath, "-- edited by hand\n", "utf8");
    await expect(writePlan(dir, plan)).rejects.toBeInstanceOf(UnsafePlanPathError);
    expect(await readFile(first.sqlPath, "utf8")).toBe("-- edited by hand\n");
  });
});

describe("design/06 §3.6 — destructive changes need a recorded acknowledgement", () => {
  it("refuses a DROP COLUMN plan whose DS103 is unacknowledged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pgorm-ack-"));
    const plan = buildPlan({ ...base, statements: [DROP_COLUMN] });
    expect(plan.hazards.map((h) => [h.code, h.severity, h.acknowledged])).toEqual([
      ["DS103", "error", false],
    ]);
    expect(plan.acknowledged).toBeNull();
    await expect(writePlan(dir, plan)).rejects.toBeInstanceOf(UnacknowledgedHazardError);
  });

  it("records a per-subject acknowledgement in the plan, and then writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pgorm-ack-"));
    const plan = buildPlan({
      ...base,
      statements: [DROP_COLUMN],
      acknowledge: {
        dataLoss: ["column:public.users.legacy_id"],
        by: "yohocx",
        reason: "removed from API in v3",
      },
    });
    expect(plan.hazards[0]?.acknowledged).toBe(true);
    expect(plan.acknowledged).toMatchObject({
      dataLoss: ["column:public.users.legacy_id"],
      by: "yohocx",
      reason: "removed from API in v3",
      blanket: false,
    });
    const written = await writePlan(dir, plan);
    const onDisk = JSON.parse(await readFile(written.planPath, "utf8")) as { acknowledged: unknown };
    expect(onDisk.acknowledged).toEqual(plan.acknowledged);
  });

  it("a blanket --allow-data-loss covers the whole plan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pgorm-ack-"));
    const plan = buildPlan({ ...base, statements: [DROP_COLUMN], acknowledge: { allowDataLoss: true } });
    expect(plan.acknowledged?.blanket).toBe(true);
    await expect(writePlan(dir, plan)).resolves.toBeTruthy();
  });

  it("the proof gate still fires first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pgorm-ack-"));
    const plan = buildPlan({ ...base, statements: [DROP_COLUMN], proof: { status: "failed" } });
    await expect(writePlan(dir, plan)).rejects.toBeInstanceOf(ProofRequiredError);
  });
});

describe("plan bookkeeping", () => {
  it("every design/06 §3.4 code has a severity, and an unknown one is not an advisory", () => {
    for (const code of ["DS105", "MF102", "LK103", "LK105", "LK106", "LK109", "LK111", "TX101", "TX201"]) {
      expect([code, hazardSeverity(code)]).toEqual([code, code.startsWith("LK") ? "warn" : "error"]);
    }
    expect(hazardSeverity("BC104")).toBe("warn");
    expect(hazardSeverity("ZZ999")).toBe("error");
  });

  it("the header states the timeouts the statements actually carry", () => {
    const plan = buildPlan({ ...base, statements: [DROP_COLUMN, CREATE_INDEX] });
    const sql = renderSql({
      id: "0007_drop_legacy",
      name: "drop_legacy",
      statements: plan.statements,
      segments: plan.segments,
      txmode: plan.txmode,
      from: plan.from.fingerprint,
      to: plan.to.fingerprint,
      pgMin: plan.pg.minVersion,
    });
    // CREATE_INDEX is shareUpdateExclusive => statement timeout null; DROP COLUMN => 30s
    expect(sql).toContain("-- pg-orm:timeout   lock=3s statement=per-statement");
    expect(sql).toContain("SET search_path = pg_catalog;");
    expect(plan.statements[1]?.timeouts.statement).toBeNull();
  });

  it("carries the unmodeled census structurally, not out of a message", () => {
    const plan = buildPlan({
      ...base,
      statements: [CREATE_INDEX],
      diagnostics: [
        { code: "unmodeled_kind", severity: "info", message: "three views, actually", subject: "view", count: 3 },
      ],
    });
    expect(plan.unmodeled).toEqual([{ kind: "view", count: 3 }]);
  });
});

describe("generate() distinguishes a refusal from an I/O failure", () => {
  const CUR = "pgorm_gate_cur";
  const DES = "pgorm_gate_des";
  const T = 180_000;

  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
    await makeDatabase(CUR);
    await makeDatabase(DES);
  }, T);

  afterAll(async () => {
    for (const db of [CUR, DES]) await destroyDatabase(db).catch(() => undefined);
  }, T);

  it(
    "an ENOTDIR outDir throws instead of being reported as an unproven plan",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "pgorm-io-"));
      const notADirectory = join(dir, "file");
      await writeFile(notADirectory, "", "utf8");

      await expect(
        generate({
          admin: ADMIN,
          target: { ...ADMIN, database: CUR },
          desired: { ...ADMIN, database: DES },
          schemas: ["public"],
          seq: 1,
          name: "io_error",
          prove: false,
          allowUnproven: true,
          outDir: join(notADirectory, "nested"),
        }),
      ).rejects.toMatchObject({ code: "ENOTDIR" });
    },
    T,
  );

  it(
    "a genuine refusal is still reported as writeRefusal",
    async () => {
      const outDir = join(await mkdtemp(join(tmpdir(), "pgorm-io-")), "plans");
      await mkdir(outDir, { recursive: true });
      const result = await generate({
        admin: ADMIN,
        target: { ...ADMIN, database: CUR },
        desired: { ...ADMIN, database: DES },
        schemas: ["public"],
        seq: 1,
        name: "unproven",
        prove: false,
        outDir,
      });
      expect(result.written).toBeUndefined();
      expect(result.writeRefusal).toMatch(/proof status is "skipped"/);
    },
    T,
  );
});
