import { index, pgTable } from "pg-prime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCatalog } from "../src/catalog/extract.js";
import { runSqlScript, withClient, type ConnInfo } from "../src/db/pg.js";
import { buildStatements } from "../src/diff/ddl.js";
import { diffIR } from "../src/diff/diff.js";
import { generateFromDatabases } from "../src/generate.js";
import { encodeId } from "../src/ir/stable-id.js";
import { emitTypeScript } from "../src/pull/emit-ts.js";
import { applySegments } from "../src/runner/apply.js";
import { emitSchema } from "../src/schema/emit.js";
import { loadDesired } from "../src/schema/load.js";
import type { Shadow } from "../src/shadow/ladder.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "./support/db.js";

const T = 180_000;
const CUR = "pgprime_collate_cur";
const DES = "pgprime_collate_des";

const blocks = (position: string, tags: string | undefined, title: string | undefined) => ({
  tables: {
    blocks: pgTable(
      "blocks",
      (t) => ({
        id: t.integer().primaryKey(),
        position: t.text().collate(position),
        tags: tags === undefined ? t.text().array() : t.text().array().collate(tags),
        title: title === undefined ? t.text() : t.text().collate(title),
      }),
      (t) => [index("blocks_position_idx").on(t.position)],
    ),
  },
});

const shadowOf = (conn: ConnInfo): Shadow => ({
  conn,
  target: conn,
  schemaMap: new Map([["public", "public"]]),
  tier: 2,
  reason: "test fixture",
  diagnostics: [],
  // oxlint-disable-next-line typescript/require-await -- implements the async dispose seam
  dispose: async () => undefined,
});

const extract = (conn: ConnInfo) => withClient(conn, (c) => extractCatalog(c, { schemas: ["public"] }));

const relfilenodes = (conn: ConnInfo) =>
  withClient(conn, async (c) => {
    const r = await c.query(
      "SELECT relname, relfilenode::text AS f FROM pg_class WHERE relname IN ('blocks', 'blocks_position_idx')",
    );
    return Object.fromEntries(r.rows.map((row) => [row["relname"], row["f"]]));
  });

const BASELINE = `CREATE TABLE blocks (
  id integer PRIMARY KEY,
  position text COLLATE "C" NOT NULL,
  tags text[] COLLATE "C" NOT NULL,
  title text COLLATE "default" NOT NULL
);
CREATE INDEX blocks_position_idx ON blocks (position);`;

/** A fresh target database holding `sql`: every test starts from its own state. */
const target = async (sql = BASELINE): Promise<ConnInfo> => {
  const conn = await makeDatabase(CUR);
  await runSqlScript(conn, sql);
  return conn;
};

const hazardsByColumn = (statements: readonly { sql: string; hazards: readonly string[] }[]) =>
  Object.fromEntries(statements.map((s) => [/ALTER COLUMN "(\w+)"/.exec(s.sql)?.[1], s.hazards]));

beforeAll(async () => {
  expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
}, T);

afterAll(async () => {
  await destroyDatabase(CUR);
  await destroyDatabase(DES);
}, T);

