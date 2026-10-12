# packages/pg-prime/src/sql/

## Purpose
The `sql` tagged template and its four primitives, identifier quoting, and the builder/compiler error
classes. Fragments are opaque handles over `RawNode`s built with `compile/nodes.ts`; the compiler splices
and numbers them. Imported throughout `query/*`, `compile/*` (`quoteIdentPart`, `quoteStringLiteral`,
`DecodePlanError`, `TooManyParametersError`), `schema/*` (`SchemaError`, quoting) and `codec/*`. Shipped as
the `pg-prime/sql` subpath and re-exported by `src/index.ts`; kit-generated schemas import `sql` from
`pg-prime/sql` (`packages/pg-prime-kit/src/pull/emit-ts.ts:436`). `index.ts` is the subpath barrel.

## Public API
- `sql` (`SqlTag`) — frozen tag function; every non-fragment, non-node hole becomes a bind parameter.
- `sql.ident(...parts)` / `sql.ident([parts])` — validated, always-quoted identifier path; never splits on `.`.
- `sql.lit(v: number | bigint | boolean | null)` — inline literal; throws `UnsafeLiteralError` otherwise.
- `sql.unsafeRaw(text)` — verbatim SQL text; records the caller frame outside production.
- `sql.join(fragments, separator = ', ')` — joins fragments; `[]` returns `sql.empty`.
- `sql.empty` — the shared empty fragment.
- `Fragment<T>` — handle with `.as(codec)` → `TypedFragment<CodecOut<C>, CodecPg<C>>` and
  `.asUnsafe<U>()` → `TypedFragment<U, 'unknown'>`; `__out` is a phantom.
- `TypedFragment<T, P>` — fragment with phantom `[OUT]`, `[META].pg`, `[SRC]` slots, usable as an operand.
- `AnyFragment` — `Fragment<unknown>`.
- `isFragment(v)` — true only for handles this module created (WeakMap membership).
- `toNode(f): RawNode` — unwraps a handle; throws `InvalidFragmentError` for anything else.
- `asExpr(v)` — fragment or AST node to `Expr`; throws `InvalidFragmentError` otherwise.
- `MAX_IDENT_BYTES` — `63` (`NAMEDATALEN - 1`), in UTF-8 bytes.
- `quoteIdentPart(part, index = 0): string` — validates and double-quotes one part; throws `InvalidIdentifierError`.
- `quoteIdentPath(parts): string` — quotes each part and joins with `.`; empty array throws (`no-parts`).
- `quoteStringLiteral(s): string` — `'…'`, or `E'…'` when `s` contains a backslash; throws `UnsafeLiteralError`.
- `isValidIdentPart(part): part is string` — non-throwing `quoteIdentPart` probe.
- `utf8ByteLength(s)`, `hasLoneSurrogate(s)`, `hasNul(s)` — allocation-free string scans.
- `PgPrimeError` — re-exported root (defined in `errors/base.ts`); `PgPrimeErrorCode` type.
- `InvalidIdentifierError` — `code 'INVALID_IDENTIFIER'`, fields `reason: IdentRejectReason`, `index`, `part`.
- `IdentRejectReason` — `not-a-string | empty | nul-byte | lone-surrogate | too-long | no-parts`.
- `InvalidFragmentError` (`INVALID_FRAGMENT`), `UnsafeLiteralError` (`UNSAFE_LITERAL`),
  `UnsupportedNodeError` (`UNSUPPORTED_NODE`, `nodeKind`).
- `TooManyParametersError` — a `UsageError` (`TOO_MANY_PARAMETERS`) with `count`, `statement`.
- `NoCodecError` (`NO_CODEC`; `table`, `column`, `pgType`), `NullOperandError` (`NULL_OPERAND`; `operator`).
- `DecodePlanError` (`DECODE_PLAN`), `BuilderError` (`BUILDER`), `SchemaError` (`SCHEMA`).

## Flow
1. `` sql`…${v}…` `` first checks that `strings` and `strings.raw` are frozen arrays of length
   `values + 1` (`packages/pg-prime/src/sql/fragment.ts:175`).
2. Each hole: `undefined` throws; a fragment contributes its node; a registered AST node must be a raw
   part; anything else becomes `param(v)` (`packages/pg-prime/src/sql/fragment.ts:196`).
3. `mkFragment` freezes a handle holding `as`/`asUnsafe` and maps it to its node in a module-private
   `WeakMap` (`packages/pg-prime/src/sql/fragment.ts:117`, `packages/pg-prime/src/sql/fragment.ts:119`).
