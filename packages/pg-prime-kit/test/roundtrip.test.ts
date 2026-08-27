import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCatalog } from "../src/catalog/extract.js";
import { diffIR } from "../src/diff/diff.js";
import { withClient } from "../src/db/pg.js";
import { generate } from "../src/generate.js";
import { applySegments } from "../src/runner/apply.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "./support/db.js";

const DESIRED_DB = "pgprime_spike_acc_desired";
const TARGET_DB = "pgprime_spike_acc_target";
const T = 120_000;

describe("acceptance: 3-table fixture round-trips through the in-house engine", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
    await makeDatabase(DESIRED_DB, "acceptance/desired.sql");
    await makeDatabase(TARGET_DB);
  }, T);

  afterAll(async () => {
    await destroyDatabase(DESIRED_DB).catch(() => undefined);
    await destroyDatabase(TARGET_DB).catch(() => undefined);
  }, T);

  it(
    "declared -> diff vs empty DB -> prove -> apply -> re-extract -> EMPTY diff",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "pg-prime-plan-"));
      const result = await generate({
        admin: ADMIN,
        target: { ...ADMIN, database: TARGET_DB },
        desired: { ...ADMIN, database: DESIRED_DB },
        schemas: ["public"],
        seq: 1,
        name: "acceptance",
        outDir,
      });

      // the diff itself
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(result.plan.statements.length).toBeGreaterThan(10);

      // D6 — proof passed on a shadow clone, and only then were files written
      expect(result.plan.proof.status).toBe("passed");
      expect(result.plan.proof.driftDeltas).toBe(0);
      expect(result.written).toBeDefined();

      const sql = await readFile(result.written!.sqlPath, "utf8");
      expect(sql).toContain("-- pg-orm:migration 0001_acceptance");
      expect(sql).toContain(`-- pg-orm:to        ${result.desiredIR.fingerprint}`);
      expect(sql).toContain("-- pg-orm:stmt 0");
      const planJson = JSON.parse(await readFile(result.written!.planPath, "utf8")) as typeof result.plan;
      expect(planJson.planId).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(planJson.from.fingerprint).toBe(result.currentIR.fingerprint);

      // every v1-M kind we claim to model is actually in the plan
      const kinds = new Set(result.plan.statements.map((s) => `${s.verb}:${s.kind}`));
      expect(kinds).toContain("create:type");
      expect(kinds).toContain("create:table");
      expect(kinds).toContain("create:index");
      expect(kinds).toContain("create:sequence");
      expect(kinds).toContain("alter:constraint");

      // apply for real
      const report = await withClient({ ...ADMIN, database: TARGET_DB }, (c) =>
        applySegments(c, result.plan.statements, result.plan.segments),
      );
      expect(report.error).toBeUndefined();
      expect(report.status).toBe("applied");

      // re-extract and assert convergence, both as deltas and as fingerprints
      const after = await withClient({ ...ADMIN, database: TARGET_DB }, (c) =>
        extractCatalog(c, { schemas: ["public"] }),
      );
      const residual = diffIR(after.ir, result.desiredIR);
      expect(residual.deltas.map((d) => JSON.stringify(d))).toEqual([]);
      expect(after.ir.fingerprint).toBe(result.desiredIR.fingerprint);
    },
    T,
  );

  it(
    "a second generate against the converged database produces an empty plan",
    async () => {
      const result = await generate({
        admin: ADMIN,
        target: { ...ADMIN, database: TARGET_DB },
        desired: { ...ADMIN, database: DESIRED_DB },
        schemas: ["public"],
        seq: 2,
        name: "noop",
        prove: false,
      });
      expect(result.diff.deltas).toEqual([]);
      expect(result.plan.statements).toEqual([]);
      expect(result.currentIR.fingerprint).toBe(result.desiredIR.fingerprint);
    },
    T,
  );

  it(
    "extraction reports the objects it deliberately does not diff (the completeness rule)",
    async () => {
      const r = await withClient({ ...ADMIN, database: DESIRED_DB }, (c) =>
        extractCatalog(c, { schemas: ["public"] }),
      );
      expect(r.diagnostics.every((d) => d.code === "unmodeled_kind")).toBe(true);
      expect(r.pgVersionNum).toBeGreaterThanOrEqual(150000);
    },
    T,
  );
});
