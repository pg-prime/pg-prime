/**
 * Two runners, one database — design/06 §5.5.
 *
 * "Two replicas starting simultaneously: one wins the advisory lock; the other blocks on
 * it (bounded by `--lock-wait`) and then re-reads history — finding nothing pending, it
 * exits 0 and starts serving. […] If the winner is mid-run when the loser's wait expires,
 * the loser exits 6."
 *
 * Both runners are real child processes against a real server: a session advisory lock is
 * a claim about two backends, and there is no way to test it inside one.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { withClient, type ConnInfo } from "../../src/db/pg.js";
import { readLease, readMigrationRows } from "../../src/history/store.js";
import { envelopeOf, runCli, sleep, spawnCli, urlOf, waitFor } from "../support/cli.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { tempDir, writeHandMigration } from "../support/migrations.js";

const T = 180_000;

/** `txmode none` so the run genuinely holds the SESSION lock across a slow statement. */
const SLEEPER = `-- pg-prime:migration 0001_sleeper
-- pg-prime:txmode    none
-- pg-prime:timeout   lock=3s statement=0

-- pg-prime:stmt 0 lock=none idempotent
SELECT pg_sleep(3);

-- pg-prime:stmt 1 lock=accessExclusive idempotent
CREATE TABLE IF NOT EXISTS public.sleeper_done (id int PRIMARY KEY);
`;

async function leaseHeld(conn: ConnInfo): Promise<boolean> {
  return withClient(conn, async (c) => {
    const present = await c.query("SELECT to_regclass('pgprime.lock') IS NOT NULL AS ok");
    if (present.rows[0]?.["ok"] !== true) return false;
    return (await readLease(c)) !== null;
  });
}

describe("concurrent deploys", () => {
  let dir = "";

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    dir = join(await tempDir("pgprime-k1-lock"), "migrations");
    await mkdir(dir, { recursive: true });
    await writeHandMigration(dir, "0001_sleeper.sql", SLEEPER);
  }, T);

  afterAll(async () => {
    for (const d of ["pgprime_k1_lock_a", "pgprime_k1_lock_b", "pgprime_k1_lock_c"]) {
      await destroyDatabase(d).catch(() => undefined);
    }
  });

  it(
    "the loser exits 6 while the winner is mid-run, and names the holder",
    async () => {
      const database = "pgprime_k1_lock_a";
      await makeDatabase(database);
      const conn = dbConn(database);
      const args = ["migrate", "apply", "--url", urlOf(conn), "--migrations", dir, "--output", "json"];

      const winner = spawnCli(args);
      try {
        await waitFor("the winner's lease row", () => leaseHeld(conn), 30_000);
        const loser = await runCli([...args, "--lock-wait", "200ms"]);
        const envelope = envelopeOf(loser);
        expect(loser.code, loser.stdout + loser.stderr).toBe(EXIT.locked);
        expect(envelope["status"]).toBe("locked");
        expect(envelope["exitCode"]).toBe(EXIT.locked);
        expect((envelope["error"] as { code: string }).code).toBe("lock_unavailable");
        expect((envelope["pending"] as string[])).toEqual(["0001_sleeper"]);
        const lock = envelope["lock"] as { acquired: boolean; holder: { holder: string } | null };
        expect(lock.acquired).toBe(false);
        expect(lock.holder?.holder).toMatch(/:\d+$/);
      } finally {
        expect(await winner.done, winner.output()).toBe(EXIT.ok);
      }

      /* The winner really did the work, and the lease is gone. */
      const rows = await withClient(conn, readMigrationRows);
      expect(rows.map((r) => [r.id, r.status, r.statementsApplied])).toEqual([["0001_sleeper", "applied", 2]]);
      expect(await leaseHeld(conn)).toBe(false);
    },
    T,
  );

  it(
    "the lease keeps beating DURING a long statement, not only between them",
    async () => {
      // design/06 §5.2 puts the heartbeat "on the same connection", which cannot beat
      // while that connection is inside a 3-second statement. The lease exists to prove
      // a long-running migration is alive, so this is the assertion that decides whether
      // the second connection is justified.
      const database = "pgprime_k1_lock_c";
      await makeDatabase(database);
      const conn = dbConn(database);
      const winner = spawnCli(["migrate", "apply", "--url", urlOf(conn), "--migrations", dir, "--heartbeat", "200ms", "--output", "json"]);
      try {
        await waitFor("the winner's lease row", () => leaseHeld(conn), 30_000);
        const beats = new Set<string>();
        const deadline = Date.now() + 2_500;
        while (Date.now() < deadline) {
          const lease = await withClient(conn, readLease);
          if (lease) beats.add(lease.heartbeatAt);
          await sleep(200);
        }
        // The one bare statement is `pg_sleep(3)`, so every beat above happened while the
        // migration connection was busy.
        expect(beats.size, `heartbeat_at values seen while pg_sleep(3) ran: ${[...beats].join(", ")}`).toBeGreaterThan(3);
      } finally {
        expect(await winner.done, winner.output()).toBe(EXIT.ok);
        await destroyDatabase(database).catch(() => undefined);
      }
    },
    T,
  );

  it(
    "the loser that waits long enough exits 0 with nothing to do",
    async () => {
      const database = "pgprime_k1_lock_b";
      await makeDatabase(database);
      const conn = dbConn(database);
      const args = ["migrate", "apply", "--url", urlOf(conn), "--migrations", dir, "--output", "json"];

      const winner = spawnCli(args);
      await waitFor("the winner's lease row", () => leaseHeld(conn), 30_000);
      const loser = await runCli([...args, "--lock-wait", "60s"]);
      expect(await winner.done, winner.output()).toBe(EXIT.ok);
      expect(loser.code, loser.stdout + loser.stderr).toBe(EXIT.ok);
      const envelope = envelopeOf(loser);
      expect(envelope["status"]).toBe("up_to_date");
      expect(envelope["applied"]).toEqual([]);

      /* Exactly one runner did the work — the table exists once and the row says applied once. */
      const rows = await withClient(conn, readMigrationRows);
      expect(rows.map((r) => [r.id, r.status])).toEqual([["0001_sleeper", "applied"]]);
      expect(await leaseHeld(conn)).toBe(false);
    },
    T,
  );
});
