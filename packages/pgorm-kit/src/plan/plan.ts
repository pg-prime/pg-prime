import { createHash } from "node:crypto";
import type { Diagnostic } from "../catalog/extract.js";
import type { RenameRecord } from "../diff/delta.js";
import type { Segment } from "../diff/order.js";
import type { LockClass, Statement, Transactionality } from "../diff/statement.js";
import { canonicalize, sha256 } from "../ir/hash.js";

export const ENGINE = { name: "pgorm-kit", version: "0.0.0-spike", backend: "in-house", irVersion: 1 } as const;

export interface PlanStatement {
  readonly index: number;
  readonly sql: string;
  readonly verb: Statement["verb"];
  readonly kind: string;
  readonly produces: readonly string[];
  readonly consumes: readonly string[];
  readonly destroys: readonly string[];
  readonly releases: readonly string[];
  readonly transactionality: Transactionality;
  readonly lockClass: LockClass;
  readonly idempotent: boolean;
  readonly timeouts: { readonly lock: string | null; readonly statement: string | null };
  readonly dataLoss: "none" | "destructive";
  readonly rewrite: boolean;
  readonly hazards: readonly string[];
}

export interface PlanHazard {
  readonly code: string;
  readonly severity: "error" | "warn";
  readonly statement: number;
  readonly subject: string;
  readonly message: string;
  readonly acknowledged: boolean;
}

export interface Proof {
  readonly status: "passed" | "failed" | "skipped";
  readonly at?: string;
  readonly shadow?: string;
  readonly driftDeltas?: number;
  readonly deltas?: readonly string[];
  readonly error?: string;
  readonly durationMs?: number;
}

export interface Plan {
  readonly formatVersion: 1;
  readonly planId: string;
  readonly engine: typeof ENGINE;
  readonly generated: { readonly at: string; readonly by: string; readonly interactive: boolean };
  readonly migration: { readonly id: string; readonly name: string; readonly file: string; readonly sha256: string };
  readonly from: { readonly fingerprint: string };
  readonly to: { readonly fingerprint: string };
  readonly pg: { readonly minVersion: number; readonly generatedAgainst: number };
  readonly normalized: boolean;
  readonly shadowTier: 1 | 2 | 3 | 4;
  readonly txmode: "transactional" | "none" | "segmented";
  readonly segments: readonly Segment[];
  readonly statements: readonly PlanStatement[];
  readonly renames: readonly RenameRecord[];
  readonly hazards: readonly PlanHazard[];
  readonly unmodeled: readonly { readonly kind: string; readonly count: number }[];
  readonly proof: Proof;
}

const HAZARD_SEVERITY: Record<string, "error" | "warn"> = {
  DS101: "error", DS102: "error", DS103: "error", DS104: "error", DS106: "error",
  MF101: "error", MF103: "error", MF104: "error", MF105: "error", MF106: "error",
  BC101: "warn", BC102: "warn", BC103: "warn",
  LK101: "warn", LK102: "warn", LK104: "warn", LK107: "warn", LK108: "warn", LK110: "warn", LK112: "warn",
  EN101: "error", EN102: "error",
};

export interface BuildPlanInput {
  readonly seq: number;
  readonly name: string;
  readonly statements: readonly Statement[];
  readonly segments: readonly Segment[];
  readonly fromFingerprint: string;
  readonly toFingerprint: string;
  readonly pgVersionNum: number;
  readonly renames: readonly RenameRecord[];
  readonly diagnostics: readonly Diagnostic[];
  readonly by?: string;
  readonly shadowTier?: 1 | 2 | 3 | 4;
  readonly proof?: Proof;
}

export function migrationId(seq: number, name: string): string {
  return `${String(seq).padStart(4, "0")}_${name}`;
}

