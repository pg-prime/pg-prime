/**
 * Types depend on types: a domain over a user enum, a composite with a user-typed
 * attribute. Ordered by name alone, `a_status AS z_status` is created before `z_status`
 * exists and dropped after it is gone.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSqlScript } from "../../src/db/pg.js";
import { generateFromDatabases as generate } from "../../src/generate.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";

const CUR = "pgprime_typedeps_cur";
const DES = "pgprime_typedeps_des";
const T = 180_000;

const TYPES = `
CREATE TYPE public.z_status AS ENUM ('on', 'off');
CREATE DOMAIN public.a_status AS public.z_status;
CREATE DOMAIN public.a_statuses AS public.z_status[];
CREATE TYPE public.a_pair AS (first public.z_status, second public.a_status);
CREATE TABLE public.things (id int PRIMARY KEY, s public.a_status, p public.a_pair);`;

const at = (sql: string[], re: RegExp): number => sql.findIndex((s) => re.test(s));

describe("user types are ordered by their dependencies, not by name", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
  }, T);
  afterAll(async () => {
    for (const db of [CUR, DES]) await destroyDatabase(db).catch(() => undefined);
  }, T);

  it(
    "the enum is created before the domains and the composite that use it",
    async () => {
      const target = await makeDatabase(CUR);
      const desired = await makeDatabase(DES);
      await runSqlScript(desired, TYPES);
      const result = await generate({
        admin: ADMIN,
        target,
        desired,
        schemas: ["public"],
        seq: 1,
        name: "types",
        dumpOracle: "strict",
      });
      const sql = result.plan.statements.map((s) => s.sql);
      const enumAt = at(sql, /CREATE TYPE "public"."z_status"/);
      for (const re of [
        /CREATE DOMAIN "public"."a_status"/,
        /CREATE DOMAIN "public"."a_statuses"/,
        /CREATE TYPE "public"."a_pair"/,
      ]) {
        expect(at(sql, re)).toBeGreaterThan(enumAt);
      }
      expect(result.plan.proof.status).toBe("passed");
    },
    T,
  );

  it(
    "and dropped after them",
    async () => {
      const target = await makeDatabase(CUR);
      await runSqlScript(target, TYPES);
      const desired = await makeDatabase(DES);
      const result = await generate({
        admin: ADMIN,
        target,
        desired,
        schemas: ["public"],
        seq: 1,
        name: "drop_types",
        dumpOracle: "strict",
        acknowledge: { allowDataLoss: true, reason: "test" },
      });
      const sql = result.plan.statements.map((s) => s.sql);
      const enumAt = at(sql, /DROP TYPE IF EXISTS "public"."z_status"/);
      for (const re of [
        /DROP TYPE IF EXISTS "public"."a_status"/,
        /DROP TYPE IF EXISTS "public"."a_statuses"/,
        /DROP TYPE IF EXISTS "public"."a_pair"/,
      ]) {
        expect(at(sql, re)).toBeLessThan(enumAt);
      }
      expect(result.plan.proof.status).toBe("passed");
    },
    T,
  );
});