describe("column .collate()", () => {
  it("emits COLLATE in CREATE TABLE", () => {
    const { sql } = emitSchema(blocks("C", "C", undefined));
    expect(sql.join("\n")).toContain(`"position" text COLLATE "C" NOT NULL`);
    expect(sql.join("\n")).toContain(`"tags" text[] COLLATE "C" NOT NULL`);
  });

  it(
    "hand-written DDL matches the DSL: no diff, and pull emits .collate()",
    async () => {
      const cur = await target();
      const des = await makeDatabase(DES);
      const desired = await loadDesired(blocks("C", "C", undefined), shadowOf(des));
      expect(desired.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

      const current = await extract(cur);
      expect(
        current.ir.get({ kind: "column", schema: "public", table: "blocks", name: "title" })?.payload["collation"],
      ).toBe(null);
      expect(diffIR(current.ir, desired.ir).deltas).toEqual([]);

      const pulled = emitTypeScript(current.ir, { schemas: ["public"] });
      expect(pulled.unsupported).toEqual([]);
      expect(pulled.ts).toContain(`t.text("position").collate("C")`);
      expect(pulled.ts).toContain(`t.text("tags").array().collate("C")`);
      expect(pulled.ts).toContain(`title: t.text("title"),`);
    },
    T,
  );

  it(
    "a type change that also sets a collation keeps the type-change hazards",
    async () => {
      const cur = await target();
      const des = await makeDatabase(DES);
      const title = pgTable("blocks", (t) => ({
        id: t.integer().primaryKey(),
        position: t.text().collate("C"),
        tags: t.text().array().collate("C"),
        title: t.varchar().collate("C"),
      }));
      await loadDesired({ tables: { blocks: title } }, shadowOf(des));
      const result = await generateFromDatabases({
        admin: ADMIN,
        target: cur,
        desired: des,
        seq: 1,
        name: "collate",
        prove: false,
      });
      expect(result.plan.statements.find((s) => /"title"/.test(s.sql))).toMatchObject({
        sql: `ALTER TABLE "public"."blocks" ALTER COLUMN "title" TYPE character varying COLLATE "C" USING "title"::character varying`,
        hazards: ["LK108", "MF105", "BC103"],
        rewrite: true,
      });
    },
    T,
  );

  it(
    "a collation change is TYPE … COLLATE with LK113, rebuilds the index, not the table, and converges",
    async () => {
      const cur = await target();
      const des = await makeDatabase(DES);
      await loadDesired(blocks("POSIX", undefined, "C"), shadowOf(des));
      const result = await generateFromDatabases({ admin: ADMIN, target: cur, desired: des, seq: 1, name: "collate" });

      expect(result.plan.statements.map((s) => [s.sql, s.hazards, s.rewrite])).toEqual([
        [`ALTER TABLE "public"."blocks" ALTER COLUMN "position" TYPE text COLLATE "POSIX"`, ["LK113"], false],
        [`ALTER TABLE "public"."blocks" ALTER COLUMN "tags" TYPE text[]`, ["LK113"], false],
        [`ALTER TABLE "public"."blocks" ALTER COLUMN "title" TYPE text COLLATE "C"`, ["LK113"], false],
      ]);
      expect(result.plan.hazards.map((h) => h.severity)).toEqual(["warn", "warn", "warn"]);
      expect(result.plan.proof.status).toBe("passed");

      const before = await relfilenodes(cur);
      const report = await withClient(cur, (c) => applySegments(c, result.plan.statements, result.plan.segments));
      expect(report.error).toBeUndefined();
      const after = await relfilenodes(cur);
      expect(after["blocks"]).toBe(before["blocks"]);
      expect(after["blocks_position_idx"]).not.toBe(before["blocks_position_idx"]);

      const applied = await extract(cur);
      expect(diffIR(applied.ir, result.desiredIR).deltas).toEqual([]);
      expect(applied.ir.fingerprint).toBe(result.desiredIR.fingerprint);
    },
    T,
  );

  it(
    "MF107 on a column a unique index, unique constraint or CHECK covers, unless the table is proven empty",
    async () => {
      const table = (collate: string) => `CREATE TABLE blocks (
        id integer PRIMARY KEY,
        position text ${collate} NOT NULL,
        title text ${collate} NOT NULL UNIQUE,
        code text ${collate} NOT NULL,
        tag text ${collate} NOT NULL CHECK (tag <> 'blocks'),
        blocks text ${collate} NOT NULL
      );
      CREATE INDEX blocks_position_idx ON blocks (position);
      CREATE UNIQUE INDEX blocks_code_idx ON blocks (lower(code));`;
      const cur = await target(table(""));
      const des = await makeDatabase(DES);
      await runSqlScript(des, table(`COLLATE "C"`));
      const result = await generateFromDatabases({
        admin: ADMIN,
        target: cur,
        desired: des,
        seq: 1,
        name: "collate",
        prove: false,
      });
      expect(hazardsByColumn(result.plan.statements)).toEqual({
        position: ["LK113"],
        title: ["LK113", "MF107"],
        code: ["LK113", "MF107"],
        tag: ["LK113", "MF107"],
        blocks: ["LK113"],
      });
      expect(result.plan.hazards.filter((h) => h.code === "MF107").map((h) => h.severity)).toEqual([
        "error",
        "error",
        "error",
      ]);

      const diff = diffIR((await extract(cur)).ir, result.desiredIR);
      const emptyTables = new Set([encodeId({ kind: "table", schema: "public", name: "blocks" })]);
      const built = buildStatements(diff, result.desiredIR, { emptyTables });
      expect(built.statements.flatMap((s) => s.hazards)).not.toContain("MF107");
    },
    T,
  );

  it(
    "a collation outside pg_catalog is extracted qualified, applied qualified, and not pulled",
    async () => {
      const collation = `CREATE COLLATION public.bytes FROM "C";`;
      const cur = await target(`${collation} CREATE TABLE blocks (id integer PRIMARY KEY);`);
      const des = await makeDatabase(DES);
      await runSqlScript(
        des,
        `${collation} CREATE TABLE blocks (id integer PRIMARY KEY, title text COLLATE public.bytes);`,
      );

      const desired = await extract(des);
      expect(
        desired.ir.get({ kind: "column", schema: "public", table: "blocks", name: "title" })?.payload["collation"],
      ).toBe(`"public"."bytes"`);

      const pulled = emitTypeScript(desired.ir, { schemas: ["public"] });
      expect(pulled.ts).toContain(`title: t.text("title").nullable(),`);
      expect(pulled.unsupported).toEqual([
        {
          kind: "column collation",
          name: "public.blocks.title",
          reason: `COLLATE "public"."bytes" — \`.collate()\` names only pg_catalog collations`,
        },
      ]);

      const result = await generateFromDatabases({ admin: ADMIN, target: cur, desired: des, seq: 1, name: "collate" });
      expect(result.plan.statements.map((s) => s.sql)).toEqual([
        `ALTER TABLE "public"."blocks" ADD COLUMN IF NOT EXISTS "title" text COLLATE "public"."bytes"`,
      ]);
      const report = await withClient(cur, (c) => applySegments(c, result.plan.statements, result.plan.segments));
      expect(report.error).toBeUndefined();
      expect(diffIR((await extract(cur)).ir, desired.ir).deltas).toEqual([]);
    },
    T,
  );
});
