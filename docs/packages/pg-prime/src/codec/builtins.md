# packages/pg-prime/src/codec/builtins.ts

## Purpose
Every built-in PostgreSQL codec with a fixed OID, the array-codec derivation, the untyped
`unknownCodec`, and the shipped set (`builtinCodecs`, `ALTERNATE_CODECS`). Uses
`parseArrayLiteral`/`writeArrayLiteral` from `src/codec/array.ts` and the error classes from
`src/codec/types.ts`. `Registry` (`src/codec/registry.ts`) registers the set; the compiler and query
layer (`src/compile/nodes.ts`, `src/compile/hoist.ts`, `src/query/ops.ts`, `src/query/insert.ts`,
`src/query/update.ts`, `src/query/meta.ts`) call `arrayCodecOf`; all exports are public via `src/codec/index.ts`.

## Public API
- `boolCodec` (`bool`, 16) — `boolean`; text `t`/`f` only.
- `int2Codec`, `int4Codec`, `oidCodec` (21, 23, 26) — `number`; encode range-checked to the type.
- `int8Codec` (`int8`, 20) — decodes to `bigint`; encodes `bigint | number | string`; `jsonEncode: 'text'`.
- `float4Codec`, `float8Codec` (700, 701) — `number`, including `NaN`/`±Infinity`.
- `numericCodec` (`numeric`, 1700) — verbatim `string`; encodes `string | number | bigint`; `jsonEncode: 'text'`.
- `textCodec`, `varcharCodec`, `bpcharCodec`, `nameCodec`, `xmlCodec`, `inetCodec`, `cidrCodec`,
  `moneyCodec`, `timeCodec`, `timetzCodec` — identity `string` codecs (`typeClass: 'string'`).
- `charCodec`, `macaddrCodec`, `macaddr8Codec`, `bitCodec`, `varbitCodec`, `pgLsnCodec`,
  `uuidCodec` — identity `string` codecs; `uuidCodec.encode` also validates the UUID shape.
- `tsvectorCodec`, `tsqueryCodec`, `jsonpathCodec` (`'other'`), `int4rangeCodec`, `int8rangeCodec`,
  `numrangeCodec`, `tsrangeCodec`, `tstzrangeCodec`, `daterangeCodec` (`'range'`) — canonical text form.
- `dateCodec` (1082) — `PgDateString`; `timestampCodec` (1114) — `PgTimestampString`, encodes `string | Date`.
- `timestamptzCodec` (1184) — `Date`; encodes `Date | string`; throws on `infinity`.
- `PgInterval` / `intervalCodec` (1186) — `{ years, months, days, hours, minutes, seconds }`.
- `jsonbCodec` (3802), `jsonCodecJson` (`json`, 114) — `JSON.parse` result; encode `JSON.stringify`.
- `byteaCodec` (17) — `Uint8Array`, sent as a binary parameter; decodes `\x` hex.
- `int8NumberCodec`, `int8StringCodec`, `numericNumberCodec`, `timestamptzStringCodec` — alternates
  sharing their default's OID; collected in `ALTERNATE_CODECS`.
- `arrayCodec(element, oid, options?)` — derives an `${name}[]` codec; `options` sets `delimiter`/`name`.
- `arrayCodecOf(element, registry?)` — registry `byName('<name>[]')` hit, else a memoised derived codec.
- `unknownCodec` — `oid: undefined`, `paramOid: 0`; the codec on an untyped `sql` template hole.
- `builtinCodecs()` — every default scalar plus its array codec, as `AnyCodec[]`.

## Flow
1. Each scalar is built by `def`, which defaults `paramOid` to `oid` and copies optional `toJson`
   and `arrayOid` (`packages/pg-prime/src/codec/builtins.ts:47`).
2. Integer, float and numeric decoders validate text with `INTEGER_TEXT`, `FLOAT_TEXT` and
   `NUMERIC_TEXT` before converting (`packages/pg-prime/src/codec/builtins.ts:106`, `packages/pg-prime/src/codec/builtins.ts:271`, `packages/pg-prime/src/codec/builtins.ts:334`).
3. `timestamptz` text is parsed by `TSTZ_RE` and assembled with `Date.UTC` plus the parsed offset;
   `new Date(raw)` is never used (`packages/pg-prime/src/codec/builtins.ts:647`).
4. `Date` parameters are written by `utcTimestampText` (UTC fields, `Z`, ` BC` for year <= 0), not
   `toISOString()` (`packages/pg-prime/src/codec/builtins.ts:553`).
