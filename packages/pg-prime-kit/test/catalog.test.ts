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
import { GENERATED_NAME } from "../src/catalog/payloads.js";
import { buildStatements } from "../src/diff/ddl.js";
import { diffIR } from "../src/diff/diff.js";
import { runSqlScript, withClient } from "../src/db/pg.js";
import { SchemaIR } from "../src/ir/fact.js";
import { encodeId } from "../src/ir/stable-id.js";
import {
  ADMIN,
  catalogsNotNullConstraints,
  destroyDatabase,
  makeDatabase,
  serverAvailable,
} from "./support/db.js";

const PART = "pgprime_cat_part";
const INH = "pgprime_cat_inh";
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
    for (const db of [PART, INH, EXT, GEN]) await destroyDatabase(db).catch(() => undefined);
  }, T);

  it(
    "classic INHERITS is reported, not silently flattened",
    async () => {
      const conn = await makeDatabase(INH, "inheritance/current.sql");
      const r = await withClient(conn, (c) => extractCatalog(c, { schemas: ["public"] }));

      const unsupported = r.diagnostics.filter((d) => d.code === "unsupported_kind");
      expect(unsupported.map((d) => d.subject).sort()).toEqual([
        "table:public.animals",
        "table:public.dogs",
      ]);
      expect(unsupported.every((d) => d.severity === "error")).toBe(true);

      // no facts at all for the excluded relations - not the table, not its columns,
      // not its indexes; and no orphans left behind by a half-applied filter
      const ids = r.ir.facts().map((f) => encodeId(f.id));
      expect(ids.filter((s) => /animals|dogs/.test(s))).toEqual([]);
      expect(r.ir.orphans()).toEqual([]);
      // the ordinary table in the same schema is untouched
      expect(r.ir.has({ kind: "table", schema: "public", name: "plain" })).toBe(true);
      expect(r.ir.has({ kind: "column", schema: "public", table: "plain", name: "id" })).toBe(true);
    },
    T,
  );

  it(
    "a partitioned parent and its partitions ARE facts, with strategy, key and bounds",
    async () => {
      const conn = await makeDatabase(PART, "partitioned/current.sql");
      const r = await withClient(conn, (c) => extractCatalog(c, { schemas: ["public"] }));

      // The negative half: partitioning stopped being an `unsupported_kind` when it
      // became Tier M, and a leftover diagnostic would make every partitioned schema
      // fail the corpus's "no error diagnostics" gate.
      expect(r.diagnostics.filter((d) => d.code === "unsupported_kind")).toEqual([]);
      expect(r.ir.orphans()).toEqual([]);

      const parent = r.ir.get({ kind: "table", schema: "public", name: "events" });
      expect(parent?.payload["relkind"]).toBe("p");
      expect(parent?.payload["partitionStrategy"]).toBe("r");
      expect(parent?.payload["partitionKey"]).toBe("RANGE (at)");
      expect(parent?.payload["partitionOf"]).toBeNull();

      const child = r.ir.get({ kind: "table", schema: "public", name: "events_2025" });
      expect(child?.payload["partitionOf"]).toBe("table:public.events");
      expect(String(child?.payload["partitionBound"])).toMatch(/^FOR VALUES FROM \('2025-01-01/);
      // The partition's columns are facts of their own: pg_dump writes a partition as a
      // full CREATE TABLE + ATTACH, and so do we.
      expect(r.ir.has({ kind: "column", schema: "public", table: "events_2025", name: "at" })).toBe(true);
      // The parent's ordinary sibling is unaffected.
      expect(r.ir.has({ kind: "table", schema: "public", name: "plain" })).toBe(true);
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

/**
 * What the IR records about a PostgreSQL 18 NOT NULL constraint — and, just as
 * load-bearing, what it records on 15/16/17, where there is no such constraint to record.
 *
 * The two failure modes this pins down are opposites. Store the generated name and every
 * column of a renamed table gets a new hash, so a rename becomes a phantom alter (I1).
 * Store nothing at all and a stale `users_first_name_not_null` survives on a column
 * called `name`, which `pg_dump` 18 prints and D10 rejects.
 */
describe("the NOT NULL constraint's name", () => {
  const NN = "pgprime_cat_notnull";
  const NN2 = "pgprime_cat_notnull_twin";
  // 30 + 30 does not fit in NAMEDATALEN, so the server truncates its own default name
  const LONG_T = "a".repeat(30);
  const LONG_C = "b".repeat(30);
  const SCHEMA = `
    CREATE TABLE public.t (
      plain    int NOT NULL,
      named    int CONSTRAINT named_required NOT NULL,
      nullable int
    );
    CREATE TABLE public.${LONG_T} (${LONG_C} int NOT NULL);`;

  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
  }, T);

  afterAll(async () => {
    for (const db of [NN, NN2]) await destroyDatabase(db).catch(() => undefined);
  }, T);

  it(
    "records THAT it is generated, never the generated name itself",
    async () => {
      const conn = await makeDatabase(NN);
      await runSqlScript(conn, SCHEMA);
      const r = await withClient(conn, (c) => extractCatalog(c, { schemas: ["public"] }));
      const nn = (table: string, name: string): unknown =>
        r.ir.get({ kind: "column", schema: "public", table, name })?.payload["notNullConstraint"];

      const catalogued = await catalogsNotNullConstraints();
      // a nullable column has no constraint on ANY server
      expect(nn("t", "nullable")).toBe(null);
      // and on PG < 18 neither does a NOT NULL one — there is no row to read
      expect(nn("t", "plain")).toBe(catalogued ? GENERATED_NAME : null);
      // a name the USER chose is a real attribute and is kept verbatim
      expect(nn("t", "named")).toBe(catalogued ? "named_required" : null);
      // the TRUNCATED default is still a default. A plain `<table>_<column>_not_null`
      // test would misread it as a user name and freeze it into the payload.
      expect(nn(LONG_T, LONG_C)).toBe(catalogued ? GENERATED_NAME : null);
    },
    T,
  );

  it(
    "produces no diff between two databases built from the same SQL",
    async () => {
      const a = await makeDatabase(NN);
      const b = await makeDatabase(NN2);
      await runSqlScript(a, SCHEMA);
      await runSqlScript(b, SCHEMA);
      const left = await withClient(a, (c) => extractCatalog(c, { schemas: ["public"] }));
      const right = await withClient(b, (c) => extractCatalog(c, { schemas: ["public"] }));
      expect(left.ir.fingerprint).toBe(right.ir.fingerprint);
      expect(diffIR(left.ir, right.ir).deltas).toEqual([]);
    },
    T,
  );
});
