/**
 * `migrate generate` — design/06 §3's pipeline, end to end, from a `pg-prime.config.ts`.
 *
 * ```
 *   TS schema ─┐
 *              ├─► desired SQL ─► [shadow] ─► extract ─► IR(desired) ─┐
 *   sql/ ──────┘                                                      │
 *   target DB ─────────────────► extract ─► IR(current) ──────────────┴─► diff
 *        renames (annotation → candidates → hints) ─────────────────────►  │
 *                                                                          ▼
 *        order ─► lock-safe rewriting ─► hazards ─► Plan(s) ─► PROVE ─► files
 * ```
 *
 * Two things here are the workstream, not plumbing:
 *
 *  1. **The desired state comes from TypeScript.** `generate` no longer takes a `desired`
 *     database. The old three-connection entry point survives as
 *     {@link generateFromDatabases} — the fixture corpus and the runner's chain builder
 *     are written against it and neither should be weakened to make room for the new one.
 *  2. **One run may write more than one file.** design/06 §3.5 rows 1, 6 and 7 all need a
 *     `CREATE INDEX CONCURRENTLY`, which cannot share a transaction with the rest of the
 *     plan, so the plan is cut into `NNNN_name.sql` (transactional) and
 *     `NNNN_name_concurrently.sql` (`txmode none`), which §4.1's `(seq, name)` ordering
 *     applies in that order. The fingerprint *between* them cannot be predicted from the
 *     IR, so it is measured on the clone: `Proof.stageFingerprints`.
 *
 * Nothing reaches disk unproven (D6) and nothing destructive reaches disk unacknowledged
 * (§3.6) — both refusals live in `writePlan` and are surfaced here as a status.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractCatalog, probeEmptiness, type Diagnostic, type ExtractResult } from "./catalog/extract.js";
import { GUC_BATCH_SIZE, GUC_WATERMARK } from "./data/batch.js";
import { HISTORY_SCHEMA } from "./history/schema.js";
import { BATCH_DEFAULTS } from "./runner/files.js";
import { renameCandidates, type RenameCandidate } from "./diff/candidates.js";
import type { RenameHint } from "./diff/delta.js";
import { buildStatements, type BuildOptions } from "./diff/ddl.js";
import { diffIR, type DiffResult } from "./diff/diff.js";
import { orderStatements, splitStages, type StagedFile } from "./diff/order.js";
import { withClient, type ConnInfo } from "./db/pg.js";
import { SchemaIR } from "./ir/fact.js";
import { encodeId, parseId, type StableId } from "./ir/stable-id.js";
import { planSql, writePlan, WriteRefusedError } from "./plan/emit.js";
import { buildPlan, type AcknowledgeInput, type Plan, type Proof } from "./plan/plan.js";
import { proveOnShadowClone, type ProveStage } from "./prove/prove.js";
import { proveInTempSchemas } from "./prove/temp-schema.js";
import type { DumpOracleMode, PgDumpLauncher } from "./prove/pg-dump.js";
import { loadRepeatables, type RepeatableFile } from "./repeatables/index.js";
import { loadDesired } from "./schema/load.js";
import type { SchemaLike } from "./schema/types.js";
import { provisionShadow, type Shadow, type ShadowStrategy } from "./shadow/ladder.js";

/* -------------------------------------------------------------------------- */
/* the config-driven entry point                                              */
/* -------------------------------------------------------------------------- */

export interface GenerateInput {
  /** Maintenance connection for `CREATE DATABASE` (shadow tier 2, and the D6 clone). */
  readonly admin?: ConnInfo;
  /** The database holding the CURRENT state. */
  readonly target: ConnInfo;
  /** The `defineSchema(...)` registry the config points at. */
  readonly schema: SchemaLike;
  /** Tier R (design/06 §3.8): loaded into the shadow so a stale view fails the proof. */
  readonly repeatablesDir?: string;
  readonly schemas?: readonly string[];
  readonly shadow?: ShadowStrategy;
  readonly seq: number;
  readonly name: string;
  /** `--hints-file`, plus whatever `renamedFrom` in the schema resolved to. */
  readonly hints?: readonly RenameHint[];
  readonly acknowledge?: AcknowledgeInput;
  /** `--no-prove` (design/06 §6.2, dev only). */
  readonly prove?: boolean;
  readonly dumpOracle?: DumpOracleMode;
  readonly allowSkippedOracle?: boolean;
  readonly pgDump?: PgDumpLauncher;
  readonly strictUnmodeled?: boolean;
  readonly noSafeRewrite?: boolean;
  /**
   * May this run emit a `txmode none` companion file (design/06 §3.5 rows 1/6/7)?
   *
   * `true` by default, because the lock-safe form is the product. `migrate check` and
   * `migrate push --dev` set it `false`: neither writes a file, and `push` applies the
   * statements itself, so a two-file plan would only cost them a `CONCURRENTLY` they
   * cannot use and a proof stage they do not need.
   */
  readonly multiFile?: boolean;
  readonly outDir?: string;
  readonly by?: string;
  readonly interactive?: boolean;
  /** test-only: makes the shadow schema/database names predictable */
  readonly token?: string;
}

