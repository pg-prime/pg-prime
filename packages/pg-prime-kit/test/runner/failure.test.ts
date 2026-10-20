/**
 * design/06 §5.3's retry policy and §5.6's failure taxonomy, against real SQLSTATEs.
 *
 * The lock contention is real (a second connection holding ACCESS EXCLUSIVE), the timeout
 * is real, and the assertions are on `pg_catalog` plus the `error` jsonb the row is
 * required to carry — never on the runner's own summary alone (R14). SQLSTATE, not
 * message text (design/09 R13).
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { EXIT } from "../../src/cli/exit.js";
import { withClient, type ConnInfo } from "../../src/db/pg.js";
import { readMigrationRows, readRepeatableRows } from "../../src/history/store.js";
import { createRepeatablesPass } from "../../src/repeatables/index.js";
import { applyPending, applyPendingOn, backoff, resumeFrom } from "../../src/runner/run.js";
import { migrationStatus } from "../../src/runner/status.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { scalar, tempDir, writeHandMigration } from "../support/migrations.js";

const T = 180_000;

const SEED = `-- pg-prime:migration 0001_seed
-- pg-prime:txmode    transactional

-- pg-prime:stmt 0 lock=accessExclusive non-idempotent
CREATE TABLE public.locked_t (id int PRIMARY KEY);
`;

const BLOCKED = `-- pg-prime:migration 0002_blocked
-- pg-prime:txmode    transactional
-- pg-prime:timeout   lock=100ms statement=30s

-- pg-prime:stmt 0 lock=accessExclusive non-idempotent
ALTER TABLE public.locked_t ADD COLUMN note text;
`;

const SLOW = `-- pg-prime:migration 0002_slow
-- pg-prime:txmode    none
-- pg-prime:timeout   lock=3s statement=150ms

-- pg-prime:stmt 0 lock=none idempotent
SELECT pg_sleep(5);
`;

const BROKEN = `-- pg-prime:migration 0002_broken
-- pg-prime:txmode    transactional

-- pg-prime:stmt 0 lock=accessExclusive non-idempotent
CREATE TABLE public.will_be_rolled_back (id int PRIMARY KEY);

-- pg-prime:stmt 1 lock=accessExclusive non-idempotent
CREATE TABLE public.locked_t (id int PRIMARY KEY);
`;

const RETRIED = `-- pg-prime:migration 0002_retried
-- pg-prime:txmode    transactional
-- pg-prime:timeout   lock=100ms statement=30s

-- pg-prime:segment 0
-- pg-prime:stmt 0 lock=accessExclusive non-idempotent
CREATE TABLE public.retry_committed_t (id int PRIMARY KEY);

-- pg-prime:segment 1
-- pg-prime:stmt 1 lock=accessExclusive non-idempotent
ALTER TABLE public.locked_t ADD COLUMN note text;
`;

const CRASHED = `-- pg-prime:migration 0002_crashed
-- pg-prime:txmode    transactional
-- pg-prime:timeout   lock=30s statement=60s

-- pg-prime:segment 0
-- pg-prime:stmt 0 lock=accessExclusive non-idempotent
CREATE TABLE public.crash_t (id int PRIMARY KEY);

-- pg-prime:segment 1
-- pg-prime:stmt 1 lock=accessExclusive non-idempotent
ALTER TABLE public.locked_t ADD COLUMN crash_note text;
`;

const NOTE_COLUMNS =
  "SELECT count(*)::int FROM pg_attribute WHERE attrelid = 'public.locked_t'::regclass AND attname = 'note' AND NOT attisdropped";

/** RETRIED with a statement prepended to the committed segment. */
const PREPENDED = `-- pg-prime:migration 0002_retried
-- pg-prime:txmode    transactional
-- pg-prime:timeout   lock=100ms statement=30s

-- pg-prime:segment 0
-- pg-prime:stmt 0 lock=accessExclusive non-idempotent
CREATE TABLE public.edited_t (id int PRIMARY KEY);

-- pg-prime:stmt 1 lock=accessExclusive non-idempotent
CREATE TABLE public.retry_committed_t (id int PRIMARY KEY);

-- pg-prime:segment 1
-- pg-prime:stmt 2 lock=accessExclusive non-idempotent
ALTER TABLE public.locked_t ADD COLUMN note text;
`;

