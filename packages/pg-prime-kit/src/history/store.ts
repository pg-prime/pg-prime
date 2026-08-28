/**
 * Reads and writes over the design/06 §4.4 tables.
 *
 * Everything here is parameterised except `recordAppliedSql`, and that one exception is
 * load-bearing: design/06 §5.3 puts the history INSERT *inside the migration's own
 * transaction*, and the transaction is driven by `runner/apply.ts`'s `applySegments`,
 * which executes plain statement text. So the row is rendered as a literal statement and
 * handed to the same executor as the DDL. Its values go through `quoteLiteral`.
 */

import type { CatalogClient } from "../catalog/extract.js";
import { quoteLiteral } from "../sql/ident.js";
import { HISTORY_SCHEMA, type MigrationStatus } from "./schema.js";

export interface MigrationRow {
  readonly id: string;
  readonly seq: number;
  readonly name: string;
  readonly checksum: string;
  readonly planId: string | null;
  readonly fingerprintFrom: string | null;
  readonly fingerprintTo: string | null;
  readonly txmode: string;
  readonly statementsTotal: number;
  readonly statementsApplied: number;
  readonly statementUncertain: number | null;
  readonly segmentApplied: number;
  readonly status: MigrationStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly appliedBy: string;
  readonly appliedFrom: string | null;
  readonly error: unknown;
  readonly engineVersion: string;
}

export interface LockRow {
  readonly runId: string;
  readonly holder: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  /** server-side age of `heartbeat_at`, so a skewed client clock cannot invent a stale lease */
  readonly heartbeatAgeMs: number;
}

export interface RepeatableRow {
  readonly path: string;
  readonly checksum: string;
  readonly appliedAt: string;
  readonly durationMs: number | null;
}

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/**
 * `to_char` rather than the driver's Date: a `timestamptz` decoded into a JS Date and
 * re-serialised loses the server's own rendering, and every consumer here only ever
 * prints it. ISO-8601 with an explicit offset, formatted by PostgreSQL.
 */
const TS = (col: string): string => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')`;

const MIGRATION_COLUMNS = `
  id, seq, name, checksum, plan_id, fingerprint_from, fingerprint_to, txmode,
  statements_total, statements_applied, statement_uncertain, segment_applied, status,
  ${TS("started_at")} AS started_at, ${TS("finished_at")} AS finished_at,
  duration_ms, applied_by, applied_from, error, engine_version`;

function toRow(r: Record<string, unknown>): MigrationRow {
  return {
    id: str(r["id"]),
    seq: num(r["seq"]),
    name: str(r["name"]),
    checksum: str(r["checksum"]),
    planId: strOrNull(r["plan_id"]),
    fingerprintFrom: strOrNull(r["fingerprint_from"]),
    fingerprintTo: strOrNull(r["fingerprint_to"]),
    txmode: str(r["txmode"]),
    statementsTotal: num(r["statements_total"]),
    statementsApplied: num(r["statements_applied"]),
    statementUncertain: numOrNull(r["statement_uncertain"]),
    segmentApplied: num(r["segment_applied"]),
    status: str(r["status"]) as MigrationStatus,
    startedAt: str(r["started_at"]),
    finishedAt: strOrNull(r["finished_at"]),
    durationMs: numOrNull(r["duration_ms"]),
    appliedBy: str(r["applied_by"]),
    appliedFrom: strOrNull(r["applied_from"]),
    error: r["error"] ?? null,
    engineVersion: str(r["engine_version"]),
  };
}

/** Ordered the way the runner orders files: `(seq, name)` (design/06 §4.1). */
export async function readMigrationRows(client: CatalogClient): Promise<MigrationRow[]> {
  const r = await client.query(
    `SELECT ${MIGRATION_COLUMNS} FROM ${HISTORY_SCHEMA}.migrations ORDER BY seq, name`,
  );
  return r.rows.map(toRow);
}

/**
 * design/06 §4.4 — "`fingerprint_to` on the last applied row is the current schema
 * fingerprint of record". Last by `(seq, name)`, not by `finished_at`: history order is
 * the file order, and a resumed run finishes out of wall-clock order.
 */
export function currentFingerprint(rows: readonly MigrationRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.status === "applied" || row.status === "baselined") return row.fingerprintTo;
  }
  return null;
}