/** design/06 §3.3's `missing_hints` envelope, one entry per unresolved decision. */
export interface Unresolved {
  readonly type: "rename_or_recreate" | "confirm_data_loss";
  readonly kind: string;
  readonly from?: string;
  readonly to?: string;
  readonly entity?: string;
  readonly confidence?: RenameCandidate["confidence"];
  readonly reason?: string;
  readonly fix: string;
}

export interface GeneratedFile {
  /** `main` → `NNNN_name.sql`, `concurrent` → `NNNN_name_concurrently.sql`, `data` → `…_data.sql`. */
  readonly stage: "main" | "concurrent" | "data";
  /** `NNNN_name`, the file's stem. */
  readonly id: string;
  /**
   * `null` for the `data` stub, which deliberately has no `.plan.json`: there is no diff
   * behind a file a human still has to write, so there is no fingerprint to gate on and
   * nothing for `writePlan`'s proof gate to be about.
   */
  readonly plan: Plan | null;
  readonly sql: string;
  readonly sqlPath?: string;
  readonly planPath?: string;
}

export type GenerateStatus = "generated" | "up_to_date" | "missing_hints" | "hazards" | "proof_failed" | "refused";

export interface GenerateResult {
  readonly status: GenerateStatus;
  readonly files: readonly GeneratedFile[];
  readonly diff: DiffResult;
  readonly currentIR: SchemaIR;
  readonly desiredIR: SchemaIR;
  readonly renameHints: readonly RenameHint[];
  readonly candidates: readonly RenameCandidate[];
  readonly unresolved: readonly Unresolved[];
  readonly repeatables: readonly RepeatableFile[];
  readonly shadow: { readonly tier: 1 | 2 | 3; readonly reason: string };
  readonly proof: Proof | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly writeRefusal?: string;
  readonly durationMs: number;
}

/** Refused for a reason the caller has to print rather than swallow. */
export class GenerateRefusedError extends Error {
  readonly code = "PG_PRIME_GENERATE_REFUSED";
  constructor(message: string) {
    super(message);
    this.name = "GenerateRefusedError";
  }
}

const adminFor = (target: ConnInfo, admin?: ConnInfo): ConnInfo =>
  admin ?? (target.database === "postgres" ? target : { ...target, database: "postgres" });

/** `--allow-data-loss` semantics live in `writePlan`; this only reads the plan back. */
const unacknowledged = (plan: Plan): readonly { code: string; subject: string }[] =>
  plan.hazards
    .filter((h) => h.severity === "error" && !h.acknowledged)
    .map((h) => ({ code: h.code, subject: h.subject }));

