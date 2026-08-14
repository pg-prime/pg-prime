/**
 * The differential oracle (design/06 amendment, 00-overview sign-off item 7).
 *
 * `@supabase/pg-delta` is a **dev-time oracle only** — pinned, devDependency,
 * never shipped, never imported from `src/`. This file is the only place in the
 * repository that knows its types, so an alpha.40 API rewrite is a one-file
 * repair.
 *
 * A disagreement is a FUTURE TEST CASE, not a failure. The one asymmetry that
 * IS a failure is ours: if our plan does not converge, we are provably wrong.
 * Convergence is judged for BOTH engines by OUR extractor and OUR differ, so
 * the criterion is engine-neutral: "apply this plan to a clone of the current
 * database, and the catalog must then equal the desired catalog".
 */

import pg from "pg";
import { extractCatalog } from "../../src/catalog/extract.js";
import { withClient, type ConnInfo } from "../../src/db/pg.js";
import { buildStatements } from "../../src/diff/ddl.js";
import { diffIR } from "../../src/diff/diff.js";
import { orderStatements } from "../../src/diff/order.js";
import type { Statement } from "../../src/diff/statement.js";
import type { SchemaIR } from "../../src/ir/fact.js";
import { encodeId } from "../../src/ir/stable-id.js";
import type { PlanStatement } from "../../src/plan/plan.js";
import { applySegments } from "../../src/runner/apply.js";
import { destroyDatabase, makeDatabase } from "./db.js";

/* ------------------------------------------------------------------ */
/* The port — the only structural knowledge of pg-delta's API we hold. */
/* ------------------------------------------------------------------ */

interface DeltaStableId {
  readonly kind: string;
}
interface DeltaAction {
  readonly sql: string;
  readonly verb: "create" | "alter" | "drop";
  readonly produces: readonly DeltaStableId[];
  readonly consumes: readonly DeltaStableId[];
  readonly destroys: readonly DeltaStableId[];
  readonly transactionality: "transactional" | "nonTransactional" | "commitBoundaryAfter";
  readonly dataLoss: "none" | "destructive";
  readonly rewriteRisk: boolean;
}
interface DeltaPlan {
  readonly actions: readonly DeltaAction[];
  readonly safetyReport: { readonly destructiveActions: number };
}
interface DeltaApplyReport {
  readonly status: "applied" | "failed";
  readonly appliedActions: number;
  readonly error?: { readonly actionIndex: number; readonly sql: string; readonly message: string };
}
interface PgDeltaApi {
  readonly extract: (pool: pg.Pool) => Promise<{ factBase: unknown }>;
  readonly plan: (
    source: unknown,
    desired: unknown,
    options?: { renames?: "auto" | "prompt" | "off" },
  ) => DeltaPlan;
  readonly apply: (
    plan: DeltaPlan,
    pool: pg.Pool,
    options?: { fingerprintGate?: boolean },
  ) => Promise<DeltaApplyReport>;
  readonly encodeId: (id: DeltaStableId) => string;
}

export const loadPgDelta = async (): Promise<PgDeltaApi> =>
  (await import("@supabase/pg-delta")) as unknown as PgDeltaApi;

