/**
 * What the extractor is allowed to be silent about.
 *
 * Three separate silences, all of which produced a plan that could not apply:
 *   - `evaluatedEnumLabels` only recognised all-bare and all-quoted spellings of a type,
 *     so `'refunded'::public."OrderStatus"` earned no `evaluates` edge and the default
 *     was emitted in the same transaction as its `ADD VALUE` (55P04);
 *   - the extension / partition exclusion was applied to `pg_class` only, so a table's
 *     columns and indexes survived it as ORPHAN facts and diffed into `ALTER TABLE` on a
 *     table the plan never creates;
 *   - partitioned parents were emitted as plain tables and inheritance children
 *     converged silently under the default `warn` oracle.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluatedEnumLabels, extractCatalog } from "../src/catalog/extract.js";
import { buildStatements } from "../src/diff/ddl.js";
import { diffIR } from "../src/diff/diff.js";
import { runSqlScript, withClient } from "../src/db/pg.js";
import { SchemaIR } from "../src/ir/fact.js";
import { encodeId } from "../src/ir/stable-id.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "./support/db.js";

const PART = "pgprime_cat_part";
const EXT = "pgprime_cat_ext";
const GEN = "pgprime_cat_gen";
const T = 180_000;

describe("evaluatedEnumLabels finds the type in every spelling pg_get_expr uses", () => {
  const labels = new Map<string, readonly string[]>([
    ["public.OrderStatus", ["pending", "refunded"]],
    ["my schema.order_status", ["pending", "refunded"]],
    ["public.order_status", ["pending", "refunded"]],
  ]);
  const names = (expr: string): string[] =>
    evaluatedEnumLabels(expr, labels)
      .map((id) => encodeId(id))
      .sort();

  it("matches a quoted TYPE name", () => {
    expect(names(`'refunded'::public."OrderStatus"`)).toEqual([
      "enumLabel:public.OrderStatus.refunded",
    ]);
    expect(names(`'refunded'::"public"."OrderStatus"`)).toEqual([
      "enumLabel:public.OrderStatus.refunded",
    ]);
  });

  it("matches a quoted SCHEMA name", () => {
    expect(names(`'refunded'::"my schema".order_status`)).toEqual([
      "enumLabel:my schema.order_status.refunded",
    ]);
    expect(names(`'refunded'::"my schema"."order_status"`)).toEqual([
      "enumLabel:my schema.order_status.refunded",
    ]);
  });

  it("still matches the all-bare and unqualified forms", () => {
    expect(names(`'refunded'::public.order_status`)).toEqual([
      "enumLabel:public.order_status.refunded",
    ]);
    // an UNQUALIFIED cast is genuinely ambiguous; the documented bias is to
    // over-match (a redundant commit boundary) rather than under-match (55P04)
    expect(names(`'refunded'::order_status`)).toEqual([
      "enumLabel:my schema.order_status.refunded",
      "enumLabel:public.order_status.refunded",
    ]);
  });

  it("negative control: a label the expression does not evaluate earns no edge", () => {
    expect(names(`'pending'::public."OrderStatus"`)).toEqual([
      "enumLabel:public.OrderStatus.pending",
    ]);
    expect(names(`'refunded'::text`)).toEqual([]);
    expect(names(`nextval('refunded_seq'::regclass)`)).toEqual([]);
  });
});

describe("live catalog exclusions", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
  }, T);

  afterAll(async () => {
    for (const db of [PART, EXT, GEN]) await destroyDatabase(db).catch(() => undefined);
  }, T);

  it(
    "partitioned and inherited tables are reported, not silently flattened",
    async () => {
      const conn = await makeDatabase(PART, "partitioned/current.sql");
      const r = await withClient(conn, (c) => extractCatalog(c, { schemas: ["public"] }));

      const unsupported = r.diagnostics.filter((d) => d.code === "unsupported_kind");
      expect(unsupported.map((d) => d.subject).sort()).toEqual([
        "table:public.animals",
        "table:public.dogs",
        "table:public.events",
        "table:public.events_2026",
      ]);
      expect(unsupported.every((d) => d.severity === "error")).toBe(true);

      // no facts at all for the excluded relations - not the table, not its columns,
      // not its indexes; and no orphans left behind by a half-applied filter
      const ids = r.ir.facts().map((f) => encodeId(f.id));
      expect(ids.filter((s) => /events|animals|dogs/.test(s))).toEqual([]);
      expect(r.ir.orphans()).toEqual([]);
      // the ordinary table in the same schema is untouched
      expect(r.ir.has({ kind: "table", schema: "public", name: "plain" })).toBe(true);
      expect(r.ir.has({ kind: "column", schema: "public", table: "plain", name: "id" })).toBe(true);
    },
    T,
  );

  it(
    "an extension-owned table takes its columns, constraints and indexes with it",
    async () => {
      const conn = await makeDatabase(EXT);
      await runSqlScript(
        conn,
        `CREATE EXTENSION hstore;
         CREATE TABLE public.ext_owned (id bigint PRIMARY KEY, tags hstore);
         CREATE INDEX ext_owned_tags_idx ON public.ext_owned USING btree (id);
         CREATE SEQUENCE public.ext_owned_seq;
         ALTER EXTENSION hstore ADD TABLE public.ext_owned;
         ALTER EXTENSION hstore ADD SEQUENCE public.ext_owned_seq;
         CREATE TABLE public.mine (id bigint PRIMARY KEY);`,
      );
      const r = await withClient(conn, (c) => extractCatalog(c, { schemas: ["public"] }));

      const ids = r.ir.facts().map((f) => encodeId(f.id));
      expect(ids.filter((s) => s.includes("ext_owned"))).toEqual([]);
      expect(r.ir.orphans()).toEqual([]);
      expect(r.ir.has({ kind: "table", schema: "public", name: "mine" })).toBe(true);

      // and the differ therefore plans nothing about it
      const empty = SchemaIR.build([], []);
      const built = buildStatements(diffIR(empty, r.ir), r.ir);
      expect(built.statements.filter((s) => s.sql.includes("ext_owned"))).toEqual([]);
    },
    T,
  );

  it(
    "a generated-column transition is an error diagnostic, not a silent no-op",
    async () => {
      const conn = await makeDatabase(GEN);
      await runSqlScript(
        conn,
        `CREATE TABLE public.items (qty integer NOT NULL, price numeric(10,2) NOT NULL, total numeric(12,2));`,
      );
      const before = (await withClient(conn, (c) => extractCatalog(c, { schemas: ["public"] }))).ir;

      await runSqlScript(
        conn,
        `ALTER TABLE public.items DROP COLUMN total;
         ALTER TABLE public.items ADD COLUMN total numeric(12,2) GENERATED ALWAYS AS (qty * price) STORED;`,
      );
      const after = (await withClient(conn, (c) => extractCatalog(c, { schemas: ["public"] }))).ir;

      const built = buildStatements(diffIR(before, after), after);
      const diag = built.diagnostics.filter((d) => d.code === "unsupported_alter");
      expect(diag.map((d) => d.subject)).toEqual(["column:public.items.total"]);
      expect(diag[0]?.severity).toBe("error");
    },
    T,
  );

  it(
    "the statement timeout is a bind, not an interpolation",
    async () => {
      const conn = await makeDatabase(GEN);
      await expect(
        withClient(conn, (c) => extractCatalog(c, { schemas: ["public"], statementTimeout: "30s'--" })),
      ).rejects.toMatchObject({ code: "22023" }); // invalid_parameter_value, from PostgreSQL
      // a legitimate value still works
      const ok = await withClient(conn, (c) =>
        extractCatalog(c, { schemas: ["public"], statementTimeout: "5s" }),
      );
      expect(ok.pgVersionNum).toBeGreaterThanOrEqual(150000);
    },
    T,
  );
});
