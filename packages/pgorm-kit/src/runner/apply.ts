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
export async function applySegments(
  client: CatalogClient,
  statements: readonly PlanStatement[],
  segments: readonly Segment[],
  options: ApplyOptions = {},
): Promise<ApplyReport> {
  let applied = 0;
  let executing = -1;
  for (const seg of segments) {
    if (seg.transactional) await client.query("BEGIN");
    try {
      if (seg.transactional) {
        await client.query(`SET LOCAL lock_timeout = '${options.lockTimeout ?? "3s"}'`);
      }
      for (const i of seg.statements) {
        const s = statements[i]!;
        executing = i;
        const timeout = s.timeouts.statement ?? options.statementTimeout ?? "0";
        if (seg.transactional) await client.query(`SET LOCAL statement_timeout = '${timeout}'`);
        await client.query(s.sql);
        applied += 1;
      }
      if (seg.transactional) await client.query("COMMIT");
    } catch (err) {
      if (seg.transactional) await client.query("ROLLBACK").catch(() => undefined);
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
