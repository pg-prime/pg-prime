/**
 * The `-- pg-prime:batch` runner — design/06 §7 lane 2, under R14 + R15 + R17.
 *
 * **R15 — crash-resume is tested by killing.** A 50 000-row backfill is started through
 * the real binary, SIGKILLed once `pgprime.data_progress` shows at least two committed
 * batches, and resumed. The assertion that it *continued* rather than *restarted* is not
 * the runner's own report: every row carries a `touched` counter incremented by the
 * backfill, so `max(touched) = 1` over 50 000 rows is a statement by PostgreSQL that no
 * row was written twice. A restart-from-zero makes it 2 for the rows the first run had
 * already done, and no amount of bookkeeping can hide that.
 *
 * **R14 — the catalog is the oracle.** Every claim is checked against the table's own
 * contents and against `pgprime.data_progress` / `pgprime.migrations`, never against the
 * envelope alone; the envelope is asserted *as well*, so a report that disagrees with the
 * database fails too.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { withClient, type ConnInfo } from "../../src/db/pg.js";
import { readAllDataProgress, readDataProgress, readMigrationRows } from "../../src/history/store.js";
import { envelopeOf, runCli, spawnCli, urlOf, waitFor } from "../support/cli.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { parseMigrationSql, type ParsedSql } from "../../src/runner/files.js";
import { tempDir, writeHandMigration } from "../support/migrations.js";

const T = 300_000;
const DATABASE = "pgprime_k4_batch";
const ROWS = 50_000;
const SIZE = 1_000;

const SEED = `CREATE TABLE public.people (
  id      bigint  PRIMARY KEY,
  country text,
  touched integer NOT NULL DEFAULT 0
);
INSERT INTO public.people (id) SELECT g FROM generate_series(1, ${String(ROWS)}) g;`;

/**
 * The lane-2 shape the `generate --data` template writes, with the guard removed: keyset,
 * one statement, reporting `rows_done` and `watermark` back to the runner.
 *
 * `pause=0` because the pause is asserted separately and 50 pauses of 100 ms would add
 * five seconds to every run of this file for no evidence.
 */
const BACKFILL = `-- pg-prime:migration 0001_backfill_country
-- pg-prime:data
-- pg-prime:txmode    none
-- pg-prime:batch     size=${String(SIZE)} pause=0ms

-- pg-prime:stmt 0 lock=rowExclusive idempotent
WITH batch AS (
  SELECT id
    FROM public.people
   WHERE country IS NULL
     AND (nullif(current_setting('pgprime.watermark', true), '') IS NULL
          OR id > nullif(current_setting('pgprime.watermark', true), '')::bigint)
   ORDER BY id
   LIMIT current_setting('pgprime.batch_size')::int
), updated AS (
  UPDATE public.people AS t
     SET country = 'US', touched = t.touched + 1
    FROM batch AS b
   WHERE t.id = b.id
  RETURNING t.id AS id
)
SELECT count(*)::bigint AS rows_done, max(id)::text AS watermark FROM updated;
`;

interface Counts {
  readonly filled: number;
  readonly maxTouched: number;
}

const progressOf = (conn: ConnInfo, id: string): Promise<Awaited<ReturnType<typeof readDataProgress>>> =>
  withClient(conn, (c) => readDataProgress(c, id));

async function counts(conn: ConnInfo): Promise<Counts> {
  return withClient(conn, async (c) => {
    const r = await c.query(
      "SELECT count(*) FILTER (WHERE country IS NOT NULL) AS filled, coalesce(max(touched), 0) AS max_touched FROM public.people",
    );
    const row = r.rows[0] ?? {};
    return { filled: Number(row["filled"]), maxTouched: Number(row["max_touched"]) };
  });
}

