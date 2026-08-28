/**
 * Structural rename candidates — design/06 §3.3's **second** input, and only the second.
 *
 * "Annotation is the only authority." Nothing in this file applies itself: it turns a
 * drop/create pair that *looks* like a rename into a question, so that `generate` can
 * refuse with `missing_hints` (exit 2) and print a fix instead of silently emitting
 * `DROP COLUMN first_name; ADD COLUMN name` — which is a data-loss bug wearing a diff's
 * clothes. A heuristic that acted on its own would be exactly the false-positive class
 * design/06 §9 rejects.
 *
 * Three verdicts, as §3.3 names them:
 *
 *  - **`unambiguous`** — one dropped fact and one created fact in the same container have
 *    the *same content hash*, and each is the other's only such partner. Because a fact's
 *    name lives in its id and never in its payload (design/06 D2/I1), "same content hash"
 *    means "identical in every respect except the name", which is precisely what a rename
 *    is. This is the verdict a prompt should pre-select.
 *  - **`ambiguous`** — several partners are equally good. Two `text NOT NULL` columns
 *    dropped and two added on one table cannot be paired by any rule that is not a guess.
 *  - **`nearMiss`** — nothing matches by content, but the names are close enough
 *    (`first_name` → `firstname`, `orgs` → `organisations`) that a human should be asked.
 *    A near miss is usually a rename *plus* an alter, which is two migrations' worth of
 *    intent in one edit.
 *
 * Only the four kinds `renamedFrom` can be written on (design/05 §5.1) are considered.
 * Indexes and constraints are already handled, and handled better, by
 * `rename.ts`'s cascade: they follow the table or column an annotation renamed, computed
 * from identity rather than matched.
 */

import type { SchemaIR } from "../ir/fact.js";
import { sha256 } from "../ir/hash.js";
import { encodeId, idName, type StableId } from "../ir/stable-id.js";
import type { DiffResult } from "./diff.js";

export type RenameConfidence = "unambiguous" | "ambiguous" | "nearMiss";

export interface RenameCandidate {
  readonly kind: StableId["kind"];
  /** encoded id of the fact that exists on the CURRENT side and not on the desired one */
  readonly from: string;
  /** encoded id of the fact that exists on the DESIRED side and not on the current one */
  readonly to: string;
  readonly confidence: RenameConfidence;
  /** the other `to` ids that matched this `from` equally well */
  readonly alternatives: readonly string[];
  readonly reason: string;
}

/** Kinds `renamedFrom` has a spelling for (design/05 §5.1). */
const RENAMEABLE: ReadonlySet<StableId["kind"]> = new Set(["column", "table", "type", "schema"]);

/**
 * Two facts can only be the same object renamed if they live in the same place.
 *
 * A column cannot move between tables under `RENAME COLUMN`, and a table cannot move
 * between schemas under `RENAME TO` (that is `SET SCHEMA`, a different statement and a
 * different annotation). Restricting the search to a container is what stops the pairing
 * from being a global hash join over the whole schema.
 */
function containerOf(id: StableId): string {
  switch (id.kind) {
    case "column":
      return `table:${id.schema}.${id.table}`;
    case "table":
    case "type":
      return `schema:${id.schema}`;
    default:
      return "cluster";
  }
}

/**
 * "Everything about this object except its own name."
 *
 * `contentHashOf` alone is identity-free (design/06 I1) and therefore exactly right for a
 * column — two columns whose payloads hash the same differ only in the name. It is far
 * too coarse for a *table*, whose payload is only `relkind`/persistence/row-security, so a
 * table brings its columns: name and content hash, sorted. Deliberately NOT `rollupOf`,
 * which folds in the table's constraint and index NAMES — and those are auto-derived from
 * the table's name, so a real rename never matches under it.
 */
function shapeHash(ir: SchemaIR, id: StableId): string {
  const own = ir.contentHashOf(encodeId(id));
  switch (id.kind) {
    case "table": {
      const columns = ir
        .childrenOf(id)
        .filter((f) => f.id.kind === "column")
        .map((f) => `${idName(f.id)}=${ir.contentHashOf(encodeId(f.id))}`)
        .sort();
      return sha256(`${own}|${columns.join("|")}`);
    }
    case "type": {
      // Ordinal order, not sorted: an enum's label ORDER is part of what it is.
      const labels = ir
        .childrenOf(id)
        .filter((f) => f.id.kind === "enumLabel")
        .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
        .map((f) => idName(f.id));
      return sha256(`${own}|${labels.join(",")}`);
    }
    case "schema": {
      const tables = ir
        .childrenOf(id)
        .filter((f) => f.id.kind === "table")
        .map((f) => `${idName(f.id)}=${shapeHash(ir, f.id)}`)
        .sort();
      return sha256(`${own}|${tables.join("|")}`);
    }
    default:
      return own;
  }
}

