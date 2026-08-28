/**
 * The `-- pg-prime:batch` runner — design/06 §7 lane 2, the "one place we add real
 * machinery rather than a template".
 *
 * ```
 *   for each statement of the file:
 *     loop:
 *       wait while replica lag > max-replica-lag        (design/12 decision 13)
 *       BEGIN
 *         SET LOCAL pgprime.batch_size = <size>
 *         SET LOCAL pgprime.watermark  = <the last one this statement reported>
 *         <the statement>
 *         INSERT INTO pgprime.data_progress … ON CONFLICT DO UPDATE
 *       COMMIT
 *       stop when the statement reported 0 rows
 *       sleep <pause>
 * ```
 *
 * Four decisions are taken here rather than transcribed, each because design/06 §7 states
 * the behaviour and not the mechanism.
 *
 * **1. The batch state reaches the statement as two GUCs, not as bind parameters.** The
 * `.sql` is the executable artifact and "runnable by `psql` if our tooling ever fails"
 * (§4.2), and a file full of `$1`s is not. `current_setting('pgprime.batch_size')` and
 * `current_setting('pgprime.watermark', true)` are ordinary SQL, they are set with
 * `set_config($1,$2,true)` so nothing is interpolated into DDL, and under `psql` they
 * simply default — `current_setting(…, true)` returns NULL for an unset name, which the
 * template's `nullif(…, '')` guard reads as "start at the beginning".
 *
 * **2. The statement reports its own progress, in its own result.** A batch statement may
 * end with `SELECT count(*) AS rows_done, max(id)::text AS watermark FROM updated` — the
 * runner reads those two columns. When it does not (a plain `UPDATE … LIMIT`-shaped
 * statement), the **command tag's row count** is used, exactly as §7 says, and the
 * watermark stays null. The runner never parses the SQL to guess a key column: the key is
 * a property of the author's table, and a tool that guessed it would guess wrong on the
 * first composite one.
 *
 * **3. `pgprime.data_progress` is written INSIDE the batch's transaction.** §7 says
 * "persist … after each batch"; doing it in the same transaction is strictly stronger and,
 * unlike §5.4's DDL, actually possible here — a data migration's work is ordinary DML. A
 * SIGKILL therefore cannot lose a committed batch's watermark, and cannot record one whose
 * rows rolled back. That is what makes R15's "resumes from its watermark, never restarts"
 * an invariant rather than a likelihood.
 *
 * **4. A statement that reports rows without advancing its watermark is a failure**, after
 * three consecutive iterations. An unbounded loop is the one way a batch runner can wedge
 * a deploy with no error to act on, and a watermark that does not move while rows keep
 * coming back is the signature of a predicate that does not narrow. Statements that report
 * no watermark at all are not gated this way — their termination comes from the predicate
 * (`WHERE country IS NULL`) — but `max-iterations=<n>` on the directive bounds those too.
 */

import type { CatalogClient } from "../catalog/extract.js";
import { HISTORY_SCHEMA } from "../history/schema.js";
import { dataProgressSql, type DataProgress } from "../history/store.js";
import { readPrimaryLag, readReplicaLag, type LagReading } from "./lag.js";
import type { ConnInfo } from "../db/pg.js";
import type { BatchDirective } from "../runner/files.js";

/** The two GUCs a batch statement may read. Custom (two-part) names, so no extension owns them. */
export const GUC_BATCH_SIZE = "pgprime.batch_size";
export const GUC_WATERMARK = "pgprime.watermark";

/** How many iterations may report rows without moving the watermark before this is a bug. */
export const STALL_LIMIT = 3;

/** A result with the row count `pg` puts on it. `CatalogClient` only promises `rows`. */
interface CountedResult {
  readonly rows: Record<string, unknown>[];
  readonly rowCount?: number | null;
}

export interface BatchEvent {
  readonly kind: "batch";
  readonly migration: string;
  readonly statement: number;
  readonly iteration: number;
  readonly rows: number;
  readonly rowsDone: number;
  readonly watermark: string | null;
}

export interface LagEvent {
  readonly kind: "lag";
  readonly migration: string;
  readonly statement: number;
  readonly state: "waiting" | "resumed" | "absent";
  readonly lagMs: number | null;
  readonly ceilingMs: number;
  readonly reading: LagReading;
}

