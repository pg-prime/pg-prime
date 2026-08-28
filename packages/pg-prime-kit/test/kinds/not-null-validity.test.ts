/**
 * `convalidated` on a `contype = 'n'` row — the Tier-M gap design/06 §3.3's AS BUILT note
 * left open, and the §3.5 rows 4/5 rewrite that depends on it.
 *
 * PostgreSQL 18 accepts `ADD CONSTRAINT … NOT NULL … NOT VALID`, which sets `attnotnull`
 * **and** leaves `convalidated = false`: existing rows are unchecked, new ones are not.
 * Before this field, `attnotnull` was the only thing read, so the two states were
 * indistinguishable — a database with an unvalidated NOT NULL diffed clean against one
 * with a validated one, and the plan silently declared a guarantee the data did not have.
 *
 * The syntax does not parse on PG 15-17, so this file is CATALOG-gated
 * (`catalogsNotNullConstraints`), never version-gated: a server that back-ports the
 * feature takes the 18 branch with no version table. The corpus fixture
 * `fixtures/diff/not-null-validity` covers what CAN be written on both.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCatalog } from "../../src/catalog/extract.js";
import { buildStatements } from "../../src/diff/ddl.js";
import { diffIR } from "../../src/diff/diff.js";
import { orderStatements } from "../../src/diff/order.js";
import { runSqlScript, withClient } from "../../src/db/pg.js";
import type { PlanStatement } from "../../src/plan/plan.js";
import { applySegments } from "../../src/runner/apply.js";
import {
  ADMIN,
  catalogsNotNullConstraints,
  destroyDatabase,
  makeDatabase,
  serverAvailable,
} from "../support/db.js";

const CUR = "pgprime_k3_nnv_cur";
const DES = "pgprime_k3_nnv_des";
const T = 180_000;

describe("NOT NULL validity (PG >= 18, catalog-gated)", () => {
  let pg18 = false;

  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
    pg18 = await catalogsNotNullConstraints();
  }, T);

  afterAll(async () => {
    for (const db of [CUR, DES]) await destroyDatabase(db).catch(() => undefined);
  }, T);

  it(
    "an unvalidated NOT NULL is a different fact from a validated one, and VALIDATE is the delta",
    async () => {
      if (!pg18) return; // 15-17 cannot express it; the payload is `null` there by design

      const cur = await makeDatabase(CUR);
      const des = await makeDatabase(DES);
      await runSqlScript(
        cur,
        `CREATE TABLE public.t (a integer);
         ALTER TABLE public.t ADD CONSTRAINT t_a_not_null NOT NULL a NOT VALID;`,
      );
      await runSqlScript(des, `CREATE TABLE public.t (a integer NOT NULL);`);

      const current = await withClient(cur, (c) => extractCatalog(c, { schemas: ["public"] }));
      const desired = await withClient(des, (c) => extractCatalog(c, { schemas: ["public"] }));

      // 1. The catalog says the two differ, and so does the IR. Without `notNullValidated`
      //    both sides read `notNull: true, notNullConstraint: %GENERATED%` and the diff is
      //    EMPTY — a guarantee the plan claims and the data does not have.
      const col = { kind: "column", schema: "public", table: "t", name: "a" } as const;
      expect(current.ir.get(col)?.payload["notNullValidated"]).toBe(false);
      expect(desired.ir.get(col)?.payload["notNullValidated"]).toBe(true);

      const diff = diffIR(current.ir, desired.ir);
      expect(diff.deltas.map((d) => `${d.op} ${d.op === "rename" ? d.to.kind : d.id.kind}`)).toEqual([
        "alter column",
      ]);

      // 2. The delta is a VALIDATE — catalog-only ADD, SHARE UPDATE EXCLUSIVE scan — and
      //    NOT a drop-and-re-add, which would pay the ACCESS EXCLUSIVE scan again.
      const built = buildStatements(diff, desired.ir);
      expect(built.statements.map((s) => s.sql)).toEqual([
        `ALTER TABLE "public"."t" VALIDATE CONSTRAINT "t_a_not_null"`,
      ]);
      expect(built.statements[0]?.lockClass).toBe("shareUpdateExclusive");

      // 3. And applying it converges.
      const ordered = orderStatements(built.statements);
      const planStatements: PlanStatement[] = ordered.statements.map((s, index) => ({
        ...s,
        index,
        timeouts: { lock: null, statement: null },
      }));
      const report = await withClient(cur, (c) => applySegments(c, planStatements, ordered.segments));
      expect(report.error).toBeUndefined();
      const after = await withClient(cur, (c) => extractCatalog(c, { schemas: ["public"] }));
      expect(diffIR(after.ir, desired.ir).deltas).toEqual([]);
      expect(after.ir.fingerprint).toBe(desired.ir.fingerprint);
    },
    T,
  );

  it(
    "a desired state that WANTS NOT VALID gets it — inline on a fresh table, and no VALIDATE",
    async () => {
      if (!pg18) return;

      const des = await makeDatabase(`${DES}2`);
      await runSqlScript(
        des,
        `CREATE TABLE public.t (a integer);
         ALTER TABLE public.t ADD CONSTRAINT t_a_not_null NOT NULL a NOT VALID;`,
      );
      const desired = await withClient(des, (c) => extractCatalog(c, { schemas: ["public"] }));
      const empty = await withClient({ ...ADMIN, database: "postgres" }, (c) =>
        extractCatalog(c, { schemas: ["pgprime_nonexistent"] }),
      );

      const built = buildStatements(diffIR(empty.ir, desired.ir), desired.ir);
      const create = built.statements.find((s) => s.sql.startsWith("CREATE TABLE"));
      // The unvalidated state has to survive the CREATE, or a fresh replay of the repo
      // produces a schema that is stricter than the one it describes.
      expect(create?.sql.replace(/\n\s*/g, " ")).toContain(`"a" integer NOT NULL NOT VALID`);
      expect(built.statements.some((s) => /VALIDATE CONSTRAINT/.test(s.sql))).toBe(false);

      await destroyDatabase(`${DES}2`).catch(() => undefined);
    },
    T,
  );
});
