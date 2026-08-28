/**
 * One assertion per Tier-M payload field K3 added: the CATALOG value on one side, the IR
 * value on the other (test rule R3).
 *
 * The corpus sweep proves these kinds *converge*; it cannot prove they are MODELLED. A
 * field the extractor drops entirely still converges — both sides are blind the same way
 * — and that is exactly the silent-loss class design/06 §3.9 was written about. These
 * tests read `pg_catalog` themselves and compare.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCatalog } from "../../src/catalog/extract.js";
import { GENERATED_NAME } from "../../src/catalog/payloads.js";
import { runSqlScript, withClient } from "../../src/db/pg.js";
import { encodeId, type StableId } from "../../src/ir/stable-id.js";
import { ADMIN, catalogsNotNullConstraints, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";

const DB = "pgprime_k3_payloads";
const T = 180_000;

let ir: Awaited<ReturnType<typeof extractCatalog>>;

const payload = (id: StableId): Record<string, unknown> => {
  const f = ir.ir.get(id);
  expect(f, `no fact ${encodeId(id)}`).toBeDefined();
  return f!.payload as Record<string, unknown>;
};

describe("Tier-M payloads carry what pg_catalog says", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
    const conn = await makeDatabase(DB);
    await runSqlScript(
      conn,
      `CREATE EXTENSION hstore;

       CREATE DOMAIN public.email AS text
         COLLATE "C"
         DEFAULT 'nobody@example.com'
         NOT NULL
         CONSTRAINT email_has_at CHECK (VALUE LIKE '%@%');

       CREATE TYPE public.addr AS (street text, city varchar(64));

       CREATE TABLE public.t (
         id       bigint NOT NULL PRIMARY KEY,
         plain    text DEFAULT 'x',
         gen      integer GENERATED ALWAYS AS (id * 2) STORED,
         span     tstzrange NOT NULL,
         nn       integer NOT NULL,
         CONSTRAINT t_no_overlap EXCLUDE USING gist (span WITH &&) DEFERRABLE
       );

       COMMENT ON TABLE public.t IS 'the table';
       COMMENT ON COLUMN public.t.plain IS 'the column';
       COMMENT ON CONSTRAINT t_no_overlap ON public.t IS 'the constraint';`,
    );
    ir = await withClient(conn, (c) => extractCatalog(c, { schemas: ["public"] }));
  }, T);

  afterAll(async () => {
    await destroyDatabase(DB).catch(() => undefined);
  }, T);

  it("domain: base type, collation, default, NOT NULL and its CHECKs", () => {
    expect(payload({ kind: "type", schema: "public", name: "email" })).toEqual({
      kind: "type",
      typtype: "d",
      baseType: "text",
      notNull: true,
      default: "'nobody@example.com'::text",
      collation: "C",
      checks: ["email_has_at CHECK ((VALUE ~~ '%@%'::text))"],
    });
  });

  it("composite: one `typeAttribute` fact per attribute, in attnum order", () => {
    expect(payload({ kind: "type", schema: "public", name: "addr" })["typtype"]).toBe("c");
    const attrs = ir.ir
      .childrenOf({ kind: "type", schema: "public", name: "addr" })
      .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    expect(attrs.map((a) => [(a.id as { name: string }).name, a.payload["type"]])).toEqual([
      ["street", "text"],
      ["city", "character varying(64)"],
    ]);
    // The negative half: `public.t` also owns a `typtype = 'c'` row, and it must NOT be
    // a type fact — a phantom `CREATE TYPE public.t` cannot be applied.
    expect(ir.ir.has({ kind: "type", schema: "public", name: "t" })).toBe(false);
  });

  it("EXCLUDE: the constraintdef verbatim, with deferrability as its own axis", () => {
    const p = payload({ kind: "constraint", schema: "public", table: "t", name: "t_no_overlap" });
    expect(p["contype"]).toBe("x");
    expect(p["deferrable"]).toBe(true);
    // Verbatim from `pg_get_constraintdef`: the operator and the access method are the
    // constraint, and reconstructing them from `conexclop` is re-modelling PostgreSQL.
    expect(p["definition"]).toBe("EXCLUDE USING gist (span WITH &&) DEFERRABLE");
    // And its backing index is NOT a separate fact.
    expect(ir.ir.has({ kind: "index", schema: "public", name: "t_no_overlap" })).toBe(false);
  });

  it("comment: keyed by the target's id, text in the payload", () => {
    expect(payload({ kind: "comment", target: "table:public.t" })).toEqual({
      kind: "comment",
      text: "the table",
    });
    expect(payload({ kind: "comment", target: "column:public.t.plain" })["text"]).toBe("the column");
    expect(payload({ kind: "comment", target: "constraint:public.t.t_no_overlap" })["text"]).toBe("the constraint");
    // A target with no comment has no fact — absence is the absence, not an empty string.
    expect(ir.ir.has({ kind: "comment", target: "column:public.t.id" })).toBe(false);
  });

  it("extension: name-only identity, schema in the payload, version deliberately absent", () => {
    expect(payload({ kind: "extension", name: "hstore" })).toEqual({
      kind: "extension",
      schema: "public",
    });
    // Declare-only means its members are projected out of every other family.
    expect(ir.ir.facts().filter((f) => encodeId(f.id).includes("hstore") && f.id.kind !== "extension")).toEqual([]);
  });

  it("default: its own fact, and a GENERATION expression is not one", () => {
    expect(payload({ kind: "default", schema: "public", table: "t", name: "plain" })).toEqual({
      kind: "default",
      expression: "'x'::text",
    });
    // `gen` has a `pg_attrdef` row too, and it must NOT become a `default` fact: the
    // expression is part of the column and PostgreSQL cannot `SET DEFAULT` it.
    expect(ir.ir.has({ kind: "default", schema: "public", table: "t", name: "gen" })).toBe(false);
    expect(payload({ kind: "column", schema: "public", table: "t", name: "gen" })["generationExpr"]).toBe("(id * 2)");
    // ...and the plain column's own payload no longer carries the default at all, which
    // is what makes "the default changed" a different delta from "the column changed".
    expect(payload({ kind: "column", schema: "public", table: "t", name: "plain" })).not.toHaveProperty("default");
  });

  it("notNullValidated is null on <18 and true on a validated 18 constraint", async () => {
    const p = payload({ kind: "column", schema: "public", table: "t", name: "nn" });
    if (await catalogsNotNullConstraints()) {
      expect(p["notNullConstraint"]).toBe(GENERATED_NAME);
      expect(p["notNullValidated"]).toBe(true);
    } else {
      // Not "false": there is no constraint row, so there is nothing whose validity to
      // state, and `false` would diff against 18 on every fixture in the corpus.
      expect(p["notNullConstraint"]).toBeNull();
      expect(p["notNullValidated"]).toBeNull();
    }
    // A nullable column never has either, on any server.
    expect(payload({ kind: "column", schema: "public", table: "t", name: "plain" })["notNullValidated"]).toBeNull();
  });
});
