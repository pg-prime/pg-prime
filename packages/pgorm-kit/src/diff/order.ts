import type { Diagnostic } from "../catalog/extract.js";
import type { Statement } from "./statement.js";

export interface Segment {
  readonly index: number;
  readonly transactional: boolean;
  readonly statements: number[];
}

export interface OrderResult {
  readonly statements: Statement[];
  readonly segments: Segment[];
  readonly diagnostics: Diagnostic[];
}

/**
 * Dependency-ordered emission.
 *
 * Hard edges come from the per-statement `produces/consumes/destroys/releases`
 * fact-id sets; `phase` is only a tie-break priority, so the graph — not a
 * hand-maintained rank table — is what actually enforces correctness.
 */
export function orderStatements(input: readonly Statement[]): OrderResult {
  const n = input.length;
  const diagnostics: Diagnostic[] = [];

  const producers = new Map<string, number[]>();
  const consumers = new Map<string, number[]>();
  const destroyers = new Map<string, number[]>();
  const releasers = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, k: string, i: number): void => {
    const l = m.get(k);
    if (l) l.push(i);
    else m.set(k, [i]);
  };
  input.forEach((s, i) => {
    for (const x of s.produces) push(producers, x, i);
    for (const x of s.consumes) push(consumers, x, i);
    for (const x of s.destroys) push(destroyers, x, i);
    for (const x of s.releases) push(releasers, x, i);
  });

  const edges = new Set<string>();
  const succ: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  const indeg = new Array<number>(n).fill(0);
  const link = (a: number, b: number): void => {
    if (a === b) return;
    const key = `${a}>${b}`;
    if (edges.has(key)) return;
    edges.add(key);
    succ[a]!.add(b);
    indeg[b]! += 1;
  };
  const relate = (
    beforeMap: Map<string, number[]>,
    afterMap: Map<string, number[]>,
  ): void => {
    for (const [k, befores] of beforeMap) {
      for (const b of afterMap.get(k) ?? []) for (const a of befores) link(a, b);
    }
  };
  relate(producers, consumers); // create the thing before you reference it
  relate(consumers, destroyers); // stop referencing it before it goes
  relate(releasers, destroyers); // drop the reference before the referent
  relate(destroyers, producers); // drop-then-recreate keeps its order

  // Kahn's algorithm, resolving ties by (phase, original index) so output is
  // deterministic and reads in the order a human would have written it.
  const ready: number[] = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) ready.push(i);
  const cmp = (a: number, b: number): number =>
    input[a]!.phase !== input[b]!.phase ? input[a]!.phase - input[b]!.phase : a - b;

  const order: number[] = [];
  while (ready.length > 0) {
    ready.sort(cmp);
    const i = ready.shift()!;
    order.push(i);
    for (const j of succ[i]!) {
      indeg[j]! -= 1;
      if (indeg[j] === 0) ready.push(j);
    }
  }
  if (order.length !== n) {
    const stuck = input.filter((_, i) => !order.includes(i));
    diagnostics.push({
      code: "dependency_cycle",
      severity: "error",
      message: `dependency cycle among ${stuck.length} statement(s); falling back to phase order: ${stuck.map((s) => s.sql).join(" | ")}`,
    });
    for (let i = 0; i < n; i++) if (!order.includes(i)) order.push(i);
    order.sort(cmp);
  }

  const statements = order.map((i) => input[i]!);

  /* ---- segmentation ------------------------------------------------- */
  const segments: Segment[] = [];
  let openIndex = -1;
  statements.forEach((s, i) => {
    const transactional = s.transactionality !== "nonTransactional";
    let seg = openIndex >= 0 ? segments[openIndex] : undefined;
    if (!seg || seg.transactional !== transactional) {
      seg = { index: segments.length, transactional, statements: [] };
      segments.push(seg);
      openIndex = seg.index;
    }
    seg.statements.push(i);
    // ALTER TYPE … ADD VALUE: the label is not usable until this COMMITs, so
    // the segment closes here — that is the boundary the ordering guarantees.
    if (s.transactionality === "commitBoundaryAfter" || !transactional) openIndex = -1;
  });

  /* ---- EN101: a new enum label used before its ADD VALUE committed ---- */
  const segmentOf = new Map<number, number>();
  for (const seg of segments) for (const i of seg.statements) segmentOf.set(i, seg.index);
  const boundaryProducers = new Map<string, number>();
  statements.forEach((s, i) => {
    if (s.transactionality === "commitBoundaryAfter") for (const x of s.produces) boundaryProducers.set(x, i);
  });
  statements.forEach((s, i) => {
    for (const x of s.consumes) {
      const p = boundaryProducers.get(x);
      if (p === undefined) continue;
      if (segmentOf.get(p)! >= segmentOf.get(i)!) {
        diagnostics.push({
          code: "EN101",
          severity: "error",
          message: `statement ${i} uses ${x} in the same transaction segment as the ALTER TYPE … ADD VALUE that creates it`,
          subject: x,
        });
      }
    }
  });

  return { statements, segments, diagnostics };
}
