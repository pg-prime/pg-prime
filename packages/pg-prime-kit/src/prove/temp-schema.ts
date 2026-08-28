/**
 * D6 without `CREATE DATABASE` — the proof for shadow tier 3 (design/06 §3.2, §3.5).
 *
 * `proveOnShadowClone` clones the target database. On a managed PostgreSQL where the role
 * has no `CREATEDB` — Supabase, Neon, a restricted RDS role, which is the whole reason
 * tier 3 exists — there is nothing to clone with, and D6 is not an optional path: nothing
 * reaches disk unproven. So the proof is run the only other way the ladder allows, in a
 * **second temp-schema set inside the target database**:
 *
 * ```
 *   shadow #1 (already provisioned by generate)   the DESIRED state, loaded from the DSL
 *   shadow #2 (provisioned here)                  the CURRENT state, materialised from IR
 *                                                 → the plan applied → extracted → diffed
 * ```
 *
 * **The statements applied here are re-derived, not rewritten.** The artifact names the
 * user's schemas; the proof needs the same plan against `pgprime_shadow_…_public`. Two
 * ways to get there: substitute the schema name in the SQL text, or remap the two IRs and
 * run the differ again. The first is what design/11 §1.6 refuses for the emitter and for
 * the same reason — a whole-identifier substitution over generated SQL cannot tell
 * `public` the schema from `'public'` inside a CHECK's string literal. The second is safe
 * by construction: `remapIr` is the function whose fixed point K2a's tier-2/tier-3
 * fingerprint-equality test already pins, and re-running `buildStatements` over remapped
 * IRs exercises the same code path on the same diff. The statement COUNT of each stage is
 * compared against the artifact's, so the two plans cannot silently diverge.
 *
 * **Extensions are excluded from both sides.** `CREATE EXTENSION … SCHEMA <shadow>` is a
 * no-op when the extension is already installed in the real `public` — `IF NOT EXISTS`
 * matches on the extension's NAME, not its schema — so the materialised side would claim
 * an extension the shadow cannot have. §3.2 states this constraint for tier 3 already
 * ("objects with a fixed schema … are not normalized"); it is reported, not hidden.
 */

import { randomBytes } from "node:crypto";
import { extractCatalog, type Diagnostic } from "../catalog/extract.js";
import { withClient, type ConnInfo } from "../db/pg.js";
import type { RenameHint } from "../diff/delta.js";
import { buildStatements, type BuildOptions } from "../diff/ddl.js";
import { diffIR } from "../diff/diff.js";
import { splitStages } from "../diff/order.js";
import { SchemaIR, type Fact } from "../ir/fact.js";
import { encodeId, parseId, type StableId } from "../ir/stable-id.js";
import type { PlanStatement, Proof } from "../plan/plan.js";
import { applySegments } from "../runner/apply.js";
import { remapIr } from "../schema/remap.js";
import { provisionShadow, type Shadow } from "../shadow/ladder.js";
import {
  compareDumps,
  dumpSchema,
  resolvePgDump,
  DUMP_SAMPLE_CAP,
  DUMP_TIMEOUT_MS,
  SpawnFailure,
  type DumpOracleMode,
  type DumpOracleVerdict,
  type PgDumpLauncher,
} from "./pg-dump.js";
import type { ProofResult } from "./prove.js";

