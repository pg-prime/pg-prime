/**
 * design/06 §3.5 rows 1, 6 and 7 — the three lock-safe rewrites K3 could not build.
 *
 * All three were blocked on one thing: `CREATE INDEX CONCURRENTLY` cannot run inside a
 * transaction, so a plan containing one cannot also be an atomic DDL file. `generate` now
 * cuts the plan into `NNNN_x.sql` (transactional) and `NNNN_x_concurrently.sql`
 * (`txmode none`), which §4.1's `(seq, name)` ordering applies in that order.
 *
 * Every case here goes all the way to the catalog: the plan is generated, proven (D6) and
 * witnessed (D10 strict), then applied through the **runner** and re-read out of
 * `pg_catalog`. A rewrite that produces a different catalog state from the literal form is
 * not a rewrite, it is a bug, and only the last two steps can tell the difference.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineSchema, index, pgTable } from "pg-prime";
import { withClient } from "../../src/db/pg.js";
import { generate } from "../../src/generate.js";
import { lintPlan } from "../../src/lint/lint.js";
import { applyPending } from "../../src/runner/run.js";
import type { SchemaLike } from "../../src/schema/types.js";
import { ADMIN, dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { tempDir } from "../support/migrations.js";

const T = 300_000;

const asSchemaLike = (s: unknown): SchemaLike => s as SchemaLike;

/* -------------------------------------------------------------------------- */

interface Case {
  readonly slug: string;
  /** what the target already holds */
  readonly current: string;
  /** rows, so `probeEmptiness` answers honestly */
  readonly seed?: string;
  readonly schema: SchemaLike;
}

/** Row 1: a plain index on a table that already exists. */
const rowOne: Case = {
  slug: "cic",
  current: `CREATE TABLE public.orders (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      status text NOT NULL
    );`,
  schema: asSchemaLike(
    defineSchema({
      orders: pgTable(
        "orders",
        (t) => ({
          id: t.bigint().generatedAlways().primaryKey(),
          status: t.text(),
        }),
        (t) => [index("orders_status_idx").on(t.status)],
      ),
    }),
  ),
};

/** Row 6: a UNIQUE constraint added to a table that already exists. */
const rowSix: Case = {
  slug: "usingidx",
  current: `CREATE TABLE public.people (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      email text NOT NULL
    );`,
  schema: asSchemaLike(
    defineSchema({
      people: pgTable("people", (t) => ({
        id: t.bigint().generatedAlways().primaryKey(),
        email: t.text().unique(),
      })),
    }),
  ),
};

/** Row 7: a nullable column with a VOLATILE default, on a table with rows in it. */
const rowSeven: Case = {
  slug: "volatile",
  current: `CREATE TABLE public.tickets (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      subject text NOT NULL
    );`,
  seed: "INSERT INTO public.tickets (subject) VALUES ('one'), ('two')",
  schema: asSchemaLike(
    defineSchema({
      tickets: pgTable("tickets", (t) => ({
        id: t.bigint().generatedAlways().primaryKey(),
        subject: t.text(),
        token: t.uuid().nullable().defaultSql("gen_random_uuid()"),
      })),
    }),
  ),
};

async function run(c: Case): Promise<{
  files: Awaited<ReturnType<typeof generate>>["files"];
  result: Awaited<ReturnType<typeof generate>>;
  dir: string;
  database: string;
}> {
  const database = `pgprime_k2b_rw_${c.slug}`;
  await makeDatabase(database);
  await withClient(dbConn(database), async (client) => {
    await client.query(c.current);
    if (c.seed) await client.query(c.seed);
  });
  const dir = join(await tempDir(`pgprime-k2b-rw-${c.slug}`), "migrations");
  await mkdir(dir, { recursive: true });
  const result = await generate({
    admin: ADMIN,
    target: dbConn(database),
    schema: c.schema,
    schemas: ["public"],
    seq: 1,
    name: c.slug,
    outDir: dir,
    dumpOracle: "strict",
  });
  return { files: result.files, result, dir, database };
}

