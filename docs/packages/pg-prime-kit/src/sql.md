# packages/pg-prime-kit/src/sql/

## Purpose
SQL text primitives for the kit: identifier/literal quoting plus ports of PostgreSQL's auto-naming rules (`ident.ts`), and a PostgreSQL-aware lexer, statement splitter and canonicalizer (`statements.ts`). Quoting is used by every DDL emitter (`diff/ddl.ts`, `schema/emit.ts`, `schema/load.ts`, `schema/views.ts`, `shadow/ladder.ts`, `history/store.ts`) and by `catalog/extract.ts` for NOT NULL names; the lexer serves `diff/rename.ts`, `lint/*`, `runner/files.ts`, `prove/pg-dump.ts`, `repeatables/*` and `seed/run.ts`.

## Public API
- `MAX_IDENT_BYTES` — `63` (`NAMEDATALEN - 1`).
- `IdentifierProblem` — `"not-a-string" | "empty" | "nul-byte" | "lone-surrogate" | "too-long"`.
- `InvalidIdentifierError` — `code = "PG_PRIME_INVALID_IDENTIFIER"`, carries `problem` and `value`.
- `utf8ByteLength(s)`, `hasLoneSurrogate(s)`, `hasNul(s)` — byte count and validity probes over UTF-16 code units.
- `quoteIdent(name)` — always `"…"` with `"` doubled; throws `InvalidIdentifierError` instead of truncating or substituting.
- `quoteQualified(schema, name)` — `quoteIdent(schema).quoteIdent(name)`.
- `quoteLiteral(value)` — `'…'` with `'` doubled, switching to `E'…'` (backslashes doubled) when a backslash is present; throws `TypeError`/`RangeError` on non-string, NUL or lone surrogate.
- `isValidIdent(name)` — non-throwing `quoteIdent` probe; type guard.
- `makeObjectName(name1, name2, label)` — port of the server's `makeObjectName`: clips the longer piece byte by byte to fit 63 bytes.
- `chooseConstraintName(name1, name2, label, taken)` — `makeObjectName` in a loop, suffix on the label (`t_a_key1`); throws after 1000 taken candidates.
- `defaultNotNullName(table, column)` — the unsuffixed PG 18 NOT NULL name, `makeObjectName(table, column, "not_null")`.
- `SegmentKind` (`code | comment | literal`), `Segment` `{ kind, text }` — exported from the package as `SqlSegment`.
- `dollarTagAt(sql, i)` — the `$$` / `$tag$` opener at `i`, or `null` (also for `$1` placeholders).
- `lexSql(sql): Segment[]` — classifies every character as code, comment or literal.
- `canonicalize(segments)` — drops comments, collapses code whitespace, keeps literals verbatim, trims a trailing `;`; exported from the package as `canonicalizeSql`.
- `splitStatements(sql): string[]` — canonical statements split at code-level `;`; empty ones dropped.
- `codeMask(sql): boolean[]` — per-character "is code" mask.

## Flow
1. `quoteIdent` checks type, emptiness, NUL, lone surrogates, then byte length, in that order (`packages/pg-prime-kit/src/sql/ident.ts:77-98`), and doubles `"` (`packages/pg-prime-kit/src/sql/ident.ts:102`).
2. `makeObjectName` computes the byte budget, shortens the longer of `name1`/`name2` one byte at a time, clips without splitting a character, and appends `_label` (`packages/pg-prime-kit/src/sql/ident.ts:159-175`).
3. `chooseConstraintName` tries `label`, `label1`, `label2`, … until `taken` says no (`packages/pg-prime-kit/src/sql/ident.ts:213-216`); `packages/pg-prime-kit/src/diff/ddl.ts:1965` uses it for the PG 15–17 temporary NOT NULL CHECK.
4. `lexSql` walks the text: line-start `\` meta-commands and `--` comments run to end of line (`packages/pg-prime-kit/src/sql/statements.ts:78-94`), `/* */` comments nest (`packages/pg-prime-kit/src/sql/statements.ts:96-112`).
5. Dollar-quoted bodies, `'…'` strings (backslash escapes only after an `E` prefix) and `"…"` identifiers become `literal` segments (`packages/pg-prime-kit/src/sql/statements.ts:114-165`); everything else accumulates as `code`.
6. `splitStatements` cuts code segments at each `;` and canonicalizes the pieces (`packages/pg-prime-kit/src/sql/statements.ts:200-222`).
7. `codeMask` re-walks the lexed segments, marking code offsets (`packages/pg-prime-kit/src/sql/statements.ts:230-238`).

## Gotchas
- Double-quoted identifiers are `literal` segments (`packages/pg-prime-kit/src/sql/statements.ts:148-165`): `canonicalize` keeps them verbatim and `codeMask` marks them as non-code, so a mask-based scan (e.g. `lint/rules.ts` ST106) never sees quoted names.
- An unterminated string, quoted identifier or dollar-quote extends to end of input (`packages/pg-prime-kit/src/sql/statements.ts:117`, `packages/pg-prime-kit/src/sql/statements.ts:127-141`); there is no lexer error.
- Plain `'…'` strings get no backslash processing, which assumes `standard_conforming_strings = on`; only `E'…'` honours `\` (`packages/pg-prime-kit/src/sql/statements.ts:55-60`).
- psql meta-commands (pg_dump 17.6+ `\restrict <token>`) are lexed as comments so their random token never reaches a comparison (`packages/pg-prime-kit/src/sql/statements.ts:76-85`).
- `canonicalize` treats a comment as a token separator (`a/**/b` becomes `a b`, `packages/pg-prime-kit/src/sql/statements.ts:186-188`).
- `quoteIdent` rejects names over 63 UTF-8 bytes rather than letting PostgreSQL truncate them into a collision (`packages/pg-prime-kit/src/sql/ident.ts:91-97`).
- `quoteLiteral` has no length limit and does not use `InvalidIdentifierError`.
- `defaultNotNullName` is deliberately unsuffixed: a suffixed server name compares unequal, so the extractor treats it as a user name (`packages/pg-prime-kit/src/sql/ident.ts:222-235`).
- `clipToBytes` uses Node's `Buffer` (`packages/pg-prime-kit/src/sql/ident.ts:136`), so `makeObjectName` is Node-only.
- `utf8ByteLength` counts any high surrogate as a 4-byte pair and skips the next unit (`packages/pg-prime-kit/src/sql/ident.ts:46-48`); it is exact only for strings `hasLoneSurrogate` accepts.

## Tests
- `packages/pg-prime-kit/test/ident.test.ts` (no database): `quoteIdent` quoting and every rejection, `quoteLiteral` `E''` switch and rejections, byte/surrogate probes, `makeObjectName`/`defaultNotNullName` truncation including multi-byte clipping.
- `packages/pg-prime-kit/test/dump-oracle.test.ts` "SQL statement splitting": `$1` vs dollar quotes, `--` inside strings, nested comments, `E''` escapes, whitespace collapse (the file's live describe needs a server).
- `test/runner/files.test.ts` and `test/repeatables/idempotence.test.ts` use `canonicalize`/`lexSql`/`splitStatements` indirectly.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/ident.test.ts test/dump-oracle.test.ts`.
- Uncovered: `chooseConstraintName` has no unit test (only the corpus fixture `fixtures/diff/name-collision` via `test/corpus.test.ts`); `codeMask` and `dollarTagAt` have no direct test.
