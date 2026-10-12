# packages/pg-prime/src/session/copy.ts

## Purpose
Pure helpers behind `copyFrom`, `copyFrom.raw`, `copyTo` and `copyTo.lines`: column resolution, the
`COPY … FROM STDIN` statement text, row encoding into text/CSV payload chunks, driver capability checks and
line splitting. Called only by `makeCopyFrom` / `makeCopyTo` in `packages/pg-prime/src/session/handles.ts:899`
and `packages/pg-prime/src/session/handles.ts:935`; reads `TableCodecMeta` from
`packages/pg-prime/src/query/meta.ts` and encodes through each column's codec.

## Public API
- `CopyFormat` — `'text' | 'csv'`; binary COPY is not offered.
- `escapeCopyText(s)` — escapes `\`, tab, `\n`, `\r` for COPY text format; returns `s` unchanged when nothing needs escaping.
- `escapeCopyCsv(s)` — quotes the field (doubling `"`) only when it contains `"`, `,`, `\n` or `\r`.
- `CopyColumn` — `{ key, name, codec }`: the row key a value is read under, the DB column name, the codec.
- `copyColumns(meta, requested)` — resolves `{ columns }` (TS key or DB name) or defaults to
  `meta.insertableKeys`; throws `UsageError` on an unknown, a stored-generated, or an empty default list.
- `copyFromSql(meta, columns, format)` — `copy <qualified> ("a", "b") from stdin with (format <f>)`.
- `encodeCopyRows(rows, columns, format, highWaterMark)` — async generator of `Uint8Array` chunks; throws
  `ConfigError` when a codec encodes to binary.
- `assertCopyIn(conn, adapter)` / `assertCopyOut(conn, adapter)` — assertion functions; throw
  `ConfigError` when the connection lacks `copyIn` / `copyOut`.
- `copyLines(chunks)` — async generator splitting a COPY TO byte stream into lines (no trailing `\n`).

## Flow
1. `copyFrom(table, rows, opts)` builds `metaOf(table, registry)` and calls `copyColumns`
   (`packages/pg-prime/src/session/handles.ts:905`).
2. With no `columns`, the list is `meta.insertableKeys`, i.e. declaration order minus identity and
   stored-generated columns (`packages/pg-prime/src/session/copy.ts:102`).
3. An explicit name is looked up as a TS key first, then as a DB name
   (`packages/pg-prime/src/session/copy.ts:117`); a stored-generated column is refused before any I/O
   (`packages/pg-prime/src/session/copy.ts:133`). Identity columns may be named.
4. `copyFromSql` quotes each column name and uses `meta.table.qualified`
   (`packages/pg-prime/src/session/copy.ts:151`).
5. `encodeCopyRows` reads each value under `col.key`, falling back to `col.name`
   (`packages/pg-prime/src/session/copy.ts:177`); `null`/`undefined` becomes `\N` (text) or an empty unquoted field (CSV).
6. Values are encoded with the column codec, escaped, joined by tab or comma, and buffered until
   `buffer.length >= highWaterMark` (`packages/pg-prime/src/session/copy.ts:194`); the remainder is flushed at the end.
7. `copyTo.lines` pipes `conn.copyOut` bytes through `copyLines`, which decodes UTF-8 in streaming mode
   and yields a final partial line if present (`packages/pg-prime/src/session/copy.ts:246`).

## Gotchas
- A column in the list that the row lacks goes out as `\N`, not as the column's database default; narrow
  `columns` to let a default apply.
- `highWaterMark` is compared against the string's UTF-16 length before encoding
  (`packages/pg-prime/src/session/copy.ts:194`), not a byte count.
- Rows are always text/CSV encoded through the same codecs as INSERT; a binary-encoding codec throws
  mid-stream (`packages/pg-prime/src/session/copy.ts:183`). Use `copyFrom.raw` for binary format.
- `escapeCopyCsv` assumes PostgreSQL's default CSV quote/delimiter; `copyFromSql` emits no other CSV options.
- Generated-expression refusal relies on `meta.generatedKeys`; mapping a DB name to its TS key assumes
  `meta.columns` and `meta.keys` are parallel (`packages/pg-prime/src/session/copy.ts:132`).

## Tests
- `packages/pg-prime/test/session/copy.test.ts` — default/explicit column lists, unknown and generated
  columns, empty default list, key vs DB-name lookup in the payload. Run:
  `pnpm --filter pg-prime exec vitest run test/session/copy.test.ts`.
- `packages/pg-prime/test/live/session.test.ts:387` — COPY round trip on PGlite (live project).
- `packages/pg-prime/test/pg/session-copy.test.ts` — COPY vs `insertMany` crossover and default columns on a
  real server (needs `PG_PRIME_TEST_URL`).
- Uncovered: no direct unit test for `escapeCopyText`, `escapeCopyCsv` or `copyLines` edge cases
  (multi-byte characters split across chunks, CSV quoting).