/** Damerau-free Levenshtein, iterative, two rows. Names are short; this is not hot. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0 || b.length === 0) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i, ...new Array<number>(b.length).fill(0)];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * "Close enough to ask about."
 *
 * `0.6` similarity, or one name containing the other. The threshold exists to keep the
 * prompt short rather than to be right: a near miss is never applied, only shown, so the
 * cost of a false one is a line of output and the cost of a missed one is a silent
 * `DROP` + `ADD`.
 */
function similar(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x.includes(y) || y.includes(x)) return true;
  const longest = Math.max(x.length, y.length);
  if (longest === 0) return false;
  return 1 - editDistance(x, y) / longest >= 0.6;
}

interface Side {
  readonly id: StableId;
  readonly key: string;
  readonly container: string;
  readonly hash: string;
  readonly name: string;
}

/**
 * The rename questions this diff raises. Sorted, so a CI envelope is stable.
 *
 * `diff.current` is the current IR *after* the accepted hints were folded in, so anything
 * an annotation already resolved is simply not here — one mechanism, two spellings
 * (design/11 §1.8).
 */
export function renameCandidates(diff: DiffResult, desired: SchemaIR): RenameCandidate[] {
  const current = diff.current;
  const drops: Side[] = [];
  const creates: Side[] = [];
  for (const d of diff.deltas) {
    if (d.op === "drop" && RENAMEABLE.has(d.id.kind)) {
      drops.push({
        id: d.id,
        key: encodeId(d.id),
        container: containerOf(d.id),
        hash: shapeHash(current, d.id),
        name: idName(d.id),
      });
    } else if (d.op === "create" && RENAMEABLE.has(d.id.kind)) {
      creates.push({
        id: d.id,
        key: encodeId(d.id),
        container: containerOf(d.id),
        hash: shapeHash(desired, d.id),
        name: idName(d.id),
      });
    }
  }
  if (drops.length === 0 || creates.length === 0) return [];

  // A table that is itself a candidate drags every one of its columns into the drop and
  // create sets. Reporting "did you rename users.id to accounts.id?" under "did you
  // rename users to accounts?" is noise about the same decision.
  const movedTables = new Set<string>();
  for (const d of drops) {
    if (d.id.kind !== "table") continue;
    if (creates.some((c) => c.id.kind === "table" && c.container === d.container)) {
      movedTables.add(`table:${d.id.schema}.${d.id.name}`);
    }
  }
  const eligible = (s: Side): boolean => !movedTables.has(s.container);

  const out: RenameCandidate[] = [];
  for (const from of drops.filter(eligible)) {
    const pool = creates.filter((c) => eligible(c) && c.id.kind === from.id.kind && c.container === from.container);
    if (pool.length === 0) continue;

    const exact = pool.filter((c) => c.hash === from.hash);
    if (exact.length === 1) {
      const to = exact[0]!;
      // Symmetry, the same rule `cascadeRenames` uses: the partner must not be an equally
      // good match for somebody else, or "the only match" is an artifact of the direction
      // the loop happens to run in.
      const back = drops.filter(
        (d) => eligible(d) && d.id.kind === to.id.kind && d.container === to.container && d.hash === to.hash,
      );
      out.push({
        kind: from.id.kind,
        from: from.key,
        to: to.key,
        confidence: back.length === 1 ? "unambiguous" : "ambiguous",
        alternatives: back.length === 1 ? [] : back.filter((d) => d.key !== from.key).map((d) => d.key),
        reason:
          back.length === 1
            ? `${from.name} and ${to.name} have identical content hashes — every attribute except the name agrees`
            : `${back.length} dropped ${from.id.kind}s have the content hash ${to.name} has; the pairing is a guess`,
      });
      continue;
    }
    if (exact.length > 1) {
      out.push({
        kind: from.id.kind,
        from: from.key,
        to: exact[0]!.key,
        confidence: "ambiguous",
        alternatives: exact.slice(1).map((c) => c.key),
        reason: `${exact.length} created ${from.id.kind}s have the same content hash as ${from.name}`,
      });
      continue;
    }
    const near = pool.filter((c) => similar(from.name, c.name));
    if (near.length > 0) {
      out.push({
        kind: from.id.kind,
        from: from.key,
        to: near[0]!.key,
        confidence: "nearMiss",
        alternatives: near.slice(1).map((c) => c.key),
        reason:
          `${from.name} and ${near[0]!.name} have similar names but different content; a rename here is ` +
          `also an alter, and only you know whether that is what you meant`,
      });
    }
  }
  out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return out;
}
