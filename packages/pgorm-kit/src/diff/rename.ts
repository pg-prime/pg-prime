import { SchemaIR, type DependencyEdge, type Fact } from "../ir/fact.js";
import { encodeId, parseId, type StableId } from "../ir/stable-id.js";
import type { RenameHint, RenameRecord } from "./delta.js";

export interface RenameApplication {
  /** the CURRENT ir, rewritten as if every accepted rename had already happened */
  readonly ir: SchemaIR;
  readonly accepted: RenameRecord[];
  readonly rejected: { hint: RenameHint; reason: string }[];
}

const asId = (v: StableId | string): StableId => (typeof v === "string" ? parseId(v) : v);

/**
 * Rewrite an identifier under a rename. Table renames cascade to the ids of
 * their columns and constraints — hierarchy is a view, so the cascade is a pure
 * id rewrite with no structural surgery.
 */
function remapId(id: StableId, from: StableId, to: StableId): StableId {
  if (encodeId(id) === encodeId(from)) return to;
  if (from.kind === "table" && to.kind === "table") {
    if ((id.kind === "column" || id.kind === "constraint") && id.schema === from.schema && id.table === from.name) {
      return { ...id, schema: to.schema, table: to.name };
    }
  }
  return id;
}

const rx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Bare/quoted column reference inside a stored definition (index keys, CHECK bodies). */
function remapColumnRef(text: string, oldName: string, newName: string): string {
  return text
    .replace(new RegExp(`"${rx(oldName)}"`, "g"), `"${newName}"`)
    .replace(new RegExp(`(?<![\\w"$.])${rx(oldName)}(?![\\w"$])`, "g"), `"${newName}"`);
}

/** Qualified relation reference (`public.users`, `"public"."users"`). */
function remapRelationRef(text: string, schema: string, oldName: string, newName: string): string {
  return text
    .replace(new RegExp(`"${rx(schema)}"\\."${rx(oldName)}"`, "g"), `"${schema}"."${newName}"`)
    .replace(new RegExp(`(?<![\\w"$.])${rx(schema)}\\.${rx(oldName)}(?![\\w"$])`, "g"), `"${schema}"."${newName}"`);
}

/**
 * D5 — annotation is the only authority. A hint applies iff the old id exists
 * on the CURRENT side and the new id does not (the `renamedFrom` firing rule
 * from design/05); anything else is rejected with a reason rather than guessed.
 */
export function applyRenameHints(current: SchemaIR, desired: SchemaIR, hints: readonly RenameHint[]): RenameApplication {
  const accepted: RenameRecord[] = [];
  const rejected: { hint: RenameHint; reason: string }[] = [];
  let facts = current.facts();
  let edges = current.edges();

  for (const hint of hints) {
    const from = asId(hint.from);
    const to = asId(hint.to);
    if (from.kind !== to.kind) {
      rejected.push({ hint, reason: `kind mismatch: ${from.kind} -> ${to.kind}` });
      continue;
    }
    if (!facts.some((f) => encodeId(f.id) === encodeId(from))) {
      rejected.push({ hint, reason: `no such fact on the current side: ${encodeId(from)}` });
      continue;
    }
    if (facts.some((f) => encodeId(f.id) === encodeId(to))) {
      rejected.push({ hint, reason: `target already exists on the current side: ${encodeId(to)}` });
      continue;
    }
    if (!desired.has(to)) {
      rejected.push({ hint, reason: `target absent from the desired side: ${encodeId(to)}` });
      continue;
    }

    const oldName = from.kind === "schema" ? from.schema : (from as { name: string }).name;
    const newName = to.kind === "schema" ? to.schema : (to as { name: string }).name;

    /** Which facts hold stored definition text that must follow this rename? */
    const parentTableOf = (f: Fact): string | null =>
      f.parent?.kind === "table" ? `${f.parent.schema}.${f.parent.name}` : null;
    const affectedTable =
      from.kind === "table"
        ? `${from.schema}.${from.name}`
        : from.kind === "column"
          ? `${from.schema}.${from.table}`
          : null;

    facts = facts.map((f): Fact => {
      const id = remapId(f.id, from, to);
      const parent = f.parent ? remapId(f.parent, from, to) : undefined;
      let payload = f.payload;
      const def = f.payload["definition"];
      // Definitions are stored text; a rename must follow it into index/CHECK
      // bodies or the very next diff sees a phantom drop+recreate.
      if (typeof def === "string" && affectedTable !== null && parentTableOf(f) === affectedTable) {
        payload = {
          ...payload,
          definition:
            from.kind === "table"
              ? remapRelationRef(def, from.schema, oldName, newName)
              : remapColumnRef(def, oldName, newName),
        };
      }
      return { ...f, id, ...(parent ? { parent } : {}), payload };
    });
    edges = edges.map(
      (e): DependencyEdge => ({ ...e, from: remapId(e.from, from, to), to: remapId(e.to, from, to) }),
    );

    accepted.push({
      kind: from.kind,
      from: encodeId(from),
      to: encodeId(to),
      source: "annotation",
      confidence: "unambiguous",
    });
  }

  return { ir: accepted.length ? SchemaIR.build(facts, edges) : current, accepted, rejected };
}
