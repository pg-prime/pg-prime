/**
 * What makes `migrate lint` exit 3, and — the harder half — what must not.
 *
 * The bugs guarded here are all "the gate was open": a `--fail-on error` run that let a
 * `warn` past *and* a run that failed on one anyway; a destructive change that reached
 * CI green without the design/06 §3.6 acknowledgement; a `nolint` for statement 0 that
 * quietly silenced the same code on statement 1; and `--rules` that filtered a code out
 * of the report but not out of the exit code.
 *
 * Plans are built with the real `buildPlan`, from real `Statement`s, and linted against
 * the real `planSql` bytes — a hand-written `Plan` literal would let this file keep
 * passing after the plan shape moved underneath it.
 */

import { describe, expect, it } from "vitest";
import { PHASE, type Statement } from "../../src/diff/statement.js";
import { formatFindings, lintPlan, unusedDirectives, type LintResult } from "../../src/lint/lint.js";
import { planSql } from "../../src/plan/emit.js";
import { buildPlan, type AcknowledgeInput, type Plan } from "../../src/plan/plan.js";

const CREATE_INDEX: Statement = {
  sql: 'CREATE INDEX "users_email_idx" ON "public"."users" USING btree (email)',
  verb: "create",
  kind: "index",
  produces: ["index:public.users_email_idx"],
  consumes: ["table:public.users"],
  destroys: [],
  releases: [],
  transactionality: "transactional",
  lockClass: "accessExclusive",
  idempotent: false,
  dataLoss: "none",
  rewrite: false,
  hazards: ["LK101"],
  phase: PHASE.createIndex,
};

/** The same LK101 on a different statement — the near-miss a per-statement nolint must not reach. */
const CREATE_INDEX_ORDERS: Statement = {
  ...CREATE_INDEX,
  sql: 'CREATE INDEX "orders_status_idx" ON "public"."orders" USING btree (status)',
  produces: ["index:public.orders_status_idx"],
  consumes: ["table:public.orders"],
};

const ADD_NOT_NULL_COLUMN: Statement = {
  sql: 'ALTER TABLE "public"."users" ADD COLUMN "tier" text NOT NULL',
  verb: "alter",
  kind: "column",
  produces: ["column:public.users.tier"],
  consumes: ["table:public.users"],
  destroys: [],
  releases: [],
  transactionality: "transactional",
  lockClass: "accessExclusive",
  idempotent: false,
  dataLoss: "none",
  rewrite: false,
  hazards: ["MF103"],
  phase: PHASE.addColumn,
};

/** Byte-identical but for the hazard: the negative control for the MF103 case. */
const ADD_NULLABLE_COLUMN: Statement = { ...ADD_NOT_NULL_COLUMN, hazards: [] };

const DROP_COLUMN: Statement = {
  sql: 'ALTER TABLE "public"."users" DROP COLUMN IF EXISTS "legacy_id"',
  verb: "drop",
  kind: "column",
  produces: [],
  consumes: ["table:public.users"],
  destroys: ["column:public.users.legacy_id"],
  releases: [],
  transactionality: "transactional",
  lockClass: "accessExclusive",
  idempotent: true,
  dataLoss: "destructive",
  rewrite: false,
  hazards: ["DS103"],
  phase: PHASE.dropColumn,
};

const LEGACY_ID = "column:public.users.legacy_id";

const planOf = (statements: readonly Statement[], acknowledge?: AcknowledgeInput): Plan =>
  buildPlan({
    seq: 7,
    name: "lint_fixture",
    statements,
    segments: [{ index: 0, transactional: true, statements: statements.map((_, i) => i) }],
    fromFingerprint: "sha256:aaa",
    toFingerprint: "sha256:bbb",
    pgVersionNum: 170011,
    renames: [],
    diagnostics: [],
    proof: { status: "passed", at: "2026-08-26T00:00:00.000Z" },
    ...(acknowledge === undefined ? {} : { acknowledge }),
  });

