/**
 * design/05 §5.1's four spellings of `renamedFrom`, as `generate` reads them.
 *
 * design/11 K2b shipped two — the column method and the extras node — and recorded the
 * other two as "reachable through `--hints-file`, but the annotation spelling is missing".
 * This is that gap closed: `pgSchema(…, { renamedFrom })`, `pgEnum(…, { renamedFrom })` and
 * the same option on `pgDomain` / `pgSequence` become `RenameHint`s, and §5.1's firing rule
 * ("iff `old` exists and `new` does not") is applied to them unchanged.
 *
 * Pure functions, no database: `annotationHints` reads the registry and `acceptHints`
 * decides, against two IRs built here by hand.
 */

import { describe, expect, it } from "vitest";
import { pgDomain, pgEnum, pgSchema, pgSequence, pgTable, defineSchema } from "pg-prime";
import { acceptHints, annotationHints } from "../../src/generate.js";
import { CATALOG_PROVENANCE, SchemaIR, type Fact } from "../../src/ir/fact.js";
import { encodeId, type StableId } from "../../src/ir/stable-id.js";
import type { SchemaLike } from "../../src/schema/types.js";

const fact = (id: StableId, kind: string): Fact => ({ id, payload: { kind }, provenance: CATALOG_PROVENANCE });

const audit = pgSchema("audit", { renamedFrom: "auditing" });
const memberRole = pgEnum("member_role", ["owner", "member"], { renamedFrom: "org_role" });
const email = pgDomain("email", "text", { renamedFrom: "email_address" });
const seq = pgSequence("orders_id_seq", { renamedFrom: "order_id_seq" });
const inert = pgEnum("colour", ["red"], { renamedFrom: "never_existed" });

const users = pgTable("users", (t) => ({ id: t.uuid().primaryKey() }));

const registry: SchemaLike = {
  ...defineSchema({ users }),
  schemas: [audit],
  enums: [memberRole, inert],
  domains: [email],
  sequences: [seq],
};

const named = (hints: readonly { from: unknown; to: unknown }[]): string[] =>
  hints.map((h) => `${encodeId(h.from as StableId)} -> ${encodeId(h.to as StableId)}`).sort();

describe("annotationHints reads all four spellings (design/05 §5.1)", () => {
  it("produces one hint per declared renamedFrom, keyed by the right fact kind", () => {
    expect(named(annotationHints(registry))).toEqual([
      "schema:auditing -> schema:audit",
      "sequence:public.order_id_seq -> sequence:public.orders_id_seq",
      // enum and domain share the `type` kind: `05` §7.2 gives both `[schema, name]`.
      "type:public.email_address -> type:public.email",
      "type:public.never_existed -> type:public.colour",
      "type:public.org_role -> type:public.member_role",
    ]);
  });

  it("fires only when the old object exists and the new one does not", () => {
    const current = SchemaIR.build(
      [
        fact({ kind: "schema", schema: "auditing" }, "schema"),
        fact({ kind: "type", schema: "public", name: "org_role" }, "type"),
        fact({ kind: "type", schema: "public", name: "email_address" }, "type"),
        fact({ kind: "sequence", schema: "public", name: "order_id_seq" }, "sequence"),
      ],
      [],
    );
    const desired = SchemaIR.build(
      [
        fact({ kind: "schema", schema: "audit" }, "schema"),
        fact({ kind: "type", schema: "public", name: "member_role" }, "type"),
        fact({ kind: "type", schema: "public", name: "email" }, "type"),
        fact({ kind: "type", schema: "public", name: "colour" }, "type"),
        fact({ kind: "sequence", schema: "public", name: "orders_id_seq" }, "sequence"),
      ],
      [],
    );

    // `colour` is inert: `never_existed` is not in the current IR, so the annotation is
    // safe to leave in the source for ever — which is the whole point of §5.1's rule.
    expect(named(acceptHints(annotationHints(registry), current, desired))).toEqual([
      "schema:auditing -> schema:audit",
      "sequence:public.order_id_seq -> sequence:public.orders_id_seq",
      "type:public.email_address -> type:public.email",
      "type:public.org_role -> type:public.member_role",
    ]);
  });

  it("does not fire when the NEW object already exists — the migration has shipped", () => {
    const both = SchemaIR.build(
      [
        fact({ kind: "type", schema: "public", name: "org_role" }, "type"),
        fact({ kind: "type", schema: "public", name: "member_role" }, "type"),
      ],
      [],
    );
    const desired = SchemaIR.build([fact({ kind: "type", schema: "public", name: "member_role" }, "type")], []);
    expect(acceptHints(annotationHints(registry), both, desired)).toEqual([]);
  });
});