/** RETRIED shrunk below what committed. */
const SHRUNK = `-- pg-prime:migration 0002_retried
-- pg-prime:txmode    transactional

-- pg-prime:stmt 0 lock=accessExclusive non-idempotent
CREATE TABLE public.retry_committed_t (id int PRIMARY KEY);
`;

const INTERLEAVED = `-- pg-prime:migration 0002_interleaved
-- pg-prime:txmode    transactional

-- pg-prime:segment 0
-- pg-prime:stmt 0 lock=accessExclusive non-idempotent
CREATE TABLE public.inter_a (id int PRIMARY KEY);

-- pg-prime:segment 1
-- pg-prime:stmt 1 lock=accessExclusive non-idempotent
CREATE TABLE public.inter_b (id int PRIMARY KEY);

-- pg-prime:segment 0
-- pg-prime:stmt 2 lock=accessExclusive non-idempotent
CREATE TABLE public.inter_c (id int PRIMARY KEY);
`;

/** Hold ACCESS EXCLUSIVE on `public.locked_t` from a second connection. */
async function holdTableLock(conn: ConnInfo): Promise<() => Promise<void>> {
  const client = new pg.Client({ ...conn });
  await client.connect();
  await client.query("BEGIN");
  await client.query("LOCK TABLE public.locked_t IN ACCESS EXCLUSIVE MODE");
  return async (): Promise<void> => {
    await client.query("COMMIT").catch(() => undefined);
    await client.end().catch(() => undefined);
  };
}

describe("backoff", () => {
  it("is exponential with jitter and a 5 s ceiling", () => {
    const lo = (n: number): number => backoff(n, 100, () => 0);
    const hi = (n: number): number => backoff(n, 100, () => 0.999999);
    expect([lo(1), lo(2), lo(3), lo(4)]).toEqual([50, 100, 200, 400]);
    expect([hi(1), hi(2)]).toEqual([100, 200]);
    expect(lo(20)).toBe(2500);
    expect(hi(20)).toBe(5000);
  });
});

describe("resumeFrom", () => {
  const row = (over: Record<string, unknown>): Parameters<typeof resumeFrom>[0] =>
    ({ status: "running", statementsApplied: 0, statementsTotal: 3, statementUncertain: null, ...over }) as never;

  it("restarts at statements_applied on a clean boundary and at 0 when a statement was in flight", () => {
    expect(resumeFrom(undefined)).toBe(0);
    expect(resumeFrom(row({ statementsApplied: 2 }))).toBe(2);
    expect(resumeFrom(row({ statementsApplied: 2, statementUncertain: 2 }))).toBe(0);
    expect(resumeFrom(row({ status: "applied", statementsApplied: 3 }))).toBe(3);
  });
});

