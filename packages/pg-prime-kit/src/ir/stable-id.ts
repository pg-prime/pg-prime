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
  | "default"
  | "constraint"
  | "index"
  | "type"
  | "enumLabel"
  | "typeAttribute"
  | "sequence"
  | "comment"
  | "extension";

export type StableId =
  | { readonly kind: "schema"; readonly schema: string }
  | { readonly kind: "table"; readonly schema: string; readonly name: string }
  | { readonly kind: "column"; readonly schema: string; readonly table: string; readonly name: string }
  /**
   * A column DEFAULT, keyed by the column it sits on (`05` §7.2's `default` kind).
   * It has no name of its own, so `name` IS the column's — which is exactly right:
   * `idName` then answers "which column", and a default change stops being a column
   * change, which is the whole reason it is a fact rather than a `ColumnPayload` field.
   */
  | { readonly kind: "default"; readonly schema: string; readonly table: string; readonly name: string }
  | { readonly kind: "constraint"; readonly schema: string; readonly table: string; readonly name: string }
  | { readonly kind: "index"; readonly schema: string; readonly name: string }
  /** enum, domain and composite all live here: `05` §7.2 gives all three `[schema, name]`. */
  | { readonly kind: "type"; readonly schema: string; readonly name: string }
  | { readonly kind: "enumLabel"; readonly schema: string; readonly type: string; readonly name: string }
  /** an attribute of a composite type — `column` is to `table` as this is to `type`. */
  | { readonly kind: "typeAttribute"; readonly schema: string; readonly type: string; readonly name: string }
  | { readonly kind: "sequence"; readonly schema: string; readonly name: string }
  /**
   * `05` §7.2: `[...targetIdentity, 'comment']`. The target identity is variable-arity,
   * so it travels as one already-encoded part — `comment:column:public\.users\.email` —
   * and `escapePart` keeps the nesting unambiguous. Storing the target id rather than a
   * (kind, schema, table, name) spread is what lets one kind cover schema, table,
   * column, type, index, constraint and sequence without eight arities.
   */
  | { readonly kind: "comment"; readonly target: string }
  /**
   * Database-scoped, name-only (`05` §7.2 gives `extension` the tuple `[name]`).
   * Not `[schema, name]`: PostgreSQL allows exactly one extension of a given name per
   * database, so a schema in the id would make a relocated extension a different
   * object — and since an extension is declare-only and never dropped, that would be a
   * CREATE that silently no-ops and a proof that never converges.
   */
  | { readonly kind: "extension"; readonly name: string };

/** Per-kind identity arity — the parts, in encoding order. */
const ARITY: Record<FactKind, readonly string[]> = {
  schema: ["schema"],
  table: ["schema", "name"],
  column: ["schema", "table", "name"],
  default: ["schema", "table", "name"],
  constraint: ["schema", "table", "name"],
  index: ["schema", "name"],
  type: ["schema", "name"],
  enumLabel: ["schema", "type", "name"],
  typeAttribute: ["schema", "type", "name"],
  sequence: ["schema", "name"],
  comment: ["target"],
  extension: ["name"],
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
  if (id.kind === "schema") return id.schema;
  if (id.kind === "comment") return id.target;
  return (id as { name: string }).name;
}

/**
 * The schema this id lives in, or `""` for the two database-scoped kinds.
 *
 * An extension belongs to the database, and a comment belongs to whatever it annotates
 * — asking either for "its schema" is a category error, and returning `undefined` would
 * make every caller a null check. `""` is never a legal schema name, so a caller that
 * uses it as one produces an immediate `quoteIdent` error rather than silent DDL.
 */
export function idSchema(id: StableId): string {
  if (id.kind === "extension") return "";
  if (id.kind === "comment") return idSchema(parseId(id.target));
  return id.schema;
}

/** Structural parent, derived (hierarchy is a view — D2). */
export function parentOf(id: StableId): StableId | undefined {
  switch (id.kind) {
    case "schema":
    case "extension":
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
    case "default":
      return { kind: "column", schema: id.schema, table: id.table, name: id.name };
    case "enumLabel":
    case "typeAttribute":
      return { kind: "type", schema: id.schema, name: id.type };
    case "comment":
      return parseId(id.target);
  }
}

export const sameId = (a: StableId, b: StableId): boolean => encodeId(a) === encodeId(b);

/** The comment fact that annotates `target`. One spelling, so nobody hand-builds the nesting. */
export function commentId(target: StableId): StableId & { kind: "comment" } {
  return { kind: "comment", target: encodeId(target) };
}

/** The `default` fact that belongs to `column`. */
export function defaultId(column: StableId & { kind: "column" }): StableId & { kind: "default" } {
  return { kind: "default", schema: column.schema, table: column.table, name: column.name };
}