describe("design/06 §7 lane 2 — a batched, resumable backfill", () => {
  let dir = "";
  const conn = dbConn(DATABASE);

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    dir = join(await tempDir("pgprime-k4-batch"), "migrations");
    await mkdir(dir, { recursive: true });
    await writeHandMigration(dir, "0001_backfill_country.sql", BACKFILL);
    await makeDatabase(DATABASE);
    await withClient(conn, async (c) => {
      await c.query(SEED);
    });
  }, T);

  afterAll(async () => {
    await destroyDatabase(DATABASE).catch(() => undefined);
  });

  it(
    "SIGKILL after two committed batches; the next apply continues from the watermark and no row is written twice",
    async () => {
      const child = spawnCli(["migrate", "apply", "--url", urlOf(conn), "--migrations", dir, "--output", "json"]);

      // Two batches, committed. `data_progress` is written inside the batch's own
      // transaction, so this is PostgreSQL saying the rows are durable, not the runner
      // saying it issued them.
      const progress = await waitFor(
        "two committed batches",
        async () => {
          const p = await progressOf(conn, "0001_backfill_country").catch(() => null);
          return p !== null && p.iterations >= 2 ? p : false;
        },
        120_000,
      );
      child.kill("SIGKILL");
      await child.done;

      /* Negative control: the kill really landed mid-backfill. */
      const mid = await counts(conn);
      expect(mid.filled, "the kill must land before the backfill finished").toBeLessThan(ROWS);
      expect(mid.filled).toBeGreaterThanOrEqual(2 * SIZE);
      // The committed watermark and the committed rows agree exactly — the two are one
      // transaction, so neither can run ahead of the other.
      const killed = (await progressOf(conn, "0001_backfill_country"))!;
      expect(killed.rowsDone).toBe(mid.filled);
      expect(killed.values["0"]).toBe(String(mid.filled));
      expect(killed.done).toBe(false);
      expect(killed.iterations).toBeGreaterThanOrEqual(progress.iterations);

      /* design/06 §7: `status` shows a running backfill's rows_done. */
      const status = await runCli(["migrate", "status", "--url", urlOf(conn), "--migrations", dir, "--output", "json"]);
      const data = envelopeOf(status)["data"] as { migrationId: string; migrationState: string; rowsDone: number; done: boolean }[];
      expect(data).toHaveLength(1);
      expect(data[0]!.migrationId).toBe("0001_backfill_country");
      expect(data[0]!.migrationState).toBe("running");
      expect(data[0]!.rowsDone).toBe(mid.filled);
      expect(data[0]!.done).toBe(false);

      /* Resume, through the binary. */
      const resumed = await runCli(["migrate", "apply", "--url", urlOf(conn), "--migrations", dir, "--output", "json"]);
      expect(resumed.code, resumed.stdout + resumed.stderr).toBe(EXIT.ok);
      const envelope = envelopeOf(resumed);
      expect(envelope["status"]).toBe("applied");
      const applied = envelope["applied"] as { id: string; batch: { rowsDone: number; iterations: number; resumed: boolean } }[];
      expect(applied).toHaveLength(1);
      expect(applied[0]!.batch.resumed).toBe(true);
      expect(applied[0]!.batch.rowsDone).toBe(ROWS);

      /* Oracle 1 — the table. Every row filled, and NO row written twice. */
      const after = await counts(conn);
      expect(after.filled).toBe(ROWS);
      expect(after.maxTouched, "a restart-from-zero would touch the first batches twice").toBe(1);

      /* Oracle 2 — data_progress. */
      const final = (await progressOf(conn, "0001_backfill_country"))!;
      expect(final.rowsDone).toBe(ROWS);
      expect(final.done).toBe(true);
      expect(final.values["0"]).toBe(String(ROWS));
      // 50 batches of 1 000 plus the empty one that terminates the loop, and the extra
      // iterations the killed run had already committed are counted once, not re-counted.
      expect(final.iterations).toBe(ROWS / SIZE + 1);

      /* Oracle 3 — the migration row. */
      const rows = await withClient(conn, readMigrationRows);
      const row = rows.find((r) => r.id === "0001_backfill_country")!;
      expect(row.status).toBe("applied");
      expect(row.txmode).toBe("none");
      expect(row.statementsApplied).toBe(row.statementsTotal);
      expect(row.statementUncertain).toBeNull();

      /* And a third run does nothing. */
      const noop = await runCli(["migrate", "apply", "--url", urlOf(conn), "--migrations", dir, "--output", "json"]);
      expect(noop.code).toBe(EXIT.ok);
      expect(envelopeOf(noop)["status"]).toBe("up_to_date");
      expect((await counts(conn)).maxTouched).toBe(1);
    },
    T,
  );
});

