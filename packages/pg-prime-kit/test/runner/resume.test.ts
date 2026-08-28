/**
 * R15 — crash-resume is tested by KILLING, not by mocking.
 *
 * The runner is spawned as a child process against a `txmode none` file whose second
 * statement is a `CREATE INDEX CONCURRENTLY` over an expression that is deliberately slow
 * (an `IMMUTABLE` function that sleeps 20 ms per row × 200 rows). The test waits until
 * PostgreSQL has committed the CIC's catalog entry — i.e. `pg_index.indisvalid = false`
 * exists and `pgprime.migrations.statement_uncertain = 1` — then SIGKILLs the runner and
 * terminates the orphaned backend, which is what a machine death looks like from the
 * server's side.
 *
 * The negative control is inside the test: it asserts the INVALID index is really there
 * before the resume, so "the index is valid afterwards" cannot pass by the crash never
 * having happened.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { withClient, type ConnInfo } from "../../src/db/pg.js";
import { readMigrationRows } from "../../src/history/store.js";
import { applyPending } from "../../src/runner/run.js";
import { envelopeOf, runCli, spawnCli, urlOf, waitFor } from "../support/cli.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { tempDir, writeHandMigration } from "../support/migrations.js";

const T = 180_000;
const DATABASE = "pgprime_k1_resume";

const SEED = `-- pg-prime:migration 0001_seed
-- pg-prime:txmode    transactional

-- pg-prime:stmt 0 lock=accessExclusive non-idempotent
CREATE TABLE public.slow_t (id int PRIMARY KEY, x int NOT NULL);

-- pg-prime:stmt 1 lock=rowExclusive non-idempotent
INSERT INTO public.slow_t SELECT g, g FROM generate_series(1, 200) g;

-- pg-prime:stmt 2 lock=none non-idempotent
CREATE FUNCTION public.pgprime_slow(i int) RETURNS int LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  -- 20 ms per row, so the CIC below spends ~4 s in its build phase. Not a comment the
  -- directive scanner may read: it is inside a dollar-quoted body, and the lexer knows.
  -- pg-prime:stmt 99 this line must NOT become a marker
  PERFORM pg_sleep(0.02);
  RETURN i;
END
$fn$;
`;

/** design/06 §4.2's own example, near enough: the CIC pair, `txmode none`, idempotent. */
const SLOW_INDEX = `-- pg-prime:migration 0002_slow_index
-- pg-prime:txmode    none
-- pg-prime:timeout   lock=3s statement=0

-- pg-prime:stmt 0 lock=shareUpdateExclusive idempotent hazards=LK101
DROP INDEX CONCURRENTLY IF EXISTS public.slow_t_x_idx;

-- pg-prime:stmt 1 lock=shareUpdateExclusive idempotent hazards=LK101
CREATE INDEX CONCURRENTLY slow_t_x_idx ON public.slow_t (public.pgprime_slow(x));
`;

async function indexValidity(conn: ConnInfo): Promise<boolean | null> {
  return withClient(conn, async (c) => {
    const r = await c.query(
      "SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'slow_t_x_idx'",
    );
    const row = r.rows[0];
    return row === undefined ? null : (row["indisvalid"] as boolean);
  });
}

async function uncertainStatement(conn: ConnInfo): Promise<number | null> {
  return withClient(conn, async (c) => {
    const r = await c.query("SELECT statement_uncertain FROM pgprime.migrations WHERE id = '0002_slow_index'");
    const v = r.rows[0]?.["statement_uncertain"];
    return v === null || v === undefined ? null : Number(v);
  });
}

async function killOrphanBuilders(conn: ConnInfo): Promise<number> {
  return withClient(conn, async (c) => {
    const r = await c.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid() AND query ILIKE 'CREATE INDEX CONCURRENTLY%'`,
      [conn.database],
    );
    return r.rows.length;
  });
}

describe("txmode none: crash mid-CIC, then resume", () => {
  let dir = "";
  const conn = dbConn(DATABASE);

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    dir = join(await tempDir("pgprime-k1-resume"), "migrations");
    await mkdir(dir, { recursive: true });
    await writeHandMigration(dir, "0001_seed.sql", SEED);
    await writeHandMigration(dir, "0002_slow_index.sql", SLOW_INDEX);
    await makeDatabase(DATABASE);
  }, T);

  afterAll(async () => {
    await destroyDatabase(DATABASE).catch(() => undefined);
  });

  it(
    "SIGKILL during the concurrent build; the next apply finishes it and the index is valid",
    async () => {
      const child = spawnCli([
        "migrate", "apply",
        "--url", urlOf(conn),
        "--migrations", dir,
        "--output", "json",
      ]);

      // Wait for PostgreSQL itself to say the build is under way: the CIC's first
      // transaction has committed an INVALID catalog entry, and our bookkeeping says the
      // statement is in flight.
      await waitFor("the CIC's invalid catalog entry", async () => (await indexValidity(conn)) === false, 60_000);
      expect(await uncertainStatement(conn)).toBe(1);

      child.kill("SIGKILL");
      await child.done;
      await killOrphanBuilders(conn);
      await waitFor("the orphaned backend to go away", async () => (await killOrphanBuilders(conn)) === 0, 60_000);

      /* Negative control: the crash really did leave the wreckage behind. */
      expect(await indexValidity(conn), "an INVALID index should survive the kill").toBe(false);
      const mid = await withClient(conn, readMigrationRows);
      expect(mid.map((r) => [r.id, r.status])).toEqual([
        ["0001_seed", "applied"],
        ["0002_slow_index", "running"],
      ]);
      expect(mid[1]!.statementUncertain).toBe(1);
      expect(mid[1]!.statementsApplied).toBe(1);

      /* Resume. */
      const resumed = await applyPending(conn, dir);
      expect(resumed.error, JSON.stringify(resumed.error)).toBeNull();
      expect(resumed.status).toBe("applied");
      expect(resumed.applied.map((a) => [a.id, a.resumedFrom])).toEqual([["0002_slow_index", 0]]);

      /* Oracle 1 — the catalog. */
      expect(await indexValidity(conn)).toBe(true);
      /* Oracle 2 — the row. */
      const rows = await withClient(conn, readMigrationRows);
      const row = rows.find((r) => r.id === "0002_slow_index")!;
      expect(row.status).toBe("applied");
      expect(row.statementsApplied).toBe(row.statementsTotal);
      expect(row.statementsTotal).toBe(2);
      expect(row.statementUncertain).toBeNull();
      expect(row.txmode).toBe("none");

      /* And a third run does nothing at all. */
      const noop = await runCli(["migrate", "apply", "--url", urlOf(conn), "--migrations", dir, "--output", "json"]);
      expect(noop.code).toBe(EXIT.ok);
      expect(envelopeOf(noop)["status"]).toBe("up_to_date");
    },
    T,
  );

  it("the dollar-quoted body's `-- pg-prime:stmt 99` was not read as a marker", async () => {
    const rows = await withClient(conn, readMigrationRows);
    expect(rows.find((r) => r.id === "0001_seed")!.statementsTotal).toBe(3);
  });
});
