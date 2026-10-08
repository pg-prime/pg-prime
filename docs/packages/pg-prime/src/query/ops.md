# packages/pg-prime/src/query/ops.ts

## Purpose
The PostgreSQL operator vocabulary as free functions, each gated on its operand's PG type class and
carrying an exact result codec. Re-exported by `packages/pg-prime/src/query/types.ts:1687` and,
by explicit name list, `packages/pg-prime/src/index.ts`. It builds AST nodes with
`packages/pg-prime/src/compile/nodes.ts` (`bin`, `fn`, `is`, `inAny`, `mkNode`, `param`, …), reads
codecs via `codecOf` (`packages/pg-prime/src/compile/hoist.ts`) and takes operand types from
`packages/pg-prime/src/query/ops.types.ts`. Every operator has a row in
`packages/pg-prime/src/query/ops.manifest.ts`.

## Public API
All return `Expr<boolean, 'bool'>` unless noted; right operands are values (bound as `$n`) or expressions.
- `eq`, `neq`, `lt`, `lte`, `gt`, `gte(a, b)` — comparisons; `b` typed `NonNullOperand<A[OUT]>`;
  `null`/`undefined` throws `NullOperandError`.
- `isDistinctFrom`, `isNotDistinctFrom(a, b)` — null-safe comparison; `b` may be `null`.
- `isNull`, `isNotNull(a)` — `a is [not] null`; `isTrue`, `isNotTrue`, `isFalse`, `isNotFalse(a)` —
  `bool`-gated `is [not] true|false`.
- `between(a, lo, hi)` — bounds encoded with `a`'s codec; `null` bound throws `NullOperandError`.
- `inList`, `notInList(a, xs)` — `a = any($n)` / `a <> all($n)` with one array bind; `[]` emits `false`/`true`.
- `inQuery(a, q)` — `a in (select …)`; `q` must be a select builder or registered select/setop node.
- `coalesce(a, b)` — `Expr<NonNullable<A[OUT]>, P>`, codec of `a`.
- `val(v, codec)` — a `$n` encoded and declared with `codec`; `Expr<CodecOut<C>, C['name']>`.
- `cast(a, codec)` — `a::<codec.sqlName>`; keeps `a`'s `| null`.
- `like`, `ilike`, `notLike`, `notILike`, `startsWith(a, p)` — `TextOperand`; `p` bound with `a`'s codec;
  `null` throws `NullOperandError`.
- `regex`, `iregex`, `notRegex`, `notIRegex`, `similarTo(a, p)` — `p` bound as `text`.
- `concat(a, b)` — `a || b`, `Expr<string | null-of-a, 'text'>`.
- `similarity(a, b)`, `wordSimilarity(needle, haystack)` — pg_trgm, `Expr<number | null-of-operands, 'float4'>`;
  `trgmSimilar(a, b)` — `a % b`, `Expr<boolean, 'bool'>` like every predicate. Strings bound as `text`.
- `tupleGt`, `tupleLt`, `tupleGte`, `tupleLte(cols, vals)` — `row(a, b) > row($1, $2)`; `vals` is a
  tuple of the same length, each bound with its column's codec.
- `overlaps`, `arrayContains`, `arrayContainedBy`, `hasAll(a, b)` — `&&`, `@>`, `<@`, `@>` on `ArrayOperand<E>`.
- `has(a, v)` — `$n = any(a)`, `v` bound with the element codec; `arrayLength(a)` — `array_length(a, 1)`,
  `Expr<number | null, 'int4'>`; `arrayConcat(a, b)` — `a || b`, `a`'s codec.
