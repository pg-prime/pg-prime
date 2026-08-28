/**
 * Schema lifecycle, in both directions.
 *
 * Forwards is easy; backwards is where a differ that leans on a phase table
 * instead of the dependency graph falls over, because the correct drop order is
 * a property of the catalog edges, not of a name sort.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCatalog } from "../src/catalog/extract.js";
import { withClient } from "../src/db/pg.js";
import { diffIR } from "../src/diff/diff.js";
import { generateFromDatabases as generate } from "../src/generate.js";
import { applySegments } from "../src/runner/apply.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "./support/db.js";

const DESIRED_DB = "pgprime_spike_ms_desired";
const TARGET_DB = "pgprime_spike_ms_target";
const EMPTY_DB = "pgprime_spike_ms_empty";
const SCHEMAS = ["public", "app", "billing"];
const T = 120_000;

describe("multi-schema lifecycle", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
    await makeDatabase(DESIRED_DB, "multi-schema/desired.sql");
    await makeDatabase(TARGET_DB);
    await makeDatabase(EMPTY_DB);
  }, T);

  afterAll(async () => {
    for (const db of [DESIRED_DB, TARGET_DB, EMPTY_DB]) await destroyDatabase(db).catch(() => undefined);
  }, T);

  it(
    "creates schemas before their contents and converges",
    async () => {
      const target = { ...ADMIN, database: TARGET_DB };
      const result = await generate({
        admin: ADMIN,
        target,
        desired: { ...ADMIN, database: DESIRED_DB },
        schemas: SCHEMAS,
        seq: 1,
        name: "multi_schema_up",
      });
      expect(result.plan.proof.status).toBe("passed");

      const sql = result.plan.statements.map((s) => s.sql);
      const at = (re: RegExp): number => sql.findIndex((s) => re.test(s));
      expect(at(/CREATE SCHEMA IF NOT EXISTS "app"/)).toBeLessThan(at(/CREATE TYPE "app"\."plan_tier"/));
      expect(at(/CREATE TYPE "app"\."plan_tier"/)).toBeLessThan(at(/CREATE TABLE "app"\."tenants"/));
      expect(at(/CREATE SCHEMA IF NOT EXISTS "billing"/)).toBeLessThan(at(/CREATE TABLE "billing"\."invoices"/));
      // the cross-schema FK lands after the uniqueness guarantee it references
      expect(at(/ADD CONSTRAINT "tenants_pkey"/)).toBeLessThan(at(/ADD CONSTRAINT "invoices_tenant_id_fkey"/));

      const report = await withClient(target, (c) => applySegments(c, result.plan.statements, result.plan.segments));
      expect(report.error).toBeUndefined();
      const after = await withClient(target, (c) => extractCatalog(c, { schemas: SCHEMAS }));
      expect(diffIR(after.ir, result.desiredIR).deltas).toEqual([]);
      expect(after.ir.fingerprint).toBe(result.desiredIR.fingerprint);
    },
    T,
  );

  it(
    "drops referencing tables before their referents, and schemas last",
    async () => {
      // `app.tenants` sorts BEFORE `billing.invoices`; only the FK edge says it
      // must be dropped second. Same for the enum its column uses.
      const target = { ...ADMIN, database: TARGET_DB };
      const result = await generate({
        admin: ADMIN,
        target,
        desired: { ...ADMIN, database: EMPTY_DB },
        schemas: SCHEMAS,
        seq: 2,
        name: "multi_schema_down",
      });
      expect(result.plan.proof.status).toBe("passed");

      const sql = result.plan.statements.map((s) => s.sql);
      const at = (re: RegExp): number => sql.findIndex((s) => re.test(s));
      expect(at(/DROP TABLE IF EXISTS "billing"\."invoices"/)).toBeLessThan(
        at(/DROP TABLE IF EXISTS "app"\."tenants"/),
      );
      expect(at(/DROP TABLE IF EXISTS "app"\."tenants"/)).toBeLessThan(at(/DROP TYPE IF EXISTS "app"\."plan_tier"/));
      expect(at(/DROP TYPE IF EXISTS "app"\."plan_tier"/)).toBeLessThan(at(/DROP SCHEMA IF EXISTS "app"/));
      expect(at(/DROP TABLE IF EXISTS "billing"\."invoices"/)).toBeLessThan(at(/DROP SCHEMA IF EXISTS "billing"/));
      expect(result.plan.hazards.some((h) => h.code === "DS101")).toBe(true);
      expect(result.plan.hazards.some((h) => h.code === "DS102")).toBe(true);

      const report = await withClient(target, (c) => applySegments(c, result.plan.statements, result.plan.segments));
      expect(report.error).toBeUndefined();
      const after = await withClient(target, (c) => extractCatalog(c, { schemas: SCHEMAS }));
      expect(after.ir.fingerprint).toBe(result.desiredIR.fingerprint);
    },
    T,
  );
});
