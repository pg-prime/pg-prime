import type { Diagnostic } from "../catalog/extract.js";
import type { Fact, SchemaIR } from "../ir/fact.js";
import { encodeId, type StableId } from "../ir/stable-id.js";
import type { Delta, RenameHint, RenameRecord } from "./delta.js";
import { applyRenameHints } from "./rename.js";

export interface DiffResult {
  readonly deltas: Delta[];
  readonly renames: RenameRecord[];
  readonly rejectedHints: { hint: RenameHint; reason: string }[];
  readonly diagnostics: Diagnostic[];
  /** the current IR after rename hints were folded in — what the plan is built against */
  readonly current: SchemaIR;
}

export interface DiffOptions {
  readonly renameHints?: readonly RenameHint[];
}

const ORDER: Record<StableId["kind"], number> = {
  schema: 0,
  type: 1,
  enumLabel: 2,
  sequence: 3,
  table: 4,
  column: 5,
  constraint: 6,
  index: 7,
};

export function diffIR(currentIn: SchemaIR, desired: SchemaIR, options: DiffOptions = {}): DiffResult {
  const { ir: current, accepted, rejected } = applyRenameHints(currentIn, desired, options.renameHints ?? []);
  const diagnostics: Diagnostic[] = [];
  const deltas: Delta[] = [];

  const byId = (ir: SchemaIR): Map<string, Fact> =>
    new Map(ir.facts().filter((f) => f.id.kind !== "enumLabel").map((f) => [encodeId(f.id), f]));

  const cur = byId(current);
  const des = byId(desired);

  // `contentHashOf` is memoised on the IR: hashing the payload inline here AND
  // again inside `rollupOf` hashed every fact on both sides twice per diff.
  for (const [key, after] of des) {
    const before = cur.get(key);
    if (!before) {
      deltas.push({ op: "create", id: after.id, fact: after });
    } else if (current.contentHashOf(key) !== desired.contentHashOf(key)) {
      deltas.push({ op: "alter", id: after.id, before, after });
    }
  }
  for (const [key, before] of cur) {
    if (!des.has(key)) deltas.push({ op: "drop", id: before.id, fact: before });
  }

  /* ---- enum labels: an ORDERED list, not a set ---------------------------
   * Appending is legal and cheap; removing or reordering is impossible in any
   * PostgreSQL version (design/06 §3.7, EN102/DS104). Diffing labels as an
   * ordered list rather than by hashed sort key means an append perturbs
   * nothing — no phantom deltas on the labels that follow it.
   */
  for (const [key, desiredType] of des) {
    if (desiredType.id.kind !== "type" || desiredType.payload["typtype"] !== "e") continue;
    if (!cur.has(key)) continue; // labels ride along with CREATE TYPE
    const currentLabels = labelsOf(current, desiredType.id);
    const desiredLabels = labelsOf(desired, desiredType.id);
    const added = desiredLabels.filter((l) => !currentLabels.includes(l));
    const survivors = desiredLabels.filter((l) => currentLabels.includes(l));
    if (survivors.length !== currentLabels.length || survivors.some((l, i) => l !== currentLabels[i])) {
      diagnostics.push({
        code: "EN102",
        severity: "error",
        message: `enum ${desiredType.id.schema}.${(desiredType.id as { name: string }).name}: labels were removed or reordered (${currentLabels.join(",")} -> ${desiredLabels.join(",")}); PostgreSQL cannot express this without the DS104 type-replacement path`,
        subject: encodeId(desiredType.id),
      });
      continue;
    }
    for (const label of added) {
      const i = desiredLabels.indexOf(label);
      const prev = i > 0 ? desiredLabels[i - 1]! : null;
      const next = i + 1 < desiredLabels.length ? desiredLabels[i + 1]! : null;
      deltas.push({
        op: "addEnumValue",
        id: { kind: "enumLabel", schema: desiredType.id.schema, type: (desiredType.id as { name: string }).name, name: label },
        anchor: prev ? { position: "AFTER", label: prev } : next ? { position: "BEFORE", label: next } : null,
      });
    }
  }

  deltas.sort((a, b) => {
    const ka = a.op === "rename" ? a.to.kind : a.id.kind;
    const kb = b.op === "rename" ? b.to.kind : b.id.kind;
    if (ORDER[ka] !== ORDER[kb]) return ORDER[ka] - ORDER[kb];
    const ia = a.op === "rename" ? encodeId(a.to) : encodeId(a.id);
    const ib = b.op === "rename" ? encodeId(b.to) : encodeId(b.id);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });

  return { deltas, renames: accepted, rejectedHints: rejected, diagnostics, current };
}

export function labelsOf(ir: SchemaIR, typeId: StableId): string[] {
  return ir
    .childrenOf(typeId)
    .filter((f) => f.id.kind === "enumLabel")
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
    .map((f) => (f.id as { name: string }).name);
}

/** `migrate verify` semantics: two fact bases agree iff every fact and edge agrees. */
export function isEmptyDiff(result: DiffResult): boolean {
  return result.deltas.length === 0;
}