describe("failures, retries and what the row says afterwards", () => {
  const databases: string[] = [];

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
  }, T);

  afterAll(async () => {
    for (const d of databases) await destroyDatabase(d).catch(() => undefined);
  }, T);

  const project = async (slug: string, second: string, body: string): Promise<{ conn: ConnInfo; dir: string }> => {
    const database = `pgprime_k1_fail_${slug}`;
    databases.push(database);
    await makeDatabase(database);
    const dir = join(await tempDir(`pgprime-k1-fail-${slug}`), "migrations");
    await mkdir(dir, { recursive: true });
    await writeHandMigration(dir, "0001_seed.sql", SEED);
    await writeHandMigration(dir, second, body);
    return { conn: dbConn(database), dir };
  };

  it(
    "55P03 is retried five times, then exit 1 with the SQLSTATE on the row",
    async () => {
      const { conn, dir } = await project("lock", "0002_blocked.sql", BLOCKED);
      expect((await applyPending(conn, dir, { to: "0001" })).status).toBe("applied");
      const release = await holdTableLock(conn);
      try {
        const attempts: string[] = [];
        const r = await applyPending(conn, dir, {
          retryBaseMs: 1,
          onEvent: (e) => {
            if (e.kind === "migration" && e.state === "retry") attempts.push(e.detail ?? "");
          },
        });
        expect(r.status).toBe("failed");
        expect(r.exitCode).toBe(EXIT.error);
        expect(r.error?.sqlState).toBe("55P03");
        expect(r.error?.attempts).toBe(5);
        expect(attempts).toHaveLength(4);
        expect(attempts[0]).toContain("SQLSTATE 55P03 attempt 2/5");

        const rows = await withClient(conn, readMigrationRows);
        const row = rows.find((x) => x.id === "0002_blocked")!;
        expect(row.status).toBe("failed");
        expect(row.statementsApplied).toBe(0);
        expect(row.error).toMatchObject({ code: "sql_error", sqlState: "55P03", attempts: 5, statementIndex: 0 });
      } finally {
        await release();
      }

      /* Control: with the lock gone, the same file applies. */
      const ok = await applyPending(conn, dir);
      expect(ok.status).toBe("applied");
      const rows = await withClient(conn, readMigrationRows);
      expect(rows.find((x) => x.id === "0002_blocked")!.error).toBeNull();
    },
    T,
  );

  it(
    "a retry that gets the lock succeeds, and the row records how many it took",
    async () => {
      const { conn, dir } = await project("retry", "0002_blocked.sql", BLOCKED);
      expect((await applyPending(conn, dir, { to: "0001" })).status).toBe("applied");
      const release = await holdTableLock(conn);
      let released = false;
      const r = await applyPending(conn, dir, {
        retryBaseMs: 1,
        onEvent: (e) => {
          if (e.kind === "migration" && e.state === "retry" && !released) {
            released = true;
            void release();
          }
        },
      });
      expect(r.status).toBe("applied");
      expect(r.applied[0]!.retries).toBeGreaterThanOrEqual(1);
      const present = await withClient(conn, async (c) => {
        const q = await c.query(
          "SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid = 'public.locked_t'::regclass AND attname = 'note' AND NOT attisdropped",
        );
        return Number(q.rows[0]?.["n"]);
      });
      expect(present).toBe(1);
    },
    T,
  );

  it(
    "57014 (statement_timeout) is never retried",
    async () => {
      const { conn, dir } = await project("timeout", "0002_slow.sql", SLOW);
      const attempts: string[] = [];
      const r = await applyPending(conn, dir, {
        retryBaseMs: 1,
        onEvent: (e) => {
          if (e.kind === "migration" && e.state === "retry") attempts.push(e.detail ?? "");
        },
      });
      expect(r.status).toBe("failed");
      expect(r.error?.sqlState).toBe("57014");
      expect(r.error?.attempts).toBe(1);
      expect(attempts).toEqual([]);
      const row = (await withClient(conn, readMigrationRows)).find((x) => x.id === "0002_slow")!;
      expect(row.status).toBe("failed");
      expect(row.error).toMatchObject({ sqlState: "57014", attempts: 1 });
    },
    T,
  );

  it(
    "a transactional failure rolls the DDL and the history row back together",
    async () => {
      // Statement 1 re-creates a table statement 0 of 0001_seed already made, so the file
      // fails halfway. design/06 §5.3: "there is no torn state, ever".
      const { conn, dir } = await project("atomic", "0002_broken.sql", BROKEN);
      const r = await applyPending(conn, dir);
      expect(r.status).toBe("failed");
      expect(r.error?.statementIndex).toBe(1);
      expect(r.error?.sqlState).toBe("42P07");

      const created = await withClient(conn, async (c) => {
        const q = await c.query("SELECT to_regclass('public.will_be_rolled_back') IS NOT NULL AS ok");
        return q.rows[0]?.["ok"] === true;
      });
      expect(created, "statement 0's table must have been rolled back with the rest").toBe(false);

      const rows = await withClient(conn, readMigrationRows);
      const row = rows.find((x) => x.id === "0002_broken")!;
      expect(row.status).toBe("failed");
      expect(row.statementsApplied).toBe(0);
      expect(row.error).toMatchObject({ code: "sql_error", sqlState: "42P07", statementIndex: 1 });
      expect(row.finishedAt).not.toBeNull();

      // Nothing of it is in the database, so deleting the file is how it is withdrawn.
      await rm(join(dir, "0002_broken.sql"));
      expect((await migrationStatus(conn, dir)).status).toBe("up_to_date");
      expect((await applyPending(conn, dir)).status).toBe("up_to_date");
    },
    T,
  );

  it(
    "a retry after a committed segment resumes at the failing segment",
    async () => {
      // Attempt 1 commits segment 0 and times out on the lock in segment 1; attempt 2 runs segment 1 alone.
      const { conn, dir } = await project("retried", "0002_retried.sql", RETRIED);
      expect((await applyPending(conn, dir, { to: "0001" })).status).toBe("applied");
      const release = await holdTableLock(conn);
      let released = false;
      const r = await applyPending(conn, dir, {
        retryBaseMs: 1,
        onEvent: (e) => {
          if (e.kind === "migration" && e.state === "retry" && !released) {
            released = true;
            void release();
          }
        },
      });
      expect(r.status).toBe("applied");
      expect(r.applied[0]!.retries).toBeGreaterThanOrEqual(1);
      const row = (await withClient(conn, readMigrationRows)).find((x) => x.id === "0002_retried")!;
      expect(row).toMatchObject({ status: "applied", statementsApplied: 2, statementUncertain: null, error: null });
      expect(await scalar(conn, NOTE_COLUMNS)).toBe(1);
    },
    T,
  );

  it(
    "a failed rerun after a committed segment skips it, and the file cannot be withdrawn meanwhile",
    async () => {
      const { conn, dir } = await project("rerun", "0002_retried.sql", RETRIED);
      expect((await applyPending(conn, dir, { to: "0001" })).status).toBe("applied");
      const release = await holdTableLock(conn);
      try {
        for (const run of [1, 2]) {
          const r = await applyPending(conn, dir, { retryBaseMs: 1 });
          expect(r.status, `run ${String(run)}`).toBe("failed");
          // Segment 0 committed in run 1 and is never replayed: the SQLSTATE stays the lock's, not 42P07.
          expect(r.error).toMatchObject({ sqlState: "55P03", statementIndex: 1, attempts: 5 });
        }
      } finally {
        await release();
      }
      const rows = () => withClient(conn, readMigrationRows).then((all) => all.find((x) => x.id === "0002_retried")!);
      expect(await rows()).toMatchObject({
        status: "failed",
        statementsApplied: 1,
        segmentApplied: 0,
        statementUncertain: 1,
      });
      await rm(join(dir, "0002_retried.sql"));
      expect((await migrationStatus(conn, dir)).missingFiles).toEqual(["0002_retried"]);
      await writeHandMigration(dir, "0002_retried.sql", RETRIED);

      const r = await applyPending(conn, dir);
      expect(r.status).toBe("applied");
      expect(r.applied[0]).toMatchObject({ id: "0002_retried", resumedFrom: 1, retries: 0 });
      expect(await rows()).toMatchObject({
        status: "applied",
        statementsApplied: 2,
        statementUncertain: null,
        error: null,
      });
      expect(await scalar(conn, NOTE_COLUMNS)).toBe(1);
    },
    T,
  );

  it(
    "a file edited after a segment committed is refused, never resumed by position",
    async () => {
      const { conn, dir } = await project("edited", "0002_retried.sql", RETRIED);
      expect((await applyPending(conn, dir, { to: "0001" })).status).toBe("applied");
      const rowNow = async (): Promise<unknown> =>
        (await withClient(conn, readMigrationRows)).find((x) => x.id === "0002_retried");
      const release = await holdTableLock(conn);
      try {
        expect((await applyPending(conn, dir, { retryBaseMs: 1 })).error?.sqlState).toBe("55P03");
        const before = await rowNow();
        for (const [label, body] of [
          ["prepended", PREPENDED],
          ["shrunk", SHRUNK],
        ] as const) {
          await writeHandMigration(dir, "0002_retried.sql", body);
          const r = await applyPending(conn, dir);
          expect(r.status, label).toBe("drift");
          expect(r.exitCode, label).toBe(EXIT.drift);
          expect(r.error, label).toMatchObject({ code: "checksum_drift", migration: "0002_retried" });
          expect(r.error?.message, label).toContain("committed 1 of 2 statement(s) (through segment 0)");
          expect(await rowNow(), label).toEqual(before);
        }
        expect(await scalar(conn, "SELECT to_regclass('public.edited_t') IS NOT NULL")).toBe(false);
        await writeHandMigration(dir, "0002_retried.sql", RETRIED);
      } finally {
        await release();
      }
      // The file that ran, restored, resumes where it stopped.
      expect((await applyPending(conn, dir)).applied[0]).toMatchObject({ id: "0002_retried", resumedFrom: 1 });
    },
    T,
  );

  it(
    "a run killed between segments resumes at the next segment",
    async () => {
      const { conn, dir } = await project("crashed", "0002_crashed.sql", CRASHED);
      expect((await applyPending(conn, dir, { to: "0001" })).status).toBe("applied");
      // Segment 0 commits, then the backend is killed while segment 1 waits on a lock.
      const release = await holdTableLock(conn);
      try {
        const victim = new pg.Client({ ...conn });
        victim.on("error", () => undefined);
        await victim.connect();
        // oxlint-disable-next-line typescript/require-await -- implements the async poolerProbe seam
        const run = applyPendingOn(victim, dir, { poolerProbe: async () => false }).catch(() => undefined);
        await withClient(conn, async (c) => {
          for (;;) {
            const q = await c.query(
              "SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%crash_note%'",
            );
            if (q.rows.length > 0) break;
            await new Promise((r) => setTimeout(r, 50));
          }
        });
        await run;
        await victim.end().catch(() => undefined);
      } finally {
        await release();
      }
      const row = (await withClient(conn, readMigrationRows)).find((x) => x.id === "0002_crashed")!;
      expect(row).toMatchObject({ status: "running", statementsApplied: 1, segmentApplied: 0, statementUncertain: 1 });
      // The rerun skips segment 0: its table is already there.
      const r = await applyPending(conn, dir);
      expect(r.status).toBe("applied");
      expect(r.applied[0]).toMatchObject({ id: "0002_crashed", resumedFrom: 1 });
      expect(await scalar(conn, NOTE_COLUMNS.replace("'note'", "'crash_note'"))).toBe(1);
    },
    T,
  );

  it(
    "a segment's progress is written inside its own transaction, never after its COMMIT",
    async () => {
      const { conn, dir } = await project("progress", "0002_retried.sql", RETRIED);
      expect((await applyPending(conn, dir, { to: "0001" })).status).toBe("applied");
      const texts = (await applyPending(conn, dir, { dryRun: true })).dryRun!.map((q) => q.text);
      const create = texts.findIndex((t) => t.includes("retry_committed_t"));
      const commit = texts.indexOf("COMMIT", create);
      const progress = texts.findIndex((t) =>
        t.startsWith("UPDATE pgprime.migrations SET statements_applied = 1, segment_applied = 0"),
      );
      expect(progress).toBeGreaterThan(create);
      expect(progress).toBeLessThan(commit);
      expect(texts[commit + 1]).toBe("BEGIN");
    },
    T,
  );

  it(
    "segment markers out of file order are refused before anything runs",
    async () => {
      const { conn, dir } = await project("interleaved", "0002_interleaved.sql", INTERLEAVED);
      const r = await applyPending(conn, dir);
      expect(r.status).toBe("failed");
      expect(r.error).toMatchObject({ code: "plan_invalid", migration: "0002_interleaved" });
      expect(r.applied.map((a) => a.id)).toEqual(["0001_seed"]);
      expect(await scalar(conn, "SELECT to_regclass('public.inter_a') IS NOT NULL")).toBe(false);
    },
    T,
  );

  it(
    "a repeatable failing after the migrations committed is a failed run that still names them",
    async () => {
      const { conn, dir } = await project("repeatable", "0002_blocked.sql", BLOCKED);
      const sql = join(dir, "..", "sql");
      await mkdir(join(sql, "010_views"), { recursive: true });
      await writeFile(
        join(sql, "010_views", "broken.sql"),
        "CREATE VIEW public.broken AS SELECT * FROM public.nope;\n",
      );
      const r = await applyPending(conn, dir, { repeatables: createRepeatablesPass(), repeatablesDir: sql });
      expect(r.status).toBe("failed");
      expect(r.exitCode).toBe(EXIT.error);
      expect(r.applied.map((a) => a.id)).toEqual(["0001_seed", "0002_blocked"]);
      expect(r.lock.acquired).toBe(true);
      expect(r.error).toMatchObject({ code: "sql_error", sqlState: "42P01" });
      expect(r.error?.message).toContain("sql/010_views/broken.sql");
      expect(r.error?.sql).toContain("public.nope");
      const rows = await withClient(conn, readMigrationRows);
      expect(rows.map((x) => x.status)).toEqual(["applied", "applied"]);
      expect(await withClient(conn, readRepeatableRows)).toEqual([]);
      // Nothing is left holding the lock.
      expect((await applyPending(conn, dir)).status).toBe("up_to_date");
    },
    T,
  );
});
