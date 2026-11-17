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
const version = (await serverAvailable())
  ? await withAdmin(async (c) =>
      Number((await c.query("SELECT current_setting('server_version_num') AS v")).rows[0]?.["v"]),
    )
  : 0;

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

/** Apply the plan to the target for real, then run `fn` against the migrated database. */
const applied = async <R>(p: Pair, fn: (c: ConnInfo) => Promise<R>): Promise<R> => {
  const report = await withClient(p.target, (c) => applySegments(c, p.result.plan.statements, p.result.plan.segments));
  expect(report.error).toBeUndefined();
  return fn(p.target);
};

beforeAll(async () => {
  expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
}, T);
afterAll(async () => {
  for (const db of dbs) await destroyDatabase(db).catch(() => undefined);
}, T);

describe("a retype sheds its DEFAULT first and sets it again after", () => {
  it(
    "text -> enum with a literal default: DROP DEFAULT, ALTER TYPE, SET DEFAULT",
    async () => {
      const p = await pair(
        "retype",
        `CREATE TABLE public.jobs (id int PRIMARY KEY, status text NOT NULL DEFAULT 'new');
         INSERT INTO public.jobs VALUES (1, 'new'), (2, 'done');`,
        `CREATE TYPE public.job_status AS ENUM ('new', 'done');
         CREATE TABLE public.jobs (id int PRIMARY KEY, status public.job_status NOT NULL DEFAULT 'new');`,
      );
      const { sql } = p;
      const drop = at(sql, /ALTER COLUMN "status" DROP DEFAULT/);
      const retype = at(sql, /ALTER COLUMN "status" TYPE public\.job_status USING "status"::public\.job_status/);
      const set = at(sql, /ALTER COLUMN "status" SET DEFAULT 'new'::public\.job_status/);
      expect([drop, retype, set].every((i) => i >= 0)).toBe(true);
      expect(drop).toBeLessThan(retype);
      expect(retype).toBeLessThan(set);
      expect(p.result.plan.proof.status).toBe("passed");

      const rows = await applied(p, (t) =>
        withClient(t, async (c) => {
          await c.query("INSERT INTO public.jobs (id) VALUES (3)");
          return (await c.query("SELECT status::text AS s FROM public.jobs ORDER BY id")).rows.map((r) => r["s"]);
        }),
      );
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

describe("a generation expression change is SET EXPRESSION", () => {
  it.skipIf(version < 170000)(
    "on a STORED column it rewrites (LK108)",
    async () => {
      const p = await pair(
        "stored_expr",
        `CREATE TABLE public.m (a int NOT NULL, b int NOT NULL, s int GENERATED ALWAYS AS (a + b) STORED);
         INSERT INTO public.m VALUES (2, 3);`,
        `CREATE TABLE public.m (a int NOT NULL, b int NOT NULL, s int GENERATED ALWAYS AS (a * b) STORED);`,
      );
      expect(p.sql).toEqual(['ALTER TABLE "public"."m" ALTER COLUMN "s" SET EXPRESSION AS ((a * b))']);
      expect(p.result.plan.statements[0]?.hazards).toEqual(["LK108"]);
      expect(p.result.plan.proof.status).toBe("passed");
      const s = await applied(p, (t) =>
        withClient(t, async (c) => (await c.query("SELECT s FROM public.m")).rows[0]?.["s"]),
      );
      expect(s).toBe(6);
    },
    T,
  );

  it.skipIf(version < 180000)(
    "on a VIRTUAL column it is catalog-only",
    async () => {
      const p = await pair(
        "virtual_expr",
        `CREATE TABLE public.m (a int NOT NULL, b int NOT NULL, v int GENERATED ALWAYS AS (a + b) VIRTUAL);`,
        `CREATE TABLE public.m (a int NOT NULL, b int NOT NULL, v int GENERATED ALWAYS AS (a * b) VIRTUAL);`,
      );
      expect(p.sql).toEqual(['ALTER TABLE "public"."m" ALTER COLUMN "v" SET EXPRESSION AS ((a * b))']);
      expect(p.result.plan.statements[0]?.hazards).toEqual([]);
      expect(p.result.plan.proof.status).toBe("passed");
    },
    T,
  );
});

describe("adding an identity continues the numbering from the rows", () => {
  it(
    "serial: DROP DEFAULT, DROP SEQUENCE, ADD IDENTITY, then setval; the next id follows the old max",
    async () => {
      const p = await pair(
        "identity",
        `CREATE TABLE public.tickets (id serial PRIMARY KEY, code text NOT NULL);
         INSERT INTO public.tickets (code) VALUES ('a'), ('b'), ('c');`,
        `CREATE TABLE public.tickets (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, code text NOT NULL);`,
      );
      const { sql } = p;
      const order = [
        at(sql, /ALTER COLUMN "id" DROP DEFAULT/),
        at(sql, /DROP SEQUENCE IF EXISTS "public"."tickets_id_seq"/),
        at(sql, /ADD GENERATED BY DEFAULT AS IDENTITY/),
        at(sql, /setval\(pg_get_serial_sequence\('"public"."tickets"', 'id'\), max\("id"\)\)/),
      ];
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      // the counter is carried over, so the sequence drop is not a data loss
      expect(p.result.plan.hazards.filter((h) => h.code === "DS107")).toEqual([]);
      expect(p.result.plan.proof.status).toBe("passed");

      const after = await applied(p, (t) =>
        withClient(t, async (c) => ({
          next: (await c.query("INSERT INTO public.tickets (code) VALUES ('d') RETURNING id")).rows[0]?.["id"],
          seq: (await c.query("SELECT pg_get_serial_sequence('public.tickets', 'id') AS s")).rows[0]?.["s"],
        })),
      );
      expect(after).toEqual({ next: 4, seq: "public.tickets_id_seq" });
    },
    T,
  );

  it(
    "a plain populated column with no default gets the setval too",
    async () => {
      const p = await pair(
        "identity_plain",
        `CREATE TABLE public.tickets (id integer PRIMARY KEY, code text NOT NULL);
         INSERT INTO public.tickets VALUES (10, 'a'), (20, 'b');`,
        `CREATE TABLE public.tickets (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, code text NOT NULL);`,
      );
      expect(at(p.sql, /ADD GENERATED BY DEFAULT AS IDENTITY/)).toBeLessThan(at(p.sql, /setval\(/));
      expect(p.sql.filter((s) => /DROP DEFAULT|DROP SEQUENCE/.test(s))).toEqual([]);
      expect(p.result.plan.proof.status).toBe("passed");
      const next = await applied(p, (t) =>
        withClient(
          t,
          async (c) => (await c.query("INSERT INTO public.tickets (code) VALUES ('c') RETURNING id")).rows[0]?.["id"],
        ),
      );
      expect(next).toBe(21);
    },
    T,
  );
});

describe("PostgreSQL 18 virtual generated columns", () => {
  it.skipIf(version < 180000)(
    "are emitted as GENERATED ALWAYS AS (…) VIRTUAL in CREATE TABLE and ADD COLUMN",
    async () => {
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
