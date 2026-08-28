/**
 * The history tables — design/06 §4.4.
 *
 * The oracle is the *catalog*: the tables that exist after `ensureHistory` are read back
 * out of `information_schema` and compared against §4.4's column list, transcribed here
 * once. A change to the DDL that does not change this list is a typo; a change that does
 * is a schema migration for the migration tool, which is why `pgprime.meta.history_version`
 * exists and is asserted alongside.
 */

import { describe, expect, it } from "vitest";
import { withClient, type ConnInfo } from "../../src/db/pg.js";
import { ensureHistory, historyPresent, historyVersion, HISTORY_SCHEMA, HISTORY_VERSION } from "../../src/history/schema.js";
import { readLease, takeLease, releaseLease, breakLease } from "../../src/history/store.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";

const T = 120_000;

/** design/06 §4.4, transcribed. `column: nullable?` — `true` means the DDL has no NOT NULL. */
const EXPECTED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  migrations: {
    id: "text NOT NULL", seq: "integer NOT NULL", name: "text NOT NULL", checksum: "text NOT NULL",
    plan_id: "text NULL", fingerprint_from: "text NULL", fingerprint_to: "text NULL",
    txmode: "text NOT NULL", statements_total: "integer NOT NULL", statements_applied: "integer NOT NULL",
    statement_uncertain: "integer NULL", segment_applied: "integer NOT NULL", status: "text NOT NULL",
    started_at: "timestamp with time zone NOT NULL", finished_at: "timestamp with time zone NULL",
    duration_ms: "integer NULL", applied_by: "text NOT NULL", applied_from: "text NULL",
    error: "jsonb NULL", engine_version: "text NOT NULL",
  },
  repeatables: {
    path: "text NOT NULL", checksum: "text NOT NULL",
    applied_at: "timestamp with time zone NOT NULL", duration_ms: "integer NULL",
  },
  checkpoints: { id: "text NOT NULL", fingerprint: "text NOT NULL", created_at: "timestamp with time zone NOT NULL" },
  lock: {
    singleton: "boolean NOT NULL", run_id: "uuid NOT NULL", holder: "text NOT NULL",
    acquired_at: "timestamp with time zone NOT NULL", heartbeat_at: "timestamp with time zone NOT NULL",
  },
  data_progress: {
    migration_id: "text NOT NULL", watermark: "jsonb NOT NULL", rows_done: "bigint NOT NULL",
    updated_at: "timestamp with time zone NOT NULL",
  },
  meta: { key: "text NOT NULL", value: "text NOT NULL" },
};

async function shape(conn: ConnInfo): Promise<Record<string, Record<string, string>>> {
  return withClient(conn, async (c) => {
    const r = await c.query(
      `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns WHERE table_schema = $1
        ORDER BY table_name, ordinal_position`,
      [HISTORY_SCHEMA],
    );
    const out: Record<string, Record<string, string>> = {};
    for (const row of r.rows) {
      const table = String(row["table_name"]);
      (out[table] ??= {})[String(row["column_name"])] =
        `${String(row["data_type"])} ${row["is_nullable"] === "YES" ? "NULL" : "NOT NULL"}`;
    }
    return out;
  });
}

describe("ensureHistory", () => {
  const DATABASE = "pgprime_k1_history";

  it(
    "creates exactly design/06 §4.4's tables, is idempotent, and survives a concurrent race",
    async () => {
      expect(await serverAvailable()).toBe(true);
      await makeDatabase(DATABASE);
      const conn = dbConn(DATABASE);
      try {
        expect(await withClient(conn, historyPresent)).toBe(false);

        // Two runners starting together is the normal case (design/06 §5.5), and
        // `CREATE … IF NOT EXISTS` is not race-free — the loser sees a duplicate.
        await Promise.all([
          withClient(conn, ensureHistory),
          withClient(conn, ensureHistory),
          withClient(conn, ensureHistory),
        ]);

        expect(await shape(conn)).toEqual(EXPECTED);
        expect(await withClient(conn, historyPresent)).toBe(true);
        expect(await withClient(conn, historyVersion)).toBe(HISTORY_VERSION);

        // Idempotent: a fourth run changes nothing, including the version row.
        await withClient(conn, ensureHistory);
        expect(await shape(conn)).toEqual(EXPECTED);
        const rows = await withClient(conn, async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${HISTORY_SCHEMA}.meta`)).rows);
        expect(Number(rows[0]?.["n"])).toBe(1);

        // `lock` is a singleton by construction: the CHECK plus the primary key.
        await withClient(conn, async (c) => {
          await takeLease(c, "00000000-0000-4000-8000-00000000000a", "a");
          await takeLease(c, "00000000-0000-4000-8000-00000000000b", "b");
          const lease = await readLease(c);
          expect(lease?.holder).toBe("b");
          expect(lease?.heartbeatAgeMs).toBeGreaterThanOrEqual(0);
          const count = await c.query(`SELECT count(*)::int AS n FROM ${HISTORY_SCHEMA}.lock`);
          expect(Number(count.rows[0]?.["n"])).toBe(1);
          await releaseLease(c, "00000000-0000-4000-8000-00000000000a");
          expect(await readLease(c)).not.toBeNull();
          expect(await breakLease(c)).toBe(true);
          expect(await readLease(c)).toBeNull();
          expect(await breakLease(c)).toBe(false);
        });
      } finally {
        await destroyDatabase(DATABASE).catch(() => undefined);
      }
    },
    T,
  );
});