export async function generate(input: GenerateInput): Promise<GenerateResult> {
  const started = Date.now();
  const schemas = [...new Set(input.schemas ?? ["public"])].sort();
  const admin = adminFor(input.target, input.admin);

  const shadow = await provisionShadow(admin, input.target, {
    schemas,
    ...(input.shadow === undefined ? {} : { shadow: input.shadow }),
    ...(input.token === undefined ? {} : { token: input.token }),
  });

  try {
    /* ---- IR(desired): emit → shadow → (repeatables) → extract ---- */
    let repeatables: readonly RepeatableFile[] = [];
    const desired = await loadDesired(
      input.schema,
      shadow,
      input.repeatablesDir === undefined
        ? {}
        : {
            afterLoad: async (client): Promise<void> => {
              // Every file, not the changed ones: the shadow was created seconds ago, so
              // "changed" has no meaning against it, and a repeatable that is skipped is a
              // repeatable whose breakage ships (design/06 §3.8).
              repeatables = await loadRepeatables(client, input.repeatablesDir!);
            },
          },
    );

    /* ---- IR(current) ---- */
    const current = await withClient(input.target, (c) => extractCatalog(c, { schemas, observe: true }));

    /* ---- renames: annotation first, then the hints file, then candidates ---- */
    const annotations = annotationHints(input.schema, schemas[0] ?? "public");
    const hints = acceptHints([...annotations, ...(input.hints ?? [])], current.ir, desired.ir);

    const extractorDiagnostics = [...current.diagnostics, ...desired.diagnostics];
    const diff = diffIR(current.ir, desired.ir, {
      renameHints: hints,
      ...(input.strictUnmodeled === undefined ? {} : { strictUnmodeled: input.strictUnmodeled }),
      diagnostics: extractorDiagnostics,
    });

    const candidates = renameCandidates(diff, desired.ir);

    /* ---- the two catalog questions the hazard rules need answered ---- */
    const emptyTables = await withClient(input.target, (c) =>
      probeEmptiness(
        c,
        current.ir.factsOfKind("table").map((f) => f.id),
      ),
    );
    const volatileDefaults = new Set(
      extractorDiagnostics.filter((d) => d.code === "volatile_default").map((d) => d.subject ?? ""),
    );

    const buildOptions: BuildOptions = {
      volatileDefaults,
      emptyTables,
      multiFile: input.multiFile !== false,
      ...(input.noSafeRewrite === undefined ? {} : { noSafeRewrite: input.noSafeRewrite }),
    };
    let built = buildStatements(diff, desired.ir, buildOptions);
    let staged = splitStages(built.statements);
    const declineNotes: Diagnostic[] = [];
    if (staged.declined !== null) {
      // design/06 §3.5's rewrite is a courtesy, never a correctness requirement. When the
      // two-file layout cannot express this plan's order, the literal single-file plan and
      // its LK hazards are the honest fallback — said out loud, not silently.
      declineNotes.push({
        code: "concurrent_rewrite_declined",
        severity: "warning",
        message: `the CONCURRENTLY rewrite was declined for this plan: ${staged.declined}`,
      });
      built = buildStatements(diff, desired.ir, { ...buildOptions, multiFile: false });
      staged = splitStages(built.statements);
    }

    const diagnostics: Diagnostic[] = [
      ...current.diagnostics,
      ...desired.diagnostics,
      ...built.diagnostics,
      ...staged.diagnostics,
      ...declineNotes,
    ];

    const empty = staged.files.every((f) => f.statements.length === 0);
    if (empty) {
      return {
        status: "up_to_date",
        files: [],
        diff,
        currentIR: current.ir,
        desiredIR: desired.ir,
        renameHints: hints,
        candidates,
        unresolved: [],
        repeatables,
        shadow: { tier: shadow.tier, reason: shadow.reason },
        proof: null,
        diagnostics,
        durationMs: Date.now() - started,
      };
    }

    /* ---- design/06 §3.3: a rename question nobody answered stops the run ---- */
    const drafts = draftPlans(input, schemas, staged.files, diff, current, desired, diagnostics, repeatables);
    const unresolved = unresolvedDecisions(candidates, drafts, hints);
    if (unresolved.length > 0 && input.interactive !== true) {
      return {
        status: "missing_hints",
        files: drafts.map((d) => ({
          stage: d.stage,
          id: `${d.plan.migration.id}_${d.plan.migration.name}`,
          plan: d.plan,
          sql: planSql(d.plan),
        })),
        diff,
        currentIR: current.ir,
        desiredIR: desired.ir,
        renameHints: hints,
        candidates,
        unresolved,
        repeatables,
        shadow: { tier: shadow.tier, reason: shadow.reason },
        proof: null,
        diagnostics,
        durationMs: Date.now() - started,
      };
    }

    /* ---- D6 ---- */
    let proof: Proof | null = null;
    if (input.prove === false) {
      if (drafts.length > 1) {
        throw new GenerateRefusedError(
          `--no-prove cannot produce a plan that spans ${String(drafts.length)} files: the fingerprint ` +
            `between ${input.name}.sql and ${input.name}_concurrently.sql is MEASURED on the clone, ` +
            `and without it the second file has no gate to apply behind. Drop --no-prove, or pass ` +
            `--no-safe-rewrite to emit one file.`,
        );
      }
    } else {
      proof = await proveIt(
        input,
        shadow,
        schemas,
        current,
        desired,
        staged.files,
        buildOptions,
        hints,
        extractorDiagnostics,
      );
    }

    const stageFingerprints = proof?.stageFingerprints ?? [];
    const final = drafts.map((d, i) =>
      buildPlan({
        ...d.input,
        fromFingerprint: i === 0 ? current.ir.fingerprint : (stageFingerprints[i - 1] ?? d.input.fromFingerprint),
        toFingerprint: stageFingerprints[i] ?? d.input.toFingerprint,
        ...(proof === null ? {} : { proof }),
      }),
    );

    const files: GeneratedFile[] = final.map((plan, i) => ({
      stage: drafts[i]!.stage,
      id: `${plan.migration.id}_${plan.migration.name}`,
      plan,
      sql: planSql(plan),
    }));
    // design/06 §3.5 row 7 — the backfill stub, one per split column, plan-less on purpose.
    for (const d of diagnostics.filter((x) => x.code === "volatile_default_split")) {
      const col = parseId(d.subject ?? "");
      if (col.kind !== "column") continue;
      // `_data_` keeps the stub after `_concurrently` under §4.1's `(seq, name)` sort, and
      // the slug is folded into MIGRATION_NAME's alphabet — a column called `firstName`
      // would otherwise produce a filename `readMigrationsDir` skips with a warning.
      const name = `${input.name}_data_backfill_${slug(col.table)}_${slug(col.name)}`;
      files.push({
        stage: "data",
        id: `${String(input.seq).padStart(4, "0")}_${name}`,
        plan: null,
        sql: dataMigrationSql({
          seq: input.seq,
          name,
          origin: `${String(input.seq).padStart(4, "0")}_${input.name}`,
          backfill: { schema: col.schema, table: col.table, column: col.name },
        }),
      });
    }

    if (proof !== null && proof.status !== "passed") {
      return report("proof_failed", files);
    }
    const blocked = final.flatMap(unacknowledged);
    if (blocked.length > 0) {
      return report("hazards", files);
    }
    if (input.outDir === undefined) return report("generated", files);

    const written: GeneratedFile[] = [];
    try {
      for (const file of files) {
        if (file.plan === null) {
          const sqlPath = join(input.outDir, `${file.id}.sql`);
          await mkdir(input.outDir, { recursive: true });
          await writeFile(sqlPath, file.sql, { encoding: "utf8", flag: "wx" });
          written.push({ ...file, sqlPath });
          continue;
        }
        const paths = await writePlan(input.outDir, file.plan, {
          allowUnproven: input.prove === false,
          allowDataLoss: input.acknowledge?.allowDataLoss ?? false,
        });
        written.push({ ...file, sqlPath: paths.sqlPath, planPath: paths.planPath });
      }
    } catch (err) {
      if (err instanceof WriteRefusedError) {
        return { ...report("refused", [...written, ...files.slice(written.length)]), writeRefusal: err.message };
      }
      throw err;
    }
    return report("generated", written);

    function report(status: GenerateStatus, out: readonly GeneratedFile[]): GenerateResult {
      return {
        status,
        files: out,
        diff,
        currentIR: current.ir,
        desiredIR: desired.ir,
        renameHints: hints,
        candidates,
        unresolved,
        repeatables,
        shadow: { tier: shadow.tier, reason: shadow.reason },
        proof,
        diagnostics,
        durationMs: Date.now() - started,
      };
    }
  } finally {
    await shadow.dispose().catch(() => undefined);
  }
}

