/**
 * Checkpoints — design/06 §4.5, design/12 decision 16.
 *
 * "A checkpoint is a normal migration file tagged `-- pg-prime:checkpoint` containing the
 * full schema DDL at that point, plus `checkpoints/NNNN.ir.json`. A **fresh** database
 * applies the newest checkpoint and then everything after it; an **existing** database
 * ignores checkpoints entirely and continues linearly. Nothing is deleted."
 *
 * Three things the design leaves open, decided here.
 *
 * **1. "Ignores" is recorded, not silent.** A checkpoint an existing database skips is
 * written to `pgprime.migrations` with `status = 'superseded'` — the value design/06 §4.4
 * already reserves — and so is every file a fresh database jumped over. Leaving them
 * "pending" would make `migrate status` exit 5 for ever on a repository that is fully
 * applied, and make `migrate check` (the CI gate) fail on every commit after a checkpoint
 * lands. Leaving them *absent* would make the reconciler's "applied file missing from
 * disk" check unable to tell a jumped file from a deleted one. `superseded` says exactly
 * what happened: this file was never executed here, and it never will be.
 *
 * **2. The IR file is `SchemaIR.toCheckpoint()`, read back with {@link irFromCheckpoint}.**
 * §2.3 already defines that serialization and it deliberately drops provenance, which is
 * right: a checkpoint is a statement about *shape*, and provenance is about where a fact
 * came from on the day it was extracted.
 *
 * **3. The DDL comes from `baseline`'s emitter path**, `diffIR(freshDatabaseIR, current)`,
 * because a checkpoint and a baseline are the same artifact asked for at two different
 * times. One code path, so a checkpoint cannot replay differently from the baseline of the
 * same schema.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractCatalog, type CatalogClient, type Diagnostic } from "../catalog/extract.js";
import { buildStatements } from "../diff/ddl.js";
import { diffIR } from "../diff/diff.js";
import { orderStatements } from "../diff/order.js";
import { SchemaIR, type DependencyEdge, type Fact, type Provenance } from "../ir/fact.js";
import type { Payload } from "../ir/hash.js";
import { encodeId, idName, parseId } from "../ir/stable-id.js";
import { buildPlan, renderSql, type Plan } from "../plan/plan.js";
import { MIGRATION_FILE } from "../runner/files.js";

/** Where `checkpoints/NNNN.ir.json` lives, relative to the migrations directory (§4.1). */
export const CHECKPOINT_DIR = "checkpoints";

/** The name every checkpoint migration carries, so the file is recognisable on disk. */
export const CHECKPOINT_NAME = "checkpoint";

/**
 * Provenance for a fact read back out of a checkpoint file.
 *
 * `baseline`, not a new origin: provenance never enters a hash (D3), the checkpoint format
 * deliberately does not carry it, and "this came from a full-schema snapshot we wrote" is
 * exactly what `baseline` already means.
 */
const CHECKPOINT_PROVENANCE: Provenance = { origin: "baseline", ownership: "managed" };

export interface CheckpointFile {
  readonly id: string;
  readonly seq: number;
  readonly name: string;
  /** `checkpoints/NNNN.ir.json`, absolute */
  readonly irPath: string;
  readonly hasIr: boolean;
}

interface CheckpointJson {
  readonly formatVersion?: number;
  readonly pgMajor?: number;
  readonly fingerprint?: string;
  readonly facts?: { id: string; parent?: string; payload: Payload; ordinal?: number }[];
  readonly edges?: { from: string; to: string; kind: DependencyEdge["kind"] }[];
}

export class CheckpointFormatError extends Error {
  readonly code = "PG_PRIME_CHECKPOINT_FORMAT";
  constructor(message: string) {
    super(message);
    this.name = "CheckpointFormatError";
  }
}

/** `SchemaIR.toCheckpoint()`, inverted. */
export function irFromCheckpoint(json: unknown): SchemaIR {
  const c = json as CheckpointJson | null;
  if (c === null || typeof c !== "object" || c.formatVersion !== 1 || !Array.isArray(c.facts)) {
    throw new CheckpointFormatError("not a formatVersion 1 checkpoint (expected { formatVersion: 1, facts: [...] })");
  }
  const facts: Fact[] = c.facts.map((f) => ({
    id: parseId(f.id),
    ...(f.parent === undefined ? {} : { parent: parseId(f.parent) }),
    payload: f.payload,
    ...(f.ordinal === undefined ? {} : { ordinal: f.ordinal }),
    provenance: CHECKPOINT_PROVENANCE,
  }));
  const edges: DependencyEdge[] = (c.edges ?? []).map((e) => ({
    from: parseId(e.from),
    to: parseId(e.to),
    kind: e.kind,
  }));
  return SchemaIR.build(facts, edges);
}

