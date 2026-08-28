/**
 * REGRESSION FIXTURE #1 — the pg-delta alpha.39 enum-ordering bug
 * (design/06 §1.3, 00-overview sign-off item 7).
 *
 * pg-delta emitted
 *     [3] ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'refunded'::order_status
 *     [4] ALTER TYPE order_status ADD VALUE 'refunded' AFTER 'paid'
 * and failed at apply with `invalid input value for enum`. Root cause:
 * `pg_depend` records a dependency on the enum TYPE, never on an individual
 * LABEL, so the topological sort had nothing to order on.
 *
 * Our engine fixes this structurally, not by a special case:
 *   I3  — an enum label is its own fact, so it is an orderable id at all;
 *   §2.1 — a synthesized `evaluates` edge from every expression that names the
 *          label to the label fact, which `pg_depend` will never give us;
 *   §3.7 — ALTER TYPE … ADD VALUE is `commitBoundaryAfter`, so consumers land
 *          in a LATER transaction segment (the label is unusable until commit).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCatalog } from "../src/catalog/extract.js";
import { withClient } from "../src/db/pg.js";
import { diffIR } from "../src/diff/diff.js";
import { PHASE, type Statement } from "../src/diff/statement.js";
import { generateFromDatabases as generate } from "../src/generate.js";
import { applySegments } from "../src/runner/apply.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "./support/db.js";

const CURRENT_DB = "pgprime_spike_enum_current";
const DESIRED_DB = "pgprime_spike_enum_desired";
const MISORDER_DB = "pgprime_spike_enum_misordered";
const T = 120_000;

const LABEL = "enumLabel:public.order_status.refunded";

describe("regression #1: ALTER TYPE … ADD VALUE is ordered before every use of the new label", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
    await makeDatabase(CURRENT_DB, "enum-ordering/current.sql");
    await makeDatabase(DESIRED_DB, "enum-ordering/desired.sql");
  }, T);

  afterAll(async () => {
    await destroyDatabase(CURRENT_DB).catch(() => undefined);
    await destroyDatabase(DESIRED_DB).catch(() => undefined);
    await destroyDatabase(MISORDER_DB).catch(() => undefined);
  }, T);

  it(
    "orders and segments the plan correctly, proves green, and converges on apply",
    async () => {
      const target = { ...ADMIN, database: CURRENT_DB };
      const result = await generate({
        admin: ADMIN,
        target,
        desired: { ...ADMIN, database: DESIRED_DB },
        schemas: ["public"],
        seq: 1,
        name: "enum_regression",
      });

      const statements = result.plan.statements;
      const addValue = statements.findIndex((s) => /ALTER TYPE .* ADD VALUE/.test(s.sql));
      expect(addValue, "the plan must contain an ALTER TYPE … ADD VALUE").toBeGreaterThanOrEqual(0);
      expect(statements[addValue]!.sql).toContain("'refunded'");
      expect(statements[addValue]!.transactionality).toBe("commitBoundaryAfter");
      expect(statements[addValue]!.produces).toContain(LABEL);

      // Every consumer of the new label — the changed DEFAULT, the new column's
      // DEFAULT, the CHECK, and the partial index — is ordered after it...
      const consumers = statements.filter((s) => s.consumes.includes(LABEL));
      expect(consumers.length).toBeGreaterThanOrEqual(4);
      // The new column's `ADD COLUMN` (which carries its DEFAULT inline — a separate
      // `SET DEFAULT` would let `NOT NULL` see rows the default has not reached), the
      // changed DEFAULT on `status`, the CHECK's ADD…NOT VALID and its VALIDATE, and the
      // partial index's predicate.
      //
      // One of these says `default` rather than `column` since K3 split the DEFAULT into
      // its own fact (`05` §7.2). The `evaluates` edge is carried on BOTH the column and
      // its default, deliberately: a folded-in default has to reach the commit boundary
      // through the column, and a standalone one through itself.
      expect(consumers.map((s) => s.kind).sort()).toEqual(["column", "constraint", "constraint", "default", "index"]);
      for (const c of consumers) expect(statements.indexOf(c)).toBeGreaterThan(addValue);

      // ...and lands in a LATER segment, because a new label is unusable until
      // the transaction that added it has COMMITted.
      const segmentOf = new Map<number, number>();
      for (const seg of result.plan.segments) for (const i of seg.statements) segmentOf.set(i, seg.index);
      for (const c of consumers) {
        expect(segmentOf.get(statements.indexOf(c))!).toBeGreaterThan(segmentOf.get(addValue)!);
      }

      // The textual form of the bug: no statement that names the label may come
      // before the ADD VALUE, whatever our metadata says.
      const firstMention = statements.findIndex((s, i) => i !== addValue && s.sql.includes("'refunded'"));
      expect(firstMention).toBeGreaterThan(addValue);

      // No EN101 (label used in the same segment as its ADD VALUE) and no other errors.
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(result.plan.hazards.filter((h) => h.code === "EN101")).toEqual([]);

      // D6 — proven on a shadow clone before anything could be written.
      expect(result.plan.proof.status).toBe("passed");
      expect(result.plan.proof.driftDeltas).toBe(0);

      // And for real, against the current database.
      const report = await withClient(target, (c) => applySegments(c, result.plan.statements, result.plan.segments));
      expect(report.error).toBeUndefined();
      expect(report.status).toBe("applied");

      const after = await withClient(target, (c) => extractCatalog(c, { schemas: ["public"] }));
      expect(diffIR(after.ir, result.desiredIR).deltas).toEqual([]);
      expect(after.ir.fingerprint).toBe(result.desiredIR.fingerprint);
    },
    T,
  );

  it(
    "refuses to write a plan whose proof failed (D6 is a gate, not a report)",
    async () => {
      // A deliberately mis-ordered plan: the SET DEFAULT before the ADD VALUE —
      // i.e. exactly what pg-delta produced. The proof must catch it and the
      // emitter must refuse to write it.
      const { proveOnShadowClone } = await import("../src/prove/prove.js");
      const { writePlan } = await import("../src/plan/emit.js");
      const { buildPlan } = await import("../src/plan/plan.js");

      const desiredIR = await withClient({ ...ADMIN, database: DESIRED_DB }, (c) =>
        extractCatalog(c, { schemas: ["public"] }),
      );
      // a pristine CURRENT — the first test converged CURRENT_DB on purpose
      const source = await makeDatabase(MISORDER_DB, "enum-ordering/current.sql");
      const base = {
        produces: [] as string[],
        consumes: [] as string[],
        destroys: [] as string[],
        releases: [] as string[],
        idempotent: true,
        dataLoss: "none" as const,
        rewrite: false,
        hazards: [] as string[],
        verb: "alter" as const,
      };
      const statements: Statement[] = [
        {
          ...base,
          sql: `ALTER TABLE "public"."orders" ALTER COLUMN "status" SET DEFAULT 'refunded'::public.order_status`,
          kind: "column",
          transactionality: "transactional",
          lockClass: "accessExclusive",
          phase: PHASE.alterColumn,
        },
        {
          ...base,
          sql: `ALTER TYPE "public"."order_status" ADD VALUE IF NOT EXISTS 'refunded' AFTER 'paid'`,
          kind: "enumLabel",
          produces: [LABEL],
          transactionality: "commitBoundaryAfter",
          lockClass: "shareRowExclusive",
          phase: PHASE.addEnumValue,
        },
      ];
      const segments = [{ index: 0, transactional: true, statements: [0, 1] }];
      const planInput = {
        seq: 9,
        name: "mis_ordered",
        statements,
        segments,
        fromFingerprint: "sha256:x",
        toFingerprint: "sha256:y",
        pgVersionNum: 170000,
        renames: [],
        diagnostics: [],
      };

      const proof = await proveOnShadowClone({
        admin: ADMIN,
        source,
        desired: desiredIR.ir,
        schemas: ["public"],
        statements: buildPlan(planInput).statements,
        segments,
      });
      expect(proof.status).toBe("failed");
      expect(proof.error).toMatch(/invalid input value for enum|unsafe use of new value/);

      const plan = buildPlan({ ...planInput, proof });
      await expect(writePlan("/tmp/pg-prime-should-not-exist", plan)).rejects.toThrow(/refusing to write/);
    },
    T,
  );
});
