/**
 * `--interactive`'s output, and why it is a patch rather than an edit.
 *
 * design/06 §3.3 wants the prompt to write `.renamedFrom('old')` into the schema source.
 * The DSL records no source location — `ColumnDdl` carries `renamedFrom`, `dbName`, a type
 * and modifiers, and nothing about where it was written — so an in-place edit would have
 * to *find* the declaration by grepping for an identifier and then rewrite somebody's
 * file on the strength of that guess. §3.3 exists to abolish hidden decisions, so the
 * confirmation prints a unified diff and exits 2 instead: same edit, reviewable, and
 * applyable with `patch -p0`.
 *
 * No TTY here, so the prompt itself is not driven; what is pinned is the artifact it
 * produces, plus the rule that a non-TTY run never prompts at all.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renameDiff } from "../../src/cli/interactive.js";

const SOURCE = `import { defineSchema, pgTable, renamedFrom } from 'pg-prime'

export const users = pgTable('users', (t) => ({
  id: t.uuid().primaryKey(),
  fullName: t.text(),
}))

export const orgs = pgTable('orgs', (t) => ({
  id: t.uuid().primaryKey(),
}))

export default defineSchema({ users, orgs })
`;

describe("--interactive writes the annotation as a patch", () => {
  it("locates a column declaration by its DB name AND by its camelCase key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pgprime-k2b-int-"));
    const file = join(dir, "schema.ts");
    await writeFile(file, SOURCE, "utf8");

    const patch = renameDiff(
      [
        {
          type: "rename_or_recreate",
          kind: "column",
          from: "column:public.users.name",
          to: "column:public.users.full_name",
        },
      ],
      [file],
    );

    // `full_name` is declared as `fullName:` — the DB name is derived by the casing
    // strategy, so the search has to fold it back or it finds nothing.
    expect(patch).toContain("-  fullName: t.text(),");
    expect(patch).toContain('+  fullName: t.text().renamedFrom("name"),');
    expect(patch).toContain("@@ -5,1 +5,1 @@");
    expect(patch).toContain("patch -p0");
  });

  it("locates a table, and says so when it cannot find the declaration at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pgprime-k2b-int-"));
    const file = join(dir, "schema.ts");
    await writeFile(file, SOURCE, "utf8");

    const table = renameDiff(
      [{ type: "rename_or_recreate", kind: "table", from: "table:public.organisations", to: "table:public.orgs" }],
      [file],
    );
    expect(table).toContain("-export const orgs = pgTable('orgs', (t) => ({");
    expect(table).toContain('renamedFrom("organisations")');

    const missing = renameDiff(
      [{ type: "rename_or_recreate", kind: "table", from: "table:public.a", to: "table:public.nowhere" }],
      [file],
    );
    // A guess that failed says so, rather than emitting a hunk against the wrong line.
    expect(missing).toContain("# could not locate the declaration of nowhere");
  });
});