export interface NewMigrationRow {
  readonly id: string;
  readonly seq: number;
  readonly name: string;
  readonly checksum: string;
  readonly planId: string | null;
  readonly fingerprintFrom: string | null;
  readonly fingerprintTo: string | null;
  readonly txmode: string;
  readonly statementsTotal: number;
  readonly statementsApplied: number;
  readonly segmentApplied: number;
  readonly status: MigrationStatus;
  readonly appliedFrom: string | null;
  readonly engineVersion: string;
}

const lit = (v: string | null): string => (v === null ? "NULL" : quoteLiteral(v));

/**
 * The row as one literal `INSERT … ON CONFLICT DO UPDATE`, for the transactional path.
 *
 * `ON CONFLICT` and not a plain INSERT because a previous *failed* attempt leaves a
 * `failed` row behind (see `markFailed`) and a retry must be able to overwrite it.
 * `transaction_timestamp()` is the start of the migration's own transaction and
 * `clock_timestamp()` is now, so `duration_ms` is two readings of the SERVER's clock —
 * a client clock never enters the history table.
 */
export function recordAppliedSql(row: NewMigrationRow): string {
  return `INSERT INTO ${HISTORY_SCHEMA}.migrations (
    id, seq, name, checksum, plan_id, fingerprint_from, fingerprint_to, txmode,
    statements_total, statements_applied, statement_uncertain, segment_applied,
    status, started_at, finished_at, duration_ms, applied_from, error, engine_version
  ) VALUES (
    ${lit(row.id)}, ${row.seq}, ${lit(row.name)}, ${lit(row.checksum)}, ${lit(row.planId)},
    ${lit(row.fingerprintFrom)}, ${lit(row.fingerprintTo)}, ${lit(row.txmode)},
    ${row.statementsTotal}, ${row.statementsApplied}, NULL, ${row.segmentApplied},
    ${lit(row.status)}, transaction_timestamp(), clock_timestamp(),
    (EXTRACT(EPOCH FROM (clock_timestamp() - transaction_timestamp())) * 1000)::int,
    ${lit(row.appliedFrom)}, NULL, ${lit(row.engineVersion)}
  )
  ON CONFLICT (id) DO UPDATE SET
    checksum = EXCLUDED.checksum, plan_id = EXCLUDED.plan_id,
    fingerprint_from = EXCLUDED.fingerprint_from, fingerprint_to = EXCLUDED.fingerprint_to,
    txmode = EXCLUDED.txmode, statements_total = EXCLUDED.statements_total,
    statements_applied = EXCLUDED.statements_applied, statement_uncertain = NULL,
    segment_applied = EXCLUDED.segment_applied, status = EXCLUDED.status,
    started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at,
    duration_ms = EXCLUDED.duration_ms, applied_by = current_user,
    applied_from = EXCLUDED.applied_from, error = NULL,
    engine_version = EXCLUDED.engine_version`;
}

/** The `running` row a non-transactional file needs before it can record any progress. */
export async function beginRow(client: CatalogClient, row: NewMigrationRow): Promise<void> {
  await client.query(
    `INSERT INTO ${HISTORY_SCHEMA}.migrations (
       id, seq, name, checksum, plan_id, fingerprint_from, fingerprint_to, txmode,
       statements_total, statements_applied, statement_uncertain, segment_applied,
       status, started_at, applied_from, error, engine_version
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,'running',now(),$12,NULL,$13)
     ON CONFLICT (id) DO UPDATE SET
       checksum = EXCLUDED.checksum, plan_id = EXCLUDED.plan_id,
       fingerprint_from = EXCLUDED.fingerprint_from, fingerprint_to = EXCLUDED.fingerprint_to,
       txmode = EXCLUDED.txmode, statements_total = EXCLUDED.statements_total,
       status = 'running', started_at = now(), finished_at = NULL, duration_ms = NULL,
       applied_by = current_user, applied_from = EXCLUDED.applied_from, error = NULL,
       engine_version = EXCLUDED.engine_version`,
    [
      row.id, row.seq, row.name, row.checksum, row.planId, row.fingerprintFrom, row.fingerprintTo,
      row.txmode, row.statementsTotal, row.statementsApplied, row.segmentApplied,
      row.appliedFrom, row.engineVersion,
    ],
  );
}

