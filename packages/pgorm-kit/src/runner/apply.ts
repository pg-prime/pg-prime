import { createHash } from "node:crypto";
import type { CatalogClient } from "../catalog/extract.js";
import type { Segment } from "../diff/order.js";
import type { PlanStatement } from "../plan/plan.js";

export interface ApplyError {
  readonly statementIndex: number;
  readonly sql: string;
  readonly message: string;
}

export interface ApplyReport {
  readonly status: "applied" | "failed";
  readonly appliedStatements: number;
  readonly error?: ApplyError;
}

export interface ApplyOptions {
  readonly lockTimeout?: string;
  readonly statementTimeout?: string;
}

/**
 * Per-segment transactions (design/06 §5.3). Never one transaction for the
 * whole run: that would hold every ACCESS EXCLUSIVE lock taken anywhere until
 * the final COMMIT — and it makes a commitBoundaryAfter segment meaningless.
 */
/**
 * `SET LOCAL <guc> = '<value>'` cannot take a bind parameter, so every caller-supplied
 * timeout used to be string-interpolated into DDL. `set_config` is the same GUC write
 * with a real parameter, and it takes the local/session flag as data too.
 */
async function setConfig(
  client: CatalogClient,
  name: string,
  value: string,
  local: boolean,
): Promise<void> {
  await client.query("SELECT set_config($1, $2, $3)", [name, value, local]);
}

/** Session GUCs a bare (non-transactional) segment set for itself. */
async function resetSessionGucs(client: CatalogClient): Promise<void> {
  await client.query("RESET lock_timeout");
  await client.query("RESET statement_timeout");
  await client.query("RESET search_path");
}

export async function applySegments(
  client: CatalogClient,
  statements: readonly PlanStatement[],
  segments: readonly Segment[],
  options: ApplyOptions = {},
): Promise<ApplyReport> {
  let applied = 0;
  let executing = -1;
  const lockTimeout = options.lockTimeout ?? "3s";
  for (const seg of segments) {
    if (seg.transactional) await client.query("BEGIN");
    try {
      // A bare segment has no transaction for `SET LOCAL` to scope to, so its GUCs
      // are session-scoped and reset at the end — a `txmode none` file used to run
      // with NO lock_timeout at all, which is exactly where a CIC blocks forever.
      await setConfig(client, "lock_timeout", lockTimeout, seg.transactional);
      // design/06 §5.3: every identifier the emitter writes is schema-qualified and
      // extraction ran under the same search_path. Pinning it means a rogue schema
      // earlier on the path cannot capture an unqualified reference in a stored
      // definition we replay verbatim.
      await setConfig(client, "search_path", "pg_catalog", seg.transactional);
      for (const i of seg.statements) {
        const s = statements[i]!;
        executing = i;
        const timeout = s.timeouts.statement ?? options.statementTimeout ?? "0";
        await setConfig(client, "statement_timeout", timeout, seg.transactional);
        await client.query(s.sql);
        applied += 1;
      }
      if (seg.transactional) await client.query("COMMIT");
      else await resetSessionGucs(client);
    } catch (err) {
      if (seg.transactional) await client.query("ROLLBACK").catch(() => undefined);
      else await resetSessionGucs(client).catch(() => undefined);
      return {
        status: "failed",
        appliedStatements: applied,
        error: {
          statementIndex: executing,
          sql: statements[executing]?.sql ?? "",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
  return { status: "applied", appliedStatements: applied };
}

/* --------------------------- D7: the lock --------------------------- */

/** Derived, never fixed: two unrelated schema sets in one database must not serialize. */
export function advisoryLockKey(database: string, schemas: readonly string[]): bigint {
  const digest = createHash("sha256").update(`${database}:${[...schemas].sort().join(",")}`).digest();
  return BigInt.asIntN(64, digest.readBigUInt64BE(0));
}

/**
 * Two `pg_backend_pid()` reads in two transactions. Different pids ⟹ a
 * transaction-mode pooler, under which session advisory locks are silently
 * broken. No other ORM checks this; it costs two round trips.
 */
export async function detectTransactionPooler(client: CatalogClient): Promise<boolean> {
  const read = async (): Promise<string> => {
    await client.query("BEGIN");
    const r = await client.query("SELECT pg_backend_pid() AS pid");
    await client.query("COMMIT");
    return String(r.rows[0]?.["pid"]);
  };
  return (await read()) !== (await read());
}

export async function acquireSessionLock(
  client: CatalogClient,
  database: string,
  schemas: readonly string[],
): Promise<boolean> {
  const r = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [advisoryLockKey(database, schemas).toString()]);
  return r.rows[0]?.["ok"] === true;
}

export async function releaseSessionLock(
  client: CatalogClient,
  database: string,
  schemas: readonly string[],
): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1)", [advisoryLockKey(database, schemas).toString()]);
}