/** Every `NNNN_checkpoint.sql` in the directory, oldest first. Reads no IR. */
export async function listCheckpoints(migrationsDir: string): Promise<CheckpointFile[]> {
  let names: string[];
  try {
    names = await readdir(migrationsDir);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  const irFiles = new Set(await readdir(join(migrationsDir, CHECKPOINT_DIR)).catch(() => [] as string[]));
  const out: CheckpointFile[] = [];
  for (const entry of names) {
    const m = MIGRATION_FILE.exec(entry);
    if (!m || m[2] !== CHECKPOINT_NAME) continue;
    const seqText = m[1]!;
    out.push({
      id: `${seqText}_${CHECKPOINT_NAME}`,
      seq: Number(seqText),
      name: CHECKPOINT_NAME,
      irPath: join(migrationsDir, CHECKPOINT_DIR, `${seqText}.ir.json`),
      hasIr: irFiles.has(`${seqText}.ir.json`),
    });
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/** The newest checkpoint at or before `seq`, or the newest of all when `seq` is undefined. */
export function newestCheckpoint(list: readonly CheckpointFile[], seq?: number): CheckpointFile | undefined {
  const eligible = seq === undefined ? list : list.filter((c) => c.seq <= seq);
  return eligible.length === 0 ? undefined : eligible[eligible.length - 1];
}

export async function readCheckpointIr(file: CheckpointFile): Promise<SchemaIR> {
  const text = await readFile(file.irPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CheckpointFormatError(
      `${file.irPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return irFromCheckpoint(parsed);
}

/* ------------------------------- writing --------------------------------- */

/** `FirstNormalObjectId` — every OID below it came from `initdb`, not from a user. */
const FIRST_NORMAL_OID = 16384;

/**
 * The IR of a database PostgreSQL has just created, restricted to the managed schemas.
 *
 * The same function `baseline` needs and for the same reason (design/11 §1.9 AS BUILT):
 * the *null* IR is not what a fresh database looks like — a fresh one already has
 * `public` — so a full-schema file whose `from.fingerprint` was the null hash could never
 * pass its own gate on replay.
 */
export async function freshDatabaseIR(
  client: CatalogClient,
  current: SchemaIR,
  schemas: readonly string[],
): Promise<SchemaIR> {
  const r = await client.query(
    `SELECT nspname FROM pg_namespace WHERE nspname = ANY($1) AND oid < ${String(FIRST_NORMAL_OID)}`,
    [[...schemas]],
  );
  const builtIn = new Set(r.rows.map((row) => String(row["nspname"])));
  const ext = await client.query(`SELECT extname FROM pg_extension WHERE oid < ${String(FIRST_NORMAL_OID)}`);
  const builtInExtensions = new Set(ext.rows.map((row) => String(row["extname"])));
  const schemaFacts = current.factsOfKind("schema").filter((f) => builtIn.has(idName(f.id)));
  const schemaIds = new Set(schemaFacts.map((f) => encodeId(f.id)));
  const commentFacts = current
    .factsOfKind("comment")
    .filter((f) => f.id.kind === "comment" && schemaIds.has(f.id.target));
  const extensionFacts = current.factsOfKind("extension").filter((f) => builtInExtensions.has(idName(f.id)));
  const facts = [...schemaFacts, ...commentFacts, ...extensionFacts];
  const kept = new Set(facts.map((f) => encodeId(f.id)));
  const edges = current.edges().filter((e) => kept.has(encodeId(e.from)) && kept.has(encodeId(e.to)));
  return SchemaIR.build(facts, edges);
}

export interface BuiltCheckpoint {
  readonly plan: Plan;
  readonly ir: SchemaIR;
  readonly sql: string;
  readonly pgMajor: number;
  readonly diagnostics: readonly Diagnostic[];
}

export interface BuildCheckpointInput {
  readonly client: CatalogClient;
  readonly schemas: readonly string[];
  readonly seq: number;
  readonly by?: string;
}

/** Extract, emit the full DDL through `baseline`'s create path, and stamp the plan. */
export async function buildCheckpoint(input: BuildCheckpointInput): Promise<BuiltCheckpoint> {
  const extracted = await extractCatalog(input.client, { schemas: input.schemas });
  const empty = await freshDatabaseIR(input.client, extracted.ir, input.schemas);
  const diff = diffIR(empty, extracted.ir);
  const built = buildStatements(diff, extracted.ir);
  const ordered = orderStatements(built.statements);
  const diagnostics = [...extracted.diagnostics, ...built.diagnostics, ...ordered.diagnostics];

  const plan = buildPlan({
    seq: input.seq,
    name: CHECKPOINT_NAME,
    statements: ordered.statements,
    segments: ordered.segments,
    fromFingerprint: empty.fingerprint,
    toFingerprint: extracted.ir.fingerprint,
    pgVersionNum: extracted.pgVersionNum,
    renames: [],
    diagnostics,
    schemas: input.schemas,
    checkpoint: true,
    ...(input.by === undefined ? {} : { by: input.by }),
    // Nothing to prove on a clone: this DDL describes a database that already exists and
    // this command never executes it. `verify --from-checkpoint` is what proves it replays.
    proof: { status: "skipped", reason: "checkpoint", at: new Date().toISOString() },
  });

  return {
    plan,
    ir: extracted.ir,
    sql: checkpointSql(plan),
    pgMajor: Math.floor(extracted.pgVersionNum / 10000),
    diagnostics,
  };
}

/** The `.sql`, with `-- pg-prime:checkpoint` in the header (design/06 §4.5). */
export function checkpointSql(plan: Plan): string {
  return renderSql({
    id: `${plan.migration.id}_${plan.migration.name}`,
    name: plan.migration.name,
    statements: plan.statements,
    segments: plan.segments,
    txmode: plan.txmode,
    from: plan.from.fingerprint,
    to: plan.to.fingerprint,
    pgMin: plan.pg.minVersion,
    checkpoint: true,
  });
}

export interface WrittenCheckpoint {
  readonly sqlPath: string;
  readonly planPath: string;
  readonly irPath: string;
}

/**
 * `NNNN_checkpoint.sql` + `NNNN_checkpoint.plan.json` + `checkpoints/NNNN.ir.json`.
 *
 * `wx` on all three: a checkpoint is history like any other migration, and silently
 * overwriting one rewrites a file another developer's fresh database may already have
 * jumped to.
 */
export async function writeCheckpoint(migrationsDir: string, built: BuiltCheckpoint): Promise<WrittenCheckpoint> {
  const id = `${built.plan.migration.id}_${CHECKPOINT_NAME}`;
  const sqlPath = join(migrationsDir, `${id}.sql`);
  const planPath = join(migrationsDir, `${id}.plan.json`);
  const irPath = join(migrationsDir, CHECKPOINT_DIR, `${built.plan.migration.id}.ir.json`);
  await mkdir(join(migrationsDir, CHECKPOINT_DIR), { recursive: true });
  await writeFile(sqlPath, built.sql, { encoding: "utf8", flag: "wx" });
  await writeFile(planPath, `${JSON.stringify(built.plan, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(irPath, `${JSON.stringify(built.ir.toCheckpoint(built.pgMajor), null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return { sqlPath, planPath, irPath };
}

/* -------------------------------- drift ----------------------------------- */

export interface DriftReport {
  /** the checkpoint the live schema was compared against, or null when there is none */
  readonly checkpoint: string | null;
  /** encoded StableIds, prefixed with the delta's verb */
  readonly deltas: readonly string[];
  /**
   * `true` when the checkpoint IS the recorded position, so every delta is real drift.
   * `false` when migrations were applied after it: those changes are in the list too, and
   * the message says so rather than presenting a superset as if it were exact.
   */
  readonly exact: boolean;
  /** the migrations applied after the checkpoint, whose changes are also in `deltas` */
  readonly since: readonly string[];
}

export interface DescribeDriftInput {
  readonly client: CatalogClient;
  readonly migrationsDir: string;
  readonly schemas: readonly string[];
  /** ids of the applied migrations, in `(seq, name)` order */
  readonly appliedIds: readonly string[];
}

/**
 * Name the drifted objects — design/11 K1's open item (a), closed by decision 16.
 *
 * K1 could not do this: "naming them needs an IR of the expected state, and §4.3
 * deliberately rejects a per-migration snapshot". A checkpoint IS that IR, for the position
 * it was taken at, so the answer is a diff of the live catalog against the newest
 * checkpoint at or before where history says we are.
 */
export async function describeDrift(input: DescribeDriftInput): Promise<DriftReport> {
  const applied = [...input.appliedIds];
  const lastSeq = applied.length === 0 ? undefined : Number(applied[applied.length - 1]!.slice(0, 4));
  const list = (await listCheckpoints(input.migrationsDir)).filter((c) => c.hasIr);
  const checkpoint = newestCheckpoint(list, lastSeq);
  if (checkpoint === undefined) return { checkpoint: null, deltas: [], exact: false, since: [] };

  const recorded = await readCheckpointIr(checkpoint);
  const live = await extractCatalog(input.client, { schemas: input.schemas, observe: false });
  const diff = diffIR(recorded, live.ir);
  const since = applied.filter((id) => Number(id.slice(0, 4)) > checkpoint.seq);
  return {
    checkpoint: checkpoint.id,
    deltas: diff.deltas.map((d) => `${d.op} ${encodeId(d.op === "rename" ? d.to : d.id)}`),
    exact: since.length === 0,
    since,
  };
}

/** One sentence for a refusal message, or `null` when there is nothing to add. */
export function driftSentence(report: DriftReport): string | null {
  if (report.checkpoint === null || report.deltas.length === 0) return null;
  const head =
    `Compared with checkpoint ${report.checkpoint}, the live schema differs in ${String(report.deltas.length)} object(s): ` +
    `${report.deltas.slice(0, 12).join(", ")}${report.deltas.length > 12 ? ", …" : ""}.`;
  return report.exact
    ? head
    : `${head} ${report.since.length} migration(s) were applied after that checkpoint (${report.since.join(", ")}), so ` +
        `their changes are in this list too — take a new checkpoint to narrow it.`;
}