export interface BatchOptions {
  readonly migrationId: string;
  readonly directive: BatchDirective;
  /** design/12 decision 13's opt-in: query these instead of `pg_stat_replication`. */
  readonly replicas?: readonly ConnInfo[];
  /** progress read back from `pgprime.data_progress` at the start of the run */
  readonly resumeFrom?: DataProgress | null;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onEvent?: (event: BatchEvent | LagEvent) => void;
  /** emitted once per run when `max-replica-lag` is set and no replica is visible */
  readonly onInfo?: (message: string) => void;
  readonly lockTimeout?: string;
  readonly statementTimeout?: string;
}

export interface BatchOutcome {
  readonly rowsDone: number;
  readonly iterations: number;
  readonly watermark: string | null;
}

export class BatchStalledError extends Error {
  readonly code = "PG_PRIME_BATCH_STALLED";
  constructor(message: string) {
    super(message);
    this.name = "BatchStalledError";
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms).unref?.());

/** `rows_done` / `watermark` off the statement's own result, else the command tag. */
function readProgressColumns(result: CountedResult): { rows: number; watermark: string | null } {
  const row = result.rows.length === 1 ? result.rows[0] : undefined;
  if (row !== undefined && Object.prototype.hasOwnProperty.call(row, "rows_done")) {
    const raw = row["rows_done"];
    const rows = Number(raw ?? 0);
    const mark = Object.prototype.hasOwnProperty.call(row, "watermark") ? row["watermark"] : undefined;
    return {
      rows: Number.isFinite(rows) ? rows : 0,
      watermark: mark === null || mark === undefined ? null : String(mark),
    };
  }
  // The command tag. `null` — every DDL statement, and `SELECT` on some drivers — means
  // "this statement has no row count", which terminates the loop after one execution.
  return { rows: typeof result.rowCount === "number" ? result.rowCount : 0, watermark: null };
}

/**
 * Block until replica lag is under the ceiling (design/06 §7: "pause automatically while
 * lag exceeds the threshold").
 *
 * Deliberately **unbounded**. A ceiling that gave up after N minutes and ran the batch
 * anyway would be a ceiling that does not hold, and one that failed the migration would
 * turn a temporary replica hiccup into a failed deploy that has to be resumed by hand —
 * while the resume is already free (the watermark is committed). An operator who wants it
 * to stop kills the process; the next `apply` continues from where it stopped.
 */
async function waitForLag(
  client: CatalogClient,
  statement: number,
  options: BatchOptions,
  seenNoReplica: { value: boolean },
): Promise<void> {
  const ceiling = options.directive.maxReplicaLagMs;
  if (ceiling === null) return;
  const sleep = options.sleep ?? defaultSleep;
  const emit = options.onEvent ?? ((): void => undefined);
  const poll = Math.max(options.directive.pauseMs, 100);
  let waited = false;
  for (;;) {
    const reading =
      options.replicas === undefined || options.replicas.length === 0
        ? await readPrimaryLag(client)
        : await readReplicaLag(options.replicas);
    if (reading.lagMs === null) {
      // design/12 decision 13: no visible replica is a NO-OP plus one `info` line. Said
      // once per run, not once per batch — a 50 000-row backfill would otherwise print it
      // fifty times and the operator would stop reading.
      if (!seenNoReplica.value) {
        seenNoReplica.value = true;
        emit({
          kind: "lag",
          migration: options.migrationId,
          statement,
          state: "absent",
          lagMs: null,
          ceilingMs: ceiling,
          reading,
        });
        options.onInfo?.(
          `max-replica-lag=${String(ceiling)}ms is set and pg_stat_replication reports no replica: the check ` +
            `is a no-op for this run. A non-superuser sees only its own rows there — grant pg_monitor, or ` +
            `list the standbys as \`replicas: ['postgres://…']\` in pg-prime.config.ts to query ` +
            `pg_last_wal_replay_lsn() on each instead.`,
        );
      }
      return;
    }
    if (reading.lagMs <= ceiling) {
      if (waited) {
        emit({
          kind: "lag",
          migration: options.migrationId,
          statement,
          state: "resumed",
          lagMs: reading.lagMs,
          ceilingMs: ceiling,
          reading,
        });
      }
      return;
    }
    waited = true;
    emit({
      kind: "lag",
      migration: options.migrationId,
      statement,
      state: "waiting",
      lagMs: reading.lagMs,
      ceilingMs: ceiling,
      reading,
    });
    await sleep(poll);
  }
}