/**
 * design/12 decision 13 — `max-replica-lag` with no visible replica is a **no-op plus one
 * `info` line**, not a failure and not a silent skip.
 *
 * The test server has no standby, so `pg_stat_replication` is empty. The line has to be
 * said exactly once per run, whatever the batch count, or a long backfill drowns its own
 * log.
 */
describe("max-replica-lag with no visible replica", () => {
  const DB = "pgprime_k4_batch_lag";
  const conn = dbConn(DB);
  let dir = "";

  const FILE = `-- pg-prime:migration 0001_lag_noop
-- pg-prime:data
-- pg-prime:txmode    none
-- pg-prime:batch     size=4 pause=0ms max-replica-lag=10s

-- pg-prime:stmt 0 lock=rowExclusive idempotent
WITH batch AS (
  SELECT id FROM public.small
   WHERE done IS FALSE
     AND (nullif(current_setting('pgprime.watermark', true), '') IS NULL
          OR id > nullif(current_setting('pgprime.watermark', true), '')::bigint)
   ORDER BY id LIMIT current_setting('pgprime.batch_size')::int
), updated AS (
  UPDATE public.small AS t SET done = TRUE FROM batch AS b WHERE t.id = b.id RETURNING t.id AS id
)
SELECT count(*)::bigint AS rows_done, max(id)::text AS watermark FROM updated;
`;

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    dir = join(await tempDir("pgprime-k4-lag"), "migrations");
    await mkdir(dir, { recursive: true });
    await writeHandMigration(dir, "0001_lag_noop.sql", FILE);
    await makeDatabase(DB);
    await withClient(conn, async (c) => {
      await c.query("CREATE TABLE public.small (id bigint PRIMARY KEY, done boolean NOT NULL DEFAULT false)");
      await c.query("INSERT INTO public.small (id) SELECT g FROM generate_series(1, 20) g");
    });
  }, T);

  afterAll(async () => {
    await destroyDatabase(DB).catch(() => undefined);
  });

  it(
    "runs the backfill, says so once, and never blocks",
    async () => {
      const result = await runCli(["migrate", "apply", "--url", urlOf(conn), "--migrations", dir, "--output", "json"]);
      expect(result.code, result.stdout + result.stderr).toBe(EXIT.ok);
      const envelope = envelopeOf(result);
      expect(envelope["status"]).toBe("applied");

      const warnings = envelope["warnings"] as string[];
      const lag = warnings.filter((w) => w.includes("max-replica-lag"));
      expect(lag, JSON.stringify(warnings)).toHaveLength(1);
      expect(lag[0]).toContain("no replica");
      expect(lag[0]).toContain("pg_monitor");
      expect(lag[0]).toContain("pg_last_wal_replay_lsn");

      /* R14 — the table, not the report. 20 rows in batches of 4. */
      const done = await withClient(conn, async (c) => {
        const r = await c.query("SELECT count(*) FILTER (WHERE done) AS n FROM public.small");
        return Number(r.rows[0]!["n"]);
      });
      expect(done).toBe(20);
      const progress = await withClient(conn, readAllDataProgress);
      expect(progress.map((p) => [p.migrationId, p.rowsDone, p.iterations, p.done])).toEqual([
        ["0001_lag_noop", 20, 6, true],
      ]);
    },
    T,
  );
});

/**
 * A statement that keeps reporting rows without moving its watermark is a **failure**, not
 * an infinite loop. This is the one way a batch runner can wedge a deploy with nothing to
 * act on, so the runner names it and stops, and the committed watermark means the fixed
 * file resumes rather than restarts.
 */
