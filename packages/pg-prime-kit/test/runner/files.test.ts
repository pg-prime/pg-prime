/**
 * `runner/files.ts` — discovery, ordering, checksums, directives, markers.
 *
 * The oracle for the marker path is the *generator*: a file `renderSql` produced must
 * parse back to the statements the plan says it has, byte for byte after the lexer's
 * canonicalisation. That is a round trip, not an echo — the two sides are written
 * independently and one of them (design/06 §4.2's format) is the reviewed artifact.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executionPlan, findDirectives, parseMigrationSql, readMigrationsDir } from "../../src/runner/files.js";
import { renderSql, type PlanStatement } from "../../src/plan/plan.js";
import { canonicalize, lexSql } from "../../src/sql/statements.js";
import { tempDir } from "../support/migrations.js";

const stmt = (index: number, sql: string, over: Partial<PlanStatement> = {}): PlanStatement => ({
  index,
  sql,
  verb: "create",
  kind: "table",
  produces: [],
  consumes: [],
  destroys: [],
  releases: [],
  transactionality: "transactional",
  lockClass: "accessExclusive",
  idempotent: false,
  timeouts: { lock: "3s", statement: "30s" },
  dataLoss: "none",
  rewrite: false,
  hazards: [],
  ...over,
});

describe("directives", () => {
  it("are the renamed `-- pg-prime:` namespace, in every header line renderSql writes", () => {
    const sql = renderSql({
      id: "0001_x",
      name: "x",
      statements: [stmt(0, "CREATE TABLE public.t (a int)")],
      segments: [{ index: 0, transactional: true, statements: [0] }],
      txmode: "transactional",
      from: "sha256:aa",
      to: "sha256:bb",
      pgMin: 150000,
    });
    expect(sql).not.toContain("pg-orm:");
    const names = findDirectives(sql).map((d) => d.name);
    expect(names).toEqual(["migration", "plan", "from", "to", "txmode", "timeout", "requires-pg", "segment", "stmt"]);
  });

  it("are not recognised inside a dollar-quoted body or a string literal", () => {
    const text = [
      "-- pg-prime:txmode none",
      "-- pg-prime:stmt 0 lock=none idempotent",
      "CREATE FUNCTION f() RETURNS text LANGUAGE sql AS $$ SELECT '-- pg-prime:stmt 7' $$;",
      "",
    ].join("\n");
    const parsed = parseMigrationSql(text, "f.sql");
    expect(parsed.statements).toHaveLength(1);
    expect(parsed.statements[0]!.sql).toContain("$$ SELECT '-- pg-prime:stmt 7' $$");
  });

  it("round-trip: what renderSql writes, parseMigrationSql reads back", () => {
    const statements = [
      stmt(0, "DROP INDEX CONCURRENTLY IF EXISTS public.t_idx", {
        lockClass: "shareUpdateExclusive",
        idempotent: true,
        hazards: ["LK101"],
        timeouts: { lock: "3s", statement: null },
      }),
      stmt(1, "CREATE INDEX CONCURRENTLY t_idx ON public.t USING btree (a)", {
        lockClass: "shareUpdateExclusive",
        idempotent: true,
        timeouts: { lock: "3s", statement: null },
      }),
      stmt(2, "ALTER TABLE public.t ADD COLUMN b text"),
    ];
    const sql = renderSql({
      id: "0007_mixed",
      name: "mixed",
      statements,
      segments: [
        { index: 0, transactional: false, statements: [0, 1] },
        { index: 1, transactional: true, statements: [2] },
      ],
      txmode: "none",
      from: "sha256:aa",
      to: "sha256:bb",
      pgMin: 150000,
    });
    const parsed = parseMigrationSql(sql, "0007_mixed.sql");
    expect(parsed.statementSource).toBe("markers");
    expect(parsed.directives.txmode).toBe("none");
    expect(parsed.directives.migration).toBe("0007_mixed");
    expect(parsed.directives.lockTimeout).toBe("3s");
    expect(parsed.directives.statementTimeout).toBe("per-statement");
    expect(parsed.statements.map((s) => canonicalize(lexSql(s.sql)))).toEqual(statements.map((s) => s.sql));
    expect(parsed.statements.map((s) => [s.lockClass, s.idempotent, s.hazards, s.segment])).toEqual([
      ["shareUpdateExclusive", true, ["LK101"], 0],
      ["shareUpdateExclusive", true, [], 0],
      ["accessExclusive", false, [], 1],
    ]);
  });

  it("falls back to the splitter for a file with no markers, and says so", () => {
    const parsed = parseMigrationSql("CREATE TABLE a (x int);\nCREATE TABLE b (y int);\n", "hand.sql");
    expect(parsed.statementSource).toBe("splitter");
    expect(parsed.statements.map((s) => s.sql)).toEqual(["CREATE TABLE a (x int)", "CREATE TABLE b (y int)"]);
    const diagnostic = parsed.diagnostics.find((d) => d.code === "statements_from_splitter");
    expect(diagnostic?.count).toBe(2);
    expect(diagnostic?.message).toContain("crash resume");
  });

  it("reports a marker whose index is out of order and one with nothing under it", () => {
    const parsed = parseMigrationSql(
      [
        "-- pg-prime:stmt 0 lock=none",
        "SELECT 1;",
        "-- pg-prime:stmt 5 lock=none",
        "SELECT 2;",
        "-- pg-prime:stmt 2 lock=none",
        "",
      ].join("\n"),
      "bad.sql",
    );
    expect(parsed.diagnostics.map((d) => d.code)).toEqual(["stmt_marker_out_of_order", "stmt_marker_empty"]);
  });
});

describe("discovery and ordering", () => {
  it("orders by (seq, name), accepts duplicate seq, and ignores what it cannot name", async () => {
    const dir = join(await tempDir("pgprime-k1-files"), "migrations");
    await mkdir(dir, { recursive: true });
    const body = "-- pg-prime:stmt 0 lock=none idempotent\nSELECT 1;\n";
    for (const name of ["0007_b.sql", "0007_a.sql", "0002_first.sql", "0010_later.sql"]) {
      await writeFile(join(dir, name), body, "utf8");
    }
    await writeFile(join(dir, "README.md"), "not a migration", "utf8");
    await writeFile(join(dir, "no_number.sql"), body, "utf8");
    await writeFile(join(dir, "0003_BadCase.sql"), body, "utf8");

    const { files, diagnostics } = await readMigrationsDir(dir);
    expect(files.map((f) => f.id)).toEqual(["0002_first", "0007_a", "0007_b", "0010_later"]);
    expect(diagnostics.map((d) => d.subject).sort()).toEqual(["0003_BadCase.sql", "no_number.sql"]);
    // sha256 of the bytes, and identical bytes hash identically.
    expect(new Set(files.map((f) => f.checksum)).size).toBe(1);
    expect(files[0]!.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(files.every((f) => f.plan === null && f.planPath === null)).toBe(true);
    expect(files[0]!.diagnostics.some((d) => d.code === "plan_missing")).toBe(true);
  });

  it("a missing directory is an empty one, not a crash", async () => {
    const { files, diagnostics } = await readMigrationsDir("/nonexistent/pgprime/k1");
    expect(files).toEqual([]);
    expect(diagnostics).toEqual([]);
  });
});

describe("executionPlan", () => {
  it("gives a planless txmode-none file one bare segment and per-statement timeouts", () => {
    const parsed = parseMigrationSql(
      [
        "-- pg-prime:txmode none",
        "-- pg-prime:timeout lock=5s statement=0",
        "-- pg-prime:stmt 0 lock=shareUpdateExclusive idempotent",
        "CREATE INDEX CONCURRENTLY i ON t (a);",
        "",
      ].join("\n"),
      "x.sql",
    );
    const exec = executionPlan({
      id: "0001_x",
      seq: 1,
      name: "x",
      path: "x",
      planPath: null,
      checksum: "sha256:0",
      text: "",
      directives: parsed.directives,
      statements: parsed.statements,
      statementSource: parsed.statementSource,
      plan: null,
      txmode: "none",
      diagnostics: [],
    });
    expect(exec.segments).toEqual([{ index: 0, transactional: false, statements: [0] }]);
    expect(exec.statements[0]!.timeouts).toEqual({ lock: "5s", statement: "0" });
    expect(exec.statements[0]!.transactionality).toBe("nonTransactional");
  });
});