/* -------------------------------------------------------------------------- */
/* the pieces                                                                 */
/* -------------------------------------------------------------------------- */

interface Draft {
  readonly stage: "main" | "concurrent" | "data";
  readonly plan: Plan;
  readonly input: Parameters<typeof buildPlan>[0];
}

function draftPlans(
  input: GenerateInput,
  schemas: readonly string[],
  files: readonly StagedFile[],
  diff: DiffResult,
  current: ExtractResult,
  desired: ExtractResult,
  diagnostics: readonly Diagnostic[],
  repeatables: readonly RepeatableFile[],
): Draft[] {
  const nonEmpty = files.filter((f) => f.statements.length > 0);
  return nonEmpty.map((file, i) => {
    const base: Parameters<typeof buildPlan>[0] = {
      seq: input.seq,
      // design/06 §4.1: duplicate NNNN is legal, ordered by (seq, name). `_concurrently`
      // sorts after the bare name, which is the order the two have to apply in.
      name:
        file.stage === "main" ? input.name : `${input.name}_${file.stage === "concurrent" ? "concurrently" : "data"}`,
      statements: file.statements,
      segments: file.segments,
      // The LIVE fingerprint, not `diff.current`'s. `diffIR` returns the current IR with
      // the accepted renames already folded in — the state the plan pretends the database
      // is in so the diff comes out as a RENAME rather than a drop and an add. The
      // runner's gate compares `from.fingerprint` against the catalog as it actually is,
      // so using the folded one makes every plan that renames anything unappliable.
      fromFingerprint: current.ir.fingerprint,
      toFingerprint: desired.ir.fingerprint,
      pgVersionNum: current.pgVersionNum,
      // The renames belong to the file that performs them, which is always the first.
      renames: i === 0 ? diff.renames : [],
      diagnostics: i === 0 ? diagnostics : [],
      schemas,
      repeatables: repeatables.map((r) => ({ path: r.path, sha256: r.sha256 })),
      ...(input.by === undefined ? {} : { by: input.by }),
      ...(input.acknowledge === undefined ? {} : { acknowledge: input.acknowledge }),
    };
    return { stage: file.stage, plan: buildPlan(base), input: base };
  });
}

async function proveIt(
  input: GenerateInput,
  shadow: Shadow,
  schemas: readonly string[],
  current: ExtractResult,
  desired: ExtractResult,
  files: readonly StagedFile[],
  buildOptions: BuildOptions,
  hints: readonly RenameHint[],
  extractorDiagnostics: readonly Diagnostic[],
): Promise<Proof> {
  const stages: ProveStage[] = files
    .filter((f) => f.statements.length > 0)
    .map((f) => ({
      statements: f.statements.map((s, index) => ({ ...s, index, timeouts: { lock: null, statement: null } })),
      segments: f.segments,
    }));

  // Tier 3 has no `CREATE DATABASE` by definition, so it cannot clone the target; the
  // proof runs in a SECOND temp-schema set instead (see prove/temp-schema.ts). Tiers 1
  // and 2 keep the clone, which is the stronger form because it proves the exact bytes.
  if (shadow.tier === 3) {
    return proveInTempSchemas({
      target: input.target,
      current: current.ir,
      desired: desired.ir,
      schemas,
      renameHints: hints,
      buildOptions,
      diagnostics: extractorDiagnostics,
      expectedStages: stages.map((s) => s.statements.length),
      desiredConn: shadow.conn,
      desiredSchemaMap: shadow.schemaMap,
      ...(input.strictUnmodeled === undefined ? {} : { strictUnmodeled: input.strictUnmodeled }),
      ...(input.dumpOracle === undefined ? {} : { dumpOracle: input.dumpOracle }),
      ...(input.allowSkippedOracle === undefined ? {} : { allowSkippedOracle: input.allowSkippedOracle }),
      ...(input.pgDump === undefined ? {} : { pgDump: input.pgDump }),
    });
  }

  return proveOnShadowClone({
    admin: adminFor(input.target, input.admin),
    source: input.target,
    current: current.ir,
    desired: desired.ir,
    schemas,
    statements: stages[0]?.statements ?? [],
    segments: stages[0]?.segments ?? [],
    stages,
    desiredConn: shadow.conn,
    ...(input.dumpOracle === undefined ? {} : { dumpOracle: input.dumpOracle }),
    ...(input.allowSkippedOracle === undefined ? {} : { allowSkippedOracle: input.allowSkippedOracle }),
    ...(input.pgDump === undefined ? {} : { pgDump: input.pgDump }),
  });
}