/** Insert a line straight after the `stmt N` marker, whichever namespace wrote it. */
const afterStmt = (sql: string, index: number, line: string): string => {
  const marker = new RegExp(`^-- pg-(?:orm|prime):stmt ${String(index)}\\b`);
  return sql
    .split("\n")
    .flatMap((l) => (marker.test(l) ? [l, line] : [l]))
    .join("\n");
};

/** Insert into the header block, before any `stmt` marker — i.e. file-wide scope. */
const inHeader = (sql: string, line: string): string => {
  const lines = sql.split("\n");
  return [lines[0] ?? "", line, ...lines.slice(1)].join("\n");
};

describe("--fail-on decides which severities are fatal", () => {
  const plan = planOf([CREATE_INDEX]);
  const sql = planSql(plan);

  it("a warn-severity LK code fires at --fail-on warn and is clean at --fail-on error", () => {
    const warn = lintPlan(plan, sql, { failOn: "warn" });
    expect(warn.findings.map((f) => [f.code, f.severity, f.statement])).toEqual([["LK101", "warn", 0]]);
    expect(warn.exitCode).toBe(3);

    // Same plan, same bytes: only the threshold moved.
    const strict = lintPlan(plan, sql, { failOn: "error" });
    expect(strict.findings.map((f) => f.code)).toEqual(["LK101"]);
    expect(strict.exitCode).toBe(0);
    expect(lintPlan(plan, sql).exitCode).toBe(0); // "error" is the default
    expect(lintPlan(plan, sql, { failOn: "off" }).exitCode).toBe(0);
  });

  it("an error-severity MF code exits 3, and the same statement without it exits 0", () => {
    const hazardous = planOf([ADD_NOT_NULL_COLUMN]);
    const dirty = lintPlan(hazardous, planSql(hazardous));
    expect(dirty.findings.map((f) => [f.code, f.severity])).toEqual([["MF103", "error"]]);
    expect(dirty.exitCode).toBe(3);

    const clean = planOf([ADD_NULLABLE_COLUMN]);
    const quiet = lintPlan(clean, planSql(clean));
    expect(quiet.findings).toEqual([]);
    expect(quiet.exitCode).toBe(0);
  });

  it("re-derives severity instead of trusting the plan's own field", () => {
    // A plan written by an older engine — or edited by hand — claiming MF103 is advisory.
    // MF, not DS, so nothing but the severity can produce the exit 3.
    const doctored: Plan = {
      ...plan,
      hazards: [
        {
          code: "MF103",
          severity: "warn",
          statement: 0,
          subject: "column:public.users.tier",
          message: "downgraded by hand",
          acknowledged: true,
        },
      ],
    };
    const result = lintPlan(doctored, sql, { failOn: "error" });
    expect(result.findings[0]?.severity).toBe("error");
    expect(result.exitCode).toBe(3);
  });
});

