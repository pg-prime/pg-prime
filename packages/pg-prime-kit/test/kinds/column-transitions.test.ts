/**
 * Column transitions whose statements only work in one order.
 *
 * A retype and an ADD IDENTITY both trip over the column's DEFAULT: PostgreSQL cannot cast
 * `'new'::text` to an enum on its own, and refuses an identity beside a default. A serial's
 * sequence has to go before the identity's own is created, or the numbering restarts at 1
 * and the next INSERT is a duplicate key.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSqlScript, withClient } from "../../src/db/pg.js";
import { generateFromDatabases as generate, type DatabaseGenerateResult } from "../../src/generate.js";
import { applySegments } from "../../src/runner/apply.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable, withAdmin } from "../support/db.js";
import type { ConnInfo } from "../../src/db/pg.js";

const T = 180_000;
const dbs: string[] = [];

interface Pair {
  readonly target: ConnInfo;
  readonly result: DatabaseGenerateResult;
  readonly sql: string[];
}

async function pair(name: string, current: string, desired: string): Promise<Pair> {
  const cur = `pgprime_coltr_${name}_cur`;
  const des = `pgprime_coltr_${name}_des`;
  dbs.push(cur, des);
  const target = await makeDatabase(cur);
  await runSqlScript(target, current);
  const wanted = await makeDatabase(des);
  await runSqlScript(wanted, desired);
  const result = await generate({
    admin: ADMIN,
    target,
    desired: wanted,
    schemas: ["public"],
    seq: 1,
    name,
    dumpOracle: "strict",
  });
  return { target, result, sql: result.plan.statements.map((s) => s.sql) };
}

const at = (sql: string[], re: RegExp): number => sql.findIndex((s) => re.test(s));

const serverVersion = (): Promise<number> =>
  withAdmin(async (c) =>
    Number((await c.query("SELECT current_setting('server_version_num') AS v")).rows[0]?.["v"]),
  ).catch(() => 0);

describe("a retype sheds its DEFAULT first and sets it again after", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
  }, T);
  afterAll(async () => {
    for (const db of dbs) await destroyDatabase(db).catch(() => undefined);
  }, T);

  it(
    "text -> enum with a literal default: DROP DEFAULT, ALTER TYPE, SET DEFAULT",
    async () => {
      const { target, result, sql } = await pair(
        "retype",
        `CREATE TABLE public.jobs (id int PRIMARY KEY, status text NOT NULL DEFAULT 'new');
         INSERT INTO public.jobs VALUES (1, 'new'), (2, 'done');`,
        `CREATE TYPE public.job_status AS ENUM ('new', 'done');
         CREATE TABLE public.jobs (id int PRIMARY KEY, status public.job_status NOT NULL DEFAULT 'new');`,
      );
      const drop = at(sql, /ALTER COLUMN "status" DROP DEFAULT/);
      const retype = at(sql, /ALTER COLUMN "status" TYPE public\.job_status USING "status"::public\.job_status/);
      const set = at(sql, /ALTER COLUMN "status" SET DEFAULT 'new'::public\.job_status/);
      expect([drop, retype, set].every((i) => i >= 0)).toBe(true);
      expect(drop).toBeLessThan(retype);
      expect(retype).toBeLessThan(set);
      expect(result.plan.proof.status).toBe("passed");

      const report = await withClient(target, (c) => applySegments(c, result.plan.statements, result.plan.segments));
      expect(report.error).toBeUndefined();
      const rows = await withClient(target, async (c) => {
        await c.query("INSERT INTO public.jobs (id) VALUES (3)");
        return (await c.query("SELECT status::text AS s FROM public.jobs ORDER BY id")).rows.map((r) => r["s"]);
      });
      expect(rows).toEqual(["new", "done", "new"]);
    },
    T,
  );

  it(
    "a default the desired side dropped still goes before the ALTER TYPE",
    async () => {
      const { result, sql } = await pair(
        "retype_nodefault",
        `CREATE TABLE public.jobs (id int PRIMARY KEY, status text DEFAULT 'new');`,
        `CREATE TYPE public.job_status AS ENUM ('new', 'done');
         CREATE TABLE public.jobs (id int PRIMARY KEY, status public.job_status);`,
      );
      expect(at(sql, /DROP DEFAULT/)).toBeLessThan(at(sql, /ALTER COLUMN "status" TYPE/));
      expect(sql.filter((s) => /SET DEFAULT/.test(s))).toEqual([]);
      expect(result.plan.proof.status).toBe("passed");
    },
    T,
  );

  it(
    "a STORED generated column is retyped without USING",
    async () => {
      const { result, sql } = await pair(
        "generated",
        `CREATE TABLE public.invoices (id bigint PRIMARY KEY, price numeric(12,2) NOT NULL, qty integer NOT NULL,
           total numeric(14,2) GENERATED ALWAYS AS (price * qty) STORED);`,
        `CREATE TABLE public.invoices (id bigint PRIMARY KEY, price numeric(12,2) NOT NULL, qty integer NOT NULL,
           total numeric(16,2) GENERATED ALWAYS AS (price * qty) STORED);`,
      );
      expect(sql.filter((s) => / TYPE /.test(s))).toEqual([
        'ALTER TABLE "public"."invoices" ALTER COLUMN "total" TYPE numeric(16,2)',
      ]);
      expect(result.plan.proof.status).toBe("passed");
    },
    T,
  );
});

describe("serial -> identity keeps the numbering", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
  }, T);

  it(
    "DROP DEFAULT, DROP SEQUENCE, ADD IDENTITY, then setval from the rows; the next id follows the old max",
    async () => {
      const { target, result, sql } = await pair(
        "identity",
        `CREATE TABLE public.tickets (id serial PRIMARY KEY, code text NOT NULL);
         INSERT INTO public.tickets (code) VALUES ('a'), ('b'), ('c');`,
        `CREATE TABLE public.tickets (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, code text NOT NULL);`,
      );
      const order = [
        at(sql, /ALTER COLUMN "id" DROP DEFAULT/),
        at(sql, /DROP SEQUENCE IF EXISTS "public"."tickets_id_seq"/),
        at(sql, /ADD GENERATED BY DEFAULT AS IDENTITY/),
        at(sql, /setval\(pg_get_serial_sequence\('"public"."tickets"', 'id'\), max\("id"\)\)/),
      ];
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      // the counter is carried over, so the sequence drop is not a data loss
      expect(result.plan.hazards.filter((h) => h.code === "DS107")).toEqual([]);
      expect(result.plan.proof.status).toBe("passed");

      const report = await withClient(target, (c) => applySegments(c, result.plan.statements, result.plan.segments));
      expect(report.error).toBeUndefined();
      const after = await withClient(target, async (c) => ({
        next: (await c.query("INSERT INTO public.tickets (code) VALUES ('d') RETURNING id")).rows[0]?.["id"],
        seq: (await c.query("SELECT pg_get_serial_sequence('public.tickets', 'id') AS s")).rows[0]?.["s"],
      }));
      expect(after).toEqual({ next: 4, seq: "public.tickets_id_seq" });
    },
    T,
  );
});

describe("PostgreSQL 18 virtual generated columns", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
  }, T);

  it(
    "are emitted as GENERATED ALWAYS AS (…) VIRTUAL in CREATE TABLE and ADD COLUMN",
    async () => {
      if ((await serverVersion()) < 180000) return;
      const { result, sql } = await pair(
        "virtual",
        `CREATE TABLE public.tags (id bigint PRIMARY KEY, name text NOT NULL);`,
        `CREATE TABLE public.tags (id bigint PRIMARY KEY, name text NOT NULL,
           slug text GENERATED ALWAYS AS (lower(name)) VIRTUAL);
         CREATE TABLE public.labels (id bigint PRIMARY KEY, name text NOT NULL,
           upper_name text GENERATED ALWAYS AS (upper(name)) VIRTUAL);`,
      );
      expect(sql.filter((s) => /VIRTUAL/.test(s)).length).toBe(2);
      expect(sql).toContain(
        'ALTER TABLE "public"."tags" ADD COLUMN IF NOT EXISTS "slug" text GENERATED ALWAYS AS (lower(name)) VIRTUAL',
      );
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(result.plan.proof.status).toBe("passed");
    },
    T,
  );
});