/* ---------------------------- rename annotations --------------------------- */

/**
 * `.renamedFrom('old')` and `renamedFrom('old')`, read off the DSL's runtime metadata and
 * turned into `RenameHint`s — design/05 §5.1's "one concept, three spellings, one IR
 * field", and design/11 §1.8's "the kit's existing `RenameHint[]` is the carrier".
 *
 * The *firing rule* is not applied here: this only says what the annotation claims.
 * {@link acceptHints} decides whether it fires, against the current IR, exactly as §5.1
 * specifies — old exists and new does not — so an annotation left in the source after its
 * migration shipped is inert rather than an error.
 */
export function annotationHints(schema: SchemaLike, defaultSchema = "public"): RenameHint[] {
  const out: RenameHint[] = [];

  /* design/05 §5.1's other two spellings, which design/11 K2b left hints-file-only:
   * `pgSchema(name, { renamedFrom })` and `pgEnum(name, values, { renamedFrom })`, plus the
   * same option on `pgDomain` and `pgSequence`. They are reachable now because `loadSchema`
   * discovers the standalone declarations off the module's exports (design/12 K4). */
  for (const s of schema.schemas ?? []) {
    if (s.renamedFrom === undefined) continue;
    out.push({ from: { kind: "schema", schema: s.renamedFrom }, to: { kind: "schema", schema: s.name } });
  }
  // enum and domain share the `type` fact kind — `05` §7.2 gives both `[schema, name]`.
  for (const t of [...(schema.enums ?? []), ...(schema.domains ?? [])]) {
    const renamedFrom = (t as { renamedFrom?: string }).renamedFrom;
    if (renamedFrom === undefined) continue;
    const ns = t.schema ?? defaultSchema;
    out.push({ from: { kind: "type", schema: ns, name: renamedFrom }, to: { kind: "type", schema: ns, name: t.name } });
  }
  for (const s of schema.sequences ?? []) {
    if (s.renamedFrom === undefined) continue;
    const ns = s.schema ?? defaultSchema;
    out.push({
      from: { kind: "sequence", schema: ns, name: s.renamedFrom },
      to: { kind: "sequence", schema: ns, name: s.name },
    });
  }

  for (const table of Object.values(schema.tables)) {
    const runtime = table.$;
    const ns = runtime.schema ?? defaultSchema;
    for (const extra of runtime.extras) {
      if (extra.node !== "renamedFrom") continue;
      out.push({
        from: { kind: "table", schema: ns, name: extra.from },
        to: { kind: "table", schema: ns, name: runtime.name },
      });
    }
    for (const ref of runtime.columns) {
      const old = ref.column.ddl.renamedFrom;
      if (old === undefined) continue;
      out.push({
        from: { kind: "column", schema: ns, table: runtime.name, name: old },
        to: { kind: "column", schema: ns, table: runtime.name, name: ref.dbName },
      });
    }
  }
  return out;
}

/**
 * design/05 §5.1 — a `renamedFrom` fires **iff** the old object exists in the current IR
 * and the new one does not. Anything else is inert, which is what makes an annotation safe
 * to leave in the source for ever and what makes a chain `a → b → c` work across two
 * migrations.
 *
 * A column rename is also checked against the table it names *after* any table rename in
 * the same batch, because `renamedFrom` on a column of a renamed table describes the state
 * before both.
 */
