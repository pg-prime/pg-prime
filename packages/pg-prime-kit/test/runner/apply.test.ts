/**
 * R14 — the catalog is the oracle for the runner.
 *
 * Every claim here is checked twice, in the same test: once against `pg_catalog` (does
 * the object exist / is the fingerprint what the plan promised) and once against
 * `pgprime.migrations` (does the row say so). A runner that reported success without
 * doing the work, and a runner that did the work without recording it, both fail.
 *
 * design/11 §3 K1's gate: "`apply` from an empty database through the fixture corpus's
 * plans, twice (second run is a no-op, exit 0)".
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { withClient } from "../../src/db/pg.js";
import { historyVersion, HISTORY_VERSION } from "../../src/history/schema.js";
import { readMigrationRows } from "../../src/history/store.js";
import { applyPending, PoolRefusedError } from "../../src/runner/run.js";
import { migrationStatus } from "../../src/runner/status.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { fingerprintOf, generateChain, scalar, type Chain } from "../support/migrations.js";

const T = 180_000;

describe("apply: corpus plans, from empty, twice", () => {
  const chains = new Map<string, Chain>();

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
  }, T);

  afterAll(async () => {
    for (const chain of chains.values()) await chain.dispose().catch(() => undefined);
  });

  interface Case {
    readonly name: string;
    readonly slug: string;
    readonly steps: readonly { name: string; fixture: string | null }[];
    readonly schemas?: readonly string[];
    /** a catalog probe that must be true after the last step */
    readonly probe: { readonly sql: string; readonly expected: unknown };
  }

  const CASES: readonly Case[] = [
    {
      name: "acceptance, in one step",
      slug: "acc",
      steps: [{ name: "acceptance", fixture: "acceptance/desired.sql" }],
      probe: { sql: "SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'", expected: 3 },
    },
    {
      name: "evolve, in two steps",
      slug: "evo",
      steps: [
        { name: "step_one", fixture: "evolve/current.sql" },
        { name: "step_two", fixture: "evolve/desired.sql" },
      ],
      probe: {
        sql: "SELECT count(*)::int FROM pg_attribute WHERE attrelid = 'public.customers'::regclass AND attname = 'full_name' AND NOT attisdropped",
        expected: 1,
      },
    },
    {
      name: "enum ordering, in two steps",
      slug: "enum",
      steps: [
        { name: "step_one", fixture: "enum-ordering/current.sql" },
        { name: "step_two", fixture: "enum-ordering/desired.sql" },
      ],
      probe: { sql: "SELECT count(*)::int FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='order_status' AND e.enumlabel = 'refunded'", expected: 1 },
    },
    {
      name: "multi-schema, in one step",
      slug: "msu",
      steps: [{ name: "multi_schema", fixture: "multi-schema/desired.sql" }],
      schemas: ["public", "app", "billing"],
      probe: { sql: "SELECT count(*)::int FROM pg_namespace WHERE nspname IN ('app','billing')", expected: 2 },
    },
  ];

  for (const c of CASES) {
    it(
      c.name,
      async () => {
        const schemas = c.schemas ?? ["public"];
        const chain = await generateChain(c.slug, c.steps, schemas);
        chains.set(c.slug, chain);
        const database = `pgprime_k1_apply_${c.slug}`;
        await makeDatabase(database);
        const conn = dbConn(database);

        try {
          const first = await applyPending(conn, chain.dir, { schemas });
          expect(first.error, JSON.stringify(first.error)).toBeNull();
          expect(first.status).toBe("applied");
          expect(first.exitCode).toBe(EXIT.ok);
          expect(first.applied.map((a) => a.id)).toEqual(chain.plans.map((p) => `${p.migration.id}_${p.migration.name}`));

          /* Oracle 1 — pg_catalog. */
          expect(await fingerprintOf(conn, schemas)).toBe(chain.finalFingerprint);
          expect(await scalar(conn, c.probe.sql)).toBe(c.probe.expected);

          /* Oracle 2 — the history table, in the same test. */
          const rows = await withClient(conn, (client) => readMigrationRows(client));
          expect(rows.map((r) => r.id)).toEqual(chain.plans.map((p) => `${p.migration.id}_${p.migration.name}`));
          for (const [i, row] of rows.entries()) {
            const plan = chain.plans[i]!;
            expect(row.status).toBe("applied");
            expect(row.statementsApplied).toBe(row.statementsTotal);
            expect(row.statementsTotal).toBe(plan.statements.length);
            expect(row.checksum).toBe(plan.migration.sha256);
            expect(row.planId).toBe(plan.planId);
            expect(row.fingerprintTo).toBe(plan.to.fingerprint);
            expect(row.error).toBeNull();
            expect(row.durationMs).toBeGreaterThanOrEqual(0);
            expect(row.finishedAt).not.toBeNull();
          }
          expect(await withClient(conn, historyVersion)).toBe(HISTORY_VERSION);

          /* The second run is a no-op that exits 0 and touches nothing. */
          const second = await applyPending(conn, chain.dir, { schemas });
          expect(second.status).toBe("up_to_date");
          expect(second.exitCode).toBe(EXIT.ok);
          expect(second.applied).toEqual([]);
          const after = await withClient(conn, (client) => readMigrationRows(client));
          expect(after.map((r) => r.finishedAt)).toEqual(rows.map((r) => r.finishedAt));
          expect(await fingerprintOf(conn, schemas)).toBe(chain.finalFingerprint);

          /* And `status` agrees with both. */
          const report = await migrationStatus(conn, chain.dir, { schemas });
          expect(report.status).toBe("up_to_date");
          expect(report.exitCode).toBe(EXIT.ok);
          expect(report.pending).toEqual([]);
          expect(report.fingerprint).toBe(chain.finalFingerprint);
          expect(report.migrations.every((m) => m.checksumOk === true)).toBe(true);

          /* The lease is released, not merely stopped being written to. */
          expect(report.lock.lease).toBeNull();
        } finally {
          await destroyDatabase(database).catch(() => undefined);
        }
      },
      T,
    );
  }

  it("refuses a pool rather than silently losing the session lock", async () => {
    const pool = { query: (): void => undefined, connect: (): void => undefined };
    await expect(applyPending(pool as never, "/nowhere")).rejects.toBeInstanceOf(PoolRefusedError);
  });
});