export interface TempSchemaProveInput {
  /** the database being migrated; the proof's schemas are created and dropped inside it */
  readonly target: ConnInfo;
  /** IR(current) and IR(desired), both in the USER's schema names */
  readonly current: SchemaIR;
  readonly desired: SchemaIR;
  readonly schemas: readonly string[];
  readonly renameHints?: readonly RenameHint[];
  readonly buildOptions?: BuildOptions;
  /** the extractor's diagnostics, threaded through `diffIR` exactly as `generate` does */
  readonly diagnostics?: readonly Diagnostic[];
  readonly strictUnmodeled?: boolean;
  /** statement count per emitted file, in order — the consistency check */
  readonly expectedStages?: readonly number[];
  /** where the DESIRED state already lives, for the D10 witness */
  readonly desiredConn?: ConnInfo;
  /** user schema → the schema `desiredConn` holds it in (identity for tiers 1 and 2) */
  readonly desiredSchemaMap?: ReadonlyMap<string, string>;
  readonly dumpOracle?: DumpOracleMode;
  readonly allowSkippedOracle?: boolean;
  readonly pgDump?: PgDumpLauncher;
  readonly dumpTimeoutMs?: number;
  /** test-only, so the shadow's name is predictable */
  readonly token?: string;
}

const withoutExtensions = (ir: SchemaIR): SchemaIR => {
  const dropped = new Set(ir.factsOfKind("extension").map((f) => encodeId(f.id)));
  if (dropped.size === 0) return ir;
  const keep = (f: Fact): boolean => {
    if (f.id.kind === "extension") return false;
    // A comment whose target is an extension goes with it.
    return !(f.id.kind === "comment" && dropped.has(f.id.target));
  };
  const facts = ir.facts().filter(keep);
  const kept = new Set(facts.map((f) => encodeId(f.id)));
  const edges = ir.edges().filter((e) => kept.has(encodeId(e.from)) && kept.has(encodeId(e.to)));
  return SchemaIR.build(facts, edges);
};

const indexed = (statements: readonly { readonly sql: string }[]): PlanStatement[] =>
  statements.map((s, index) => ({
    ...(s as PlanStatement),
    index,
    timeouts: { lock: null, statement: null },
  }));

