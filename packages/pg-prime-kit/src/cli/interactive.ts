/**
 * `--interactive`'s output: the annotation edit, as a unified diff.
 *
 * design/06 §3.3 wants the prompt to *write* `.renamedFrom('old')` into the schema source.
 * The DSL does not record where anything was declared — `ColumnDdl` has `renamedFrom`,
 * `dbName`, a type and modifiers, and no `sourceRef` — so there is no location to edit;
 * there is only a name to search for. Silently rewriting a file we found by grepping for
 * an identifier is exactly the class of hidden decision §3.3 exists to abolish, so the
 * confirmation produces a **patch** instead: the same edit, on stdout, reviewable, and
 * applyable with `patch -p0 < renames.patch`. Exit stays 2 until the annotation is in the
 * repository, which keeps CI and the human on the same rule.
 *
 * The hunk is located by finding the declaration line for the column or table, which is a
 * *search*, and the diff says so: a wrong hunk is visible before it is applied, whereas a
 * wrong in-place edit is visible only in `git diff` afterwards.
 */

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { parseId, type StableId } from "../ir/stable-id.js";

export interface RenameEdit {
  readonly from?: string;
  readonly to?: string;
  readonly kind: string;
  readonly type: string;
}

const nameOf = (id: StableId): string => ("name" in id ? id.name : "schema" in id ? id.schema : id.target);

/**
 * Where a column or table is declared, as a 0-based line index — or null.
 *
 * Two patterns, both anchored on the DB name the catalog uses:
 *
 *   `  email: t.text()…`          a column whose TS key IS its DB name
 *   `  email: t.text().dbName(…)` — not a thing; the DSL derives the DB name from the key
 *   `export const users = pgTable('users'` / `audit.table('events'`
 *
 * A camelCase TS key whose DB name is snake_case is found by folding the DB name back:
 * `first_name` also matches `firstName:`.
 */
function findDeclaration(lines: readonly string[], kind: string, name: string): number | null {
  const camel = name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  const patterns =
    kind === "column"
      ? [new RegExp(`^\\s*${escape(name)}\\s*:`), new RegExp(`^\\s*${escape(camel)}\\s*:`)]
      : [new RegExp(`(pgTable|\\.table)\\(\\s*['"\`]${escape(name)}['"\`]`)];
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some((p) => p.test(lines[i]!))) return i;
  }
  return null;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `  email: t.text(),` → `  email: t.text().renamedFrom('email_address'),` */
function annotate(line: string, kind: string, oldName: string): string {
  const call = `.renamedFrom(${JSON.stringify(oldName)})`;
  if (kind !== "column") {
    return `${line}\n// add to the table's extras array:  renamedFrom(${JSON.stringify(oldName)}),`;
  }
  const trimmedEnd = line.replace(/([,;]?\s*)$/, "");
  const tail = line.slice(trimmedEnd.length);
  return `${trimmedEnd}${call}${tail}`;
}

/** A one-hunk unified diff per accepted rename, concatenated. */
export function renameDiff(edits: readonly RenameEdit[], schemaPaths: readonly string[]): string {
  const out: string[] = [];
  const cache = new Map<string, string[]>();
  const read = (path: string): string[] => {
    const memo = cache.get(path);
    if (memo) return memo;
    let lines: string[];
    try {
      lines = readFileSync(path, "utf8").split("\n");
    } catch {
      lines = [];
    }
    cache.set(path, lines);
    return lines;
  };

  for (const edit of edits) {
    if (edit.from === undefined || edit.to === undefined) continue;
    const from = parseId(edit.from);
    const to = parseId(edit.to);
    const oldName = nameOf(from);
    const newName = nameOf(to);
    let placed = false;
    for (const path of schemaPaths) {
      const lines = read(path);
      const at = findDeclaration(lines, to.kind, newName);
      if (at === null) continue;
      const before = lines[at]!;
      const after = annotate(before, to.kind, oldName);
      const rel = relative(process.cwd(), path);
      out.push(
        `--- a/${rel}`,
        `+++ b/${rel}`,
        `@@ -${String(at + 1)},1 +${String(at + 1)},${String(after.split("\n").length)} @@`,
        `-${before}`,
        ...after.split("\n").map((l) => `+${l}`),
        "",
      );
      placed = true;
      break;
    }
    if (!placed) {
      out.push(
        `# could not locate the declaration of ${newName} in ${schemaPaths.join(", ")};`,
        `# add renamedFrom(${JSON.stringify(oldName)}) to it by hand.`,
        "",
      );
    }
  }
  out.push(
    "# design/06 §3.3: the annotation is the authority, so it has to live in your repository.",
    "# Apply this with `patch -p0`, commit it, and re-run `pg-prime migrate generate`.",
  );
  return out.join("\n");
}
