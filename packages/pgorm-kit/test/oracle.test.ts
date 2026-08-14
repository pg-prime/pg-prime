/**
 * The differential oracle (00-overview sign-off item 7).
 *
 * Run `@supabase/pg-delta@1.0.0-alpha.39` over the same fixture corpus and log
 * every structural disagreement. A disagreement is a FUTURE TEST CASE, not a
 * failure — the oracle is an alpha with five releases a week and a different
 * IR granularity, so it is expected to differ. The only assertion this file
 * makes about the oracle is the one we can prove: when the two engines disagree
 * about CONVERGENCE, and ours is the one that converges, the oracle is wrong.
 *
 * What this file DOES assert about us: our plan converges on every fixture.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatReport, runOracle, type Disagreement, type OracleReport } from "./support/oracle.js";
import { ADMIN, serverAvailable } from "./support/db.js";

const T = 240_000;

interface Fixture {
  readonly fixture: string;
  readonly slug: string;
  readonly current: string | null;
  readonly desired: string | null;
  readonly schemas?: readonly string[];
}

const FIXTURES: readonly Fixture[] = [
  // #1 — the reason this whole engine exists (design/06 §1.3)
  {
    fixture: "enum-ordering",
    slug: "pgorm_oracle_enum",
    current: "enum-ordering/current.sql",
    desired: "enum-ordering/desired.sql",
  },
  {
    fixture: "acceptance",
    slug: "pgorm_oracle_acc",
    current: null,
    desired: "acceptance/desired.sql",
  },
  {
    fixture: "evolve",
    slug: "pgorm_oracle_evolve",
    current: "evolve/current.sql",
    desired: "evolve/desired.sql",
  },
  {
    fixture: "multi-schema/up",
    slug: "pgorm_oracle_msu",
    current: null,
    desired: "multi-schema/desired.sql",
    schemas: ["public", "app", "billing"],
  },
  {
    fixture: "multi-schema/down",
    slug: "pgorm_oracle_msd",
    current: "multi-schema/desired.sql",
    desired: null,
    schemas: ["public", "app", "billing"],
  },
];

const reports = new Map<string, OracleReport>();
const all: Disagreement[] = [];

describe("differential oracle — @supabase/pg-delta@1.0.0-alpha.39", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
  }, T);

  afterAll(() => {
    const wrong = all.filter((d) => d.oracleWrong).length;
    const expected = all.filter((d) => d.expected).length;
    console.log(
      `\noracle summary: ${all.length} disagreement(s) across ${reports.size} fixture(s) — ` +
        `${wrong} where the oracle is provably wrong, ${expected} deliberate design differences, ` +
        `${all.length - wrong - expected} open (future test cases)\n`,
    );
  });

  it.each(FIXTURES.map((f) => [f.fixture, f] as const))(
    "fixture %s",
    async (_name, f) => {
      const report = await runOracle(f);
      reports.set(f.fixture, report);
      all.push(...report.disagreements);
      console.log(`\n${formatReport(report)}\n`);

      // The only hard assertion: WE converge. If we do not, we are wrong,
      // whatever the oracle did.
      expect(report.ours.error).toBeUndefined();
      expect(report.ours.residual).toEqual([]);
      expect(report.ours.converged).toBe(true);

      // The oracle's output is recorded, never asserted.
      expect(report.theirs.statements.length).toBeGreaterThanOrEqual(0);
    },
    T,
  );

  it(
    "fixture #1 reproduces the enum-ordering bug that motivated the in-house engine",
    () => {
      const report = reports.get("enum-ordering");
      expect(report, "the enum fixture must have run first").toBeDefined();
      const theirs = report!.theirs;

      // Our engine orders ALTER TYPE … ADD VALUE before every use of the label.
      const oursAddValue = report!.ours.statements.findIndex((s) => /ALTER TYPE .* ADD VALUE/.test(s));
      const oursFirstUse = report!.ours.statements.findIndex(
        (s, i) => i !== oursAddValue && s.includes("'refunded'"),
      );
      expect(oursAddValue).toBeGreaterThanOrEqual(0);
      expect(oursFirstUse).toBeGreaterThan(oursAddValue);

      const theirAddValue = theirs.statements.findIndex((s) => /ALTER TYPE .* ADD VALUE/.test(s));
      const theirFirstUse = theirs.statements.findIndex(
        (s, i) => i !== theirAddValue && s.includes("'refunded'"),
      );
      const misordered = theirAddValue >= 0 && theirFirstUse >= 0 && theirFirstUse < theirAddValue;

      if (!theirs.converged) {
        // The state of the world as of alpha.39 — the bug is live.
        console.log(
          `oracle[enum-ordering] ORACLE-WRONG: pg-delta's plan does not converge` +
            `${misordered ? ` (ALTER TYPE … ADD VALUE is action ${theirAddValue}, first use is action ${theirFirstUse})` : ""}` +
            `\n    ${theirs.error ?? theirs.residual.join(", ")}`,
        );
        expect(report!.disagreements.some((d) => d.axis === "convergence" && d.oracleWrong)).toBe(true);
      } else {
        // If a later alpha fixes it, this is where we find out — the fixture
        // stays, because it is OUR regression test either way.
        console.log("oracle[enum-ordering]: pg-delta now converges on this fixture too");
      }
    },
    T,
  );
});
