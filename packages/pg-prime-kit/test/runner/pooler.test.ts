/**
 * design/06 §5.2's active transaction-pooler detection, against a REAL PgBouncer in
 * `pool_mode=transaction`.
 *
 * "Different pids ⟹ the connection is behind a transaction-mode pooler […] Session
 * advisory locks are then silently broken." No amount of unit testing establishes that;
 * the claim is about a pooler, so the test needs one. CI's `pg` job runs one and exports
 * `PG_PRIME_TEST_PGBOUNCER_URL`; locally:
 *
 *   docker network create pgprime-k1
 *   docker network connect pgprime-k1 pgorm-spike-diff
 *   docker run -d --name pgprime-k1-bouncer --network pgprime-k1 -p 56432:5432 \
 *     -e DB_HOST=pgorm-spike-diff -e DB_PORT=5432 -e DB_USER=postgres -e DB_PASSWORD=postgres \
 *     -e POOL_MODE=transaction -e AUTH_TYPE=scram-sha-256 -e MAX_PREPARED_STATEMENTS=200 \
 *     edoburu/pgbouncer:latest
 *   PG_PRIME_TEST_PGBOUNCER_URL=postgres://postgres:postgres@127.0.0.1:56432/postgres
 *
 * The database is whatever the pooler is configured to route — asked of the server with
 * `current_database()` rather than assumed, because a PgBouncer with a fixed `[databases]`
 * entry (which is how CI configures it) will not route a scratch name. The negative
 * control is in the same file: the DIRECT connection to that same database must be
 * accepted, so "refused" cannot be the detector saying no to everything.
 */

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDatabaseUrl } from "../../src/config/load.js";
import { EXIT } from "../../src/cli/exit.js";
import { withClient, type ConnInfo } from "../../src/db/pg.js";
import { historyPresent, HISTORY_SCHEMA } from "../../src/history/schema.js";
import { detectTransactionPooler, detectTransactionPoolerStrict } from "../../src/runner/apply.js";
import { applyPending } from "../../src/runner/run.js";
import { envelopeOf, runCli, urlOf } from "../support/cli.js";
import { ADMIN, serverAvailable } from "../support/db.js";
import { tempDir } from "../support/migrations.js";

const T = 120_000;
const POOLER_URL = process.env["PG_PRIME_TEST_PGBOUNCER_URL"];

describe.skipIf(POOLER_URL === undefined)("a transaction-mode pooler is refused", () => {
  let dir = "";
  let pooled: ConnInfo;
  let direct: ConnInfo;
  let hadHistory = false;

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    dir = await tempDir("pgprime-k1-pooler");
    pooled = parseDatabaseUrl(POOLER_URL!).conn;
    const routed = await withClient(pooled, async (c) => String((await c.query("SELECT current_database() AS db")).rows[0]?.["db"]));
    pooled = { ...pooled, database: routed };
    direct = { ...ADMIN, database: routed };
    hadHistory = await withClient(direct, historyPresent);
  }, T);

  afterAll(async () => {
    // The negative control below runs a real `apply`, which creates the history schema in
    // whatever database the pooler routes to — a shared one, not a scratch one. Put it back.
    if (!hadHistory) {
      await withClient(direct, (c) => c.query(`DROP SCHEMA IF EXISTS ${HISTORY_SCHEMA} CASCADE`)).catch(() => undefined);
    }
  });

  it(
    "design/06 §5.2's two-pid probe MISSES an idle transaction pool — measured, not assumed",
    async () => {
      // PgBouncer 1.25, pool_mode=transaction, one client: the second transaction is
      // handed the same (only) idle server connection, so the pids match and the cheap
      // probe says "not pooled". This is the finding that made the strict probe
      // necessary; it is asserted rather than described so a future PgBouncer that
      // behaves differently shows up as a failing test rather than as dead code.
      expect(await withClient(pooled, detectTransactionPooler)).toBe(false);
    },
    T,
  );

  it(
    "the strict probe pins a server and gets moved — true through the pooler, false direct",
    async () => {
      const pin = (conn: ConnInfo) => async (): Promise<() => Promise<void>> => {
        const second = new pg.Client({ ...conn });
        await second.connect();
        await second.query("BEGIN");
        await second.query("SELECT 1");
        return async (): Promise<void> => {
          await second.query("ROLLBACK").catch(() => undefined);
          await second.end();
        };
      };
      expect(await withClient(pooled, (c) => detectTransactionPoolerStrict(c, pin(pooled)))).toBe(true);
      expect(await withClient(direct, (c) => detectTransactionPoolerStrict(c, pin(direct)))).toBe(false);
    },
    T,
  );

  it(
    "apply refuses, and the sentence names the direct port",
    async () => {
      const before = await withClient(direct, historyPresent);
      const r = await applyPending(pooled, dir);
      expect(r.status).toBe("refused");
      expect(r.exitCode).toBe(EXIT.error);
      expect(r.error?.code).toBe("transaction_pooler");
      expect(r.error?.message).toContain("pg_backend_pid");
      expect(r.error?.message).toMatch(/reports port \d+/);
      // It refused BEFORE writing anything: a pooled connection must not even get as far
      // as `ensureHistory`.
      expect(await withClient(direct, historyPresent)).toBe(before);
    },
    T,
  );

  it(
    "through the binary: exit 1 with the refusal in the envelope",
    async () => {
      const result = await runCli(["migrate", "apply", "--url", urlOf(pooled), "--migrations", dir, "--output", "json"]);
      expect(result.code).toBe(EXIT.error);
      const envelope = envelopeOf(result);
      expect(envelope["status"]).toBe("refused");
      expect(envelope["exitCode"]).toBe(EXIT.error);
      expect((envelope["error"] as { code: string }).code).toBe("transaction_pooler");
    },
    T,
  );

  it(
    "the direct connection through the binary is accepted (the negative control)",
    async () => {
      const result = await runCli(["migrate", "apply", "--url", urlOf(direct), "--migrations", dir, "--output", "json"]);
      expect(result.code, result.stdout + result.stderr).toBe(EXIT.ok);
      expect(envelopeOf(result)["status"]).toBe("up_to_date");
    },
    T,
  );
});
