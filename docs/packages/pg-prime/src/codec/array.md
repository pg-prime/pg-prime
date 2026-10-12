# packages/pg-prime/src/codec/array.ts

## Purpose
Pure grammar for PostgreSQL array literals: parse wire text into nested `string | null` arrays and
write already-encoded elements back out. No imports. Called by `arrayCodec` and `unknownCodec` in
`src/codec/builtins.ts`, and by `Registry.resolveDynamic` in `src/codec/registry.ts` to send
`text[]` parameters; re-exported publicly through `src/codec/index.ts`.

## Public API
- `PgArrayLiteral` — `readonly (string | null | PgArrayLiteral)[]`; arbitrarily nested parse result.
- `parseArrayLiteral(raw, delimiter = ',')` — returns a `PgArrayLiteral`; throws `SyntaxError` on
  malformed input, an unterminated quote, a dangling escape or trailing text.
- `writeArrayLiteral(values, delimiter = ',', encodeLeaf?, isLeaf?)` — returns the literal string;
  `encodeLeaf` maps a leaf to text or `null`, `isLeaf` says whether a JS array is one element.

## Flow
1. `parseArrayLiteral` skips an optional dimension prefix (`[0:1]=`) by jumping past the first `=`
   (`packages/pg-prime/src/codec/array.ts:23`).
2. `parseList` requires `{`, returns `[]` for `{}`, then loops over elements
   (`packages/pg-prime/src/codec/array.ts:29`).
3. A `{` recurses; a `"` reads a quoted element where `\` takes the next char literally
   (`packages/pg-prime/src/codec/array.ts:40`).
4. Any other element runs to the delimiter or `}`, is trimmed, and becomes `null` when it equals
   `NULL` case-insensitively (`packages/pg-prime/src/codec/array.ts:61`).
5. After each element it expects the delimiter or `}`; after the outer list it requires end of input
   (`packages/pg-prime/src/codec/array.ts:81`).
6. `writeArrayLiteral` renders `null` as `NULL`, recurses into arrays unless `isLeaf` says otherwise,
   and runs every other value through `encodeLeaf` (`packages/pg-prime/src/codec/array.ts:113`).
7. A leaf is double-quoted (with `\` and `"` escaped) when it is empty, spells `NULL`, contains the
   delimiter, or contains `{ } " \` or whitespace (`packages/pg-prime/src/codec/array.ts:85`).

## Gotchas
- The delimiter is per type (`pg_type.typdelim`): `box` uses `;`. Callers must pass it; the default
  is `,` (`packages/pg-prime/src/codec/array.ts:19`).
- The dimension prefix is discarded, so lower-bound information is lost on parse.
- Quoted `"NULL"` is the string `'NULL'`; unquoted `NULL` is SQL NULL. The writer quotes the string
  `'NULL'` for the same reason (`packages/pg-prime/src/codec/array.ts:89`).
- The default `encodeLeaf` turns `undefined` into `NULL`; `arrayCodec` and `unknownCodec` pass their
  own encoder that throws instead (`packages/pg-prime/src/codec/array.ts:109`).
- `Array.from` (not `.map`) visits sparse holes as `undefined`, so a hole reaches `encodeLeaf`
  rather than producing `{1,,3}` (`packages/pg-prime/src/codec/array.ts:120`).
- The default `isLeaf` treats every JS array as nesting; `jsonb[]`/`vector[]` need `isLeaf` to
  return `true` (supplied by `arrayCodec`).
- `parseArrayLiteral` throws bare `SyntaxError`; `arrayCodec` re-wraps it as `PgDecodeError`.

## Tests
- `packages/pg-prime/test/codec/array-literal.test.ts` — parse cases (NULL vs `"NULL"`, quoting, nesting, lower-bound
  prefix, `;` delimiter), writer quoting, and a live oracle that PostgreSQL agrees with both halves
  including `box[]` at `packages/pg-prime/test/codec/array-literal.test.ts:201`.
- `packages/pg-prime/test/codec/decoding-strictness.test.ts:155` — arrays whose element is itself an array (`isLeaf`).
- `packages/pg-prime/test/codec/encoding-policy.test.ts:227` — `undefined` holes are errors, not NULL.
- Run (live project): `pnpm --filter pg-prime exec vitest run test/codec/array-literal.test.ts`.
- Not covered: the `SyntaxError` paths for a prefix with no `=`, an unterminated quote and a
  dangling escape (only trailing text is asserted, `packages/pg-prime/test/codec/array-literal.test.ts:97`).
