import { describe, expect, it } from "vitest";
import { canonicalize, contentHash } from "../src/ir/hash.js";
import { SchemaIR, type Fact } from "../src/ir/fact.js";
import { encodeId, idName, parseId, type StableId } from "../src/ir/stable-id.js";
import { advisoryLockKey } from "../src/runner/apply.js";
import { evaluatedEnumLabels } from "../src/catalog/extract.js";

const prov = { origin: "catalog", ownership: "managed" } as const;

describe("StableId encoding", () => {
  const cases: StableId[] = [
    { kind: "schema", schema: "public" },
    { kind: "table", schema: "public", name: "users" },
    { kind: "column", schema: "public", table: "users", name: "email" },
    { kind: "constraint", schema: "app", table: "orders", name: "orders_user_id_fkey" },
    { kind: "index", schema: "public", name: "orders_open_idx" },
    { kind: "type", schema: "public", name: "order_status" },
    { kind: "enumLabel", schema: "public", type: "order_status", name: "paid" },
    { kind: "sequence", schema: "public", name: "invoice_no_seq" },
    // the adversarial ones: dots and backslashes inside identifiers
    { kind: "column", schema: "we.ird", table: "ta\\ble", name: "co.l" },
    { kind: "enumLabel", schema: "public", type: "t", name: "a.b\\c." },
  ];
  it.each(cases.map((c) => [encodeId(c), c] as const))("round-trips %s", (_enc, c) => {
    expect(parseId(encodeId(c))).toEqual(c);
  });

  it("reads like the design document for the ordinary case", () => {
    expect(encodeId({ kind: "column", schema: "public", table: "users", name: "email" })).toBe(
      "column:public.users.email",
    );
  });
});

describe("canonicalization (I2 — provenance never enters a hash)", () => {
  it("is key-order independent", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });
  it("distinguishes null from absent-but-present keys consistently", () => {
    expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
    expect(canonicalize({ a: undefined })).toBe(canonicalize({}));
  });
  it("gives byte-identical hashes for a TS-declared and a catalog-read fact", () => {
    const payload = { kind: "column", type: "text", notNull: true, default: null };
    const fromTs: Fact = { id: { kind: "column", schema: "public", table: "u", name: "e" }, payload, provenance: { origin: "ts", ownership: "managed" } };
    const fromDb: Fact = { ...fromTs, provenance: { origin: "catalog", ownership: "observed", sourceRef: { file: "x", line: 1 } } };
    expect(contentHash(fromTs.payload)).toBe(contentHash(fromDb.payload));
  });
});

describe("SchemaIR rollups and fingerprint", () => {
  const build = (tableName: string, colName: string): SchemaIR => {
    const schema: StableId = { kind: "schema", schema: "public" };
    const table: StableId = { kind: "table", schema: "public", name: tableName };
    const col: StableId = { kind: "column", schema: "public", table: tableName, name: colName };
    return SchemaIR.build(
      [
        { id: schema, payload: { kind: "schema" }, provenance: prov },
        { id: table, parent: schema, payload: { kind: "table", relkind: "r", persistence: "p", rowSecurity: false }, provenance: prov },
        { id: col, parent: table, payload: { kind: "column", type: "text", notNull: true, default: null }, ordinal: 1, provenance: prov },
      ],
      [{ from: col, to: table, kind: "owner" }],
    );
  };

  it("is stable across rebuilds", () => {
    expect(build("users", "email").fingerprint).toBe(build("users", "email").fingerprint);
  });

  it("I1: a renamed TABLE keeps its rollup (the rename is a hash join, not a score)", () => {
    const a = build("users", "email");
    const b = build("people", "email");
    expect(a.rollupOf({ kind: "table", schema: "public", name: "users" })).toBe(
      b.rollupOf({ kind: "table", schema: "public", name: "people" }),
    );
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("a renamed COLUMN changes its parent's rollup (child names are payload to the parent)", () => {
    const a = build("users", "email");
    const b = build("users", "e_mail");
    expect(a.rollupOf({ kind: "table", schema: "public", name: "users" })).not.toBe(
      b.rollupOf({ kind: "table", schema: "public", name: "users" }),
    );
  });

  it("ordinal is not hashed — physical column order never manufactures a diff", () => {
    const withOrdinal = SchemaIR.build(
      [{ id: { kind: "schema", schema: "public" }, payload: { kind: "schema" }, ordinal: 7, provenance: prov }],
      [],
    );
    const without = SchemaIR.build(
      [{ id: { kind: "schema", schema: "public" }, payload: { kind: "schema" }, provenance: prov }],
      [],
    );
    expect(withOrdinal.fingerprint).toBe(without.fingerprint);
  });
});

describe("evaluates-edge synthesis (the fix for the pg-delta enum bug)", () => {
  const labels = new Map([["public.order_status", ["pending", "paid", "refunded"]]]);

  it("finds the label a column default evaluates", () => {
    expect(evaluatedEnumLabels("'refunded'::public.order_status", labels)).toEqual([
      { kind: "enumLabel", schema: "public", type: "order_status", name: "refunded" },
    ]);
  });

  it("finds labels inside an index predicate", () => {
    const edges = evaluatedEnumLabels("(status <> 'shipped'::public.order_status)", new Map([["public.order_status", ["pending", "shipped"]]]));
    expect(edges.map(idName)).toEqual(["shipped"]);
  });

  it("does not fire on an unrelated string literal", () => {
    expect(evaluatedEnumLabels("'refunded'::text", labels)).toEqual([]);
  });
});

describe("D7 — the advisory lock key is derived, never fixed", () => {
  it("differs per database and per managed schema set", () => {
    const a = advisoryLockKey("app", ["public"]);
    expect(advisoryLockKey("app", ["public"])).toBe(a);
    expect(advisoryLockKey("other", ["public"])).not.toBe(a);
    expect(advisoryLockKey("app", ["public", "billing"])).not.toBe(a);
    expect(advisoryLockKey("app", ["billing", "public"])).toBe(advisoryLockKey("app", ["public", "billing"]));
  });
  it("fits in a signed 64-bit integer", () => {
    const k = advisoryLockKey("app", ["public"]);
    expect(k).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(k).toBeLessThan(2n ** 63n);
  });
});