/** design/06 §5.4 — "BEGIN; UPDATE … SET statement_uncertain = i; COMMIT;". */
export async function markUncertain(client: CatalogClient, id: string, index: number): Promise<void> {
  await client.query("BEGIN");
  await client.query(
    `UPDATE ${HISTORY_SCHEMA}.migrations SET statement_uncertain = $2 WHERE id = $1`,
    [id, index],
  );
  await client.query("COMMIT");
}

/** design/06 §5.4 — "SET statements_applied = i + 1, statement_uncertain = NULL". */
export async function markStatementApplied(
  client: CatalogClient,
  id: string,
  index: number,
  segment: number,
): Promise<void> {
  await client.query("BEGIN");
  await client.query(
    `UPDATE ${HISTORY_SCHEMA}.migrations
        SET statements_applied = GREATEST(statements_applied, $2),
            segment_applied = GREATEST(segment_applied, $3),
            statement_uncertain = NULL
      WHERE id = $1`,
    [id, index + 1, segment],
  );
  await client.query("COMMIT");
}

export async function markApplied(client: CatalogClient, id: string, applied: number): Promise<void> {
  await client.query(
    `UPDATE ${HISTORY_SCHEMA}.migrations
        SET status = 'applied', statements_applied = $2, statement_uncertain = NULL,
            finished_at = now(),
            duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int,
            error = NULL
      WHERE id = $1`,
    [id, applied],
  );
}

export interface RecordedError {
  readonly code: string;
  readonly message: string;
  readonly sqlState?: string;
  readonly statementIndex?: number;
  readonly sql?: string;
  readonly attempts?: number;
}

/**
 * Every failure records `error` jsonb on the row.
 *
 * Written in its OWN statement outside any migration transaction — a transactional
 * migration that fails has already rolled its history INSERT back, so this is what makes
 * the failure visible at all.
 */
export async function markFailed(
  client: CatalogClient,
  row: NewMigrationRow,
  error: RecordedError,
  applied: number,
): Promise<void> {
  await client.query(
    `INSERT INTO ${HISTORY_SCHEMA}.migrations (
       id, seq, name, checksum, plan_id, fingerprint_from, fingerprint_to, txmode,
       statements_total, statements_applied, segment_applied, status, finished_at,
       duration_ms, applied_from, error, engine_version
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'failed',now(),NULL,$12,$13::jsonb,$14)
     ON CONFLICT (id) DO UPDATE SET
       status = 'failed', statements_applied = EXCLUDED.statements_applied,
       segment_applied = EXCLUDED.segment_applied, finished_at = now(),
       duration_ms = (EXTRACT(EPOCH FROM (now() - ${HISTORY_SCHEMA}.migrations.started_at)) * 1000)::int,
       error = EXCLUDED.error`,
    [
      row.id, row.seq, row.name, row.checksum, row.planId, row.fingerprintFrom, row.fingerprintTo,
      row.txmode, row.statementsTotal, applied, row.segmentApplied,
      row.appliedFrom, JSON.stringify(error), row.engineVersion,
    ],
  );
}

/* ------------------------------- the lease ------------------------------- */

const LOCK_COLUMNS = `run_id::text AS run_id, holder,
  ${TS("acquired_at")} AS acquired_at, ${TS("heartbeat_at")} AS heartbeat_at,
  (EXTRACT(EPOCH FROM (now() - heartbeat_at)) * 1000)::bigint AS age_ms`;

export async function readLease(client: CatalogClient): Promise<LockRow | null> {
  const r = await client.query(`SELECT ${LOCK_COLUMNS} FROM ${HISTORY_SCHEMA}.lock`);
  const row = r.rows[0];
  if (!row) return null;
  return {
    runId: str(row["run_id"]),
    holder: str(row["holder"]),
    acquiredAt: str(row["acquired_at"]),
    heartbeatAt: str(row["heartbeat_at"]),
    heartbeatAgeMs: num(row["age_ms"]),
  };
}

/** Overwrites unconditionally: the caller already holds the session advisory lock. */
export async function takeLease(client: CatalogClient, runId: string, holder: string): Promise<void> {
  await client.query(
    `INSERT INTO ${HISTORY_SCHEMA}.lock (singleton, run_id, holder, acquired_at, heartbeat_at)
     VALUES (true, $1::uuid, $2, now(), now())
     ON CONFLICT (singleton) DO UPDATE
       SET run_id = EXCLUDED.run_id, holder = EXCLUDED.holder,
           acquired_at = now(), heartbeat_at = now()`,
    [runId, holder],
  );
}

