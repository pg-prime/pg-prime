/**
 * Running repeatables: one transaction, all of it or none of it (design/06 §3.8, §5.1 step 8).
 *
 * The single transaction is not a convenience. Repeatables reference each other — a view over
 * a function over a type — so a run that stops halfway leaves a database no file on disk
 * describes. Worse, the caller writes `pgprime.repeatables` from what this function RETURNS
 * (`06` §4.4), so a partial return would record a hash for a file whose objects were rolled
 * back, and the next deploy would consider it unchanged and never re-apply it. The tool would
 * have talked itself into skipping the very file that is missing.
 *
 * This module writes to no history table. Recording is the runner's job, in the runner's
 * transaction, which is what lets the runner decide the ordering of its own bookkeeping.
 */

import type { RepeatableFile, ScanOptions } from "./scan.js";
import { scanRepeatables } from "./scan.js";

/**
 * The single method this pass needs from a connection. Deliberately narrower than
 * `CatalogClient`: nothing here binds parameters, and the narrower shape means the runner can
 * hand over whatever it holds — including a wrapper that logs or dry-runs.
 */
export interface RepeatableClient {
  query(text: string): Promise<unknown>;
}

/** Exactly one `pgprime.repeatables` row, for the caller to write. */
export interface AppliedRepeatable {
  readonly path: string;
  readonly sha256: string;
  readonly durationMs: number;
}

/** The message is read in a terminal; the untruncated statement stays on `.sql`. */
const abbreviate = (sql: string): string => (sql.length <= 160 ? sql : `${sql.slice(0, 159)}…`);

export class RepeatableApplyError extends Error {
  readonly code = "PG_PRIME_REPEATABLE_FAILED";
  constructor(
    readonly path: string,
    readonly statementIndex: number,
    readonly sql: string,
    cause: unknown,
  ) {
    super(`repeatable ${path} failed at statement ${statementIndex}: ${abbreviate(sql)}`, { cause });
    this.name = "RepeatableApplyError";
  }
}

/**
 * Best-effort, and silent on purpose.
 *
 * A ROLLBACK that fails — the usual reason being that the connection died, which is also why
 * the statement failed — must not replace the error that explains what went wrong. That swap
 * is how a syntax error gets reported to the user as "connection terminated unexpectedly".
 */
async function rollbackQuietly(client: RepeatableClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // deliberately swallowed; the caller is about to throw the real error
  }
}

export async function applyRepeatables(
  client: RepeatableClient,
  toApply: readonly RepeatableFile[],
): Promise<AppliedRepeatable[]> {
  const applied: AppliedRepeatable[] = [];
  // No files is not an empty transaction: an idle BEGIN/COMMIT pair on the migration
  // connection shows up in `pg_stat_activity` and in every log, for nothing.
  if (toApply.length === 0) return applied;

  await client.query("BEGIN");
  for (const file of toApply) {
    const started = performance.now();
    for (let i = 0; i < file.statements.length; i++) {
      const sql = file.statements[i]!;
      try {
        await client.query(sql);
      } catch (err) {
        await rollbackQuietly(client);
        throw new RepeatableApplyError(file.path, i, sql, err);
      }
    }
    applied.push({
      path: file.path,
      sha256: file.sha256,
      durationMs: Math.round(performance.now() - started),
    });
  }
  // A COMMIT failure (a deferred constraint firing, most often) belongs to no single
  // statement, so it is rethrown as itself rather than dressed up as a RepeatableApplyError
  // that would name an innocent one. PostgreSQL has already ended the transaction here, so
  // there is nothing left to roll back.
  await client.query("COMMIT");
  return applied;
}

/**
 * Load every repeatable into the shadow during `generate` (design/06 §3.8).
 *
 * Every file, not just the changed ones: the shadow was created empty seconds ago, so
 * "changed" has no meaning against it, and the whole point of the shadow load is that a view
 * referencing a to-be-dropped column fails the proof at author time. A repeatable that was
 * skipped as unchanged is a repeatable whose breakage ships.
 */
export async function loadRepeatables(
  client: RepeatableClient,
  dir: string,
  options?: ScanOptions,
): Promise<RepeatableFile[]> {
  const files = await scanRepeatables(dir, options);
  await applyRepeatables(client, files);
  return files;
}