export async function proveInTempSchemas(input: TempSchemaProveInput): Promise<ProofResult> {
  const started = Date.now();
  const token = input.token ?? randomBytes(4).toString("hex");
  const diagnostics: Diagnostic[] = [];
  let shadow: Shadow | undefined;

  const done = (proof: Proof): ProofResult => ({
    ...proof,
    provisioning: "materialized",
    cloneName: `temp-schema:${token}`,
    durationMs: Date.now() - started,
  });

  try {
    shadow = await provisionShadow(input.target, input.target, {
      shadow: "temp-schema",
      schemas: input.schemas,
      token,
    });
    const forward = shadow.schemaMap;
    const reverse = new Map([...forward].map(([user, shadowName]) => [shadowName, user]));
    const shadowSchemas = [...forward.values()].sort();

    const current2 = withoutExtensions(remapIr(input.current, forward));
    const desired2 = withoutExtensions(remapIr(input.desired, forward));
    if (current2.factsOfKind("schema").length !== input.current.factsOfKind("schema").length) {
      diagnostics.push({
        code: "shadow_temp_schema_proof",
        severity: "info",
        message: "an extension fact was excluded from the tier-3 proof (design/06 §3.2)",
      });
    }

    /* 1. materialise IR(current) into shadow #2 */
    const bootstrap = diffIR(SchemaIR.build([], []), current2);
    const boot = splitStages(buildStatements(bootstrap, current2).statements);
    for (const file of boot.files) {
      const report = await withClient(input.target, (c) =>
        applySegments(c, indexed(file.statements), file.segments),
      );
      if (report.status === "failed") {
        return done({
          status: "failed",
          at: new Date().toISOString(),
          shadow: "temp-schema",
          error:
            `the tier-3 proof could not materialise the CURRENT state in ${shadowSchemas.join(", ")}: ` +
            `${report.error?.message} — ${report.error?.sql}`,
        });
      }
    }

    /* 2. re-derive the plan against the shadow names and apply it, file by file */
    const mapSchema = (id: StableId): StableId =>
      "schema" in id ? ({ ...id, schema: forward.get(id.schema) ?? id.schema } as StableId) : id;
    const remapHint = (h: RenameHint): RenameHint => ({
      from: mapSchema(typeof h.from === "string" ? parseId(h.from) : h.from),
      to: mapSchema(typeof h.to === "string" ? parseId(h.to) : h.to),
    });
    const shadowDiff = diffIR(current2, desired2, {
      renameHints: (input.renameHints ?? []).map(remapHint),
      ...(input.strictUnmodeled === undefined ? {} : { strictUnmodeled: input.strictUnmodeled }),
      ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
    });
    const shadowPlan = splitStages(
      buildStatements(shadowDiff, desired2, input.buildOptions ?? {}).statements,
    );
    if (input.expectedStages !== undefined) {
      const got = shadowPlan.files.map((f) => f.statements.length);
      const want = [...input.expectedStages];
      if (got.length !== want.length || got.some((n, i) => n !== want[i])) {
        return done({
          status: "failed",
          at: new Date().toISOString(),
          shadow: "temp-schema",
          error:
            `the tier-3 proof re-derived a DIFFERENT plan: ${got.join("+")} statements against the ` +
            `artifact's ${want.join("+")}. The schema remap is not name-transparent, so the proof ` +
            `would not be about the file being written.`,
        });
      }
    }

    const stageFingerprints: string[] = [];
    for (const [i, file] of shadowPlan.files.entries()) {
      const report = await withClient(input.target, (c) =>
        applySegments(c, indexed(file.statements), file.segments),
      );
      if (report.status === "failed") {
        return done({
          status: "failed",
          at: new Date().toISOString(),
          shadow: "temp-schema",
          stageFingerprints,
          error:
            `${shadowPlan.files.length > 1 ? `file ${i + 1}/${shadowPlan.files.length}, ` : ""}` +
            `statement ${report.error?.statementIndex}: ${report.error?.message} — ${report.error?.sql}`,
        });
      }
      const extracted = await withClient(input.target, (c) => extractCatalog(c, { schemas: shadowSchemas, observe: false }));
      stageFingerprints.push(remapIr(extracted.ir, reverse).fingerprint);
    }

    /* 3. the residual diff, in the USER's names — what the artifact claims */
    const finalExtract = await withClient(input.target, (c) =>
      extractCatalog(c, { schemas: shadowSchemas, observe: false }),
    );
    const after = remapIr(finalExtract.ir, reverse);
    const desiredNoExt = withoutExtensions(input.desired);
    const residual = diffIR(withoutExtensions(after), desiredNoExt);
    if (residual.deltas.length > 0) {
      return done({
        status: "failed",
        at: new Date().toISOString(),
        shadow: "temp-schema",
        driftDeltas: residual.deltas.length,
        deltas: residual.deltas.map((d) => `${d.op} ${encodeId(d.op === "rename" ? d.to : d.id)}`),
        stageFingerprints,
        error: "plan does not converge: non-empty diff after apply",
      });
    }
    const adopted = residual.diagnostics.filter(
      (d) => d.code === "adopted_partition" || d.code === "extension_retained",
    );
    if (adopted.length === 0 && withoutExtensions(after).fingerprint !== desiredNoExt.fingerprint) {
      return done({
        status: "failed",
        at: new Date().toISOString(),
        shadow: "temp-schema",
        driftDeltas: 0,
        stageFingerprints,
        error: `fingerprint mismatch after apply: ${withoutExtensions(after).fingerprint} != ${desiredNoExt.fingerprint}`,
      });
    }

    /* 4. D10, with both dumps normalised back to the user's schema names */
    const dumpOracle = await runDumpOracle(input, shadow, finalExtract.pgVersionNum);
    const blockedByFailure = dumpOracle.mode === "strict" && dumpOracle.status === "failed";
    const blockedBySkip =
      dumpOracle.mode === "strict" && dumpOracle.status === "skipped" && input.allowSkippedOracle !== true;
    return done({
      status: blockedByFailure || blockedBySkip ? "failed" : "passed",
      at: new Date().toISOString(),
      shadow: "temp-schema",
      driftDeltas: 0,
      stageFingerprints,
      dumpOracle,
      ...(blockedByFailure
        ? {
            error:
              `pg_dump oracle: ${dumpOracle.missingCount ?? 0} statement(s) missing from the ` +
              `migrated shadow, ${dumpOracle.extraCount ?? 0} unexpected`,
          }
        : {}),
      ...(blockedBySkip
        ? { error: `pg_dump oracle could not run under strict mode: ${dumpOracle.reason ?? "unknown reason"}` }
        : {}),
    });
  } catch (err) {
    return done({
      status: "failed",
      at: new Date().toISOString(),
      shadow: "temp-schema",
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (shadow) await shadow.dispose().catch(() => undefined);
  }
}

/** `pgprime_shadow_ab12_public.users` → `public.users`, as whole identifiers. */
function unshadow(text: string, map: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [from, to] of map) {
    if (from === to) continue;
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replaceAll(new RegExp(`"${escaped}"`, "g"), `"${to}"`);
    out = out.replaceAll(new RegExp(`\\b${escaped}\\b`, "g"), to);
  }
  return out;
}

async function runDumpOracle(
  input: TempSchemaProveInput,
  shadow: Shadow,
  serverVersionNum: number,
): Promise<DumpOracleVerdict> {
  const mode: DumpOracleMode = input.dumpOracle ?? "warn";
  if (mode === "off") return { status: "skipped", mode, reason: "disabled" };
  if (!input.desiredConn || !input.desiredSchemaMap) {
    return { status: "skipped", mode, reason: "no desired connection supplied" };
  }
  const pgDump = await resolvePgDump(input.pgDump);
  if ("unavailable" in pgDump) return { status: "skipped", mode, reason: pgDump.unavailable };
  const serverMajor = Math.floor(serverVersionNum / 10000);
  if (serverMajor > 0 && pgDump.major < serverMajor) {
    return {
      status: "skipped",
      mode,
      pgDumpVersion: pgDump.version,
      reason: `pg_dump major ${pgDump.major} is older than the server (major ${serverMajor})`,
    };
  }

  const timeoutMs = input.dumpTimeoutMs ?? DUMP_TIMEOUT_MS;
  // Both sides are dumped under whatever schema names they happen to live in and then
  // rewritten to the USER's names, because the two shadows never share a prefix — the
  // comparison would otherwise report every statement as both missing and extra.
  const proofMap = new Map([...shadow.schemaMap].map(([user, name]) => [name, user]));
  const desiredMap = new Map([...input.desiredSchemaMap].map(([user, name]) => [name, user]));
  try {
    const proofDump = await dumpSchema({
      pgDump,
      conn: input.target,
      database: input.target.database,
      schemas: [...shadow.schemaMap.values()],
      timeoutMs,
    });
    const desiredDump = await dumpSchema({
      pgDump,
      conn: input.desiredConn,
      database: input.desiredConn.database,
      schemas: [...input.desiredSchemaMap.values()],
      timeoutMs,
    });
    const cmp = compareDumps(unshadow(proofDump, proofMap), unshadow(desiredDump, desiredMap));
    const reordered = cmp.reordered.length > 0 ? { reordered: cmp.reordered } : {};
    if (cmp.equal) {
      return { status: "passed", mode, pgDumpVersion: pgDump.version, statementCount: cmp.statementCount, ...reordered };
    }
    return {
      status: "failed",
      mode,
      pgDumpVersion: pgDump.version,
      statementCount: cmp.statementCount,
      missingCount: cmp.missing.length,
      extraCount: cmp.extra.length,
      missing: cmp.missing.slice(0, DUMP_SAMPLE_CAP),
      extra: cmp.extra.slice(0, DUMP_SAMPLE_CAP),
      ...reordered,
    };
  } catch (err) {
    if (err instanceof SpawnFailure) return { status: "skipped", mode, reason: err.message };
    return { status: "failed", mode, reason: err instanceof Error ? err.message : String(err) };
  }
}