5. Interval text is sniffed: a leading `P` parses ISO-8601, anything else the `postgres` style
   token grammar; encode always emits ISO-8601 (`packages/pg-prime/src/codec/builtins.ts:802`, `packages/pg-prime/src/codec/builtins.ts:886`).
6. `arrayCodec` decodes text via `parseArrayLiteral` with the element's `decodeText`; `decodeJson`
   accepts a literal string (element `jsonEncode: 'text'`) or a JSON array
   (`packages/pg-prime/src/codec/builtins.ts:1074`, `packages/pg-prime/src/codec/builtins.ts:1126`).
7. `arrayCodec.encode` writes via `writeArrayLiteral`, encoding each leaf with the element codec and
   converting a `Uint8Array` to `\x` hex text (`packages/pg-prime/src/codec/builtins.ts:1106`, `packages/pg-prime/src/codec/builtins.ts:1159`).
8. `builtinCodecs()` walks `SCALARS` and appends `arrayCodecOf(scalar)` for each `arrayOid`
   (`packages/pg-prime/src/codec/builtins.ts:1350`).

## Gotchas
- `jsonEncode: 'text'` is required on `int8`, `numeric`, their alternates and `timestamptz:string`;
  `int8.decodeJson` rejects an unsafe JSON number and `numeric.decodeJson` rejects any JSON number
  (`packages/pg-prime/src/codec/builtins.ts:185`, `packages/pg-prime/src/codec/builtins.ts:355`).
- `timestamp.decodeJson` replaces PG's JSON `T` separator with a space; `timestamptz` parses both
  spellings (`packages/pg-prime/src/codec/builtins.ts:625`).
- `timestamptzCodec` truncates microseconds to milliseconds and throws on `infinity`/`-infinity`;
  use `timestamptzStringCodec` for either (`packages/pg-prime/src/codec/builtins.ts:648`, `packages/pg-prime/src/codec/builtins.ts:660`).
- `dateCodec`/`timestampCodec` decode verbatim and encode any string unchecked (`'infinity'`,
  `BC` dates survive) (`packages/pg-prime/src/codec/builtins.ts:586`, `packages/pg-prime/src/codec/builtins.ts:612`).
- `numericNumberCodec` decodes with bare `Number(raw)`, no validation and no precision guard
  (`packages/pg-prime/src/codec/builtins.ts:378`).
- `uuidCodec.encode` lowercases; `bpcharCodec` keeps PG's space padding; `bpcharCodec.sqlName` is
  `char`, while `charCodec` is the one-byte `"char"` (`packages/pg-prime/src/codec/builtins.ts:416`, `packages/pg-prime/src/codec/builtins.ts:436`).
- `bytea` decode requires `bytea_output = 'hex'` and a valid nibble table lookup
  (`packages/pg-prime/src/codec/builtins.ts:1018`).
- `json`/`jsonb`/`vector` elements and `unknown` are array leaves: `jsonb[]` holding `[[1,2]]`
  is one element (`packages/pg-prime/src/codec/builtins.ts:1071`).
- `undefined` inside an array is a `PgEncodeError`, not NULL (`packages/pg-prime/src/codec/builtins.ts:1114`).
- `arrayCodecOf` memoises on a `WeakMap` so `arrayCodecOf(textCodec)` is one object everywhere,
  including inside every `Registry` (`packages/pg-prime/src/codec/builtins.ts:1206`).
- `unknownCodec` refuses objects other than `Date`/`Uint8Array`, `undefined`, functions and
  symbols; there is no `JSON.stringify` fallback (`packages/pg-prime/src/codec/builtins.ts:1266`).
- `unknownCodec` is not in `builtinCodecs()`; `Registry` adds it by name only.

## Tests
- `packages/pg-prime/test/codec/builtins.test.ts` — int8, numeric, timestamptz/timestamp, bool/uuid/float8/bytea/json,
  alternates by name.
- `packages/pg-prime/test/codec/r5-golden.test.ts` — depth 0 equals depth 3 for every built-in and alternate; negative
  control without `::text` at `packages/pg-prime/test/codec/r5-golden.test.ts:346`.
- `packages/pg-prime/test/codec/decoding-strictness.test.ts`, `packages/pg-prime/test/codec/encoding-policy.test.ts`,
  `packages/pg-prime/test/codec/date.test.ts`, `packages/pg-prime/test/codec/interval.test.ts` — strict spellings, `unknownCodec`,
  `Date` encoding, interval styles.
- Run (live project): `pnpm --filter pg-prime exec vitest run test/codec`.
- Not covered: malformed text through `numericNumberCodec.decodeText`, which yields `NaN` silently.