export function buildPlan(input: BuildPlanInput): Plan {
  const statements: PlanStatement[] = input.statements.map((s, index) => ({
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
    timeouts: {
      lock: "3s",
      // Intentionally long-running builds are exempt from statement_timeout;
      // lock_timeout still applies (design/06 §5.4).
      statement: s.lockClass === "shareUpdateExclusive" ? null : "30s",
    },
    dataLoss: s.dataLoss,
    rewrite: s.rewrite,
    hazards: s.hazards,
  }));

  const hazards: PlanHazard[] = [];
  statements.forEach((s, index) => {
    for (const code of s.hazards) {
      hazards.push({
        code,
        severity: HAZARD_SEVERITY[code] ?? "warn",
        statement: index,
        subject: s.destroys[0] ?? s.produces[0] ?? s.consumes[0] ?? "",
        message: `${code} on: ${s.sql.split("\n")[0]}`,
        acknowledged: false,
      });
    }
  });
  for (const d of input.diagnostics) {
    if (d.severity !== "error") continue;
    hazards.push({
      code: d.code,
      severity: "error",
      statement: -1,
      subject: d.subject ?? "",
      message: d.message,
      acknowledged: false,
    });
  }

  const txmode: Plan["txmode"] =
    input.segments.every((s) => s.transactional)
      ? input.segments.length > 1
        ? "segmented"
        : "transactional"
      : "none";

  const id = migrationId(input.seq, input.name);
  const file = `${id}.sql`;
  const sqlText = renderSql({ id, name: input.name, statements, segments: input.segments, txmode, from: input.fromFingerprint, to: input.toFingerprint, pgMin: 150000 });

  const core = {
    formatVersion: 1 as const,
    engine: ENGINE,
    migration: { id: String(input.seq).padStart(4, "0"), name: input.name, file, sha256: sha256(sqlText) },
    from: { fingerprint: input.fromFingerprint },
    to: { fingerprint: input.toFingerprint },
    pg: { minVersion: 150000, generatedAgainst: input.pgVersionNum },
    normalized: true,
    shadowTier: input.shadowTier ?? 2,
    txmode,
    segments: input.segments,
    statements,
    renames: input.renames,
    hazards,
    unmodeled: input.diagnostics
      .filter((d) => d.code === "unmodeled_kind")
      .map((d) => ({ kind: d.subject ?? "?", count: Number(/^(\d+)/.exec(d.message)?.[1] ?? 0) })),
  };

  // planId deliberately excludes `generated` and `proof`, so the same logical
  // plan re-proven by a different person on a different day has a stable id.
  const planId = `sha256:${createHash("sha256").update(canonicalize(core), "utf8").digest("hex")}`;

  return {
    ...core,
    planId,
    generated: { at: new Date().toISOString(), by: input.by ?? "spike", interactive: false },
    proof: input.proof ?? { status: "skipped" },
  };
}

export interface RenderInput {
  readonly id: string;
  readonly name: string;
  readonly statements: readonly PlanStatement[];
  readonly segments: readonly Segment[];
  readonly txmode: Plan["txmode"];
  readonly from: string;
  readonly to: string;
  readonly pgMin: number;
}

/** The `.sql` is the executable artifact and must be runnable by psql. */
export function renderSql(r: RenderInput): string {
  const lines: string[] = [
    `-- pg-orm:migration ${r.id}`,
    `-- pg-orm:plan      ${r.id}.plan.json`,
    `-- pg-orm:from      ${r.from}`,
    `-- pg-orm:to        ${r.to}`,
    `-- pg-orm:txmode    ${r.txmode}`,
    `-- pg-orm:timeout   lock=3s statement=30s`,
    `-- pg-orm:requires-pg ${r.pgMin}`,
    "",
  ];
  for (const seg of r.segments) {
    lines.push(`-- pg-orm:segment ${seg.index} ${seg.transactional ? "transactional" : "bare"}`);
    for (const i of seg.statements) {
      const s = r.statements[i]!;
      const flags = [
        `lock=${s.lockClass}`,
        s.idempotent ? "idempotent" : "non-idempotent",
        ...(s.hazards.length ? [`hazards=${s.hazards.join(",")}`] : []),
      ];
      lines.push(`-- pg-orm:stmt ${i} ${flags.join(" ")}`);
      lines.push(`${s.sql};`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