async function withPool<T>(c: ConnInfo, fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ ...c, max: 4 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/* ------------------------------------------------------------------ */
/* Report shapes                                                       */
/* ------------------------------------------------------------------ */

/**
 * One operation, addressed by the fact it is ABOUT.
 *
 * The verb is deliberately absent: `ALTER TABLE … ADD COLUMN` is verb "create"
 * to pg-delta (it creates a column) and verb "alter" to us (it is an ALTER
 * statement). That is vocabulary, not disagreement. What is comparable across
 * two engines is *how many operations each performs on each object, and in what
 * order*.
 */
export interface Op {
  readonly subject: string;
  readonly sql: string;
}

export interface EngineOutcome {
  readonly engine: "pgorm-kit" | "pg-delta";
  /** the emitted statement stream, in plan order */
  readonly statements: readonly string[];
  readonly ops: readonly Op[];
  readonly applied: boolean;
  readonly error?: string;
  /** residual drift after apply, measured by OUR extractor against IR(desired) */
  readonly residual: readonly string[];
  readonly converged: boolean;
}

export type DisagreementAxis = "convergence" | "operations" | "ordering" | "planning";

export interface Disagreement {
  readonly axis: DisagreementAxis;
  readonly fixture: string;
  readonly detail: string;
  /** set when the divergence is a deliberate design difference, not a defect */
  readonly expected?: string;
  /** set when the oracle is provably wrong and we are provably right */
  readonly oracleWrong?: boolean;
}

export interface OracleReport {
  readonly fixture: string;
  readonly ours: EngineOutcome;
  readonly theirs: EngineOutcome;
  readonly disagreements: readonly Disagreement[];
}

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

function inScope(encoded: string, schemas: readonly string[]): boolean {
  const body = encoded.slice(encoded.indexOf(":") + 1);
  const schema = body.split(".")[0] ?? "";
  return schemas.includes(schema);
}

/**
 * pg-delta gives a column default its own fact kind (`default:s.t.c`); we make
 * it an attribute of the column, because a default is not independently
 * addressable in DDL. Speak their vocabulary for the comparison so a
 * SET/DROP DEFAULT lines up with the fact it changes on their side.
 */
function oursOps(statements: readonly PlanStatement[], schemas: readonly string[]): Op[] {
  const out: Op[] = [];
  for (const s of statements) {
    let subject = s.produces[0] ?? s.destroys[0] ?? s.consumes[0] ?? "";
    if (subject.startsWith("column:") && /(?:SET|DROP) DEFAULT/.test(s.sql)) {
      subject = `default:${subject.slice("column:".length)}`;
    }
    if (!subject || !inScope(subject, schemas)) continue;
    out.push({ subject, sql: s.sql });
  }
  return out;
}

function theirsOps(actions: readonly DeltaAction[], api: PgDeltaApi, schemas: readonly string[]): Op[] {
  const out: Op[] = [];
  for (const a of actions) {
    const first = a.produces[0] ?? a.destroys[0] ?? a.consumes[0];
    if (!first) continue;
    const subject = api.encodeId(first);
    if (!inScope(subject, schemas)) continue;
    out.push({ subject, sql: a.sql });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The harness                                                         */
/* ------------------------------------------------------------------ */

export interface OracleInput {
  /** fixture directory under `fixtures/diff`, for reporting */
  readonly fixture: string;
  /** db-name prefix; four scratch databases are created and dropped */
  readonly slug: string;
  /** fixture-relative path of the CURRENT state, or null for an empty database */
  readonly current: string | null;
  /** fixture-relative path of the DESIRED state, or null for an empty database */
  readonly desired: string | null;
  readonly schemas?: readonly string[];
}

export async function runOracle(input: OracleInput): Promise<OracleReport> {
  const schemas = input.schemas ?? ["public"];
  const names = {
    current: `${input.slug}_cur`,
    desired: `${input.slug}_des`,
    ours: `${input.slug}_ours`,
    theirs: `${input.slug}_theirs`,
  };
  const api = await loadPgDelta();

  const current = await makeDatabase(names.current, input.current ?? undefined);
  const desired = await makeDatabase(names.desired, input.desired ?? undefined);
  try {
    const currentIR = await withClient(current, (c) => extractCatalog(c, { schemas }));
    const desiredIR = await withClient(desired, (c) => extractCatalog(c, { schemas }));

    /* ---- our engine ---- */
    const diff = diffIR(currentIR.ir, desiredIR.ir);
    const built = buildStatements(diff, desiredIR.ir);
    const ordered = orderStatements(built.statements);
    const ourStatements = toPlanStatements(ordered.statements);
    const ours = await runOnClone({
      engine: "pgorm-kit",
      seed: input.current,
      dbName: names.ours,
      schemas,
      desiredIR: desiredIR.ir,
      statements: ourStatements.map((s) => s.sql),
      ops: oursOps(ourStatements, schemas),
      run: async (conn) => {
        const report = await withClient(conn, (c) => applySegments(c, ourStatements, ordered.segments));
        return report.status === "applied"
          ? { status: "applied" as const }
          : {
              status: "failed" as const,
              error: {
                index: report.error?.statementIndex ?? -1,
                sql: report.error?.sql ?? "",
                message: report.error?.message ?? "unknown",
              },
            };
      },
    });

    /* ---- the oracle ---- */
    let theirPlan: DeltaPlan | undefined;
    let planError: string | undefined;
    try {
      const sourceBase = await withPool(current, async (p) => (await api.extract(p)).factBase);
      const desiredBase = await withPool(desired, async (p) => (await api.extract(p)).factBase);
      theirPlan = api.plan(sourceBase, desiredBase, { renames: "off" });
    } catch (err) {
      planError = err instanceof Error ? err.message : String(err);
    }

    const theirs: EngineOutcome = await (async (): Promise<EngineOutcome> => {
      if (!theirPlan) {
        return {
          engine: "pg-delta",
          statements: [],
          ops: [],
          applied: false,
          ...(planError === undefined ? {} : { error: planError }),
          residual: [],
          converged: false,
        };
      }
      const plan = theirPlan;
      return runOnClone({
        engine: "pg-delta",
        seed: input.current,
        dbName: names.theirs,
        schemas,
        desiredIR: desiredIR.ir,
        statements: plan.actions.map((a) => a.sql),
        ops: theirsOps(plan.actions, api, schemas),
        run: async (conn) => {
          const report = await withPool(conn, (pool) => api.apply(plan, pool, { fingerprintGate: false }));
          return report.status === "applied"
            ? { status: "applied" as const }
            : {
                status: "failed" as const,
                error: {
                  index: report.error?.actionIndex ?? -1,
                  sql: report.error?.sql ?? "",
                  message: report.error?.message ?? "unknown",
                },
              };
        },
      });
    })();

    return {
      fixture: input.fixture,
      ours,
      theirs,
      disagreements: compare(input.fixture, ours, theirs, ourStatements),
    };
  } finally {
    for (const n of Object.values(names)) await destroyDatabase(n).catch(() => undefined);
  }
}

interface CloneRun {
  readonly engine: EngineOutcome["engine"];
  readonly seed: string | null;
  readonly dbName: string;
  readonly schemas: readonly string[];
  readonly desiredIR: SchemaIR;
  readonly statements: readonly string[];
  readonly ops: readonly Op[];
  readonly run: (conn: ConnInfo) => Promise<{
    status: "applied" | "failed";
    error?: { index: number; sql: string; message: string };
  }>;
}

/** apply → re-extract → diff, on a throwaway database seeded with CURRENT. */
async function runOnClone(input: CloneRun): Promise<EngineOutcome> {
  const conn = await makeDatabase(input.dbName, input.seed ?? undefined);
  try {
    const report = await input.run(conn);
    if (report.status === "failed") {
      return {
        engine: input.engine,
        statements: input.statements,
        ops: input.ops,
        applied: false,
        error: `action ${report.error?.index}: ${report.error?.message} — ${report.error?.sql}`,
        residual: [],
        converged: false,
      };
    }
    const after = await withClient(conn, (c) => extractCatalog(c, { schemas: input.schemas }));
    const residual = diffIR(after.ir, input.desiredIR).deltas.map(
      (d) => `${d.op} ${encodeId(d.op === "rename" ? d.to : d.id)}`,
    );
    return {
      engine: input.engine,
      statements: input.statements,
      ops: input.ops,
      applied: true,
      residual,
      converged: residual.length === 0 && after.ir.fingerprint === input.desiredIR.fingerprint,
    };
  } finally {
    await destroyDatabase(input.dbName).catch(() => undefined);
  }
}

/** Our `Statement[]` in the shape `applySegments` consumes. */
export function toPlanStatements(statements: readonly Statement[]): PlanStatement[] {
  return statements.map((s, index) => ({
    index,
    sql: s.sql,
    verb: s.verb,
    kind: s.kind,
    produces: s.produces,
    consumes: s.consumes,
    destroys: s.destroys,
    releases: s.releases,
    transactionality: s.transactionality,
    lockClass: s.lockClass,
    idempotent: s.idempotent,
    timeouts: { lock: "3s", statement: s.lockClass === "shareUpdateExclusive" ? null : "30s" },
    dataLoss: s.dataLoss,
    rewrite: s.rewrite,
    hazards: s.hazards,
  }));
}

/* ------------------------------------------------------------------ */
/* Structural comparison                                               */
/* ------------------------------------------------------------------ */

/** Divergences we chose. Documented so the harness never re-reports them as news. */
interface ExpectedRule {
  readonly match: (subject: string, ours: number, theirs: number, extra: readonly string[]) => boolean;
  readonly reason: string;
}

const EXPECTED: readonly ExpectedRule[] = [
  {
    match: (s, a, b) => s.startsWith("constraint:") && a === b + 1,
    reason:
      "design/06 §3.5 lock-safe rewriting — we split a validated FK/CHECK into ADD … NOT VALID + VALIDATE CONSTRAINT; pg-delta emits one validated ADD",
  },
  {
    match: (s, _a, b) => s.startsWith("constraint:") && b === 0,
    reason:
      "pg-delta's compaction folds a self-contained validated PK/UNIQUE/CHECK into the CREATE TABLE parens; we always emit one statement per fact, because per-statement hazard/lock/timeout metadata has to be addressable in the plan artifact",
  },
  {
    match: (s, _a, _b, extra) =>
      s.startsWith("enumLabel:") || extra.some((sql) => /ALTER TYPE .* ADD VALUE/.test(sql)),
    reason:
      "I3 granularity-is-one — an enum label is its own fact for us, so ALTER TYPE … ADD VALUE has an orderable label subject; pg-delta has no enumLabel id kind at all, and that is the root cause of its ordering bug",
  },
  {
    match: (s) => s.startsWith("schema:"),
    reason:
      "we emit CREATE SCHEMA IF NOT EXISTS for every managed schema; pg-delta treats an existing schema as pre-existing",
  },
  {
    // the whole surplus on their side is ownership statements
    match: (_s, a, b, extra) => extra.filter((sql) => /OWNER TO/.test(sql)).length === Math.abs(a - b),
    reason:
      "Tier O (design/06 §2.2) — ownership and ACLs are observed, never written; pg-delta manages them",
  },
  {
    match: (s, a, _b, extra) =>
      a === 0 &&
      (s.startsWith("column:") || s.startsWith("default:")) &&
      extra.every((sql) => /ADD COLUMN|SET DEFAULT/.test(sql)),
    reason:
      "pg-delta emits a separate ADD COLUMN / SET DEFAULT where its compaction cannot fold the clause into CREATE TABLE (the enum-type edge crosses the merge); we fold every column clause into the CREATE TABLE we are already emitting",
  },
];

function countBySubject(ops: readonly Op[]): Map<string, Op[]> {
  const m = new Map<string, Op[]>();
  for (const op of ops) {
    const l = m.get(op.subject);
    if (l) l.push(op);
    else m.set(op.subject, [op]);
  }
  return m;
}

function compare(
  fixture: string,
  ours: EngineOutcome,
  theirs: EngineOutcome,
  ourStatements: readonly PlanStatement[],
): Disagreement[] {
  const out: Disagreement[] = [];

  if (ours.converged !== theirs.converged) {
    out.push({
      axis: "convergence",
      fixture,
      detail: ours.converged
        ? `our plan converges; pg-delta's does not (${theirs.error ?? theirs.residual.join(", ")})`
        : `pg-delta's plan converges; ours does not (${ours.error ?? ours.residual.join(", ")})`,
      ...(ours.converged ? { oracleWrong: true } : {}),
    });
  }

  const a = countBySubject(ours.ops);
  const b = countBySubject(theirs.ops);
  for (const subject of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const na = a.get(subject)?.length ?? 0;
    const nb = b.get(subject)?.length ?? 0;
    if (na === nb) continue;
    const sample = (na > nb ? a.get(subject) : b.get(subject)) ?? [];
    const extra = sample.map((o) => o.sql.split("\n")[0]!);
    const expected = EXPECTED.find((e) => e.match(subject, na, nb, extra));
    out.push({
      axis: "operations",
      fixture,
      detail:
        `${subject}: ours ×${na}, pg-delta ×${nb}` +
        `\n    on ${na > nb ? "our" : "their"} side: ${extra.join(" | ")}`,
      ...(expected ? { expected: expected.reason } : {}),
    });
  }

  /* ---- ordering ----------------------------------------------------
   * Only dependency-related pairs are reported. Two independent objects
   * emitted in a different relative order is a tie-break, not a
   * disagreement; reporting it drowns the signal.
   */
  const producerOf = new Map<string, string>(); // produced fact id -> subject
  for (const s of ourStatements) {
    let subject = s.produces[0] ?? s.destroys[0] ?? s.consumes[0] ?? "";
    if (subject.startsWith("column:") && /(?:SET|DROP) DEFAULT/.test(s.sql)) {
      subject = `default:${subject.slice("column:".length)}`;
    }
    for (const p of s.produces) producerOf.set(p, subject);
  }
  const related = new Set<string>();
  for (const s of ourStatements) {
    let consumer = s.produces[0] ?? s.destroys[0] ?? s.consumes[0] ?? "";
    if (consumer.startsWith("column:") && /(?:SET|DROP) DEFAULT/.test(s.sql)) {
      consumer = `default:${consumer.slice("column:".length)}`;
    }
    for (const c of s.consumes) {
      const producer = producerOf.get(c);
      if (producer && producer !== consumer) related.add(`${producer} ${consumer}`);
    }
  }

  const firstIndex = (ops: readonly Op[], subject: string): number =>
    ops.findIndex((o) => o.subject === subject);
  for (const pair of [...related].sort()) {
    const [producer, consumer] = pair.split(" ") as [string, string];
    const tp = firstIndex(theirs.ops, producer);
    const tc = firstIndex(theirs.ops, consumer);
    if (tp < 0 || tc < 0) continue; // not a shared pair; nothing to compare
    if (tp > tc) {
      out.push({
        axis: "ordering",
        fixture,
        detail: `pg-delta emits [${consumer}] (action ${tc}) before [${producer}] (action ${tp}), which produces what it consumes`,
      });
    }
  }

  return out;
}

/** One-line-per-disagreement, machine-greppable. */
export function formatReport(report: OracleReport): string {
  const lines = [
    `oracle[${report.fixture}] ours: ${report.ours.statements.length} stmts converged=${report.ours.converged}` +
      (report.ours.error ? ` error=${report.ours.error}` : ""),
    `oracle[${report.fixture}] pg-delta: ${report.theirs.statements.length} actions converged=${report.theirs.converged}` +
      (report.theirs.error ? ` error=${report.theirs.error}` : ""),
  ];
  for (const d of report.disagreements) {
    lines.push(
      `oracle[${report.fixture}] ${d.axis}${d.oracleWrong ? " ORACLE-WRONG" : ""}: ${d.detail}` +
        (d.expected ? `\n    expected: ${d.expected}` : ""),
    );
  }
  return lines.join("\n");
}
