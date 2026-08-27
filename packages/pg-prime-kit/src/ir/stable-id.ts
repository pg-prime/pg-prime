/**
 * Structured, discriminated stable identifiers (design/06 §2.1, D2).
 *
 * The load-bearing rule: **a fact's own name lives in its id, never in its
 * hashed payload.** Everything downstream (rename-as-hash-join, phantom-diff
 * immunity, dependency edges that land on real targets) follows from that.
 *
 * The string encoding exists in exactly one place — here.
 */

export type FactKind =
  | "schema"
  | "table"
  | "column"
  | "constraint"
  | "index"
  | "type"
  | "enumLabel"
  | "sequence";

export type StableId =
  | { readonly kind: "schema"; readonly schema: string }
  | { readonly kind: "table"; readonly schema: string; readonly name: string }
  | { readonly kind: "column"; readonly schema: string; readonly table: string; readonly name: string }
  | { readonly kind: "constraint"; readonly schema: string; readonly table: string; readonly name: string }
  | { readonly kind: "index"; readonly schema: string; readonly name: string }
  | { readonly kind: "type"; readonly schema: string; readonly name: string }
  | { readonly kind: "enumLabel"; readonly schema: string; readonly type: string; readonly name: string }
  | { readonly kind: "sequence"; readonly schema: string; readonly name: string };

/** Per-kind identity arity — the parts, in encoding order. */
const ARITY: Record<FactKind, readonly string[]> = {
  schema: ["schema"],
  table: ["schema", "name"],
  column: ["schema", "table", "name"],
  constraint: ["schema", "table", "name"],
  index: ["schema", "name"],
  type: ["schema", "name"],
  enumLabel: ["schema", "type", "name"],
  sequence: ["schema", "name"],
};

const escapePart = (s: string): string => s.replace(/\\/g, "\\\\").replace(/\./g, "\\.");

function splitEscaped(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\") {
      i += 1;
      cur += s[i] ?? "";
    } else if (ch === ".") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** `column:public.users.email` — the one and only encoding. */
export function encodeId(id: StableId): string {
  const parts = ARITY[id.kind];
  const rec = id as unknown as Record<string, string>;
  return `${id.kind}:${parts.map((p) => escapePart(rec[p]!)).join(".")}`;
}

export function parseId(s: string): StableId {
  const colon = s.indexOf(":");
  if (colon < 0) throw new Error(`malformed StableId (no kind): ${s}`);
  const kind = s.slice(0, colon) as FactKind;
  const parts = ARITY[kind];
  if (!parts) throw new Error(`unknown fact kind: ${kind}`);
  const values = splitEscaped(s.slice(colon + 1));
  if (values.length !== parts.length) {
    throw new Error(`StableId ${s}: expected ${parts.length} parts for kind ${kind}, got ${values.length}`);
  }
  const out: Record<string, string> = { kind };
  parts.forEach((p, i) => {
    out[p] = values[i]!;
  });
  return out as unknown as StableId;
}

/** The fact's own name — the part that is deliberately absent from the payload. */
export function idName(id: StableId): string {
  return id.kind === "schema" ? id.schema : (id as { name: string }).name;
}

/** The schema this id lives in. */
export function idSchema(id: StableId): string {
  return id.schema;
}

/** Structural parent, derived (hierarchy is a view — D2). */
export function parentOf(id: StableId): StableId | undefined {
  switch (id.kind) {
    case "schema":
      return undefined;
    case "table":
    case "type":
    case "sequence":
      return { kind: "schema", schema: id.schema };
    case "index":
      return { kind: "schema", schema: id.schema };
    case "column":
    case "constraint":
      return { kind: "table", schema: id.schema, name: id.table };
    case "enumLabel":
      return { kind: "type", schema: id.schema, name: id.type };
  }
}

export const sameId = (a: StableId, b: StableId): boolean => encodeId(a) === encodeId(b);