export async function heartbeatLease(client: CatalogClient, runId: string): Promise<void> {
  await client.query(
    `UPDATE ${HISTORY_SCHEMA}.lock SET heartbeat_at = now() WHERE run_id = $1::uuid`,
    [runId],
  );
}

/** Only ever deletes OUR row, unless `force`. */
export async function releaseLease(client: CatalogClient, runId: string): Promise<void> {
  await client.query(`DELETE FROM ${HISTORY_SCHEMA}.lock WHERE run_id = $1::uuid`, [runId]);
}

export async function breakLease(client: CatalogClient): Promise<boolean> {
  const r = await client.query(`DELETE FROM ${HISTORY_SCHEMA}.lock RETURNING run_id`);
  return r.rows.length > 0;
}

/* --------------------- checkpoints (design/06 §4.4, §4.5) ----------------- */

/**
 * A file this database will never execute — design/06 §4.5's "an existing database ignores
 * checkpoints entirely", and the files a fresh database jumped over.
 *
 * Recorded rather than left pending, and recorded with `statements_applied = 0`, because
 * that is the truth: nothing ran. `status = 'superseded'` is §4.4's own value, reserved
 * for exactly this by design/11 K1.
 */
export async function recordSuperseded(
  client: CatalogClient,
  file: {
    readonly id: string;
    readonly seq: number;
    readonly name: string;
    readonly checksum: string;
    readonly txmode: string;
    readonly statements: readonly unknown[];
    readonly plan: { readonly planId: string; readonly to: { readonly fingerprint: string } } | null;
  },
  engineVersion: string,
  appliedFrom: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO ${HISTORY_SCHEMA}.migrations (
       id, seq, name, checksum, plan_id, fingerprint_from, fingerprint_to, txmode,
       statements_total, statements_applied, statement_uncertain, segment_applied,
       status, started_at, finished_at, duration_ms, applied_from, error, engine_version
     ) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,0,NULL,0,'superseded',now(),now(),0,$9,NULL,$10)
     ON CONFLICT (id) DO NOTHING`,
    [
      file.id, file.seq, file.name, file.checksum,
      file.plan?.planId ?? null, file.plan?.to.fingerprint ?? null,
      file.txmode, file.statements.length, appliedFrom, engineVersion,
    ],
  );
}

/** design/06 §4.4's `pgprime.checkpoints`, written when a fresh database jumps to one. */
export async function recordCheckpoint(client: CatalogClient, id: string, fingerprint: string): Promise<void> {
  await client.query(
    `INSERT INTO ${HISTORY_SCHEMA}.checkpoints (id, fingerprint, created_at)
     VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, created_at = now()`,
    [id, fingerprint],
  );
}

export interface CheckpointRow {
  readonly id: string;
  readonly fingerprint: string;
  readonly createdAt: string;
}

export async function readCheckpointRows(client: CatalogClient): Promise<CheckpointRow[]> {
  const r = await client.query(
    `SELECT id, fingerprint, ${TS("created_at")} AS created_at FROM ${HISTORY_SCHEMA}.checkpoints ORDER BY id`,
  );
  return r.rows.map((row) => ({
    id: str(row["id"]),
    fingerprint: str(row["fingerprint"]),
    createdAt: str(row["created_at"]),
  }));
}

/* -------------------- data migrations (design/06 §4.4, §7) ---------------- */

/**
 * `pgprime.data_progress.watermark`, as this release writes it.
 *
 * The column is `jsonb NOT NULL` and design/06 §7 only says it holds "`{ rows_done,
 * watermark }`" — `rows_done` is its own column, so this is the `watermark` half, and it
 * has to answer two questions a resume asks: *which statement of the file was in flight*
 * and *how far did each statement get*. Both, because a lane-2 file may hold more than
 * one batched statement and the row is keyed by migration id alone.
 *
 * `values` is keyed by statement index and holds the text the statement itself reported
 * (`SELECT … AS watermark`), never a value the runner invented: the runner cannot know
 * whether the key is a `bigint`, a `uuid` or a `(tenant, created_at)` pair, so it carries
 * the token opaquely and hands it back through the `pgprime.watermark` GUC.
 */
export interface DataProgress {
  readonly migrationId: string;
  /** cumulative across every statement and every iteration of this migration */
  readonly rowsDone: number;
  /** the statement index that was in flight when this row was written */
  readonly statement: number;
  /** total iterations executed for this migration, across statements */
  readonly iterations: number;
  /** statement index (as a decimal string) → the last watermark that statement reported */
  readonly values: Readonly<Record<string, string | null>>;
  /** every statement of the file has reported zero rows */
  readonly done: boolean;
  readonly updatedAt: string;
}

export const EMPTY_WATERMARK: Omit<DataProgress, "migrationId" | "updatedAt"> = {
  rowsDone: 0,
  statement: 0,
  iterations: 0,
  values: {},
  done: false,
};

interface WatermarkJson {
  readonly formatVersion?: number;
  readonly statement?: number;
  readonly iterations?: number;
  readonly values?: Record<string, string | null>;
  readonly done?: boolean;
}

function toProgress(r: Record<string, unknown>): DataProgress {
  const raw = r["watermark"];
  const json: WatermarkJson =
    typeof raw === "string" ? (JSON.parse(raw) as WatermarkJson) : ((raw ?? {}) as WatermarkJson);
  return {
    migrationId: str(r["migration_id"]),
    rowsDone: num(r["rows_done"]),
    statement: typeof json.statement === "number" ? json.statement : 0,
    iterations: typeof json.iterations === "number" ? json.iterations : 0,
    values: json.values ?? {},
    done: json.done === true,
    updatedAt: str(r["updated_at"]),
  };
}

const DATA_COLUMNS = `migration_id, watermark, rows_done, ${TS("updated_at")} AS updated_at`;

export async function readDataProgress(client: CatalogClient, migrationId: string): Promise<DataProgress | null> {
  const r = await client.query(
    `SELECT ${DATA_COLUMNS} FROM ${HISTORY_SCHEMA}.data_progress WHERE migration_id = $1`,
    [migrationId],
  );
  const row = r.rows[0];
  return row === undefined ? null : toProgress(row);
}

export async function readAllDataProgress(client: CatalogClient): Promise<DataProgress[]> {
  const r = await client.query(`SELECT ${DATA_COLUMNS} FROM ${HISTORY_SCHEMA}.data_progress ORDER BY migration_id`);
  return r.rows.map(toProgress);
}

/**
 * The progress upsert as one literal statement, for the batch runner.
 *
 * Literal rather than parameterised for the same reason `recordAppliedSql` is: it rides
 * **inside the batch's own transaction**, right behind the `UPDATE` it is bookkeeping for,
 * so a crash between the two is not possible and a batch can be neither lost nor
 * double-counted. design/06 §7 says the row is "persisted after each batch"; putting it in
 * the same transaction is strictly stronger and — unlike the DDL of §5.4 — actually
 * available here, because a data migration's work is ordinary DML.
 */
export function dataProgressSql(p: Omit<DataProgress, "updatedAt">): string {
  const watermark = JSON.stringify({
    formatVersion: 1,
    statement: p.statement,
    iterations: p.iterations,
    values: p.values,
    done: p.done,
  });
  return `INSERT INTO ${HISTORY_SCHEMA}.data_progress (migration_id, watermark, rows_done, updated_at)
     VALUES (${quoteLiteral(p.migrationId)}, ${quoteLiteral(watermark)}::jsonb, ${String(p.rowsDone)}, now())
     ON CONFLICT (migration_id) DO UPDATE
       SET watermark = EXCLUDED.watermark, rows_done = EXCLUDED.rows_done, updated_at = now()`;
}

/* ----------------------------- repeatables ------------------------------- */

export async function readRepeatableRows(client: CatalogClient): Promise<RepeatableRow[]> {
  const r = await client.query(
    `SELECT path, checksum, ${TS("applied_at")} AS applied_at, duration_ms
       FROM ${HISTORY_SCHEMA}.repeatables ORDER BY path`,
  );
  return r.rows.map((row) => ({
    path: str(row["path"]),
    checksum: str(row["checksum"]),
    appliedAt: str(row["applied_at"]),
    durationMs: numOrNull(row["duration_ms"]),
  }));
}

export async function upsertRepeatable(
  client: CatalogClient,
  path: string,
  checksum: string,
  durationMs: number,
): Promise<void> {
  await client.query(
    `INSERT INTO ${HISTORY_SCHEMA}.repeatables (path, checksum, applied_at, duration_ms)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (path) DO UPDATE
       SET checksum = EXCLUDED.checksum, applied_at = now(), duration_ms = EXCLUDED.duration_ms`,
    [path, checksum, durationMs],
  );
}
