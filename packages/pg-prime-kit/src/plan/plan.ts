import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import type { Diagnostic } from "../catalog/extract.js";
import type { RenameRecord } from "../diff/delta.js";
import type { Segment } from "../diff/order.js";
import type { LockClass, Statement, Transactionality } from "../diff/statement.js";
import { canonicalize, sha256 } from "../ir/hash.js";
import type { DumpOracleVerdict } from "../prove/pg-dump.js";

export const ENGINE = { name: "pg-prime-kit", version: "0.0.0-spike", backend: "in-house", irVersion: 1 } as const;

/**
 * `--by`'s advertised default: the operating-system user (design/12 F2 item g).
 *
 * Every `--by` flag in the CLI has said `default $USER` since K1 and nothing read it — the plan
 * recorded the literal `"spike"`, so every acknowledgement in every repository was signed by a
 * word from a spike branch. The order is the one an operator can reason about: `USER`/`USERNAME`
 * first, because that is what a shell exports and what a CI job overrides; `os.userInfo()` next,
 * for a process started with no environment at all (a systemd unit, a container ENTRYPOINT);
 * `unknown` last, because a plan with no author is still a plan and a missing passwd entry is not
 * a reason to fail a `generate`.
 */
export function osUser(env: NodeJS.ProcessEnv = process.env): string {
  const named = env["USER"] ?? env["USERNAME"];
  if (named !== undefined && named.trim() !== "") return named;
  try {
    const username = userInfo().username;
    if (username.trim() !== "") return username;
  } catch {
    // uid with no passwd entry — `userInfo` throws rather than answering
  }
  return "unknown";
}

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
  /**
   * Why a proof was skipped. `migrate baseline` (design/11 §1.9) writes a plan whose DDL
   * was never executed anywhere — the database it describes already exists — so there is
   * nothing to prove on a clone, and "skipped" with no reason is indistinguishable from
   * `generate --no-prove`. Additive: every existing `{ status: "skipped" }` still parses.
   */
  readonly reason?: string;
  readonly at?: string;
  readonly shadow?: string;
  /** which tier of design/06 §3.2 actually provisioned the shadow */
  readonly provisioning?: "template" | "materialized";
  readonly driftDeltas?: number;
  readonly deltas?: readonly string[];
  /**
   * The catalog fingerprint after each emitted FILE was applied to the clone, measured.
   *
   * A `generate` run that splits a plan across `NNNN_name.sql` and
   * `NNNN_name_concurrently.sql` (design/06 §3.5 rows 1/6/7) needs the state *between*
   * them for the second file's `from.fingerprint`, and it cannot be predicted from the
   * IR — only observed. One entry per stage, in apply order.
   */
  readonly stageFingerprints?: readonly string[];
  readonly error?: string;
  readonly durationMs?: number;
  /** independent witness: PostgreSQL's own serializer (see prove/pg-dump.ts) */
  readonly dumpOracle?: DumpOracleVerdict;
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
  /**
   * The managed schema set this plan was generated against (design/11 K1's open item 1).
   *
   * It scopes the diff, the fingerprint AND the advisory-lock key, so a runner pointed at
   * a different set computes a different fingerprint and refuses — with a message about
   * fingerprints, which is the wrong sentence for the actual mistake. Recording the set in
   * the artifact lets `apply` name both sides instead.
   */
  readonly schemas: readonly string[];
  readonly normalized: boolean;
  readonly shadowTier: 1 | 2 | 3 | 4;
  readonly txmode: "transactional" | "none" | "segmented";
  readonly segments: readonly Segment[];
  readonly statements: readonly PlanStatement[];
  readonly renames: readonly RenameRecord[];
  readonly hazards: readonly PlanHazard[];
  readonly unmodeled: readonly { readonly kind: string; readonly count: number }[];
  /** design/06 §4.3 — the Tier-R files that were loaded into the shadow for this proof. */
  readonly repeatables: readonly { readonly path: string; readonly sha256: string }[];
  /**
   * design/06 §3.6 — a destructive change cannot be generated silently. This lands
   * in `.plan.json`, so it shows up as a diff line in the pull request; that IS the
   * review interface. Excluded from `planId` for the same reason `generated` is: it
   * carries a wall-clock timestamp and an operator name.
   */
  readonly acknowledged: Acknowledgement | null;
  readonly proof: Proof;
}

export interface Acknowledgement {
  /** hazard subjects (encoded StableIds) the operator signed off on */
  readonly dataLoss: readonly string[];
  readonly by: string;
  readonly reason: string;
  readonly at: string;
  /** blanket `--allow-data-loss`, rather than a per-subject list */
  readonly blanket: boolean;
}

