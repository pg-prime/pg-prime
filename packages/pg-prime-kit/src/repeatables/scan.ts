/**
 * Tier R repeatables, as they exist on disk (design/06 §3.8, §4.1).
 *
 * A repeatable is not diffed: the runner re-applies the FILE, so the file's bytes and the
 * file's position in the tree are the whole contract. Both have a way of going wrong that
 * this module exists to prevent:
 *
 *   - **Order is directory-lexicographic, files and directories in ONE sort.** A view in
 *     `030_views/` depends on a function in `020_functions/`, so the apply order is a
 *     correctness property, not a presentation one. The shape a naive walk produces —
 *     directories first, then files — puts a top-level `015_prep.sql` after every subtree
 *     and inverts a dependency the author expressed by naming.
 *   - **`path` is the identity.** It is the primary key of `pgprime.repeatables` (`06` §4.4)
 *     and it is what the plan records (`06` §4.3: `"sql/030_views/active_users.sql"`), so it
 *     is always POSIX-separated and always carries the root directory's own name, whatever
 *     the host separator and whatever absolute path the scan was pointed at. A Windows
 *     checkout that recorded `sql\030_views\x.sql` would re-apply every repeatable on a Linux
 *     runner, for ever.
 */

import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { sha256 } from "../ir/hash.js";
import { splitStatements } from "../sql/statements.js";

/** One `-- pg-prime:<name> <value>` line from a file's header. `line` is 1-based. */
export interface Directive {
  readonly name: string;
  readonly value: string;
  readonly line: number;
}

export interface RepeatableFile {
  /** POSIX, prefixed — the `pgprime.repeatables` primary key. */
  readonly path: string;
  readonly absPath: string;
  /** `"sha256:<hex>"`, the same spelling the IR uses. */
  readonly sha256: string;
  readonly directives: readonly Directive[];
  readonly statements: readonly string[];
}

export interface ScanOptions {
  /** Defaults to the scanned directory's own name, so `/proj/sql` yields `sql/…`. */
  readonly pathPrefix?: string;
}

/* ---- directives ---- */

const DIRECTIVE = /^--\s*pg-prime:([A-Za-z0-9_-]+)[ \t]*(.*)$/;

/**
 * Read `-- pg-prime:<name> <rest of line>` out of the file's LEADING comment block: the
 * contiguous run of lines from the top that are blank or `--` comments.
 *
 * Scoped to the header deliberately. A directive is a statement about the whole file, and the
 * only way to keep that true is to stop looking at the first line that is neither blank nor a
 * comment. Otherwise a `-- pg-prime:nolint …` a developer wrote above one statement — or one
 * that happens to sit inside a quoted function body — silently reconfigures the file.
 */
export function parseDirectives(text: string): Directive[] {
  const out: Directive[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue; // a blank line does not close the header block
    if (!line.startsWith("--")) break; // the first SQL token does
    const m = DIRECTIVE.exec(line);
    if (m) out.push({ name: m[1]!, value: m[2]!.trim(), line: i + 1 });
  }
  return out;
}

/* ---- the walk ---- */

const isEnoent = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";

// Case-insensitive because a case-insensitive filesystem (macOS, Windows) will hand back
// `Bump.SQL` for a file the author committed as `bump.sql`.
const isSqlFile = (name: string): boolean => name.toLowerCase().endsWith(".sql");

const isRegularFile = (abs: string): Promise<boolean> =>
  stat(abs).then(
    (s) => s.isFile(),
    () => false, // a broken symlink is not a repeatable
  );

/**
 * `null` when the directory is not there.
 *
 * A project with no repeatables is legal (`06` §4.1 lists `sql/` alongside `seeds/` as
 * optional), so a missing root is an empty pass rather than a failure. The same answer covers
 * a subdirectory that disappears mid-walk, which is a race no caller could act on. Every other
 * error — EACCES above all — propagates, because "cannot read" must never be reported as
 * "nothing to apply": that would silently drop every repeatable from a deploy.
 */
async function readdirSorted(absDir: string): Promise<Dirent[] | null> {
  let entries: Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  // Code-unit order, NOT `localeCompare`: collation is locale-dependent, so the apply order of
  // a tree would otherwise change with the machine's LANG and two developers would run the
  // same files in two different orders.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

async function walk(absDir: string, rel: string, out: string[]): Promise<void> {
  const entries = await readdirSorted(absDir);
  if (entries === null) return;
  for (const e of entries) {
    const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
    // Depth-first at the entry's own position in the ONE sort: a file named `015_prep.sql`
    // therefore runs between the `010_types/` and `020_functions/` subtrees, which is what
    // "directory-lexicographic" in `06` §3.8 means and what the numeric prefixes are for.
    if (e.isDirectory()) {
      await walk(join(absDir, e.name), childRel, out);
      continue;
    }
    if (!isSqlFile(e.name)) continue;
    // A symlink is neither `isFile()` nor `isDirectory()`, so it is resolved here — but only
    // to a file. A symlinked DIRECTORY is deliberately not followed: a cycle would make the
    // scan non-terminating, and a repeatable tree has no reason to contain one.
    if (e.isFile() || (e.isSymbolicLink() && (await isRegularFile(join(absDir, e.name))))) {
      out.push(childRel);
    }
  }
}

/* ---- the scan ---- */

export async function scanRepeatables(dir: string, options: ScanOptions = {}): Promise<RepeatableFile[]> {
  const root = resolve(dir);
  const prefix = options.pathPrefix ?? basename(root);
  const relatives: string[] = [];
  await walk(root, "", relatives);

  const files: RepeatableFile[] = [];
  for (const rel of relatives) {
    const absPath = join(root, rel);
    // Decoded once and hashed as text: for the UTF-8 a `.sql` file must be to parse at all,
    // `sha256`'s own utf8 encoding reproduces the bytes exactly, and reusing `ir/hash.ts`
    // keeps ONE spelling of "sha256:" in the kit — a second one is how a hash comparison
    // starts failing on the format rather than on the content.
    const text = (await readFile(absPath)).toString("utf8");
    files.push({
      path: prefix === "" ? rel : `${prefix}/${rel}`,
      absPath,
      sha256: sha256(text),
      directives: parseDirectives(text),
      // The splitter, not a `;` split: a `;` inside a `$$…$$` plpgsql body is not a statement
      // boundary, and every interesting repeatable is a function body.
      statements: splitStatements(text),
    });
  }
  return files;
}
