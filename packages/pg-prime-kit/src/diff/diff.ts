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
  /**
   * `--strict-unmodeled` (design/06 §2.2's completeness rule): a non-empty Tier-U census
   * stops being an `info` and becomes an `error`, which `buildPlan` turns into an
   * unacknowledged hazard and `writePlan` refuses. Off by default — a census is a report,
   * and making it fatal by default would refuse to migrate any database with a `citext`
   * cast in it.
   */
  readonly strictUnmodeled?: boolean;
  /**
   * The extractor's own diagnostics for the CURRENT and DESIRED sides, so
   * `strictUnmodeled` has something to re-classify. `diffIR` never queries.
   */
  readonly diagnostics?: readonly Diagnostic[];
}

const ORDER: Record<StableId["kind"], number> = {
  extension: 0,
  schema: 1,
  type: 2,
  enumLabel: 3,
  typeAttribute: 4,
  sequence: 5,
  table: 6,
  column: 7,
  default: 8,
  constraint: 9,
  index: 10,
  comment: 11,
};

/** Tier-U kinds are what `--strict-unmodeled` is about; Tier R is authored on purpose. */
const TIER_R_CENSUS: ReadonlySet<string> = new Set([
  "view",
  "materializedView",
  "function",
  "procedure",
  "trigger",
  "policy",
  "rule",
]);

export function diffIR(currentIn: SchemaIR, desired: SchemaIR, options: DiffOptions = {}): DiffResult {
  const { ir: current, accepted, rejected } = applyRenameHints(currentIn, desired, options.renameHints ?? []);
  const diagnostics: Diagnostic[] = [];
  const deltas: Delta[] = [];

  const byId = (ir: SchemaIR): Map<string, Fact> =>
    new Map(ir.facts().filter((f) => f.id.kind !== "enumLabel").map((f) => [encodeId(f.id), f]));

  const cur = byId(current);
  const des = byId(desired);

  /**
   * `partitions({ unknown: 'adopt' })` — `05` §7.2: "the IR asserts *nothing* about
   * undeclared partitions; they must never enter the drop set."
   *
   * A partition of a declared parent that the desired state does not mention is a
   * production reality (yesterday's daily partition; a `pg_partman` child), and dropping
   * it destroys data nobody asked to destroy. It is skipped on BOTH sides of the diff —
   * skipping only the delta would leave the shadow proof reporting it as residual drift
   * and refusing every plan.
   */
  const adoptedPartitions = new Set<string>();
  for (const [key, f] of cur) {
    if (f.id.kind !== "table" || f.payload["partitionOf"] === null) continue;
    if (des.has(key)) continue;
    adoptedPartitions.add(key);
    for (const d of current.descendantsOf(f.id)) adoptedPartitions.add(encodeId(d.id));
    diagnostics.push({
      code: "adopted_partition",
      severity: "info",
      message:
        `${key} is a partition of ${String(f.payload["partitionOf"])} that the desired state does ` +
        `not declare; it is adopted, never dropped (design/05 §7.2)`,
      subject: key,
    });
  }
  for (const key of adoptedPartitions) cur.delete(key);

  /**
   * Extensions are declare-only (`06` §2.2): created if absent, **never dropped**.
   *
   * Skipped on both sides for the same reason adopted partitions are — leaving the drop
   * delta out but keeping the fact would make the shadow proof report the surviving
   * extension as residual drift and refuse every plan that stopped declaring one. The
   * retention is reported, so it is a decision rather than a silence.
   */
  for (const [key, f] of cur) {
    if (f.id.kind !== "extension" || des.has(key)) continue;
    cur.delete(key);
    diagnostics.push({
      code: "extension_retained",
      severity: "info",
      message:
        `${key} is no longer declared but is never dropped (design/06 §2.2, declare-only); ` +
        `drop it by hand if that is what you meant`,
      subject: key,
    });
  }

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

  /* ---- the completeness rule, escalated on demand (design/06 §2.2) ---- */
  if (options.strictUnmodeled) {
    const seen = new Set<string>();
    for (const d of options.diagnostics ?? []) {
      if (d.code !== "unmodeled_kind") continue;
      const kind = d.subject ?? "?";
      if (TIER_R_CENSUS.has(kind) || seen.has(kind)) continue;
      seen.add(kind);
      diagnostics.push({
        code: "unmodeled_kind_strict",
        severity: "error",
        message:
          `${d.count ?? 0} ${kind} object(s) are present and not modelled; --strict-unmodeled ` +
          `makes a non-empty Tier-U census a failure`,
        subject: kind,
        ...(d.count === undefined ? {} : { count: d.count }),
      });
    }
  }

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