- `anyOf(a)`, `allOf(a)` — `any(a)` / `all(a)` as an operand, `ExprOf<E>`, element codec.
- `jsonGet`, `jsonPath(a, k|path)` — `->` / `#>` on `JsonOperand`, result `json` or `jsonb` matching `a`.
- `jsonGetText`, `jsonPathText(a, k|path)` — `->>` / `#>>`, `Expr<string | null, 'text'>`.
- `jsonContains`, `jsonContainedBy(a, doc)` — `@>` / `<@`, `doc` bound as `jsonb`; `JsonbOperand` only.
- `hasKey(a, k)`, `hasAnyKey`, `hasAllKeys(a, ks)` — `?` (text) / `?|` / `?&` (`text[]`).
- `jsonPathExists`, `jsonPathMatch(a, jp)` — `@?` / `@@`, `jp` bound as `jsonpath`.
- `jsonConcat(a, b)`, `jsonDelete(a, k)`, `jsonDeletePath(a, path)` — `||`, `-`, `#-`; `Expr<unknown, 'jsonb'>`.
- `jsonbSet(a, path, value, createMissing?)` — `jsonb_set(a, $path, $value[, bool])`; `path` a `text[]`
  bind or `text[]` expression, `value` a `JsonbOperand` or `JsonValue`; `Expr<unknown, 'jsonb'>`.
- `add`, `sub`, `mul`, `div`, `mod(a, b)`, `abs(a)` — `NumOperand<T, P>`; `Expr<T, P>`, `a`'s codec.
- `matches(a, q)` — `tsvector @@ tsquery`; `tsRank`, `tsRankCd(a, q)` — `Expr<number, 'float4'>`.
- `tsHeadline([config, ]doc, q, opts?)` — `ts_headline`, overload picked by `typeof config === 'string'`;
  `Expr<string | null-of-doc, 'text'>`.
- `rangeOverlaps`, `rangeContains`, `rangeContainedBy`, `strictlyLeft`, `strictlyRight`, `adjacent(a, b)` —
  `&&`, `@>`, `<@`, `<<`, `>>`, `-|-` on `RangeOperand<P>`.
- `rangeUnion`, `rangeIntersection(a, b)` — `+` / `*`, `a`'s codec; `rangeLower`, `rangeUpper(a)` —
  `lower(a)` / `upper(a)`, `Expr<RangeElem<P> | null, RangeElemPg<P>>`.
- `containsNet`, `containedByNet`, `overlapsNet(a, b)` — `>>`, `<<`, `&&` on `NetOperand`.
- `l2`, `cosine`, `innerProduct`, `l1(a, b)` — `<->`, `<=>`, `<#>`, `<+>` on `VectorOperand`, `b` bound as `vector`.
- `hamming`, `jaccard(a, b)` — `<~>`, `<%>` on `BitOperand`; all six distances return `Expr<number, 'float8'>`.
- `RANGE_ELEMENT_NAMES` — frozen range→subtype name map; a test fixture, not on the public barrel.

## Flow
1. The caller passes a gated left operand (column ref, `Expr`, or typed fragment) and a value or expression.
2. `toExpr` (`packages/pg-prime/src/query/ops.ts:105`) keeps registered AST nodes and fragments and turns
   anything else into `param(v, codec)` — classification is nominal (WeakSet/WeakMap), not structural.
3. The right operand's codec is chosen per operator: explicit (`textCodec`, `jsonbCodec`, …) or `a`'s
   own codec via `codecOfOperand` (`packages/pg-prime/src/query/ops.ts:112`, used by `binary` at `:119`).
4. `pred` (`packages/pg-prime/src/query/ops.ts:130`) builds a `bool`-result binary node; other operators
   pass their result codec to `binary` or `fnNode`.
5. JSON key operators pick `int4` vs `text` from the JS type of the key (`keyCodec`,
   `packages/pg-prime/src/query/ops.ts:594`) and `json` vs `jsonb` result from `a` (`jsonCodecOf`, `:587`).
6. Range bounds look up the subtype codec in `RANGE_ELEMENT` (`packages/pg-prime/src/query/ops.ts:841`).
7. The node is returned typed as `Expr<…>`; nodes are frozen and operands are never mutated.

