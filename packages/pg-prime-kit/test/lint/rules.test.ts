/**
 * The `06` §3.4 codes that are properties of the FILE, not of a delta — TX101, TX102,
 * TX201, LK103, LK111, DS105 and the `ST101–ST106` style family.
 *
 * Every case here has a NEGATIVE control (test rule R4), because these rules read
 * statement TEXT and the failure mode of a text rule is firing on the near miss: a
 * `CONCURRENTLY` in a non-transactional segment is correct and must stay quiet, a
 * `timestamptz` must not trip ST103, and a `char(3)` inside a string literal is data.
 *
 * The style family is `off` by default. Half of what these tests assert is that it stays
 * that way unless somebody asks.
 */

import { describe, expect, it } from "vitest";
import { PHASE, type Statement, type Transactionality } from "../../src/diff/statement.js";
import { lintPlan } from "../../src/lint/lint.js";
import { planSql } from "../../src/plan/emit.js";
import { buildPlan, type Plan } from "../../src/plan/plan.js";

const stmt = (sql: string, over: Partial<Statement> = {}): Statement => ({
  sql,
  verb: "create",
  kind: "table",
  produces: [],
  consumes: ["table:public.t"],
  destroys: [],
  releases: [],
  transactionality: "transactional",
  lockClass: "accessExclusive",
  idempotent: true,
  dataLoss: "none",
  rewrite: false,
  hazards: [],
  phase: PHASE.createTable,
  ...over,
});

/**
 * `txmode` is DERIVED by `buildPlan` from the segments, so a fixture cannot just declare
 * one: a plan is `none` iff some segment is non-transactional. Both are spelled out here
 * so a test that means "a bare statement in a transactional file" gets exactly that.
 */
const planOf = (statements: readonly Statement[], transactional = true): Plan =>
  buildPlan({
    seq: 1,
    name: "rules_fixture",
    statements,
    segments: [{ index: 0, transactional, statements: statements.map((_, i) => i) }],
    fromFingerprint: "sha256:aaa",
    toFingerprint: "sha256:bbb",
    pgVersionNum: 170011,
    renames: [],
    diagnostics: [],
  });

const codes = (plan: Plan, options?: Parameters<typeof lintPlan>[2]): string[] =>
  lintPlan(plan, planSql(plan), { failOn: "warn", ...options }).findings.map((f) => f.code);

const NON_TX: Transactionality = "nonTransactional";

describe("TX101/TX102 — a non-transactional statement needs its own segment", () => {
  const CIC = 'CREATE INDEX CONCURRENTLY "t_a_idx" ON "public"."t" USING btree (a)';

  it("fires when a bare statement sits inside a transactional segment", () => {
    // `transactional: true` with a `nonTransactional` statement is precisely the framing
    // bug: `buildPlan` reads the SEGMENT, so the file says transactional while the
    // statement cannot be.
    const plan = planOf([stmt(CIC, { transactionality: NON_TX, kind: "index" })], true);
    expect(plan.txmode).toBe("transactional");
    expect(codes(plan)).toEqual(expect.arrayContaining(["TX101", "TX102", "LK103"]));
  });

  it("negative control: the same statement in a bare segment is silent", () => {
    const plan = planOf([stmt(CIC, { transactionality: NON_TX, kind: "index" })], false);
    expect(plan.txmode).toBe("none");
    expect(codes(plan)).not.toContain("TX101");
    expect(codes(plan)).not.toContain("TX102");
    // LK103 too: CONCURRENTLY is only a hazard when something wraps it in a transaction.
    expect(codes(plan)).not.toContain("LK103");
  });
});

describe("TX201 — every statement in a txmode-none file must be re-runnable", () => {
  const CREATE = 'CREATE TABLE "public"."t" ("a" integer)';

  it("fires on a non-idempotent statement in a bare segment", () => {
    const plan = planOf([stmt(CREATE, { idempotent: false, transactionality: NON_TX })], false);
    expect(codes(plan)).toContain("TX201");
  });

  it("negative control: the idempotent spelling of the same statement is silent", () => {
    const plan = planOf([
      stmt('CREATE TABLE IF NOT EXISTS "public"."t" ("a" integer)', {
        idempotent: true,
        transactionality: NON_TX,
      }),
    ], false);
    expect(codes(plan)).not.toContain("TX201");
  });

  it("negative control: a non-idempotent statement in a TRANSACTIONAL file is fine", () => {
    // A transaction rolls it back, so re-execution starts from the same state — which is
    // exactly why TX201 is scoped to `txmode none` (design/06 §5.4) and not global.
    const plan = planOf([stmt(CREATE, { idempotent: false })], true);
    expect(codes(plan)).not.toContain("TX201");
  });
});

