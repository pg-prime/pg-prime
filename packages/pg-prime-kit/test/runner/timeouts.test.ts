/**
 * `--statement-timeout` and the CIC/VALIDATE exemption (design/06 §5.4, §6.2 · design/12 F2 h).
 *
 * A plan records `timeouts.statement: null` for the intentionally long builds — everything the
 * emitter classes `shareUpdateExclusive`. That null is an **exemption**, and the resolution used
 * to read it as an absence (`s.timeouts.statement ?? ctx.statementTimeout ?? "0"`), so an explicit
 * `--statement-timeout` landed on exactly the statements it must not cap — a `CREATE INDEX
 * CONCURRENTLY` cut off mid-build, leaving an INVALID index — and on no others, because every
 * ordinary statement carries a concrete `30s` that `??` preferred.
 *
 * R14: the oracle is the session, read from inside the statement itself. A probe statement
 * carries the lock class under test and records `current_setting('statement_timeout')` into a
 * table, so what is asserted is the GUC the runner actually set for that statement, not the
 * runner's opinion about it. A real `CREATE INDEX CONCURRENTLY` runs beside the probes and its
 * `indisvalid` is checked, so the file is a genuine CIC file rather than a mock of one.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { resolveStatementTimeout } from "../../src/runner/apply.js";
import { envelopeOf, runCli, urlOf } from "../support/cli.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { scalar, tempDir, writeHandMigration } from "../support/migrations.js";

const T = 120_000;
const DATABASE = "pgprime_f2_timeouts";

const CREATE = `-- pg-prime:migration 0001_create_widgets
-- pg-prime:txmode    transactional
-- pg-prime:timeout   lock=3s statement=30s

-- pg-prime:stmt 0 lock=accessExclusive non-idempotent
CREATE TABLE public.widgets (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL);
`;

/**
 * A bare file: no `statement=` in the header, so each statement's ceiling comes from its lock
 * class — `null` for the two `shareUpdateExclusive` ones, `30s` for the last.
 */
const BARE = `-- pg-prime:migration 0002_bare_probes
-- pg-prime:txmode    none
-- pg-prime:timeout   lock=3s

-- pg-prime:stmt 0 lock=shareUpdateExclusive idempotent hazards=LK101
CREATE INDEX CONCURRENTLY IF NOT EXISTS widgets_name_idx ON public.widgets USING btree (name);

-- pg-prime:stmt 1 lock=shareUpdateExclusive idempotent
CREATE TABLE IF NOT EXISTS public.bare_exempt AS SELECT current_setting('statement_timeout') AS v;

-- pg-prime:stmt 2 lock=accessExclusive non-idempotent
CREATE TABLE public.bare_capped AS SELECT current_setting('statement_timeout') AS v;
`;

/** The same two questions on the transactional path, which is a different function. */
const TRANSACTIONAL = `-- pg-prime:migration 0003_tx_probes
-- pg-prime:txmode    transactional
-- pg-prime:timeout   lock=3s

-- pg-prime:stmt 0 lock=shareUpdateExclusive idempotent
CREATE TABLE public.tx_exempt AS SELECT current_setting('statement_timeout') AS v;

-- pg-prime:stmt 1 lock=accessExclusive non-idempotent
CREATE TABLE public.tx_capped AS SELECT current_setting('statement_timeout') AS v;
`;

describe("statement_timeout resolution", () => {
  let dir = "";

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    dir = join(await tempDir("pgprime-f2-timeouts"), "migrations");
    await mkdir(dir, { recursive: true });
    await writeHandMigration(dir, "0001_create_widgets.sql", CREATE);
    await writeHandMigration(dir, "0002_bare_probes.sql", BARE);
    await writeHandMigration(dir, "0003_tx_probes.sql", TRANSACTIONAL);
    await makeDatabase(DATABASE);
  }, T);

  afterAll(async () => {
    await destroyDatabase(DATABASE).catch(() => undefined);
  });

  it("plan-null beats the flag, the flag beats the plan's own value, and neither invents one", () => {
    expect(resolveStatementTimeout(null, "1s")).toBe("0");
    expect(resolveStatementTimeout(null, undefined)).toBe("0");
    expect(resolveStatementTimeout("30s", "1s")).toBe("1s");
    expect(resolveStatementTimeout("30s", undefined)).toBe("30s");
  });

  it(
    "an explicit --statement-timeout does not reach a statement the plan exempts",
    async () => {
      const conn = dbConn(DATABASE);
      const r = await runCli([
        "migrate",
        "apply",
        "--url",
        urlOf(conn),
        "--migrations",
        dir,
        "--statement-timeout",
        "1s",
        "--output",
        "json",
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.ok);
      expect(envelopeOf(r)["status"]).toBe("applied");

      // The session, as the exempt statements saw it: no ceiling at all.
      expect(await scalar(conn, "SELECT v FROM public.bare_exempt")).toBe("0");
      expect(await scalar(conn, "SELECT v FROM public.tx_exempt")).toBe("0");
      // …and the flag is not a no-op: it overrides the ceiling the file carries for the rest.
      expect(await scalar(conn, "SELECT v FROM public.bare_capped")).toBe("1s");
      expect(await scalar(conn, "SELECT v FROM public.tx_capped")).toBe("1s");
      // The CIC beside the probes really built, and is valid rather than half-finished.
      expect(
        await scalar(
          conn,
          "SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'widgets_name_idx'",
        ),
      ).toBe(true);
    },
    T,
  );
});
