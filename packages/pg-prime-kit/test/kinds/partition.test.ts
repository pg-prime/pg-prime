/**
 * `partitions({ unknown: 'adopt' })` — design/05 §7.2: "the IR asserts *nothing* about
 * undeclared partitions; they must never enter the drop set."
 *
 * The bug this guards is a data-loss bug, not a convergence bug: a differ that treats a
 * partition like any other table plans `DROP TABLE events_2024` the moment the desired
 * state stops naming it, and yesterday's partition is exactly the object nobody thinks
 * to declare. `test/corpus.test.ts` cannot cover it — the D10 witness would correctly
 * report the surviving partition as a dump difference — so the assertion lives here,
 * where it is about the PLAN.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCatalog } from "../../src/catalog/extract.js";
import { buildStatements } from "../../src/diff/ddl.js";
import { diffIR } from "../../src/diff/diff.js";
import { orderStatements } from "../../src/diff/order.js";
import { runSqlScript, withClient } from "../../src/db/pg.js";
import { applySegments } from "../../src/runner/apply.js";
import type { PlanStatement } from "../../src/plan/plan.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";

const CUR = "pgprime_k3_part_cur";
const DES = "pgprime_k3_part_des";
const T = 180_000;

const PARENT = `
CREATE TABLE public.events (
  id bigint NOT NULL,
  at timestamptz NOT NULL
) PARTITION BY RANGE (at);
CREATE TABLE public.events_2025 PARTITION OF public.events
  FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');`;

describe("undeclared partitions are adopted, never dropped", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
  }, T);

  afterAll(async () => {
    for (const db of [CUR, DES]) await destroyDatabase(db).catch(() => undefined);
  }, T);

  it(
    "plans no DROP for a partition the desired state never mentions, and says so",
    async () => {
      const cur = await makeDatabase(CUR);
      const des = await makeDatabase(DES);
      // CURRENT has an extra partition and an extra ordinary table. The ordinary one is
      // the control: it must still be dropped, or this test would pass on a differ that
      // simply stopped dropping anything.
      await runSqlScript(
        cur,
        `${PARENT}
         CREATE TABLE public.events_2024 PARTITION OF public.events
           FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
         CREATE TABLE public.scratch (id bigint);`,
      );
      await runSqlScript(des, PARENT);

      const current = await withClient(cur, (c) => extractCatalog(c, { schemas: ["public"] }));
      const desired = await withClient(des, (c) => extractCatalog(c, { schemas: ["public"] }));
      const diff = diffIR(current.ir, desired.ir);

      // The partition and its columns are gone from the diff entirely; only the ordinary
      // table (and its own column) survive as drops.
      expect(
        diff.deltas
          .filter((d) => d.op === "drop")
          .map((d) => (d.op === "drop" ? `${d.id.kind}` : ""))
          .sort(),
      ).toEqual(["column", "table"]);
      const sql = buildStatements(diff, desired.ir).statements.map((s) => s.sql);
      expect(sql.some((s) => s.includes("events_2024"))).toBe(false);
      expect(sql.some((s) => /DROP TABLE IF EXISTS "public"."scratch"/.test(s))).toBe(true);

      // Adoption is a decision, and a decision has to be reported.
      expect(diff.diagnostics.filter((d) => d.code === "adopted_partition").map((d) => d.subject)).toEqual([
        "table:public.events_2024",
      ]);
      // ...and it is `info`, so it does not fail the corpus's error gate.
      expect(diff.diagnostics.find((d) => d.code === "adopted_partition")?.severity).toBe("info");
    },
    T,
  );

  it(
    "a declared partition is created and ATTACHed, and a bound change is DETACH + ATTACH",
    async () => {
      const cur = { ...ADMIN, database: CUR };
      // Reuse the databases from the previous case: CURRENT now has 2024 + 2025.
      const target = await makeDatabase(`${CUR}2`);
      await runSqlScript(target, PARENT);
      const before = await withClient(target, (c) => extractCatalog(c, { schemas: ["public"] }));

      const desiredDb = await makeDatabase(`${DES}2`);
      await runSqlScript(
        desiredDb,
        `${PARENT}
         CREATE TABLE public.events_2026 PARTITION OF public.events
           FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');`,
      );
      const after = await withClient(desiredDb, (c) => extractCatalog(c, { schemas: ["public"] }));

      const diff = diffIR(before.ir, after.ir);
      const built = buildStatements(diff, after.ir);
      const sql = built.statements.map((s) => s.sql.replace(/\n\s*/g, " "));
      expect(sql.some((s) => /^CREATE TABLE "public"."events_2026" \(/.test(s))).toBe(true);
      const attach = sql.findIndex((s) =>
        /ALTER TABLE "public"."events" ATTACH PARTITION "public"."events_2026" FOR VALUES FROM/.test(s),
      );
      expect(attach).toBeGreaterThanOrEqual(0);
      // The table has to exist before it can be attached; the edge, not the phase, is
      // what guarantees that, so assert on the ORDERED stream.
      const ordered = orderStatements(built.statements).statements.map((s) => s.sql);
      expect(ordered.findIndex((s) => s.includes('CREATE TABLE "public"."events_2026"'))).toBeLessThan(
        ordered.findIndex((s) => s.includes("ATTACH PARTITION")),
      );

      // And it really applies.
      const planStatements: PlanStatement[] = ordered.map((_, index) => ({
        ...orderStatements(built.statements).statements[index]!,
        index,
        timeouts: { lock: null, statement: null },
      }));
      const report = await withClient(target, (c) =>
        applySegments(c, planStatements, orderStatements(built.statements).segments),
      );
      expect(report.error).toBeUndefined();
      const converged = await withClient(target, (c) => extractCatalog(c, { schemas: ["public"] }));
      expect(diffIR(converged.ir, after.ir).deltas).toEqual([]);
      void cur;

      await destroyDatabase(`${CUR}2`).catch(() => undefined);
      await destroyDatabase(`${DES}2`).catch(() => undefined);
    },
    T,
  );
});
