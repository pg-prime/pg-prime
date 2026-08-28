/**
 * What `-- pg-prime:nolint` is allowed to silence, and where.
 *
 * Every bug this file guards is a suppression that should not have been honoured:
 * a directive with no reason (unreviewable — design/06 §3.4 makes the reason mandatory
 * for exactly that reason), a directive that is really a string literal in an `INSERT`,
 * a directive in a `$$ … $$` function body, and a per-statement directive silently
 * widening to file-wide because the `-- pg-orm:stmt N` marker above it was not
 * recognised after the namespace rename (design/11 §1.1).
 */

import { describe, expect, it } from "vitest";
import { parseNolint } from "../../src/lint/lint.js";

describe("nolint scope follows the stmt markers", () => {
  it("binds a directive to the marker above it, and leaves header directives file-wide", () => {
    const { directives, errors } = parseNolint(
      [
        "-- pg-prime:migration 0007_x",
        '-- pg-prime:nolint ST103 "the whole file predates timestamptz"',
        "",
        "-- pg-prime:stmt 0 lock=shareUpdateExclusive hazards=LK101",
        'CREATE INDEX a ON t (c); -- pg-prime:nolint LK101 "200-row lookup table"',
        "",
        "-- pg-prime:stmt 4 lock=accessExclusive hazards=LK107",
        '-- pg-prime:nolint LK107 "table is empty in every environment"',
        "ALTER TABLE t ALTER COLUMN c SET NOT NULL;",
      ].join("\n"),
    );

    expect(errors).toEqual([]);
    expect(directives).toEqual([
      { code: "ST103", reason: "the whole file predates timestamptz", line: 2, statement: null },
      { code: "LK101", reason: "200-row lookup table", line: 5, statement: 0 },
      // 4, not 2: the index comes from the marker, not from counting markers.
      { code: "LK107", reason: "table is empty in every environment", line: 8, statement: 4 },
    ]);
  });

  it("accepts the legacy `pg-orm:` prefix that renderSql still writes", () => {
    const { directives, errors } = parseNolint(
      ['-- pg-orm:stmt 2 lock=accessExclusive', '-- pg-orm:nolint DS103 "column is dead"'].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(directives).toEqual([{ code: "DS103", reason: "column is dead", line: 2, statement: 2 }]);
  });

  it("does not treat an unrelated comment as a directive", () => {
    const { directives, errors } = parseNolint(
      ["-- nolint LK101 \"no namespace\"", "-- pgprime:nolint LK101 \"wrong namespace\"", "-- pg-prime:nolinting LK101 \"not the verb\""].join("\n"),
    );
    expect(directives).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("a directive that is not a comment is not a directive", () => {
  const CODE = '-- pg-prime:nolint LK101 "genuinely a directive"';

  it("ignores one inside a string literal, and honours the identical text as a comment", () => {
    const inLiteral = parseNolint(
      ["-- pg-prime:stmt 0 lock=rowExclusive", `INSERT INTO audit(note) VALUES ('${CODE}');`].join("\n"),
    );
    expect(inLiteral.directives).toEqual([]);
    expect(inLiteral.errors).toEqual([]);

    const asComment = parseNolint(["-- pg-prime:stmt 0 lock=rowExclusive", CODE].join("\n"));
    expect(asComment.directives.map((d) => d.code)).toEqual(["LK101"]);
  });

  it("ignores one inside a dollar-quoted body, and honours the identical text outside it", () => {
    const body = [
      "-- pg-prime:stmt 0 lock=accessExclusive",
      "CREATE FUNCTION f() RETURNS void AS $body$",
      CODE,
      "BEGIN END;",
      "$body$ LANGUAGE plpgsql;",
    ].join("\n");
    expect(parseNolint(body).directives).toEqual([]);

    const outside = `${body}\n${CODE}`;
    expect(parseNolint(outside).directives.map((d) => [d.code, d.statement])).toEqual([["LK101", 0]]);
  });

  it("ignores one that has been commented out with a block comment", () => {
    expect(parseNolint(`/* ${CODE} */`).directives).toEqual([]);
    expect(parseNolint(CODE).directives).toHaveLength(1);
  });
});

describe("an unreviewable suppression is an error, not a suppression", () => {
  const errorsFor = (line: string): readonly string[] => parseNolint(line).errors.map((e) => e.message);

  it("rejects a missing reason, an empty reason and a whitespace reason", () => {
    expect(parseNolint("-- pg-prime:nolint").directives).toEqual([]);
    expect(errorsFor("-- pg-prime:nolint")[0]).toMatch(/needs a code and a quoted reason/);
    expect(errorsFor("-- pg-prime:nolint LK101")[0]).toMatch(/has no reason/);
    expect(errorsFor('-- pg-prime:nolint LK101 ""')[0]).toMatch(/reason is empty/);
    expect(errorsFor('-- pg-prime:nolint LK101 "   "')[0]).toMatch(/reason is empty/);
    expect(errorsFor("-- pg-prime:nolint LK101 not quoted")[0]).toMatch(/double-quoted/);
    // …and the near-miss that must NOT be an error
    expect(parseNolint('-- pg-prime:nolint LK101 "why"').errors).toEqual([]);
  });

  it("rejects a code that is not a code, and reports the offending line verbatim", () => {
    const { directives, errors } = parseNolint(['-- pg-prime:nolint "just a reason"'].join("\n"));
    expect(directives).toEqual([]);
    expect(errors).toEqual([
      { line: 1, text: '-- pg-prime:nolint "just a reason"', message: expect.stringMatching(/is not a hazard code/) },
    ]);
    // A comma-joined code list is not a supported spelling and must not silently
    // suppress only the first code.
    expect(errorsFor('-- pg-prime:nolint LK101,LK102 "both"')[0]).toMatch(/is not a hazard code|double-quoted/);
  });

  it("keeps the reason's escaped quotes", () => {
    expect(parseNolint('-- pg-prime:nolint LK101 "the \\"lookup\\" table"').directives[0]?.reason).toBe(
      'the "lookup" table',
    );
  });
});