4. `.as(codec)` builds a new raw node carrying the codec and a call site from `captureSite('as')`
   (`packages/pg-prime/src/sql/fragment.ts:127`); `.asUnsafe()` keeps `resultCodec` `null` for OID decoding.
5. `sql.ident` copies the parts, quotes them eagerly via `quoteIdentPath`, and wraps an `ident` node
   (`packages/pg-prime/src/sql/fragment.ts:233`).
6. `quoteIdentPart` takes a fast path for 1–63 printable ASCII chars without `"`; otherwise it checks
   type, empty, NUL, lone surrogate, then UTF-8 byte length, and doubles `"` (`packages/pg-prime/src/sql/ident.ts:97`).
7. `sql.lit` refuses strings, other non-literal types, and non-finite numbers before building a `lit`
   node (`packages/pg-prime/src/sql/fragment.ts:259`).
8. `sql.unsafeRaw` builds an `unsafeRaw` node with `origin` from `captureSite`
   (`packages/pg-prime/src/sql/fragment.ts:315`).
9. `sql.join` interleaves the separator node between fragment nodes with empty chunks
   (`packages/pg-prime/src/sql/fragment.ts:335`).

## Gotchas
- `isFragment` is nominal: a structurally identical object (e.g. from `JSON.parse`) is data and becomes a
  parameter (`packages/pg-prime/src/sql/fragment.ts:143`).
- Calling `sql(array)` as a plain function throws `InvalidFragmentError` unless the array and `.raw` are
  frozen (`packages/pg-prime/src/sql/fragment.ts:180`).
- `undefined` in a hole throws; `null` binds as SQL NULL (`packages/pg-prime/src/sql/fragment.ts:198`).
- Order items and statements are AST nodes but not raw parts, so interpolating one throws at the tag
  (`packages/pg-prime/src/sql/fragment.ts:216`).
- `SqlTag` has no type parameter; result typing requires `.as(codec)` or `.asUnsafe<U>()`.
- Production is detected once, lazily, from `globalThis.process.env.NODE_ENV`, and cached for the process
  (`packages/pg-prime/src/sql/fragment.ts:295`). In production `.as()`/`unsafeRaw` record no call site.
- `captureSite` takes stack line index 3, so the reported frame depends on call depth
  (`packages/pg-prime/src/sql/fragment.ts:308`).
- Identifiers over 63 UTF-8 bytes are rejected, not truncated; no case folding or normalisation happens
  (`packages/pg-prime/src/sql/ident.ts:154`).
- `utf8ByteLength` assumes surrogates are already paired; a trailing lone high surrogate counts 4 bytes
  (`packages/pg-prime/src/sql/ident.ts:55`).
- `quoteStringLiteral` is only for compile-time keys (`json_build_object`); nothing routes user data to it.
- `NullOperandError` maps an operator name to its SQL symbol for the message, defaulting to `=`
  (`packages/pg-prime/src/sql/errors.ts:166`).
- `sql/errors.ts` also re-exports `ConfigError` and `UsageError` and their init types from `errors/base.ts`,
  but `sql/index.ts` does not, so they are absent from the `pg-prime/sql` subpath
  (`packages/pg-prime/src/sql/errors.ts:14`).

## Tests
- `packages/pg-prime/test/sql/tag.test.ts` — tag, nesting, `.as`, `unsafeRaw`, forgery resistance, `lit`.
- `packages/pg-prime/test/sql/tag-guards.test.ts` — `undefined` holes, non-expression nodes, ownership
  and allocation, literal/identifier contracts.
- `packages/pg-prime/test/sql/ident.test.ts` — the five identifier rules, 63-byte rejection, helper
  predicates, call-time validation.
- `packages/pg-prime/test/sql/kysely-cve.test.ts` — the Kysely 2026 CVE corpus shown inert.
- `packages/pg-prime/test/fuzz/ident-oracle.test.ts` (live) — `sql.ident` against `format('%I')` and a
  `CREATE TEMP TABLE` round trip.
- Error classes are exercised from `test/compile/*` and `test/query/*` (e.g. `NullOperandError` in
  `packages/pg-prime/test/query/guards.test.ts`).
- Run: `pnpm --filter pg-prime exec vitest run test/sql`; fuzz:
  `pnpm --filter pg-prime exec vitest run test/fuzz/ident-oracle.test.ts`.
- Uncovered: `quoteStringLiteral` has no direct test.
