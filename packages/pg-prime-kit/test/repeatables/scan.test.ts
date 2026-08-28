/**
 * What the scan promises the rest of the pass, pinned as values rather than as prose.
 *
 * Three of these assertions are the whole reason the module exists:
 *   - the exact ORDER, because `030_views/x.sql` depends on `020_functions/y.sql` and a walk
 *     that visits directories before files runs a top-level `015_prep.sql` last;
 *   - the exact PATH spelling, because it is the `pgprime.repeatables` primary key and a
 *     changed spelling silently re-applies every repeatable in the project;
 *   - that a `-- pg-prime:` line below the first statement is NOT a file-level directive.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "../../src/ir/hash.js";
import { planRepeatables } from "../../src/repeatables/plan.js";
import { parseDirectives, scanRepeatables } from "../../src/repeatables/scan.js";

let tmp = "";
/** The scanned root is called `sql` so the default prefix is the one `06` §4.3 records. */
const sqlDir = (): string => join(tmp, "sql");

async function write(rel: string, text: string): Promise<void> {
  const abs = join(sqlDir(), rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, text, "utf8");
}

const VIEW = "CREATE OR REPLACE VIEW public.v AS SELECT 1 AS n;\n";

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pgprime-k3-rep-scan-"));
  // `015_prep.sql` sits BETWEEN two directories in one lexicographic sort, and `nested/`
  // sits between two files: those two facts are the ordering rule.
  await write("010_types/a.sql", VIEW);
  await write("010_types/nested/z.sql", VIEW);
  await write("010_types/zz.sql", VIEW);
  await write("015_prep.sql", VIEW);
  await write("020_functions/b.sql", VIEW);
  await write("030_views/c.sql", VIEW);
  await write("notes.md", "not sql\n");
});

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

const ORDERED = [
  "sql/010_types/a.sql",
  "sql/010_types/nested/z.sql",
  "sql/010_types/zz.sql",
  "sql/015_prep.sql",
  "sql/020_functions/b.sql",
  "sql/030_views/c.sql",
];