export interface AcknowledgeInput {
  readonly dataLoss?: readonly string[];
  readonly by?: string;
  readonly reason?: string;
  /** `--allow-data-loss`: acknowledge every error-severity hazard in this plan */
  readonly allowDataLoss?: boolean;
}

/**
 * design/06 §3.4, complete. A code absent from this table used to silently default to
 * `warn`, which is the wrong direction for the DS/MF/TX families: an unlisted DS105 was
 * a destructive change reported as an advisory.
 */
const HAZARD_SEVERITY: Record<string, "error" | "warn"> = {
  DS101: "error",
  DS102: "error",
  DS103: "error",
  DS104: "error",
  DS105: "error",
  DS106: "error",
  MF101: "error",
  MF102: "error",
  MF103: "error",
  MF104: "error",
  MF105: "error",
  MF106: "error",
  BC101: "warn",
  BC102: "warn",
  BC103: "warn",
  BC104: "warn",
  BC105: "warn",
  LK101: "warn",
  LK102: "warn",
  LK103: "warn",
  LK104: "warn",
  LK105: "warn",
  LK106: "warn",
  LK107: "warn",
  LK108: "warn",
  LK109: "warn",
  LK110: "warn",
  LK111: "warn",
  LK112: "warn",
  TX101: "error",
  TX102: "error",
  TX201: "error",
  EN101: "error",
  EN102: "error",
};

/** An unknown code is a bug in the emitter, not an advisory — it must not be silent. */
export function hazardSeverity(code: string): "error" | "warn" {
  return HAZARD_SEVERITY[code] ?? "error";
}

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
  readonly acknowledge?: AcknowledgeInput;
  /** the managed schema set; defaults to `["public"]` */
  readonly schemas?: readonly string[];
  /** design/06 §7 lane 2 — write `-- pg-prime:data` into the header */
  readonly data?: boolean;
  /** design/06 §4.5 — write `-- pg-prime:checkpoint` into the header */
  readonly checkpoint?: boolean;
  /** design/06 §4.3's `repeatables`: the `sql/` files loaded into the shadow */
  readonly repeatables?: readonly { readonly path: string; readonly sha256: string }[];
}

/**
 * A migration name becomes a FILENAME, and `writePlan` used to join it into the output
 * directory unchecked - `name: "../../escaped"` wrote outside `outDir`. The alphabet is
 * deliberately narrower than "safe": migration ids are also matched by the runner's
 * reconciler and sorted lexicographically, so case and punctuation are liabilities.
 */
export const MIGRATION_NAME: RegExp = /^[a-z0-9_]+$/;

export class InvalidMigrationIdError extends Error {
  readonly code = "PG_PRIME_INVALID_MIGRATION_ID";
  constructor(message: string) {
    super(message);
    this.name = "InvalidMigrationIdError";
  }
}

