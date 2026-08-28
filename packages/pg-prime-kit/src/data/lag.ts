/**
 * Replica lag, for `-- pg-prime:batch max-replica-lag=<duration>` (design/06 §7, design/12
 * decision 13).
 *
 * Two readers, and which one runs is a configuration decision rather than a guess:
 *
 *  - **primary-side, by default.** `pg_stat_replication.replay_lag` on the connection the
 *    migration already holds. It needs no replica URLs, no second credential and no extra
 *    connection, it is exactly the number an operator watches, and PostgreSQL has had it
 *    since 10. The cost is that a non-superuser sees only its own rows unless it is in
 *    `pg_monitor`, which is why "no rows" is reported as *no visible replica* rather than
 *    as *no lag* — the two are different sentences and only one of them is evidence.
 *  - **replica-side, opt in with `replicas: [url]`.** design/06 §7's literal shape:
 *    `pg_last_wal_replay_lsn()` on each replica. The duration is derived the standard way,
 *    from `pg_last_xact_replay_timestamp()`, and only when the replica has not caught up —
 *    an idle replica whose replay timestamp is an hour old is not an hour behind.
 *
 * Neither reader ever *changes* anything. A lag over the ceiling makes the batch loop
 * wait; it never makes it skip a batch or shrink one.
 */

import type { CatalogClient } from "../catalog/extract.js";
import { withClient, type ConnInfo } from "../db/pg.js";

export interface LagReading {
  /** the worst lag across every replica that answered, in ms; null when none did */
  readonly lagMs: number | null;
  /** how many replicas this reading covers */
  readonly replicas: number;
  /** `primary` = `pg_stat_replication`; `replicas` = one query per configured URL */
  readonly source: "primary" | "replicas";
  /** the LSNs read, for the report — design/06 §7 names `pg_last_wal_replay_lsn()` */
  readonly detail: readonly string[];
}

/** `pg_stat_replication`, on the migration's own connection. */
export async function readPrimaryLag(client: CatalogClient): Promise<LagReading> {
  const r = await client.query(
    `SELECT coalesce(application_name, client_addr::text, 'replica') AS name,
            state,
            coalesce((EXTRACT(EPOCH FROM replay_lag) * 1000)::bigint, 0) AS lag_ms,
            replay_lsn::text AS replay_lsn
       FROM pg_stat_replication
      ORDER BY 1`,
  );
  if (r.rows.length === 0) return { lagMs: null, replicas: 0, source: "primary", detail: [] };
  let worst = 0;
  const detail: string[] = [];
  for (const row of r.rows) {
    const ms = Number(row["lag_ms"] ?? 0);
    if (Number.isFinite(ms) && ms > worst) worst = ms;
    detail.push(`${String(row["name"])} ${String(row["state"])} replay_lsn=${String(row["replay_lsn"] ?? "?")} lag=${String(Math.round(ms))}ms`);
  }
  return { lagMs: worst, replicas: r.rows.length, source: "primary", detail };
}

/**
 * `pg_last_wal_replay_lsn()` on each configured replica (design/06 §7).
 *
 * A replica that cannot be reached is **not** treated as zero lag: it contributes
 * `Infinity`, which keeps the loop paused. Silently proceeding past a replica we cannot
 * see is the failure the ceiling exists to prevent.
 */
export async function readReplicaLag(replicas: readonly ConnInfo[]): Promise<LagReading> {
  if (replicas.length === 0) return { lagMs: null, replicas: 0, source: "replicas", detail: [] };
  let worst = 0;
  const detail: string[] = [];
  for (const conn of replicas) {
    try {
      const row = await withClient(conn, async (client) => {
        const r = await client.query(
          `SELECT pg_is_in_recovery() AS in_recovery,
                  pg_last_wal_replay_lsn()::text AS replay_lsn,
                  CASE WHEN NOT pg_is_in_recovery() THEN 0
                       WHEN pg_last_wal_receive_lsn() IS NOT DISTINCT FROM pg_last_wal_replay_lsn() THEN 0
                       ELSE coalesce((EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000)::bigint, 0)
                  END AS lag_ms`,
        );
        return r.rows[0] ?? {};
      });
      const ms = Number(row["lag_ms"] ?? 0);
      if (Number.isFinite(ms) && ms > worst) worst = ms;
      detail.push(
        `${conn.host}:${String(conn.port)}/${conn.database} replay_lsn=${String(row["replay_lsn"] ?? "?")} lag=${String(Math.round(ms))}ms`,
      );
    } catch (err) {
      worst = Number.POSITIVE_INFINITY;
      detail.push(`${conn.host}:${String(conn.port)}/${conn.database} UNREACHABLE (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { lagMs: worst, replicas: replicas.length, source: "replicas", detail };
}
