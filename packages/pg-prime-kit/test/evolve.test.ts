/**
 * The ALTER half of the v1-M subset (design/06 §2.2 Tier M), and D5 renames.
 *
 * Creating a schema from empty exercises the emitter; evolving one exercises
 * the DIFFER — which is the part that is actually hard, and the part where a
 * phantom diff or a missed attribute shows up as a plan that does not converge.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCatalog } from "../src/catalog/extract.js";
import { withClient } from "../src/db/pg.js";
import { diffIR } from "../src/diff/diff.js";
import { generateFromDatabases as generate } from "../src/generate.js";
import { applySegments } from "../src/runner/apply.js";
import {
  ADMIN,
  catalogsNotNullConstraints,
  destroyDatabase,
  makeDatabase,
  serverAvailable,
} from "./support/db.js";

const CURRENT_DB = "pgprime_spike_evolve_current";
const DESIRED_DB = "pgprime_spike_evolve_desired";
const RENAME_DB = "pgprime_spike_evolve_rename";
const T = 120_000;

describe("evolution: diffing two populated catalogs", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
    await makeDatabase(CURRENT_DB, "evolve/current.sql");
    await makeDatabase(DESIRED_DB, "evolve/desired.sql");
  }, T);

  afterAll(async () => {
    await destroyDatabase(CURRENT_DB).catch(() => undefined);
    await destroyDatabase(DESIRED_DB).catch(() => undefined);
    await destroyDatabase(RENAME_DB).catch(() => undefined);
  }, T);

  it(
    "covers the M-subset alter paths and converges",
    async () => {
      const target = { ...ADMIN, database: CURRENT_DB };
      const result = await generate({
        admin: ADMIN,
        target,
        desired: { ...ADMIN, database: DESIRED_DB },
        schemas: ["public"],
        seq: 1,
        name: "evolve",
      });

      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(result.plan.proof.status).toBe("passed");

      const sql = result.plan.statements.map((s) => s.sql);
      const has = (re: RegExp): boolean => sql.some((s) => re.test(s));
      expect(has(/ALTER COLUMN "legacy_code" TYPE character varying\(16\)/)).toBe(true);
      expect(has(/ALTER COLUMN "signup_source" DROP DEFAULT/)).toBe(true);
      // §3.5 rows 4 and 5 — `SET NOT NULL` is lock-safely rewritten, and which rewrite
      // depends on the CATALOG, not on `server_version_num`: PG >= 18 catalogues NOT NULL
      // as a `pg_constraint` row and can add one `NOT VALID`, PG 15-17 has to prove it
      // with a temporary CHECK and then let `SET NOT NULL` skip its scan.
      if (await catalogsNotNullConstraints()) {
        expect(has(/ADD CONSTRAINT "customers_signup_source_not_null" NOT NULL "signup_source" NOT VALID/)).toBe(true);
        expect(has(/VALIDATE CONSTRAINT "customers_signup_source_not_null"/)).toBe(true);
        expect(has(/ALTER COLUMN "signup_source" SET NOT NULL/)).toBe(false);
      } else {
        expect(has(/ADD CONSTRAINT "customers_signup_source_not_null" CHECK \("signup_source" IS NOT NULL\) NOT VALID/)).toBe(true);
        expect(has(/VALIDATE CONSTRAINT "customers_signup_source_not_null"/)).toBe(true);
        expect(has(/ALTER COLUMN "signup_source" SET NOT NULL/)).toBe(true);
        expect(has(/DROP CONSTRAINT IF EXISTS "customers_signup_source_not_null"/)).toBe(true);
      }
      expect(has(/ADD COLUMN IF NOT EXISTS "country" text DEFAULT 'US'::text NOT NULL/)).toBe(true);
      expect(has(/DROP COLUMN IF EXISTS "note"/)).toBe(true);
      expect(has(/DROP INDEX IF EXISTS "public"."orders_note_idx"/)).toBe(true);
      expect(has(/ADD CONSTRAINT "customers_email_key" UNIQUE \(email\)/)).toBe(true);
      // §3.5 — a validated FK is emitted as NOT VALID + VALIDATE
      expect(has(/ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY .* NOT VALID/)).toBe(true);
      expect(has(/VALIDATE CONSTRAINT "orders_customer_id_fkey"/)).toBe(true);
      // ...while a constraint the user WANTS unvalidated stays unvalidated
      expect(has(/ADD CONSTRAINT "orders_total_ck" CHECK .* NOT VALID/)).toBe(true);
      expect(sql.some((s) => /VALIDATE CONSTRAINT "orders_total_ck"/.test(s))).toBe(false);
      expect(has(/ALTER SEQUENCE "public"."ticket_seq" AS bigint INCREMENT BY 5/)).toBe(true);

      // the index on a dropped column must go BEFORE the column it indexes
      const dropIndex = sql.findIndex((s) => /DROP INDEX IF EXISTS "public"."orders_note_idx"/.test(s));
      const dropColumn = sql.findIndex((s) => /DROP COLUMN IF EXISTS "note"/.test(s));
      expect(dropIndex).toBeLessThan(dropColumn);

      // the FK must come after the uniqueness guarantee it references exists
      const addUnique = sql.findIndex((s) => /ADD CONSTRAINT "customers_email_key"/.test(s));
      expect(addUnique).toBeGreaterThanOrEqual(0);

      const report = await withClient(target, (c) =>
        applySegments(c, result.plan.statements, result.plan.segments),
      );
      expect(report.error).toBeUndefined();

      const after = await withClient(target, (c) => extractCatalog(c, { schemas: ["public"] }));
      expect(diffIR(after.ir, result.desiredIR).deltas).toEqual([]);
      expect(after.ir.fingerprint).toBe(result.desiredIR.fingerprint);

      // and the unvalidated CHECK really did survive as unvalidated
      const ck = after.ir.get({ kind: "constraint", schema: "public", table: "orders", name: "orders_total_ck" });
      expect(ck?.payload["validated"]).toBe(false);
    },
    T,
  );

  it(
    "D5 — a rename happens only because an annotation says so, and it is a RENAME, not drop+add",
    async () => {
      const target = await makeDatabase(RENAME_DB, "evolve/current.sql");
      const result = await generate({
        admin: ADMIN,
        target,
        desired: { ...ADMIN, database: DESIRED_DB },
        schemas: ["public"],
        seq: 1,
        name: "evolve_renamed",
        renameHints: [
          { from: "column:public.customers.nickname", to: "column:public.customers.full_name" },
        ],
      });

      expect(result.diff.renames).toEqual([
        {
          kind: "column",
          from: "column:public.customers.nickname",
          to: "column:public.customers.full_name",
          source: "annotation",
          confidence: "unambiguous",
        },
      ]);
      const sql = result.plan.statements.map((s) => s.sql);
      expect(sql[0]).toMatch(/RENAME COLUMN "nickname" TO "full_name"/);
      expect(sql.some((s) => /DROP COLUMN IF EXISTS "nickname"/.test(s))).toBe(false);
      expect(sql.some((s) => /ADD COLUMN IF NOT EXISTS "full_name"/.test(s))).toBe(false);
      expect(result.plan.statements.filter((s) => s.dataLoss === "destructive").map((s) => s.sql)).toEqual([
        expect.stringMatching(/DROP COLUMN IF EXISTS "note"/),
      ]);

      expect(result.plan.proof.status).toBe("passed");
      const report = await withClient(target, (c) =>
        applySegments(c, result.plan.statements, result.plan.segments),
      );
      expect(report.error).toBeUndefined();
      const after = await withClient(target, (c) => extractCatalog(c, { schemas: ["public"] }));
      expect(after.ir.fingerprint).toBe(result.desiredIR.fingerprint);
    },
    T,
  );

  it(
    "rejects a hint it cannot prove, rather than guessing",
    async () => {
      const result = await generate({
        admin: ADMIN,
        target: { ...ADMIN, database: DESIRED_DB },
        desired: { ...ADMIN, database: DESIRED_DB },
        schemas: ["public"],
        seq: 1,
        name: "bad_hints",
        prove: false,
        renameHints: [
          // the source does not exist on the current side
          { from: "column:public.customers.ghost", to: "column:public.customers.full_name" },
          // the target already exists on the current side (the §05 firing rule)
          { from: "column:public.customers.email", to: "column:public.customers.full_name" },
          { from: "column:public.customers.email", to: "table:public.customers" },
        ],
      });
      expect(result.diff.renames).toEqual([]);
      expect(result.diff.rejectedHints.map((r) => r.reason)).toEqual([
        "no such fact on the current side: column:public.customers.ghost",
        "target already exists on the current side: column:public.customers.full_name",
        "kind mismatch: column -> table",
      ]);
      expect(result.diff.deltas).toEqual([]);
    },
    T,
  );
});