export function acceptHints(hints: readonly RenameHint[], current: SchemaIR, desired: SchemaIR): RenameHint[] {
  const asId = (v: StableId | string): StableId => (typeof v === "string" ? parseId(v) : v);
  const renamedTables = new Map<string, string>();
  const accepted: RenameHint[] = [];

  // Tables first: a column hint on a renamed table has to be read in the OLD table's name.
  for (const pass of [0, 1]) {
    for (const hint of hints) {
      const from = asId(hint.from);
      const to = asId(hint.to);
      if (from.kind !== to.kind) continue;
      if ((pass === 0) !== (from.kind === "table")) continue;
      const resolvedFrom =
        from.kind === "column" && renamedTables.has(`${from.schema}.${from.table}`)
          ? { ...from, table: renamedTables.get(`${from.schema}.${from.table}`)! }
          : from;
      if (!current.has(resolvedFrom)) continue;
      if (current.has(to)) continue;
      if (!desired.has(to)) continue;
      accepted.push({ from: resolvedFrom, to });
      if (from.kind === "table" && to.kind === "table") renamedTables.set(`${to.schema}.${to.name}`, from.name);
    }
  }
  return accepted;
}

/**
 * The questions design/06 §3.3 refuses to answer on its own.
 *
 * Two kinds, exactly as the §3.3 envelope lists them: a drop/create pair that looks like a
 * rename, and an error-severity destructive hazard nobody signed off. Both exit 2, because
 * both need a human decision recorded in the repository rather than taken at 3am by a CLI.
 */
