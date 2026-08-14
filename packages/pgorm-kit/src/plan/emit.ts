import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderSql, type Plan } from "./plan.js";

export class ProofRequiredError extends Error {
  constructor(readonly plan: Plan) {
    super(
      `refusing to write ${plan.migration.file}: proof status is "${plan.proof.status}"` +
        (plan.proof.error ? ` — ${plan.proof.error}` : "") +
        (plan.proof.deltas?.length ? ` — residual drift: ${plan.proof.deltas.join(", ")}` : ""),
    );
    this.name = "ProofRequiredError";
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
 * D6 — no plan reaches disk until it has been proven on a shadow clone.
 * This is the whole mitigation: an ordering bug becomes a `generate` failure
 * on a throwaway database instead of a production incident.
 */
export async function writePlan(
  dir: string,
  plan: Plan,
  options: { readonly allowUnproven?: boolean } = {},
): Promise<{ sqlPath: string; planPath: string }> {
  if (plan.proof.status !== "passed" && !options.allowUnproven) throw new ProofRequiredError(plan);
  await mkdir(dir, { recursive: true });
  const base = `${plan.migration.id}_${plan.migration.name}`;
  const sqlPath = join(dir, `${base}.sql`);
  const planPath = join(dir, `${base}.plan.json`);
  await writeFile(sqlPath, planSql(plan), "utf8");
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return { sqlPath, planPath };
}
