# packages/pg-prime-kit/src/cli/interactive.ts

## Purpose
Turns renames confirmed under `migrate generate --interactive` into a unified-diff patch that adds `.renamedFrom(...)` to the schema source, instead of editing the file.
Called only by `interactiveRenames` in `packages/pg-prime-kit/src/cli/commands/generate.ts:470`; uses `parseId` from `packages/pg-prime-kit/src/ir/stable-id.ts`.

## Public API
- `RenameEdit` — `{ from?, to?, kind, type }`; `from`/`to` are stable-id strings such as `column:public.users.name`.
- `renameDiff(edits, schemaPaths)` — returns one hunk (or a `#` comment when not found) per edit, plus a two-line trailer; never throws.

## Flow
1. Skip edits missing `from` or `to` (`packages/pg-prime-kit/src/cli/interactive.ts:86`).
2. Parse both ids and take a name: `name`, else `schema`, else `target` (`packages/pg-prime-kit/src/cli/interactive.ts:29`).
3. For each schema path in order, read its lines (cached; an unreadable file reads as empty) (`packages/pg-prime-kit/src/cli/interactive.ts:72`).
4. `findDeclaration` searches by the new name, using the parsed `to.kind` (`packages/pg-prime-kit/src/cli/interactive.ts:43`):
   columns match `^\s*name\s*:` or the camelCase fold of a snake_case name; tables match `pgTable('name'` or `.table('name'`.
5. `annotate` appends `.renamedFrom("old")` before any trailing `,`/`;` for a column; for a table it adds a comment line telling the author to put `renamedFrom("old")` in the extras array (`packages/pg-prime-kit/src/cli/interactive.ts:58`).
6. Emit `--- a/<rel>`, `+++ b/<rel>`, an `@@ -N,1 +N,k @@` header, and the old/new lines; stop at the first file that matches (`packages/pg-prime-kit/src/cli/interactive.ts:99`).
7. If no file matches, emit a `# could not locate the declaration ...` comment (`packages/pg-prime-kit/src/cli/interactive.ts:110`).
8. Append the trailer telling the author to apply with `patch -p0`, commit, and re-run `pg-prime migrate generate` (`packages/pg-prime-kit/src/cli/interactive.ts:118`).

## Gotchas
- Location is a text search, not a source map: the first matching line in the first matching file wins. A column search is not scoped to its table, so another table's key with the same name can be hit.
- Hunk headers use `a/` and `b/` prefixes (`packages/pg-prime-kit/src/cli/interactive.ts:100`) while the trailer says `patch -p0` (`packages/pg-prime-kit/src/cli/interactive.ts:120`). Stripping those prefixes needs `-p1`.
- Paths are relative to `process.cwd()`, not the CLI's injected `cwd`, and may contain `../` (`packages/pg-prime-kit/src/cli/interactive.ts:98`).
- The table "edit" adds a `//` comment line instead of changing code; the author still has to add the annotation.
- Old names are quoted with `JSON.stringify`, so the patch uses double quotes regardless of the file's quote style.
- `generate` only prompts when both stdin and stdout are TTYs (`packages/pg-prime-kit/src/cli/commands/generate.ts:289`) and still exits 2 after printing the patch.

## Tests
- `packages/pg-prime-kit/test/cli/interactive.test.ts`: column found by camelCase key (hunk line, annotation, `patch -p0` trailer), table found via `pgTable`, and the "could not locate" message.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli/interactive.test.ts` (no server needed).
- Uncovered: the readline prompt itself (no TTY in tests), multiple schema files, `.table(...)` declarations, unreadable files, and whether the emitted patch actually applies.