function unresolvedDecisions(
  candidates: readonly RenameCandidate[],
  drafts: readonly Draft[],
  hints: readonly RenameHint[],
): Unresolved[] {
  const answered = new Set(hints.map((h) => (typeof h.to === "string" ? h.to : encodeId(h.to))));
  const out: Unresolved[] = candidates
    .filter((c) => !answered.has(c.to))
    .map((c) => ({
      type: "rename_or_recreate" as const,
      kind: c.kind,
      from: c.from,
      to: c.to,
      confidence: c.confidence,
      reason: c.reason,
      fix:
        c.kind === "column"
          ? `add .renamedFrom(${JSON.stringify(nameOf(c.from))}) to ${nameOf(c.to)} in your schema, ` +
            `or pass --hints-file with { "from": "${c.from}", "to": "${c.to}" }`
          : `add renamedFrom(${JSON.stringify(nameOf(c.from))}) to the ${c.kind} ${nameOf(c.to)}, ` +
            `or pass --hints-file with { "from": "${c.from}", "to": "${c.to}" }`,
    }));

  const seen = new Set<string>();
  for (const draft of drafts) {
    for (const h of draft.plan.hazards) {
      if (h.severity !== "error" || h.acknowledged) continue;
      if (!h.code.startsWith("DS")) continue;
      const key = `${h.code}:${h.subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        type: "confirm_data_loss",
        kind: h.code,
        entity: h.subject,
        reason: h.message,
        fix: "re-run with --allow-data-loss, or record the acknowledgement in a --hints-file",
      });
    }
  }
  return out;
}

const nameOf = (encoded: string): string => {
  const id = parseId(encoded);
  return "name" in id ? id.name : encoded;
};

/* -------------------------------------------------------------------------- */
/* --empty and --data: the two files with no plan behind them                  */
/* -------------------------------------------------------------------------- */

/**
 * `migrate generate --empty` (design/06 §6.2) — a hand-written migration's skeleton.
 *
 * No `.plan.json`: there is no diff behind it, so there is no fingerprint to gate on, and
 * `readMigrationsDir` already treats a plan-less file as hand-written and says so with a
 * diagnostic. Inventing a plan whose `from` was the live fingerprint would make the file
 * un-appliable the moment anything else landed first.
 */
export function emptyMigrationSql(seq: number, name: string): string {
  const id = `${String(seq).padStart(4, "0")}_${name}`;
  return [
    `-- pg-prime:migration ${id}`,
    "-- pg-prime:txmode    transactional",
    "-- pg-prime:timeout   lock=3s statement=30s",
    "",
    "-- Hand-written migration. There is no .plan.json beside it, so `apply` runs it with",
    "-- no fingerprint gate and no checksum gate — it is yours.",
    "--",
    "-- Number every statement: the marker IS the resume position (design/06 §4.2), and",
    "-- without markers the runner falls back to its SQL splitter and says so.",
    "",
    "-- pg-prime:stmt 0 lock=accessExclusive non-idempotent",
    "SELECT 1;",
    "",
  ].join("\n");
}

export interface DataStubInput {
  readonly seq: number;
  readonly name: string;
  /** the migration whose split produced this stub, named in the TODO */
  readonly origin?: string;
  /** the column the volatile-default split (design/06 §3.5 row 7) left un-backfilled */
  readonly backfill?: { readonly schema: string; readonly table: string; readonly column: string };
  /**
   * The keyset column the template orders and resumes by, and the cast that turns the
   * watermark text back into it. `generate` cannot know either — the volatile-default
   * split names a column, not a key — so they default to `id` / `bigint` and step 1 of
   * the template's own checklist is "check them".
   */
  readonly key?: string;
  readonly keyCast?: string;
  /** rows per batch written into the directive; design/06 §7's example is 1000 */
  readonly size?: number;
}

/** Fold any identifier into `MIGRATION_NAME`'s alphabet, so the runner can see the file. */
export const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "") || "x";

/**
 * `migrate generate --data`, and the §3.5 row-7 backfill stub — design/06 §7 lane 2.
 *
 * The file is a **working batched backfill with a guard in front of it**, not a sketch in
 * a comment. Two statements:
 *
 *  - `stmt 0` is a `DO … RAISE EXCEPTION`, marked `non-idempotent` so `migrate lint`
 *    reports TX201 on it and `migrate apply` stops on it. A stub that applied silently
 *    would be recorded `applied` in `pgprime.migrations` while the rows it exists to fix
 *    stayed unfixed, and the next `generate` would see a converged schema and never
 *    mention it again. This is the only spelling of "TODO" a deploy pipeline can hear.
 *  - `stmt 1` is the real batch: a **keyset** `WITH batch AS (SELECT … WHERE key >
 *    watermark ORDER BY key LIMIT size)` that reads the runner's two GUCs and reports
 *    `rows_done` / `watermark` back. Deleting the guard and renumbering this to `0` is the
 *    whole edit, and forgetting the renumber is a `stmt_marker_out_of_order` error rather
 *    than a silent misordering.
 *
 * **Why keyset rather than design/06 §7's `WHERE id IN (SELECT … LIMIT n)`.** That form
 * has no watermark: every iteration re-scans from the start of the table looking for rows
 * the predicate still matches, so N rows in batches of n cost O(N²/n) row reads and each
 * batch is slower than the last — and after a crash it restarts that scan from zero,
 * because there is nothing to resume from. The keyset form reads each row once, resumes at
 * the recorded key, and gives `pgprime.data_progress.watermark` something true to hold.
 * The runner supports both — a statement with no `rows_done` column falls back to its
 * command tag, which is exactly §7's shape — and the template picks the better one.
 */
export function dataMigrationSql(input: DataStubInput): string {
  const id = `${String(input.seq).padStart(4, "0")}_${input.name}`;
  const b = input.backfill;
  const qualified = b ? `${b.schema}.${b.table}` : "your_schema.your_table";
  const column = b?.column ?? "your_column";
  const key = input.key ?? "id";
  const cast = input.keyCast ?? "bigint";
  const size = input.size ?? BATCH_DEFAULTS.size;
  const mark = `nullif(current_setting('${GUC_WATERMARK}', true), '')`;
  return [
    `-- pg-prime:migration ${id}`,
    "-- pg-prime:data",
    "-- pg-prime:txmode    none",
    `-- pg-prime:batch     size=${String(size)} pause=${String(BATCH_DEFAULTS.pauseMs)}ms max-replica-lag=10s`,
    "",
    b ? `-- TODO: backfill ${qualified}.${column}.` : "-- TODO: write the data migration.",
    b
      ? [
          `-- ${input.origin ?? "The migration beside this one"}.sql added ${column} NULLABLE and set`,
          "-- its DEFAULT, so new rows already carry a value and the table was not rewritten under",
          "-- ACCESS EXCLUSIVE (design/06 §3.5 row 7). The rows that were already there are NULL.",
        ].join("\n")
      : "-- design/06 §7 lane 2: one statement, re-executed by the runner until it reports 0 rows.",
    "--",
    "-- The `-- pg-prime:batch` directive above is interpreted by the RUNNER, not by a",
    "-- template (design/06 §7). It re-executes every statement in this file, each in its",
    "-- OWN transaction, until that statement reports zero rows; it pauses `pause` between",
    "-- iterations; it waits while replica lag exceeds `max-replica-lag`; and it commits",
    `-- { rows_done, watermark } to ${HISTORY_SCHEMA}.data_progress in the SAME transaction as the`,
    "-- batch, so a killed backfill resumes from its watermark instead of restarting.",
    "--",
    "-- The contract between this file and the runner is two settings and two columns:",
    "--",
    `--   current_setting('${GUC_BATCH_SIZE}')        the directive's \`size\`, as text`,
    `--   current_setting('${GUC_WATERMARK}', true)    the last watermark THIS statement`,
    "--                                              reported; '' on the first iteration",
    "--   … AS rows_done, … AS watermark             what the statement reports back",
    "--",
    "-- TO SHIP THIS FILE:",
    `--   1. check that \`${key}\` is this table's ordering key and that \`::${cast}\` is its type;`,
    "--   2. check the predicate — it must match exactly the rows that still need the write;",
    "--   3. delete statement 0 (the guard) and renumber statement 1 to 0.",
    "",
    "-- pg-prime:stmt 0 lock=none non-idempotent",
    `DO $pgprime$ BEGIN RAISE EXCEPTION 'pg-prime: ${id}.sql is a generated data-migration STUB and was applied unedited'; END $pgprime$;`,
    "",
    "-- pg-prime:stmt 1 lock=rowExclusive idempotent",
    "WITH batch AS (",
    `  SELECT ${key}`,
    `    FROM ${qualified}`,
    `   WHERE ${column} IS NULL`,
    `     AND (${mark} IS NULL OR ${key} > ${mark}::${cast})`,
    `   ORDER BY ${key}`,
    `   LIMIT current_setting('${GUC_BATCH_SIZE}')::int`,
    "), updated AS (",
    `  UPDATE ${qualified} AS t`,
    `     SET ${column} = DEFAULT`,
    "    FROM batch AS b",
    `   WHERE t.${key} = b.${key}`,
    `  RETURNING t.${key} AS ${key}`,
    ")",
    `SELECT count(*)::bigint AS rows_done, max(${key})::text AS watermark FROM updated;`,
    "",
  ].join("\n");
}

/** Read a `--hints-file`: a JSON array of `{ from, to }`, encoded ids or `StableId`s. */
export async function readHintsFile(path: string): Promise<RenameHint[]> {
  const text = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new GenerateRefusedError(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { hints?: unknown })?.hints;
  if (!Array.isArray(list)) {
    throw new GenerateRefusedError(`${path} must be a JSON array of { "from": …, "to": … } (or { "hints": [...] })`);
  }
  return list.map((raw, i) => {
    const h = raw as { from?: unknown; to?: unknown };
    if (h === null || typeof h !== "object" || h.from === undefined || h.to === undefined) {
      throw new GenerateRefusedError(`${path}[${String(i)}] needs both "from" and "to"`);
    }
    return { from: h.from as RenameHint["from"], to: h.to as RenameHint["to"] };
  });
}

/* -------------------------------------------------------------------------- */
/* the original three-connection entry point                                   */
/* -------------------------------------------------------------------------- */

export interface DatabaseGenerateInput {
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
  /** pg_dump equality oracle; default `"warn"` (record differences, never block) */
  readonly dumpOracle?: DumpOracleMode;
  /** under `strict`, accept a `skipped` oracle instead of blocking the plan */
  readonly allowSkippedOracle?: boolean;
  readonly pgDump?: PgDumpLauncher;
  /** design/06 §3.6 — sign-off for destructive changes, recorded in the plan */
  readonly acknowledge?: AcknowledgeInput;
}

export interface DatabaseGenerateResult {
  readonly plan: Plan;
  readonly diff: DiffResult;
  readonly currentIR: SchemaIR;
  readonly desiredIR: SchemaIR;
  readonly diagnostics: readonly Diagnostic[];
  readonly written?: { readonly sqlPath: string; readonly planPath: string };
  readonly writeRefusal?: string;
}

/**
 * design/06 §3's pipeline with the desired state supplied as a **database** rather than as
 * a schema module.
 *
 * This is what `generate` was before the DSL leg existed, kept because the fixture corpus
 * and the runner's chain builder are the round-1 evidence that the differ works and
 * neither should be rewritten to accommodate a new entry point. It is single-file by
 * construction (`multiFile` off): a caller that hands over two databases has no `outDir`
 * convention for a companion file, and every one of its tests pins the single-file shape.
 */
export async function generateFromDatabases(input: DatabaseGenerateInput): Promise<DatabaseGenerateResult> {
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
    // The LIVE fingerprint. `diff.current` is the current IR with accepted renames folded
    // in, which is what the differ needed and not what the runner's gate will find.
    fromFingerprint: current.ir.fingerprint,
    toFingerprint: desired.ir.fingerprint,
    pgVersionNum: current.pgVersionNum,
    renames: diff.renames,
    diagnostics: [...current.diagnostics, ...diagnostics],
    schemas,
    ...(input.acknowledge ? { acknowledge: input.acknowledge } : {}),
  };

  const draft = buildPlan(base);

  let plan = draft;
  if (input.prove !== false) {
    const proof = await proveOnShadowClone({
      admin: input.admin,
      source: input.target,
      current: current.ir,
      desired: desired.ir,
      schemas,
      statements: draft.statements,
      segments: draft.segments,
      desiredConn: input.desired,
      ...(input.dumpOracle ? { dumpOracle: input.dumpOracle } : {}),
      ...(input.allowSkippedOracle === undefined ? {} : { allowSkippedOracle: input.allowSkippedOracle }),
      ...(input.pgDump ? { pgDump: input.pgDump } : {}),
    });
    plan = buildPlan({ ...base, proof });
  }

  const result: DatabaseGenerateResult = {
    plan,
    diff,
    currentIR: current.ir,
    desiredIR: desired.ir,
    // The extractor's own findings (orphaned facts, unmodeled kinds, partitioning)
    // are diagnostics about THIS run and belong in the report, not only in the plan.
    diagnostics: [...current.diagnostics, ...desired.diagnostics, ...diagnostics],
  };
  if (!input.outDir) return result;
  try {
    const written = await writePlan(input.outDir, plan, {
      allowUnproven: input.allowUnproven ?? false,
      allowDataLoss: input.acknowledge?.allowDataLoss ?? false,
    });
    return { ...result, written };
  } catch (err) {
    // Only a REFUSAL is a refusal. EACCES/ENOSPC used to be reported as one, so a
    // read-only output directory looked exactly like an unproven plan.
    if (err instanceof WriteRefusedError) return { ...result, writeRefusal: err.message };
    throw err;
  }
}