## Gotchas
- Null rejection is per operator: `eq`/`neq`/`lt`/`lte`/`gt`/`gte`, `between`, `like`/`ilike`/
  `notLike`/`notILike`/`startsWith`, `trgmSimilar` and the tuple comparisons throw `NullOperandError` (`packages/pg-prime/src/query/ops.ts:154`);
  the regex family, `similarTo`, array, JSON, range, net and vector operators bind a JS `null` as NULL.
- A structurally perfect plain-object copy of a node is data and becomes a bind, not SQL
  (`packages/pg-prime/src/query/ops.ts:105`); `inQuery` refuses it via `queryAstOf`.
- `like`-family patterns use `a`'s codec so `citext` stays case-insensitive; the regex family forces
  `text` because PostgreSQL has no `citext ~ citext` (`packages/pg-prime/src/query/ops.ts:429`).
- `<<`/`>>` mean "strictly left/right" for ranges and "contained by/contains" for `inet`/`cidr`; only the
  operand gate tells them apart (`packages/pg-prime/src/query/ops.ts:793`, `:884`).
- `innerProduct` returns pgvector's negated inner product (`packages/pg-prime/src/query/ops.ts:929`).
- `div` on integer operands is integer division (`packages/pg-prime/src/query/ops.ts:678`).
- `inList([])` / `notInList([])` emit constants: a second SQL shape for the empty list
  (`packages/pg-prime/src/query/ops.ts:322`).
- `rangeUnion` raises SQLSTATE `22000` server-side when the union is not contiguous.
- `RANGE_ELEMENT` falls back to `unknownCodec` for an unrecognised range codec (`packages/pg-prime/src/query/ops.ts:862`).
- The pg_trgm functions bind strings as `text` even for `citext` (`packages/pg-prime/src/query/ops.ts:476`).
- `jsonbSet` turns a JS `null` value into `$n::jsonb` with `'null'`, since an SQL NULL argument nulls
  the whole result (`packages/pg-prime/src/query/ops.ts:647`); its `unknown` result needs a cast to write back into a `$type<T>()` column.
- `tsHeadline` options are one `text` bind: fixed key order, integers enforced (`BuilderError`),
  strings double-quoted with `"` doubled (`headlineOptions`, `packages/pg-prime/src/query/ops.ts:724`).
- Tuple comparisons throw `BuilderError` on a length mismatch and `NullOperandError` on a `null`
  value (`rowCompare`, `packages/pg-prime/src/query/ops.ts:400`); all columns compare in one direction.
- `gt(u.createdAt, '2026-01-01')` is a compile error: `b` is typed by the decoded `TOut`, not the
  codec's `TIn` (`packages/pg-prime/src/query/ops.ts:189`).

## Tests
- `packages/pg-prime/test/query/ops.test.ts` — byte-exact SQL + binds golden per manifest row,
  immutability, `inList([])`, `eq(a, null)`, JSON key binding, `json`/`jsonb` result codecs.
  Run `pnpm --filter pg-prime exec vitest run test/query/ops.test.ts`.
- `packages/pg-prime/test/query/guards.test.ts` — ordered comparisons reject NULL, `between` inside
  `and`, `inQuery` refusing structural copies. Run `pnpm --filter pg-prime exec vitest run test/query/guards.test.ts`.
- `packages/pg-prime/test/live-query/ops.test.ts` — result-OID and semantic differentials for every
  confirmable row on PGlite; vector rows skip there and run in `packages/pg-prime/test/pg/vector.test.ts`
  (needs `PG_PRIME_TEST_URL` with pgvector); the pg_trgm rows are deferred there and run in
  `packages/pg-prime/test/pg/trgm.test.ts` (`pnpm --filter pg-prime test:pg` with `PG_PRIME_TEST_URL`). Run `pnpm --filter pg-prime exec vitest run test/live-query/ops.test.ts`.
- Type gates: `packages/pg-prime/test/query/types/ops.probe.ts` and `search.probe.ts` via `pnpm --filter pg-prime typecheck`.
- Uncovered: NULL right operands of the regex/array/range/net/vector operators.
