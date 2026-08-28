import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { migrationId, renderSql, type Plan, type PlanHazard } from "./plan.js";

/** Every reason `writePlan` refuses. Callers distinguish a refusal from an I/O error. */
export abstract class WriteRefusedError extends Error {
  abstract readonly code: string;
}

export class ProofRequiredError extends WriteRefusedError {
  readonly code = "PG_PRIME_PROOF_REQUIRED";
  constructor(readonly plan: Plan) {
    super(
      `refusing to write ${plan.migration.file}: proof status is "${plan.proof.status}"` +
        (plan.proof.error ? ` — ${plan.proof.error}` : "") +
        (plan.proof.deltas?.length ? ` — residual drift: ${plan.proof.deltas.join(", ")}` : ""),
    );
    this.name = "ProofRequiredError";
  }
}

/**
 * design/06 §3.6 — a destructive change cannot reach disk silently. `writePlan` used
 * to gate on the proof alone, so a plan that dropped a column was written with every
 * DS103 hazard sitting at `acknowledged: false`.
 */
export class UnacknowledgedHazardError extends WriteRefusedError {
  readonly code = "PG_PRIME_UNACKNOWLEDGED_HAZARD";
  constructor(
    readonly plan: Plan,
    readonly hazards: readonly PlanHazard[],
  ) {
    super(
      `refusing to write ${plan.migration.file}: ${hazards.length} error-severity hazard(s) ` +
        `are unacknowledged — ${hazards.map((h) => `${h.code} ${h.subject || "(no subject)"}`).join(", ")}. ` +
        `Pass allowDataLoss, or record the acknowledgement in the plan (design/06 §3.6).`,
    );
    this.name = "UnacknowledgedHazardError";
  }
}

/** A migration name that would escape `outDir`, or a file that already exists. */
export class UnsafePlanPathError extends WriteRefusedError {
  readonly code = "PG_PRIME_UNSAFE_PLAN_PATH";
  constructor(message: string) {
    super(message);
    this.name = "UnsafePlanPathError";
  }
}

export function planSql(plan: Plan): string {
  return renderSql({
    id: `${plan.migration.id}_${plan.migration.name}`,
    name: plan.migration.name,
    statements: plan.statements,
    segments: plan.segments,
    txmode: plan.txmode,
    from: plan.from.fingerprint,
    to: plan.to.fingerprint,
    pgMin: plan.pg.minVersion,
  });
}

/**
 * A migration's ordering key. design/06 §4.1: duplicate `NNNN` is legal and files are
 * ordered by `(seq, name)`, which is what lets one `generate` run emit `0007_x.sql`,
 * `0007_x_concurrently.sql` and `0007_x_data.sql` and have the runner apply them in that
 * order without a journal.
 */
export function planOrderKey(plan: Plan): readonly [number, string] {
  return [Number(plan.migration.id), plan.migration.name];
}

/**
 * D6 — no plan reaches disk until it has been proven on a shadow clone.
 * This is the whole mitigation: an ordering bug becomes a `generate` failure
 * on a throwaway database instead of a production incident.
 */
export async function writePlan(
  dir: string,
  plan: Plan,
  options: { readonly allowUnproven?: boolean; readonly allowDataLoss?: boolean } = {},
): Promise<{ sqlPath: string; planPath: string }> {
  if (plan.proof.status !== "passed" && !options.allowUnproven) throw new ProofRequiredError(plan);
  if (!options.allowDataLoss) {
    const unacknowledged = plan.hazards.filter((h) => h.severity === "error" && !h.acknowledged);
    if (unacknowledged.length > 0) throw new UnacknowledgedHazardError(plan, unacknowledged);
  }

  // `migration.name` is caller data that becomes a path segment. Validate it, then
  // prove containment on the RESOLVED path, so neither a traversal nor a symlinked
  // `dir` can place the artifact somewhere the caller did not name.
  try {
    migrationId(Number(plan.migration.id), plan.migration.name);
  } catch (err) {
    throw new UnsafePlanPathError(err instanceof Error ? err.message : String(err));
  }
  const root = resolve(dir);
  const base = `${plan.migration.id}_${plan.migration.name}`;
  const sqlPath = join(root, `${base}.sql`);
  const planPath = join(root, `${base}.plan.json`);
  for (const path of [sqlPath, planPath]) {
    if (resolve(path) !== path || !path.startsWith(root + sep)) {
      throw new UnsafePlanPathError(`refusing to write ${JSON.stringify(path)}: it is outside ${JSON.stringify(root)}`);
    }
  }

  await mkdir(root, { recursive: true });
  // `wx`: a migration file is immutable history. Silently overwriting one rewrites a
  // migration another developer may already have applied.
  try {
    await writeFile(sqlPath, planSql(plan), { encoding: "utf8", flag: "wx" });
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "EEXIST") {
      throw new UnsafePlanPathError(`refusing to overwrite an existing migration ${JSON.stringify(base)} in ${JSON.stringify(root)}`);
    }
    throw err;
  }
  return { sqlPath, planPath };
}
