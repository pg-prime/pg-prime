import { randomBytes } from "node:crypto";
import pg from "pg";
import { extractCatalog } from "../catalog/extract.js";
import { diffIR } from "../diff/diff.js";
import type { Segment } from "../diff/order.js";
import { createDatabase, dropDatabase, withClient, withDatabase, type ConnInfo } from "../db/pg.js";
import { encodeId } from "../ir/stable-id.js";
import type { SchemaIR } from "../ir/fact.js";
import type { PlanStatement, Proof } from "../plan/plan.js";
import { applySegments } from "../runner/apply.js";

export interface ProveInput {
  /** a maintenance connection (any database other than the one being cloned) */
  readonly admin: ConnInfo;
  /** the CURRENT-state database; cloned, never touched */
  readonly source: ConnInfo;
  readonly desired: SchemaIR;
  readonly schemas: readonly string[];
  readonly statements: readonly PlanStatement[];
  readonly segments: readonly Segment[];
  readonly cloneName?: string;
  readonly keepClone?: boolean;
}

export interface ProofResult extends Proof {
  readonly cloneName: string;
}

/**
 * `migrate verify` semantics, run at generate time (D6):
 * clone → apply the plan → re-extract → assert the diff against the desired
 * state is EMPTY. A plan that does not converge never reaches disk.
 */
export async function proveOnShadowClone(input: ProveInput): Promise<ProofResult> {
  const started = Date.now();
  const clone = input.cloneName ?? `pgorm_shadow_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ ...input.admin });
  await admin.connect();
  try {
    await dropDatabase(admin, clone);
    await createDatabase(admin, clone, input.source.database);
  } finally {
    await admin.end();
  }

  const cloneConn = withDatabase(input.source, clone);
  const fail = async (proof: Proof): Promise<ProofResult> => {
    if (!input.keepClone) await cleanup(input.admin, clone);
    return { ...proof, cloneName: clone, durationMs: Date.now() - started };
  };

  try {
    const applyReport = await withClient(cloneConn, (client) =>
      applySegments(client, input.statements, input.segments),
    );
    if (applyReport.status === "failed") {
      return await fail({
        status: "failed",
        at: new Date().toISOString(),
        shadow: "createdb",
        error: `statement ${applyReport.error?.statementIndex}: ${applyReport.error?.message} — ${applyReport.error?.sql}`,
      });
    }

    const after = await withClient(cloneConn, (client) =>
      extractCatalog(client, { schemas: input.schemas }),
    );
    const residual = diffIR(after.ir, input.desired);
    if (residual.deltas.length > 0) {
      return await fail({
        status: "failed",
        at: new Date().toISOString(),
        shadow: "createdb",
        driftDeltas: residual.deltas.length,
        deltas: residual.deltas.map((d) => `${d.op} ${encodeId(d.op === "rename" ? d.to : d.id)}`),
        error: "plan does not converge: non-empty diff after apply",
      });
    }
    // Fingerprint equality is the stronger statement: it covers edges too.
    if (after.ir.fingerprint !== input.desired.fingerprint) {
      return await fail({
        status: "failed",
        at: new Date().toISOString(),
        shadow: "createdb",
        driftDeltas: 0,
        error: `fingerprint mismatch after apply: ${after.ir.fingerprint} != ${input.desired.fingerprint}`,
      });
    }
    return await fail({ status: "passed", at: new Date().toISOString(), shadow: "createdb", driftDeltas: 0 });
  } catch (err) {
    return await fail({
      status: "failed",
      at: new Date().toISOString(),
      shadow: "createdb",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function cleanup(adminConn: ConnInfo, clone: string): Promise<void> {
  const admin = new pg.Client({ ...adminConn });
  await admin.connect();
  try {
    await dropDatabase(admin, clone);
  } finally {
    await admin.end();
  }
}