describe("scanRepeatables", () => {
  it("is directory-lexicographic, with files and directories in one sort", async () => {
    const files = await scanRepeatables(sqlDir());
    expect(files.map((f) => f.path)).toEqual(ORDERED);
  });

  it("takes only .sql files", async () => {
    const files = await scanRepeatables(sqlDir());
    expect(files.some((f) => f.path.endsWith(".md"))).toBe(false);
  });

  it("prefixes with the directory's own name, and always with POSIX separators", async () => {
    const files = await scanRepeatables(sqlDir());
    expect(files[0]?.path).toBe("sql/010_types/a.sql");
    expect(files.some((f) => f.path.includes("\\"))).toBe(false);
    // absPath is the host's spelling; path never is
    expect(files[0]?.absPath).toBe(join(sqlDir(), "010_types", "a.sql"));
  });

  it("honours an explicit pathPrefix, including the empty one", async () => {
    const nested = await scanRepeatables(sqlDir(), { pathPrefix: "db/sql" });
    expect(nested.map((f) => f.path)).toEqual(ORDERED.map((p) => p.replace(/^sql\//, "db/sql/")));

    const bare = await scanRepeatables(sqlDir(), { pathPrefix: "" });
    // no leading slash: an empty prefix must not turn `path` into an absolute-looking key
    expect(bare.map((f) => f.path)).toEqual(ORDERED.map((p) => p.replace(/^sql\//, "")));
  });

  it("a missing directory is an empty pass, not a throw", async () => {
    // a project with no repeatables is legal (design/06 §4.1)
    await expect(scanRepeatables(join(tmp, "no-such-dir"))).resolves.toEqual([]);
  });

  it("hashes the bytes, in the IR's spelling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pgprime-k3-rep-hash-"));
    try {
      const file = join(dir, "one.sql");
      await writeFile(file, "CREATE OR REPLACE VIEW v AS SELECT 1;\n", "utf8");
      const before = await scanRepeatables(dir);
      expect(before[0]?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(before[0]?.sha256).toBe(sha256("CREATE OR REPLACE VIEW v AS SELECT 1;\n"));

      // one byte of difference — and nothing else about the file changes
      await writeFile(file, "CREATE OR REPLACE VIEW v AS SELECT 2;\n", "utf8");
      const after = await scanRepeatables(dir);
      expect(after[0]?.path).toBe(before[0]?.path);
      expect(after[0]?.sha256).not.toBe(before[0]?.sha256);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("splits with the lexer, so a `;` inside a body is not a boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pgprime-k3-rep-split-"));
    try {
      await writeFile(
        join(dir, "fn.sql"),
        [
          "CREATE OR REPLACE FUNCTION public.bump() RETURNS int LANGUAGE plpgsql AS $$",
          "BEGIN",
          "  -- a comment; with a semicolon",
          "  RETURN 1;",
          "END;",
          "$$;",
          "CREATE OR REPLACE VIEW public.v AS SELECT 1;",
        ].join("\n"),
        "utf8",
      );
      const files = await scanRepeatables(dir);
      expect(files[0]?.statements).toHaveLength(2);
      // the body is kept byte-for-byte: PostgreSQL stores prosrc verbatim
      expect(files[0]?.statements[0]).toContain("-- a comment; with a semicolon");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseDirectives", () => {
  const HEADER = [
    "-- pg-prime:owner analytics",
    "--",
    "  -- pg-prime:nolint TX201 \"generated by the reporting tool\"",
    "",
    "-- an ordinary comment",
    "-- pg-prime:checkpoint",
    "CREATE OR REPLACE VIEW public.v AS SELECT 1;",
    "-- pg-prime:owner someone-else",
  ].join("\n");

  it("reads name, value and 1-based line from the header block", () => {
    expect(parseDirectives(HEADER)).toEqual([
      { name: "owner", value: "analytics", line: 1 },
      { name: "nolint", value: 'TX201 "generated by the reporting tool"', line: 3 },
      { name: "checkpoint", value: "", line: 6 },
    ]);
  });

  it("stops at the first statement", () => {
    // the eighth line is a `-- pg-prime:` line and must NOT be a file-level directive:
    // a directive describes the file, and only the header can
    expect(parseDirectives(HEADER).some((d) => d.value === "someone-else")).toBe(false);
  });

  it("survives CRLF and an empty file", () => {
    expect(parseDirectives("-- pg-prime:txmode none\r\nSELECT 1;\r\n")).toEqual([
      { name: "txmode", value: "none", line: 1 },
    ]);
    expect(parseDirectives("")).toEqual([]);
  });

  it("is reported on the scanned file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pgprime-k3-rep-dir-"));
    try {
      await writeFile(join(dir, "v.sql"), HEADER, "utf8");
      const files = await scanRepeatables(dir);
      expect(files[0]?.directives.map((d) => d.name)).toEqual(["owner", "nolint", "checkpoint"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("planRepeatables", () => {
  it("splits on the recorded hash and reports orphans", async () => {
    const scanned = await scanRepeatables(sqlDir());
    const unchangedFile = scanned[0]!; // sql/010_types/a.sql
    const changedFile = scanned[1]!; // sql/010_types/nested/z.sql

    const applied = new Map<string, string>([
      [unchangedFile.path, unchangedFile.sha256],
      [changedFile.path, "sha256:0000000000000000000000000000000000000000000000000000000000000000"],
      // recorded, deleted from disk: `06` §2.2 — removal is not auto-detected, it is reported
      ["sql/999_gone/removed.sql", "sha256:1111111111111111111111111111111111111111111111111111111111111111"],
      ["sql/000_also_gone.sql", "sha256:2222222222222222222222222222222222222222222222222222222222222222"],
    ]);

    const plan = await planRepeatables(sqlDir(), applied);
    expect(plan.unchanged.map((f) => f.path)).toEqual([unchangedFile.path]);
    // everything not recorded with a matching hash, still in scan order
    expect(plan.toApply.map((f) => f.path)).toEqual(ORDERED.filter((p) => p !== unchangedFile.path));
    expect(plan.orphaned).toEqual(["sql/000_also_gone.sql", "sql/999_gone/removed.sql"]);
  });

  it("an empty history applies everything, and an empty tree plans nothing", async () => {
    const all = await planRepeatables(sqlDir(), new Map());
    expect(all.toApply.map((f) => f.path)).toEqual(ORDERED);
    expect(all.unchanged).toEqual([]);
    expect(all.orphaned).toEqual([]);

    const none = await planRepeatables(join(tmp, "no-such-dir"), new Map([["sql/x.sql", "sha256:x"]]));
    expect(none.toApply).toEqual([]);
    expect(none.orphaned).toEqual(["sql/x.sql"]);
  });
});