describe("LK111 / DS105 — the Tier-R objects the differ never sees", () => {
  it("LK111 fires on CREATE TRIGGER and not on CREATE INDEX", () => {
    const trigger = planOf([
      stmt('CREATE TRIGGER "t_bump" BEFORE UPDATE ON "public"."t" FOR EACH ROW EXECUTE FUNCTION bump()'),
    ]);
    expect(codes(trigger)).toContain("LK111");
    expect(codes(planOf([stmt('CREATE INDEX "t_a_idx" ON "public"."t" (a)')]))).not.toContain("LK111");
  });

  it("DS105 fires on DROP MATERIALIZED VIEW and not on DROP VIEW", () => {
    expect(codes(planOf([stmt('DROP MATERIALIZED VIEW "public"."mv"', { verb: "drop" })]))).toContain("DS105");
    expect(codes(planOf([stmt('DROP VIEW "public"."v"', { verb: "drop" })]))).not.toContain("DS105");
  });

  it("a word inside a string literal is data, not a statement", () => {
    // `codeMask` blanks literals before any of these regexes run. Without it, seeding a
    // row whose text mentions a trigger would report LK111 on an INSERT.
    const plan = planOf([
      stmt(`INSERT INTO "public"."t" (note) VALUES ('CREATE TRIGGER / DROP MATERIALIZED VIEW')`),
    ]);
    expect(codes(plan)).not.toContain("LK111");
    expect(codes(plan)).not.toContain("DS105");
  });
});

describe("ST101–ST106 are opt-in (design/06 §3.4: default off)", () => {
  const SERIAL = planOf([stmt('CREATE TABLE "public"."t" ("id" serial PRIMARY KEY)')]);

  it("is silent by default and speaks when asked", () => {
    expect(codes(SERIAL)).toEqual([]);
    expect(codes(SERIAL, { style: true })).toContain("ST101");
    // `--rules ST101` implies the family: selecting a code that can never be produced
    // would exit 0 and read as "the rule passed".
    expect(codes(SERIAL, { rules: ["ST101"] })).toEqual(["ST101"]);
  });

  it("style findings are warn, so the default --fail-on stays green", () => {
    const result = lintPlan(SERIAL, planSql(SERIAL), { style: true });
    expect(result.findings.map((f) => f.severity)).toEqual(
      result.findings.map(() => "warn"),
    );
    expect(result.exitCode).toBe(0);
  });

  it("each rule fires on its own case and not on the fixed one", () => {
    const fire = (sql: string): string[] => codes(planOf([stmt(sql)]), { style: true });
    expect(fire('CREATE TABLE "public"."t" ("id" bigserial)')).toContain("ST101");
    expect(fire('CREATE TABLE "public"."t" ("id" bigint GENERATED ALWAYS AS IDENTITY)')).not.toContain("ST101");

    expect(fire('CREATE TABLE "public"."t" ("c" character(3))')).toContain("ST102");
    expect(fire('CREATE TABLE "public"."t" ("c" text)')).not.toContain("ST102");

    expect(fire('CREATE TABLE "public"."t" ("at" timestamp)')).toContain("ST103");
    expect(fire('CREATE TABLE "public"."t" ("at" timestamp with time zone)')).not.toContain("ST103");

    expect(fire('CREATE TABLE "public"."t" ("id" integer PRIMARY KEY)')).toContain("ST104");
    expect(fire('CREATE TABLE "public"."t" ("id" bigint PRIMARY KEY)')).not.toContain("ST104");

    const long = "x".repeat(64);
    expect(fire(`CREATE INDEX "${long}" ON "public"."t" (a)`)).toContain("ST105");
    expect(fire(`CREATE INDEX "${"x".repeat(63)}" ON "public"."t" (a)`)).not.toContain("ST105");

    expect(fire('ALTER TABLE t ADD COLUMN "a" integer')).toContain("ST106");
    expect(fire('ALTER TABLE "public"."t" ADD COLUMN "a" integer')).not.toContain("ST106");
  });
});