export function migrationId(seq: number, name: string): string {
  if (!Number.isInteger(seq) || seq < 0) {
    throw new InvalidMigrationIdError(`migration seq must be a non-negative integer, received ${String(seq)}`);
  }
  if (!MIGRATION_NAME.test(name)) {
    throw new InvalidMigrationIdError(`migration name ${JSON.stringify(name)} must match ${String(MIGRATION_NAME)}`);
  }
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

  const ack = input.acknowledge;
  const signedOff = new Set(ack?.dataLoss ?? []);
  const blanket = ack?.allowDataLoss === true;
  const isAcknowledged = (severity: "error" | "warn", subject: string): boolean =>
    severity !== "error" || blanket || signedOff.has(subject);

  const raw: PlanHazard[] = [];
  statements.forEach((s, index) => {
    for (const code of s.hazards) {
      const severity = hazardSeverity(code);
      const subject = s.destroys[0] ?? s.produces[0] ?? s.consumes[0] ?? "";
      raw.push({
        code,
        severity,
        statement: index,
        subject,
        message: `${code} on: ${s.sql.split("\n")[0]}`,
        acknowledged: isAcknowledged(severity, subject),
      });
    }
  });
  for (const d of input.diagnostics) {
    if (d.severity !== "error") continue;
    raw.push({
      code: d.code,
      severity: "error",
      statement: -1,
      subject: d.subject ?? "",
      message: d.message,
      acknowledged: isAcknowledged("error", d.subject ?? ""),
    });
  }
  const hazards: readonly PlanHazard[] = raw;
  const acknowledgedSubjects = [
    ...new Set(raw.filter((h) => h.severity === "error" && h.acknowledged).map((h) => h.subject)),
  ].sort();
  const acknowledged: Acknowledgement | null =
    ack === undefined || (!blanket && signedOff.size === 0)
      ? null
      : {
          dataLoss: acknowledgedSubjects,
          by: ack.by ?? input.by ?? osUser(),
          reason: ack.reason ?? (blanket ? "--allow-data-loss" : "hints-file acknowledgement"),
          at: new Date().toISOString(),
          blanket,
        };

  const txmode: Plan["txmode"] = input.segments.every((s) => s.transactional)
    ? input.segments.length > 1
      ? "segmented"
      : "transactional"
    : "none";

  const id = migrationId(input.seq, input.name);
  const file = `${id}.sql`;
  const sqlText = renderSql({
    id,
    name: input.name,
    statements,
    segments: input.segments,
    txmode,
    from: input.fromFingerprint,
    to: input.toFingerprint,
    pgMin: 150000,
    ...(input.data === true ? { data: true } : {}),
    ...(input.checkpoint === true ? { checkpoint: true } : {}),
  });

  const core = {
    formatVersion: 1 as const,
    engine: ENGINE,
    migration: { id: String(input.seq).padStart(4, "0"), name: input.name, file, sha256: sha256(sqlText) },
    from: { fingerprint: input.fromFingerprint },
    to: { fingerprint: input.toFingerprint },
    pg: { minVersion: 150000, generatedAgainst: input.pgVersionNum },
    schemas: [...(input.schemas ?? ["public"])].sort(),
    normalized: true,
    shadowTier: input.shadowTier ?? 2,
    txmode,
    segments: input.segments,
    statements,
    renames: input.renames,
    hazards,
    // The count travels on the diagnostic; parsing it back out of the human-readable
    // message with a regex made the plan's census hostage to message wording.
    unmodeled: input.diagnostics
      .filter((d) => d.code === "unmodeled_kind")
      .map((d) => ({ kind: d.subject ?? "?", count: d.count ?? 0 })),
    repeatables: input.repeatables ?? [],
  };

  // planId deliberately excludes `generated` and `proof`, so the same logical
  // plan re-proven by a different person on a different day has a stable id.
  const planId = `sha256:${createHash("sha256").update(canonicalize(core), "utf8").digest("hex")}`;

  return {
    ...core,
    planId,
    generated: { at: new Date().toISOString(), by: input.by ?? osUser(), interactive: false },
    acknowledged,
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
  /** design/06 §7 lane 2 — emit `-- pg-prime:data` in the header. */
  readonly data?: boolean;
  /** design/06 §4.5 — emit `-- pg-prime:checkpoint` in the header. */
  readonly checkpoint?: boolean;
}

/** The `.sql` is the executable artifact and must be runnable by psql. */
export function renderSql(r: RenderInput): string {
  // Declared, not assumed: an intentionally long-running build carries
  // `statement: null`, so a blanket `statement=30s` in the header was a lie the
  // runner did not tell. `0` is PostgreSQL's spelling of "no timeout".
  const uniform = (pick: (s: PlanStatement) => string | null): string => {
    const seen = new Set(r.statements.map((s) => pick(s) ?? "0"));
    return seen.size === 1 ? [...seen][0]! : "per-statement";
  };
  const lock = r.statements.length ? uniform((s) => s.timeouts.lock) : "3s";
  const statement = r.statements.length ? uniform((s) => s.timeouts.statement) : "30s";
  const lines: string[] = [
    `-- pg-prime:migration ${r.id}`,
    `-- pg-prime:plan      ${r.id}.plan.json`,
    `-- pg-prime:from      ${r.from}`,
    `-- pg-prime:to        ${r.to}`,
    `-- pg-prime:txmode    ${r.txmode}`,
    `-- pg-prime:timeout   lock=${lock} statement=${statement}`,
    `-- pg-prime:requires-pg ${r.pgMin}`,
    ...(r.data === true ? ["-- pg-prime:data"] : []),
    ...(r.checkpoint === true ? ["-- pg-prime:checkpoint"] : []),
    "",
    // Every identifier the emitter writes is schema-qualified, and extraction ran
    // under the same search_path, so pinning it makes the file mean the same thing
    // under psql as it does under the runner (design/06 §5.3).
    "SET search_path = pg_catalog;",
    "",
  ];
  for (const seg of r.segments) {
    lines.push(`-- pg-prime:segment ${seg.index} ${seg.transactional ? "transactional" : "bare"}`);
    for (const i of seg.statements) {
      const s = r.statements[i]!;
      const flags = [
        `lock=${s.lockClass}`,
        s.idempotent ? "idempotent" : "non-idempotent",
        ...(s.hazards.length ? [`hazards=${s.hazards.join(",")}`] : []),
      ];
      lines.push(`-- pg-prime:stmt ${i} ${flags.join(" ")}`);
      lines.push(`${s.sql};`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