describe("design/06 §3.6 — a DS hazard needs its subject acknowledged", () => {
  // `--fail-on off` isolates the gate: nothing else here can produce an exit 3, so an
  // exit 3 is the data-loss gate and only the data-loss gate.
  const lintOff = (ack?: AcknowledgeInput): LintResult => {
    const plan = planOf([DROP_COLUMN], ack);
    return lintPlan(plan, planSql(plan), { failOn: "off" });
  };

  it("fails an unacknowledged DS103 even at --fail-on off", () => {
    const result = lintOff();
    expect(result.findings.map((f) => [f.code, f.acknowledged])).toEqual([["DS103", false]]);
    expect(result.exitCode).toBe(3);
  });

  it("passes once the subject is in acknowledged.dataLoss", () => {
    const result = lintOff({ dataLoss: [LEGACY_ID], by: "yohocx", reason: "removed from API in v3" });
    expect(result.findings.map((f) => [f.code, f.acknowledged])).toEqual([["DS103", true]]);
    expect(result.exitCode).toBe(0);
  });

  it("is not fooled by an acknowledgement for a different subject", () => {
    const result = lintOff({ dataLoss: ["column:public.users.nickname"], by: "yohocx", reason: "wrong column" });
    expect(result.findings[0]?.acknowledged).toBe(false);
    expect(result.exitCode).toBe(3);
  });

  it("passes under a blanket --allow-data-loss", () => {
    const result = lintOff({ allowDataLoss: true });
    expect(result.findings[0]?.acknowledged).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("reports an acknowledged DS103 but does not fail on it", () => {
    // design/06 §3.6: "`migrate lint` fails on any DS-class hazard whose subject is NOT
    // in `acknowledged.dataLoss`". The acknowledgement lands in `.plan.json`, so it is a
    // diff line a reviewer already argued with — re-failing on it would make
    // `--allow-data-loss` unable to produce a green lint, which is the whole point of
    // recording one. The finding is still REPORTED; only the exit code softens.
    const plan = planOf([DROP_COLUMN], { dataLoss: [LEGACY_ID], by: "yohocx", reason: "v3" });
    const result = lintPlan(plan, planSql(plan));
    expect(result.findings.map((f) => [f.code, f.acknowledged])).toContainEqual(["DS103", true]);
    expect(result.exitCode).toBe(0);
  });
});

describe("nolint scope is the statement it sits under", () => {
  const plan = planOf([CREATE_INDEX, CREATE_INDEX_ORDERS]);
  const sql = planSql(plan);
  const REASON = "200-row lookup table";

  it("suppresses statement 0 and leaves the same code on statement 1 fatal", () => {
    const result = lintPlan(plan, afterStmt(sql, 0, `-- pg-prime:nolint LK101 "${REASON}"`), { failOn: "warn" });
    expect(result.findings.map((f) => [f.statement, f.suppressedBy])).toEqual([
      [0, REASON],
      [1, null],
    ]);
    // Suppression removes the finding from the exit code, not from the report.
    expect(result.findings.map((f) => f.severity)).toEqual(["warn", "warn"]);
    expect(result.exitCode).toBe(3);
  });

  it("goes clean once statement 1 is suppressed too", () => {
    const both = afterStmt(
      afterStmt(sql, 0, `-- pg-prime:nolint LK101 "${REASON}"`),
      1,
      '-- pg-prime:nolint LK101 "same"',
    );
    const result = lintPlan(plan, both, { failOn: "warn" });
    expect(result.findings.map((f) => f.suppressedBy)).toEqual([REASON, "same"]);
    expect(result.exitCode).toBe(0);
  });

  it("a header nolint covers every occurrence, and a different code covers none", () => {
    const fileWide = lintPlan(plan, inHeader(sql, `-- pg-prime:nolint LK101 "${REASON}"`), { failOn: "warn" });
    expect(fileWide.directives).toEqual([{ code: "LK101", reason: REASON, line: 2, statement: null }]);
    expect(fileWide.findings.map((f) => f.suppressedBy)).toEqual([REASON, REASON]);
    expect(fileWide.exitCode).toBe(0);

    const wrongCode = lintPlan(plan, inHeader(sql, '-- pg-prime:nolint LK102 "wrong code"'), { failOn: "warn" });
    expect(wrongCode.findings.map((f) => f.suppressedBy)).toEqual([null, null]);
    expect(wrongCode.exitCode).toBe(3);
  });

  it("prefers the per-statement reason over the header one", () => {
    const text = afterStmt(
      inHeader(sql, '-- pg-prime:nolint LK101 "blanket"'),
      0,
      '-- pg-prime:nolint LK101 "this one specifically"',
    );
    const result = lintPlan(plan, text, { failOn: "warn" });
    expect(result.findings.map((f) => f.suppressedBy)).toEqual(["this one specifically", "blanket"]);
  });

  it("reports a directive that suppressed nothing without failing on it", () => {
    const result = lintPlan(plan, inHeader(sql, '-- pg-prime:nolint TX201 "not in this plan"'), { failOn: "warn" });
    expect(result.exitCode).toBe(3); // the two LK101s are still live
    expect(unusedDirectives(result).map((d) => d.code)).toEqual(["TX201"]);

    const used = lintPlan(plan, inHeader(sql, `-- pg-prime:nolint LK101 "${REASON}"`), { failOn: "warn" });
    expect(unusedDirectives(used)).toEqual([]);
  });
});

describe("a malformed nolint is itself a lint failure", () => {
  // A plan with no hazards at all: the only thing that can fail is the directive.
  const plan = planOf([ADD_NULLABLE_COLUMN]);
  const sql = planSql(plan);

  it("fails on a nolint with no reason, and passes with one", () => {
    const bare = lintPlan(plan, afterStmt(sql, 0, "-- pg-prime:nolint MF103"));
    expect(bare.findings).toEqual([]);
    expect(bare.directiveErrors.map((e) => e.text)).toEqual(["-- pg-prime:nolint MF103"]);
    expect(bare.exitCode).toBe(3);

    const reasoned = lintPlan(plan, afterStmt(sql, 0, '-- pg-prime:nolint MF103 "the table is created empty"'));
    expect(reasoned.directiveErrors).toEqual([]);
    expect(reasoned.exitCode).toBe(0);
  });

  it("fails on an empty reason, which is the same evasion with two more keystrokes", () => {
    const empty = lintPlan(plan, afterStmt(sql, 0, '-- pg-prime:nolint MF103 ""'));
    expect(empty.directiveErrors).toHaveLength(1);
    expect(empty.exitCode).toBe(3);
    expect(empty.directives).toEqual([]);
  });
});

describe("--rules narrows the report and the exit code together", () => {
  const plan = planOf([CREATE_INDEX, ADD_NOT_NULL_COLUMN, DROP_COLUMN]);
  const sql = planSql(plan);

  it("keeps only the named code, including for the DS gate", () => {
    const only = lintPlan(plan, sql, { rules: ["LK101"], failOn: "warn" });
    expect(only.findings.map((f) => f.code)).toEqual(["LK101"]);
    // The unacknowledged DS103 is out of scope for this run, so it cannot fail it.
    expect(lintPlan(plan, sql, { rules: ["LK101"] }).exitCode).toBe(0);

    // Negative control: unfiltered, the same plan and bytes report all three and exit 3.
    const all = lintPlan(plan, sql);
    expect(all.findings.map((f) => f.code)).toEqual(["LK101", "MF103", "DS103"]);
    expect(all.exitCode).toBe(3);
    // An empty `rules` is "no filter", not "no rules".
    expect(lintPlan(plan, sql, { rules: [] }).findings).toHaveLength(3);
  });
});

describe("formatFindings", () => {
  const plan = planOf([CREATE_INDEX, CREATE_INDEX_ORDERS]);
  const sql = afterStmt(planSql(plan), 0, '-- pg-prime:nolint LK101 "200-row lookup table"');
  const result = lintPlan(plan, sql, { failOn: "warn" });

  it("prints one line per finding, with suppressed ones marked", () => {
    expect(formatFindings(result, "text").split("\n")).toEqual([
      'suppressed warn LK101 [stmt 0] index:public.users_email_idx: LK101 on: CREATE INDEX "users_email_idx" ON "public"."users" USING btree (email)',
      'warn LK101 [stmt 1] index:public.orders_status_idx: LK101 on: CREATE INDEX "orders_status_idx" ON "public"."orders" USING btree (status)',
    ]);
  });

  it("prints malformed directives too, so an exit 3 is never silent", () => {
    const broken = lintPlan(plan, afterStmt(planSql(plan), 1, "-- pg-prime:nolint LK101"), { failOn: "off" });
    expect(broken.exitCode).toBe(3);
    expect(formatFindings(broken, "text").split("\n")[0]).toMatch(
      /^error nolint \[line \d+] -- pg-prime:nolint LK101: /,
    );
  });

  it("round-trips through json", () => {
    expect(JSON.parse(formatFindings(result, "json")) as unknown).toEqual(result);
    expect(formatFindings(result, "json")).toContain('\n  "findings": [');
  });
});