describe("a batch whose watermark does not advance", () => {
  const DB = "pgprime_k4_batch_stall";
  const conn = dbConn(DB);
  let dir = "";

  // Reports rows and a CONSTANT watermark, for ever: the predicate does not narrow.
  const FILE = `-- pg-prime:migration 0001_stall
-- pg-prime:data
-- pg-prime:txmode    none
-- pg-prime:batch     size=2 pause=0ms

-- pg-prime:stmt 0 lock=rowExclusive idempotent
SELECT 2::bigint AS rows_done, 'stuck'::text AS watermark;
`;

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    dir = join(await tempDir("pgprime-k4-stall"), "migrations");
    await mkdir(dir, { recursive: true });
    await writeHandMigration(dir, "0001_stall.sql", FILE);
    await makeDatabase(DB);
  }, T);

  afterAll(async () => {
    await destroyDatabase(DB).catch(() => undefined);
  });

  it(
    "stops with a sentence naming the watermark, and leaves the position recorded",
    async () => {
      const result = await runCli(["migrate", "apply", "--url", urlOf(conn), "--migrations", dir, "--output", "json"]);
      expect(result.code).toBe(EXIT.error);
      const envelope = envelopeOf(result);
      expect(envelope["status"]).toBe("failed");
      const error = envelope["error"] as { message: string };
      expect(error.message).toContain("without moving its watermark");
      expect(error.message).toContain("\"stuck\"");

      const progress = (await progressOf(conn, "0001_stall"))!;
      expect(progress.values["0"]).toBe("stuck");
      expect(progress.iterations).toBe(4);
      const rows = await withClient(conn, readMigrationRows);
      expect(rows.find((r) => r.id === "0001_stall")!.status).toBe("failed");
    },
    T,
  );
});

/**
 * The directive itself, as a pure function. A malformed value is a diagnostic and never a
 * silent default: a `size=1oooo` typo that quietly became 1000 would run a backfill ten
 * times longer than the author asked for and nothing would say so.
 */
describe("-- pg-prime:batch, parsed", () => {
  const parse = (header: string): ParsedSql =>
    parseMigrationSql(`${header}\n\n-- pg-prime:stmt 0 lock=none idempotent\nSELECT 1;\n`, "x.sql");

  it("reads size, pause, max-replica-lag and max-iterations", () => {
    const p = parse("-- pg-prime:txmode none\n-- pg-prime:batch size=250 pause=2s max-replica-lag=1m max-iterations=9");
    expect(p.directives.batch).toEqual({ size: 250, pauseMs: 2000, maxReplicaLagMs: 60_000, maxIterations: 9 });
    expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("defaults to design/06 §7's own example line, and to no lag ceiling", () => {
    const p = parse("-- pg-prime:txmode none\n-- pg-prime:batch");
    expect(p.directives.batch).toEqual({ size: 1000, pauseMs: 100, maxReplicaLagMs: null, maxIterations: 0 });
  });

  it("is null when the file does not carry the directive", () => {
    expect(parse("-- pg-prime:txmode none").directives.batch).toBeNull();
  });

  it("reports a malformed size and a malformed duration rather than defaulting silently", () => {
    const p = parse("-- pg-prime:txmode none\n-- pg-prime:batch size=1oooo pause=soon");
    const codes = p.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
    expect(codes).toEqual(["batch_directive_invalid", "batch_directive_invalid"]);
    expect(p.diagnostics.map((d) => d.message).join(" ")).toContain('size="1oooo"');
  });

  it("refuses size=0, which would never make progress", () => {
    const p = parse("-- pg-prime:txmode none\n-- pg-prime:batch size=0");
    expect(p.diagnostics.map((d) => d.message).join(" ")).toContain("would never make progress");
  });

  it("refuses a batch in a transactional file: one transaction cannot be one per iteration", () => {
    const p = parse("-- pg-prime:txmode transactional\n-- pg-prime:batch size=10");
    const hit = p.diagnostics.find((d) => d.code === "batch_requires_txmode_none");
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toContain("txmode none");
  });
});