describe("design/06 §3.5 — the three rewrites that need a second file", () => {
  it(
    "row 1: CREATE INDEX becomes DROP INDEX CONCURRENTLY IF EXISTS + CREATE INDEX CONCURRENTLY, in a txmode none file",
    async () => {
      expect(await serverAvailable()).toBe(true);
      const { files, result, dir, database } = await run(rowOne);
      try {
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("generated");
        expect(result.proof?.status, result.proof?.error).toBe("passed");
        expect(result.proof?.dumpOracle?.status).toBe("passed");

        expect(files.map((f) => `${f.id}:${f.stage}`)).toEqual([
          "0001_cic_concurrently:concurrent",
        ]);
        const plan = files[0]!.plan!;
        expect(plan.txmode).toBe("none");
        expect(plan.statements.map((s) => s.sql)).toEqual([
          'DROP INDEX CONCURRENTLY IF EXISTS "public"."orders_status_idx"',
          'CREATE INDEX CONCURRENTLY "orders_status_idx" ON public.orders USING btree (status)',
        ]);
        // The DROP prefix is what makes the CIC replayable from statement 0, which is where
        // §5.4's resume restarts — so both are `idempotent` and TX201 has nothing to say.
        expect(plan.statements.every((s) => s.idempotent)).toBe(true);
        const sqlText = await readFile(files[0]!.sqlPath!, "utf8");
        const lint = lintPlan(plan, sqlText);
        expect(lint.findings.filter((f) => f.code === "TX201")).toEqual([]);
        expect(lint.findings.filter((f) => f.code === "LK103")).toEqual([]);
        // LK101 is what the rewrite prevents; it must not be reported on the safe form.
        expect(lint.findings.filter((f) => f.code === "LK101")).toEqual([]);

        const applied = await applyPending(dbConn(database), dir, { schemas: ["public"] });
        expect(applied.status, applied.error?.message).toBe("applied");
        const valid = await withClient(dbConn(database), async (client) => {
          const r = await client.query(
            "SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'orders_status_idx'",
          );
          return r.rows[0]?.["indisvalid"];
        });
        expect(valid).toBe(true);
      } finally {
        await destroyDatabase(database).catch(() => undefined);
      }
    },
    T,
  );

  it(
    "row 6: ADD UNIQUE becomes CREATE UNIQUE INDEX CONCURRENTLY + ADD CONSTRAINT … USING INDEX",
    async () => {
      expect(await serverAvailable()).toBe(true);
      const { files, result, dir, database } = await run(rowSix);
      try {
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("generated");
        expect(result.proof?.status, result.proof?.error).toBe("passed");
        // D10: the rewritten form has to land on the SAME catalog state the literal
        // `ALTER TABLE … ADD CONSTRAINT … UNIQUE` would have produced.
        expect(result.proof?.dumpOracle?.status).toBe("passed");

        const plan = files.find((f) => f.stage === "concurrent")!.plan!;
        expect(plan.statements.map((s) => s.sql)).toEqual([
          'ALTER TABLE "public"."people" DROP CONSTRAINT IF EXISTS "people_email_key"',
          'DROP INDEX CONCURRENTLY IF EXISTS "public"."people_email_key"',
          'CREATE UNIQUE INDEX CONCURRENTLY "people_email_key" ON "public"."people" USING btree (email)',
          'ALTER TABLE "public"."people" ADD CONSTRAINT "people_email_key" UNIQUE USING INDEX "people_email_key"',
        ]);
        // LK104 is the ACCESS EXCLUSIVE index build the rewrite exists to avoid.
        expect(plan.hazards.map((h) => h.code)).not.toContain("LK104");

        const applied = await applyPending(dbConn(database), dir, { schemas: ["public"] });
        expect(applied.status, applied.error?.message).toBe("applied");
        const row = await withClient(dbConn(database), async (client) => {
          const r = await client.query(
            `SELECT c.contype, c.conname, i.indisunique, i.indisvalid
               FROM pg_constraint c JOIN pg_index i ON i.indexrelid = c.conindid
              WHERE c.conrelid = 'public.people'::regclass AND c.contype = 'u'`,
          );
          return r.rows[0];
        });
        expect(row).toMatchObject({ contype: "u", conname: "people_email_key", indisunique: true, indisvalid: true });
      } finally {
        await destroyDatabase(database).catch(() => undefined);
      }
    },
    T,
  );

  it(
    "row 7: ADD COLUMN with a volatile default splits, and writes a -- pg-prime:data stub with a TODO",
    async () => {
      expect(await serverAvailable()).toBe(true);
      const { files, result, dir, database } = await run(rowSeven);
      try {
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("generated");
        expect(result.proof?.status, result.proof?.error).toBe("passed");

        const main = files.find((f) => f.stage === "main")!;
        expect(main.plan!.statements.map((s) => s.sql)).toEqual([
          'ALTER TABLE "public"."tickets" ADD COLUMN IF NOT EXISTS "token" uuid',
          'ALTER TABLE "public"."tickets" ALTER COLUMN "token" SET DEFAULT gen_random_uuid()',
        ]);
        // The whole point: no table rewrite, and therefore no LK109.
        expect(main.plan!.statements.some((s) => s.rewrite)).toBe(false);
        expect(main.plan!.hazards.map((h) => h.code)).not.toContain("LK109");

        const stub = files.find((f) => f.stage === "data");
        expect(stub, "the split must scaffold its own backfill").toBeDefined();
        expect(stub!.plan, "a stub has no plan: there is no diff behind a file you have to write").toBeNull();
        expect(stub!.sql).toContain("-- pg-prime:data");
        expect(stub!.sql).toContain("TODO: backfill public.tickets.token");
        // Applied unedited it must FAIL, not be silently recorded as done.
        expect(stub!.sql).toContain("RAISE EXCEPTION");
        // …and behind the guard, a WORKING keyset batch (design/12 K4 item 1): the batch
        // directive, the two GUCs the runner publishes, and the two columns it reads back.
        expect(stub!.sql).toContain("-- pg-prime:batch");
        expect(stub!.sql).toContain("UPDATE public.tickets AS t");
        expect(stub!.sql).toContain("SET token = DEFAULT");
        expect(stub!.sql).toContain("current_setting('pgprime.batch_size')::int");
        expect(stub!.sql).toContain("nullif(current_setting('pgprime.watermark', true), '')");
        expect(stub!.sql).toContain("AS rows_done");
        expect(stub!.sql).toContain("AS watermark");

        const applied = await applyPending(dbConn(database), dir, { schemas: ["public"] });
        expect(applied.status).toBe("failed");
        expect(applied.error?.message).toContain("STUB");

        const state = await withClient(dbConn(database), async (client) => {
          const r = await client.query(
            "SELECT count(*) FILTER (WHERE token IS NULL)::int AS nulls, count(*)::int AS total FROM public.tickets",
          );
          const d = await client.query(
            "SELECT pg_get_expr(ad.adbin, ad.adrelid) AS expr FROM pg_attrdef ad JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum WHERE ad.adrelid = 'public.tickets'::regclass AND a.attname = 'token'",
          );
          return { nulls: r.rows[0]?.["nulls"], total: r.rows[0]?.["total"], expr: d.rows[0]?.["expr"] };
        });
        // The existing rows are exactly what the stub is FOR: still NULL, and the default
        // is in place so new rows are not.
        expect(state).toMatchObject({ nulls: 2, total: 2, expr: "gen_random_uuid()" });
      } finally {
        await destroyDatabase(database).catch(() => undefined);
      }
    },
    T,
  );

  it(
    "--no-safe-rewrite puts the literal single-file form back, with its hazards",
    async () => {
      expect(await serverAvailable()).toBe(true);
      const database = "pgprime_k2b_rw_literal";
      await makeDatabase(database);
      await withClient(dbConn(database), async (client) => {
        await client.query(rowOne.current);
      });
      try {
        const result = await generate({
          admin: ADMIN,
          target: dbConn(database),
          schema: rowOne.schema,
          schemas: ["public"],
          seq: 1,
          name: "literal",
          noSafeRewrite: true,
          dumpOracle: "strict",
        });
        expect(result.files).toHaveLength(1);
        const plan = result.files[0]!.plan!;
        expect(plan.txmode).toBe("transactional");
        expect(plan.statements.map((s) => s.sql)).toEqual([
          'CREATE INDEX "orders_status_idx" ON public.orders USING btree (status)',
        ]);
        expect(plan.hazards.map((h) => h.code)).toContain("LK101");
      } finally {
        await destroyDatabase(database).catch(() => undefined);
      }
    },
    T,
  );

  it(
    "--no-prove is refused for a plan that spans two files, because the intermediate fingerprint is measured",
    async () => {
      expect(await serverAvailable()).toBe(true);
      const database = "pgprime_k2b_rw_noprove";
      await makeDatabase(database);
      await withClient(dbConn(database), async (client) => {
        await client.query(rowOne.current);
      });
      // A column AND an index, so the plan really does span a transactional file and a
      // concurrent one — a concurrent-only plan is a single file and needs no intermediate.
      const twoStage = asSchemaLike(
        defineSchema({
          orders: pgTable(
            "orders",
            (t) => ({
              id: t.bigint().generatedAlways().primaryKey(),
              status: t.text(),
              note: t.text().nullable(),
            }),
            (t) => [index("orders_status_idx").on(t.status)],
          ),
        }),
      );
      try {
        await expect(
          generate({
            admin: ADMIN,
            target: dbConn(database),
            schema: twoStage,
            schemas: ["public"],
            seq: 1,
            name: "noprove",
            prove: false,
          }),
        ).rejects.toThrow(/--no-prove cannot produce a plan that spans/);
      } finally {
        await destroyDatabase(database).catch(() => undefined);
      }
    },
    T,
  );
});