/**
 * Run ONE statement of a batch file to completion.
 *
 * `state` is threaded in and out so the caller can persist the whole file's progress under
 * one `data_progress` row (the table is keyed by migration id — design/06 §4.4).
 */
export async function runBatchStatement(
  client: CatalogClient,
  sql: string,
  statement: number,
  state: Omit<DataProgress, "updatedAt" | "migrationId">,
  options: BatchOptions,
): Promise<BatchOutcome> {
  const { directive } = options;
  const sleep = options.sleep ?? defaultSleep;
  const emit = options.onEvent ?? ((): void => undefined);
  const seenNoReplica = { value: false };

  let watermark = state.values[String(statement)] ?? null;
  let rowsDone = state.rowsDone;
  let iterations = state.iterations;
  let localIterations = 0;
  let stalls = 0;

  for (;;) {
    await waitForLag(client, statement, options, seenNoReplica);

    const previous = watermark;
    let progress: { rows: number; watermark: string | null };
    await client.query("BEGIN");
    try {
      if (options.lockTimeout !== undefined) {
        await client.query("SELECT set_config($1, $2, true)", ["lock_timeout", options.lockTimeout]);
      }
      await client.query("SELECT set_config($1, $2, true)", ["statement_timeout", options.statementTimeout ?? "0"]);
      await client.query("SELECT set_config($1, $2, true)", [GUC_BATCH_SIZE, String(directive.size)]);
      // `''` and not NULL: `set_config` takes text, and the template's own
      // `nullif(current_setting('pgprime.watermark', true), '')` is what turns the empty
      // string back into "no watermark yet" in the author's own key type.
      await client.query("SELECT set_config($1, $2, true)", [GUC_WATERMARK, watermark ?? ""]);
      const result = (await client.query(sql)) as CountedResult;
      progress = readProgressColumns(result);
      const nextWatermark = progress.watermark ?? watermark;
      await client.query(
        dataProgressSql({
          migrationId: options.migrationId,
          rowsDone: rowsDone + progress.rows,
          statement,
          iterations: iterations + 1,
          values: { ...state.values, [String(statement)]: nextWatermark },
          done: progress.rows === 0,
        }),
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }

    // Committed. Only now is any of this true.
    localIterations += 1;
    iterations += 1;
    rowsDone += progress.rows;
    if (progress.watermark !== null) watermark = progress.watermark;
    state = {
      rowsDone,
      statement,
      iterations,
      values: { ...state.values, [String(statement)]: watermark },
      done: progress.rows === 0,
    };
    emit({
      kind: "batch",
      migration: options.migrationId,
      statement,
      iteration: localIterations,
      rows: progress.rows,
      rowsDone,
      watermark,
    });

    if (progress.rows === 0) return { rowsDone, iterations, watermark };

    if (progress.watermark !== null) {
      stalls = previous !== null && previous === progress.watermark ? stalls + 1 : 0;
      if (stalls >= STALL_LIMIT) {
        throw new BatchStalledError(
          `${options.migrationId} statement ${String(statement)} reported ${String(progress.rows)} row(s) in each of ` +
            `${String(STALL_LIMIT + 1)} consecutive batches without moving its watermark (still ${JSON.stringify(progress.watermark)}). ` +
            `The predicate is not narrowing: either the batch does not update the rows it selects, or the ` +
            `watermark column is not the key it orders by. ${String(rowsDone)} row(s) are already committed and ` +
            `${HISTORY_SCHEMA}.data_progress records the position, so a fixed file resumes rather than restarts.`,
        );
      }
    }
    if (directive.maxIterations > 0 && localIterations >= directive.maxIterations) {
      throw new BatchStalledError(
        `${options.migrationId} statement ${String(statement)} hit max-iterations=${String(directive.maxIterations)} ` +
          `after ${String(rowsDone)} row(s). Raise the ceiling on the -- pg-prime:batch directive, or check the ` +
          `predicate; the watermark is committed, so the next apply resumes.`,
      );
    }
    await sleep(directive.pauseMs);
  }
}
