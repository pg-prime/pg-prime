import { extractCatalog, type Diagnostic } from "./catalog/extract.js";
import type { RenameHint } from "./diff/delta.js";
import { buildStatements } from "./diff/ddl.js";
import { diffIR, type DiffResult } from "./diff/diff.js";
import { orderStatements } from "./diff/order.js";
import { withClient, type ConnInfo } from "./db/pg.js";
import type { SchemaIR } from "./ir/fact.js";
import { writePlan, type ProofRequiredError } from "./plan/emit.js";
import { buildPlan, type Plan } from "./plan/plan.js";
import { proveOnShadowClone } from "./prove/prove.js";

export interface GenerateInput {
  /** maintenance connection used for CREATE DATABASE (the shadow ladder, tier 2) */
  readonly admin: ConnInfo;
  /** the database holding the CURRENT state */
  readonly target: ConnInfo;
  /** the database holding the DESIRED state, already normalized by PostgreSQL */
  readonly desired: ConnInfo;
  readonly schemas?: readonly string[];
  readonly seq: number;
  readonly name: string;
  readonly renameHints?: readonly RenameHint[];
  readonly outDir?: string;
  readonly prove?: boolean;
  readonly allowUnproven?: boolean;
}

export interface GenerateResult {
  readonly plan: Plan;
  readonly diff: DiffResult;
  readonly currentIR: SchemaIR;
  readonly desiredIR: SchemaIR;
  readonly diagnostics: readonly Diagnostic[];
  readonly written?: { readonly sqlPath: string; readonly planPath: string };
  readonly writeRefusal?: string;
}

/** The whole pipeline of design/06 §3, minus the CLI. */
export async function generate(input: GenerateInput): Promise<GenerateResult> {
  const schemas = input.schemas ?? ["public"];

  const current = await withClient(input.target, (c) => extractCatalog(c, { schemas }));
  const desired = await withClient(input.desired, (c) => extractCatalog(c, { schemas }));

  const diff = diffIR(current.ir, desired.ir, { renameHints: input.renameHints ?? [] });
  const built = buildStatements(diff, desired.ir);
  const ordered = orderStatements(built.statements);
  const diagnostics = [...built.diagnostics, ...ordered.diagnostics];

  const base = {
    seq: input.seq,
    name: input.name,
    statements: ordered.statements,
    segments: ordered.segments,
    fromFingerprint: diff.current.fingerprint,
    toFingerprint: desired.ir.fingerprint,
    pgVersionNum: current.pgVersionNum,
    renames: diff.renames,
    diagnostics: [...current.diagnostics, ...diagnostics],
  };

  const draft = buildPlan(base);

  let plan = draft;
  if (input.prove !== false) {
    const proof = await proveOnShadowClone({
      admin: input.admin,
      source: input.target,
      desired: desired.ir,
      schemas,
      statements: draft.statements,
      segments: draft.segments,
    });
    plan = buildPlan({ ...base, proof });
  }

  const result: GenerateResult = {
    plan,
    diff,
    currentIR: current.ir,
    desiredIR: desired.ir,
    diagnostics,
  };
  if (!input.outDir) return result;
  try {
    const written = await writePlan(input.outDir, plan, { allowUnproven: input.allowUnproven ?? false });
    return { ...result, written };
  } catch (err) {
    return { ...result, writeRefusal: (err as ProofRequiredError).message };
  }
}
