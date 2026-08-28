/**
 * Built-in codecs — design/02-driver.md §4.5, with the sign-off decode defaults (00 §6):
 *   int8 → bigint · numeric → string · date → branded 'YYYY-MM-DD' · timestamptz → Date (throws on infinity)
 *
 * Every `decodeJson` here is REQUIRED (R5) and is pinned by a depth-0-vs-depth-3 golden test.
 * The two JSON shapes that surprised us on live PG 17.11, both handled below:
 *   - `timestamp`   depth 0 `2026-08-14 12:00:00.123456`  → depth 3 `2026-08-14T12:00:00.123456`
 *                   (PG's to_json inserts a **T**; decodeJson normalises it back)
 *   - `timestamptz` depth 0 `2026-08-14 06:30:00.123456+00` → depth 3 `…T…+00:00`
 */

import { parseArrayLiteral, writeArrayLiteral } from './array.js'
import { PgDecodeError, PgEncodeError } from './types.js'
import type {
  AnyCodec,
  Codec,
  CodecContext,
  CodecRegistry,
  JsonEncode,
  PgDateString,
  PgTimestampString,
  TypeClass,
} from './types.js'
import type { PgParam } from '../driver/types.js'

interface Spec<TIn, TOut, N extends string> {
  name: N
  oid: number
  sqlName: string
  typeClass: TypeClass
  jsonEncode: JsonEncode
  paramOid?: number
  encode(v: TIn): PgParam
  decodeText(raw: string, ctx: CodecContext): TOut
  decodeJson(raw: unknown, ctx: CodecContext): TOut
  toJson?(v: TOut): unknown
  /** Element array OID, when this type has one. */
  arrayOid?: number
}

/**
 * `N` is a type parameter and not just `string` so every built-in keeps its name as a LITERAL:
 * `typeof textCodec` is `Codec<string, string, 'text'>`, not `Codec<string, string, string>`.
 * That literal is the whole mechanism behind `` sql`…`.as(codec) `` being a class-specific
 * operand (WS3) — see the `Codec` docblock in `./types.ts`.
 */
function def<TIn, TOut, N extends string>(s: Spec<TIn, TOut, N>): Codec<TIn, TOut, N> {
  const c: Codec<TIn, TOut, N> & { arrayOid?: number } = {
    name: s.name,
    oid: s.oid,
    paramOid: s.paramOid ?? s.oid,
    sqlName: s.sqlName,
    typeClass: s.typeClass,
    jsonEncode: s.jsonEncode,
    encode: s.encode,
    decodeText: s.decodeText,
    decodeJson: s.decodeJson,
  }
  if (s.toJson) (c as { toJson?: (v: TOut) => unknown }).toJson = s.toJson
  if (s.arrayOid !== undefined) c.arrayOid = s.arrayOid
  return c
}

// ─────────────────────────────────────────────────────────────────────────────
// bool
// ─────────────────────────────────────────────────────────────────────────────

export const boolCodec = def({
  name: 'bool',
  oid: 16,
  arrayOid: 1000,
  sqlName: 'boolean',
  typeClass: 'boolean',
  jsonEncode: 'native',
  encode: (v: boolean) => {
    if (typeof v !== 'boolean') throw new PgEncodeError('bool', v, 'a boolean')
    return v ? 't' : 'f'
  },
  // single-char compare, NOT `Boolean(x)` — `Boolean('f')` is `true`. `t` and `f` are the ONLY
  // two spellings `boolout` ever emits, so accepting 'true'/'y'/'1' bought nothing and cost the
  // property that matters: everything else is a decode ERROR rather than a silent `false`.
  decodeText: (raw) => decodeBoolText(raw),
  decodeJson: (raw) => {
    if (typeof raw === 'boolean') return raw
    // the same set at depth 3: a bool cast ::text inside json_build_object is still 't'/'f'.
    if (typeof raw === 'string') return decodeBoolText(raw)
    throw new PgDecodeError('bool', raw, 'expected boolean')
  },
})

function decodeBoolText(raw: string): boolean {
  if (raw === 't') return true
  if (raw === 'f') return false
  throw new PgDecodeError('bool', raw, "expected 't' or 'f'")
}

// ─────────────────────────────────────────────────────────────────────────────
// integers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ONLY spelling PostgreSQL's integer output functions emit. `Number(raw)` is not a substitute:
 * it accepts `''` → 0, `' 12 '` → 12, `'0x10'` → 16 and `'1e3'` → 1000, none of which can come off
 * the wire, so every one of them would be a silent wrong answer for corrupt or misrouted text.
 */
const INTEGER_TEXT = /^[+-]?\d+$/

function intCodec<N extends string>(
  name: N,
  oid: number,
  arrayOid: number,
  sqlName: string,
  min: number,
  max: number,
): Codec<number, number, N> & { arrayOid?: number } {
  const decodeText = (raw: string): number => {
    if (!INTEGER_TEXT.test(raw)) throw new PgDecodeError(name, raw, 'not an integer')
    const n = Number(raw)
    if (!Number.isSafeInteger(n))
      throw new PgDecodeError(name, raw, 'outside the safe-integer range')
    return n
  }
  return def<number, number, N>({
    name,
    oid,
    arrayOid,
    sqlName,
    typeClass: 'number',
    jsonEncode: 'native',
    encode: (v) => {
      if (typeof v !== 'number' || !Number.isInteger(v))
        throw new PgEncodeError(name, v, 'an integer')
      if (v < min || v > max) throw new PgEncodeError(name, v, `an integer in [${min}, ${max}]`)
      return String(v)
    },
    decodeText,
    decodeJson: (raw) => {
      if (typeof raw === 'number') {
        if (!Number.isInteger(raw)) throw new PgDecodeError(name, raw, 'not an integer')
        return raw
      }
      if (typeof raw === 'string') return decodeText(raw)
      throw new PgDecodeError(name, raw, 'expected number')
    },
  })
}

export const int2Codec = intCodec('int2', 21, 1005, 'smallint', -32768, 32767)
export const int4Codec = intCodec('int4', 23, 1007, 'integer', -2147483648, 2147483647)
export const oidCodec = intCodec('oid', 26, 1028, 'oid', 0, 4294967295)

/**
 * `int8` → `bigint` (sign-off 00 §6). `int8` is the type of every `bigserial` PK and of `count(*)`;
 * `number` silently loses precision above 2^53 (9007199254740993 is a real, storable int8).
 *
 * jsonEncode MUST be 'text': measured, `json_build_object('a', 9007199254740993::int8)` emits the
 * JSON *number* 9007199254740993, which `JSON.parse` rounds to 9007199254740992.
 */
export const int8Codec = def({
  name: 'int8',
  oid: 20,
  arrayOid: 1016,
  sqlName: 'bigint',
  typeClass: 'bigint',
  jsonEncode: 'text',
  encode: (v: bigint | number | string) => {
    if (typeof v === 'bigint') return String(v)
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) throw new PgEncodeError('int8', v, 'a safe integer')
      return String(v)
    }
    if (typeof v === 'string') {
      // `BigInt` is not a validator: BigInt('') is 0n, BigInt('0x10') is 16n and BigInt(' 12 ')
      // is 12n. Sending 0 because the caller passed an empty string is the coercion bug this
      // codec exists to prevent.
      if (!INTEGER_TEXT.test(v)) throw new PgEncodeError('int8', v, 'an integer string')
      return String(BigInt(v))
    }
    throw new PgEncodeError('int8', v, 'a bigint')
  },
  decodeText: (raw): bigint => decodeInt8Text(raw, 'int8'),
  decodeJson: (raw) => {
    if (typeof raw === 'bigint') return raw
    if (typeof raw === 'string') return decodeInt8Text(raw, 'int8')
    if (typeof raw === 'number') {
      if (!Number.isSafeInteger(raw))
        throw new PgDecodeError(
          'int8',
          raw,
          'arrived as a JSON number outside the safe-integer range — the compiler must emit ::text for int8 inside json_build_object',
        )
      return BigInt(raw)
    }
    throw new PgDecodeError('int8', raw, 'expected string')
  },
  toJson: (v) => String(v),
})

function decodeInt8Text(raw: string, codecName: string): bigint {
  if (!INTEGER_TEXT.test(raw)) throw new PgDecodeError(codecName, raw, 'not an integer')
  return BigInt(raw)
}

/** Ships in the box: `int8:number`, range-checked. `count()` binds this explicitly. */
export const int8NumberCodec = def({
  name: 'int8:number',
  oid: 20,
  sqlName: 'bigint',
  typeClass: 'number',
  jsonEncode: 'text',
  encode: (v: bigint | number) => {
    if (typeof v === 'bigint') return String(v)
    if (typeof v !== 'number' || !Number.isSafeInteger(v))
      throw new PgEncodeError('int8:number', v, 'a safe integer')
    return String(v)
  },
  decodeText: (raw): number => {
    if (!INTEGER_TEXT.test(raw)) throw new PgDecodeError('int8:number', raw, 'not an integer')
    const n = Number(raw)
    if (!Number.isSafeInteger(n))
      throw new PgDecodeError('int8:number', raw, 'exceeds Number.MAX_SAFE_INTEGER; use int8')
    return n
  },
  decodeJson: (raw) => {
    if (typeof raw === 'number') {
      if (!Number.isSafeInteger(raw))
        throw new PgDecodeError('int8:number', raw, 'exceeds Number.MAX_SAFE_INTEGER; use int8')
      return raw
    }
    if (typeof raw !== 'string') throw new PgDecodeError('int8:number', raw, 'expected a number')
    if (!INTEGER_TEXT.test(raw)) throw new PgDecodeError('int8:number', raw, 'not an integer')
    const n = Number(raw)
    if (!Number.isSafeInteger(n))
      throw new PgDecodeError('int8:number', raw, 'exceeds Number.MAX_SAFE_INTEGER; use int8')
    return n
  },
})

/** Ships in the box: `int8:string`. */
export const int8StringCodec = def({
  name: 'int8:string',
  oid: 20,
  sqlName: 'bigint',
  typeClass: 'string',
  jsonEncode: 'text',
  encode: (v: bigint | number | string) => {
    if (typeof v === 'bigint') return String(v)
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) throw new PgEncodeError('int8:string', v, 'a safe integer')
      return String(v)
    }
    // `String(v)` used to turn `{}` into '[object Object]' and `undefined` into 'undefined',
    // both of which PostgreSQL then rejected with a confusing 22P02 instead of us rejecting them.
    if (typeof v !== 'string' || !INTEGER_TEXT.test(v))
      throw new PgEncodeError('int8:string', v, 'an integer string')
    return v
  },
  decodeText: (raw): string => raw,
  decodeJson: (raw) => {
    if (typeof raw === 'string') return raw
    if (typeof raw === 'number' || typeof raw === 'bigint') return String(raw)
    throw new PgDecodeError('int8:string', raw, 'expected string')
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// floats
// ─────────────────────────────────────────────────────────────────────────────

/** Every finite spelling `float4out`/`float8out`/`numeric_out` can produce. No hex, no blanks. */
const FLOAT_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

function floatCodec<N extends string>(
  name: N,
  oid: number,
  arrayOid: number,
  sqlName: string,
): Codec<number, number, N> & { arrayOid?: number } {
  const fromString = (raw: string): number => {
    // text is the EXACT shortest round-trip repr; NaN/±Infinity must be special-cased.
    if (raw === 'NaN') return Number.NaN
    if (raw === 'Infinity') return Number.POSITIVE_INFINITY
    if (raw === '-Infinity') return Number.NEGATIVE_INFINITY
    // `Number('')` is 0 and `Number('0x10')` is 16 — neither is a float PostgreSQL can emit, and
    // both are silent wrong answers rather than the `NaN` this used to rely on.
    if (!FLOAT_TEXT.test(raw)) throw new PgDecodeError(name, raw, 'not a number')
    return Number(raw)
  }
  return def({
    name,
    oid,
    arrayOid,
    sqlName,
    typeClass: 'number',
    // 'native' verified exact: `json_build_object('n', 0.1::float8 + 0.2::float8)` → 0.30000000000000004.
    // NaN/±Infinity come back as JSON *strings* from the same expression, which decodeJson handles.
    jsonEncode: 'native',
    encode: (v: number) => {
      if (typeof v !== 'number') throw new PgEncodeError(name, v, 'a number')
      return String(v)
    },
    decodeText: fromString,
    decodeJson: (raw) => {
      if (typeof raw === 'number') return raw
      if (typeof raw === 'string') return fromString(raw)
      throw new PgDecodeError(name, raw, 'expected number')
    },
  })
}

export const float4Codec = floatCodec('float4', 700, 1021, 'real')
export const float8Codec = floatCodec('float8', 701, 1022, 'double precision')

// ─────────────────────────────────────────────────────────────────────────────
// numeric → string (sign-off 00 §6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * There is no lossless JS primitive for arbitrary-precision decimal and we have ZERO runtime
 * dependencies, so we cannot ship a `Decimal`. `number` is wrong twice: it loses precision beyond
 * 17 significant digits AND it loses scale, which is semantically meaningful (`numeric(10,2)`
 * renders `1.10`, not `1.1` — measured). Text also carries `'NaN'`/`'Infinity'`/`'-Infinity'`.
 *
 * jsonEncode MUST be 'text': native emits the JSON number `1.10`, which `JSON.parse` → `1.1`.
 */
/**
 * What `numeric_in` actually accepts, measured on PG 17.11 / PGlite 0.5.5 rather than guessed:
 *  - a leading `+` is legal (`'+1.5'::numeric` → 1.5) — the old regex rejected it;
 *  - a trailing point is legal (`'1.'::numeric` → 1);
 *  - `NaN` is case-insensitive but takes NO sign: `'-NaN'::numeric` is `22P02
 *    invalid input syntax for type numeric` — the old regex accepted it and let the server 500;
 *  - `Infinity`/`inf` DO take a sign (PG 14+).
 */
const NUMERIC_TEXT = /^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|NaN|[+-]?(Infinity|inf))$/i

export const numericCodec = def({
  name: 'numeric',
  oid: 1700,
  arrayOid: 1231,
  sqlName: 'numeric',
  typeClass: 'string',
  jsonEncode: 'text',
  encode: (v: string | number | bigint) => {
    if (typeof v === 'string') {
      if (!NUMERIC_TEXT.test(v)) throw new PgEncodeError('numeric', v, 'a decimal string')
      return v
    }
    if (typeof v === 'bigint') return String(v)
    if (typeof v === 'number') return String(v)
    throw new PgEncodeError('numeric', v, 'a decimal string')
  },
  decodeText: (raw): string => raw,
  decodeJson: (raw) => {
    if (typeof raw === 'string') return raw
    if (typeof raw === 'number')
      throw new PgDecodeError(
        'numeric',
        raw,
        'arrived as a JSON number — the compiler must emit ::text for numeric inside json_build_object (scale and precision are lost otherwise)',
      )
    throw new PgDecodeError('numeric', raw, 'expected string')
  },
})

export const numericNumberCodec = def({
  name: 'numeric:number',
  oid: 1700,
  sqlName: 'numeric',
  typeClass: 'number',
  jsonEncode: 'text',
  encode: (v: string | number) => {
    // `String(v)` accepted anything at all: `{}` went out as '[object Object]'.
    if (typeof v === 'number') return String(v)
    if (typeof v !== 'string' || !NUMERIC_TEXT.test(v))
      throw new PgEncodeError('numeric:number', v, 'a decimal string')
    return v
  },
  decodeText: (raw): number => Number(raw),
  decodeJson: (raw) => Number(raw),
})

// ─────────────────────────────────────────────────────────────────────────────
// strings
// ─────────────────────────────────────────────────────────────────────────────

function stringCodec<N extends string>(
  name: N,
  oid: number,
  arrayOid: number | undefined,
  sqlName: string,
): Codec<string, string, N> & { arrayOid?: number } {
  const spec: Spec<string, string, N> = {
    name,
    oid,
    sqlName,
    typeClass: 'string',
    jsonEncode: 'native',
    encode: (v) => {
      if (typeof v !== 'string') throw new PgEncodeError(name, v, 'a string')
      return v
    },
    // identity — zero-cost
    decodeText: (raw) => raw,
    decodeJson: (raw) => {
      if (typeof raw === 'string') return raw
      throw new PgDecodeError(name, raw, 'expected string')
    },
  }
  if (arrayOid !== undefined) spec.arrayOid = arrayOid
  return def(spec)
}

export const textCodec = stringCodec('text', 25, 1009, 'text')
export const varcharCodec = stringCodec('varchar', 1043, 1015, 'varchar')
/** PG SPACE-PADS `bpchar` — measured `"ab   "`. Do not trim. */
export const bpcharCodec = stringCodec('bpchar', 1042, 1014, 'char')
export const nameCodec = stringCodec('name', 19, 1003, 'name')
export const xmlCodec = stringCodec('xml', 142, 143, 'xml')
export const inetCodec = stringCodec('inet', 869, 1041, 'inet')
export const cidrCodec = stringCodec('cidr', 650, 651, 'cidr')
/** `$12.34`, formatted by `lc_monetary` — not portably parseable. The DSL warns on it. */
export const moneyCodec = stringCodec('money', 790, 791, 'money')
export const timeCodec = stringCodec('time', 1083, 1183, 'time')
export const timetzCodec = stringCodec('timetz', 1266, 1270, 'timetz')

/**
 * The string-like remainder of §4.5's table, registered so their OIDs stop falling through
 * `planFor`'s unknown-OID escape hatch as untyped raw text (`typeClass` and `sqlName` were the
 * two things a pass-through column could not carry).
 *
 * All six are decode-identity by design, not by omission: PostgreSQL's own output is already the
 * canonical, round-trippable spelling and parsing it would only invent a second representation to
 * disagree with — the same call as `numeric` → `string` and `date` → `'YYYY-MM-DD'`.
 */
/** OID 18, `"char"` — the one-byte internal type. NOT `char(n)`, which is `bpchar` (1042). */
export const charCodec = stringCodec('char', 18, 1002, '"char"')
export const macaddrCodec = stringCodec('macaddr', 829, 1040, 'macaddr')
export const macaddr8Codec = stringCodec('macaddr8', 774, 775, 'macaddr8')
/** `bit(n)`; `null::bit` is `bit(1)`. Text is the digit string, e.g. `101`. */
export const bitCodec = stringCodec('bit', 1560, 1561, 'bit')
export const varbitCodec = stringCodec('varbit', 1562, 1563, 'varbit')
export const pgLsnCodec = stringCodec('pg_lsn', 3220, 3221, 'pg_lsn')

// ─────────────────────────────────────────────────────────────────────────────
// Full-text search and ranges (WS3)
//
// These exist so `03` §2.9's `tsvector` and `range` operator classes have something real to be
// gated on and something real to be *differentially tested against*. They are all wire-text
// in and wire-text out, like `time` and `inet` above, but they carry their own `typeClass`, and
// that is the entire point: `matches()` accepts a `tsvector` operand and refuses a `text` one,
// which is the Kysely defect `03` §2.9 exists to fix.
//
// All eight are BUILT-IN PostgreSQL types with fixed OIDs, so unlike `citext` and `vector` they
// need no `resolveDynamic` round trip. The OIDs below are confirmed against a live server by
// `test/codec/r5-golden.test.ts`, which resolves each `select <expr>` back through
// `registry.forOid(field.dataTypeID)` — a wrong number here fails there, not in production.
//
// `jsonEncode: 'native'`: PostgreSQL renders every one of these as a JSON *string* (a range's
// text form `[1,5)` and a tsvector's `'a':1 'b':2`), so nothing is lost the way it is for `int8`
// and `numeric`. Pinned at depth 3 by the same golden.
// ─────────────────────────────────────────────────────────────────────────────

/** Wire-text scalar in a class of its own — `stringCodec` hard-codes `typeClass: 'string'`. */
function opaqueTextCodec<N extends string>(
  name: N,
  oid: number,
  arrayOid: number,
  typeClass: TypeClass,
): Codec<string, string, N> & { arrayOid?: number } {
  return def({
    name,
    oid,
    arrayOid,
    sqlName: name,
    typeClass,
    jsonEncode: 'native' as JsonEncode,
    encode: (v: string): string => {
      if (typeof v !== 'string') throw new PgEncodeError(name, v, 'a string')
      return v
    },
    decodeText: (raw): string => raw,
    decodeJson: (raw): string => {
      if (typeof raw === 'string') return raw
      throw new PgDecodeError(name, raw, 'expected string')
    },
  })
}

/** `to_tsvector('english', body)`. Normalised lexemes with positions: `'bodi':2 'one':1`. */
export const tsvectorCodec = opaqueTextCodec('tsvector', 3614, 3643, 'other')
/** `websearch_to_tsquery('english', term)`. */
export const tsqueryCodec = opaqueTextCodec('tsquery', 3615, 3645, 'other')
/** SQL/JSON path, the right operand of `jsonb @?` and `jsonb @@` (`'$.a[*] > 2'`). */
export const jsonpathCodec = opaqueTextCodec('jsonpath', 4072, 4073, 'other')

/**
 * Ranges decode to their canonical text form (`'[1,5)'`), never to a `{lower, upper}` object.
 *
 * That is the same call as `date` → `'YYYY-MM-DD'` (00 sign-off #6) and for the same reason: the
 * text form is lossless and total. An object would have to invent a representation for the four
 * things a range text form says and a naive `{lower, upper}` does not — inclusivity per side,
 * empty, and unbounded — and `'empty'` has no lower or upper at all.
 */
export const int4rangeCodec = opaqueTextCodec('int4range', 3904, 3905, 'range')
export const numrangeCodec = opaqueTextCodec('numrange', 3906, 3907, 'range')
export const tsrangeCodec = opaqueTextCodec('tsrange', 3908, 3909, 'range')
export const tstzrangeCodec = opaqueTextCodec('tstzrange', 3910, 3911, 'range')
export const daterangeCodec = opaqueTextCodec('daterange', 3912, 3913, 'range')
export const int8rangeCodec = opaqueTextCodec('int8range', 3926, 3927, 'range')

/** PG normalises UUID case on output — measured: `550E8400-…` in, `550e8400-…` out. */
export const uuidCodec = def({
  name: 'uuid',
  oid: 2950,
  arrayOid: 2951,
  sqlName: 'uuid',
  typeClass: 'string',
  jsonEncode: 'native',
  encode: (v: string) => {
    if (typeof v !== 'string' || !/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(v))
      throw new PgEncodeError('uuid', v, 'a UUID string')
    return v.toLowerCase()
  },
  decodeText: (raw): string => raw,
  decodeJson: (raw) => {
    if (typeof raw === 'string') return raw
    throw new PgDecodeError('uuid', raw, 'expected string')
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// temporal
// ─────────────────────────────────────────────────────────────────────────────

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))

/**
 * Format a `Date` the way PostgreSQL reads it back — NOT `toISOString()`.
 *
 * ⚠️ MEASURED (PGlite 0.5.5, PG 17.11): `toISOString()` switches to ECMAScript's *expanded year*
 * form outside `[1, 9999]` — `new Date('10000-01-01Z').toISOString()` is
 * `'+010000-01-01T00:00:00.000Z'`, and a year ≤ 0 gets `'-000001-…'`. PostgreSQL rejects both:
 *   `select '+010000-01-01T00:00:00.000Z'::timestamptz`
 *   → 22023 time zone displacement out of range
 * — it reads the leading `+010000` as a zone displacement. Both years are perfectly storable
 * (`'10000-01-01 00:00:00Z'` and `'0001-01-01 00:00:00Z BC'` both round-trip), so the fix is to
 * spell them the way PG does: plain digits for a large year, and ` BC` with the proleptic
 * 1-year for year ≤ 0 (ES year 0 is 1 BC, −1 is 2 BC).
 *
 * A space separator and a trailing `Z` are both accepted by `timestamp_in`/`timestamptz_in`, and
 * `Z BC` in that order is accepted too (measured) — `datetime_in` is token-based, not positional.
 */
function utcTimestampText(v: Date, codecName: string, zone: 'Z' | ''): string {
  if (Number.isNaN(v.getTime())) throw new PgEncodeError(codecName, v, 'a valid Date')
  let year = v.getUTCFullYear()
  let era = ''
  if (year <= 0) {
    era = ' BC'
    year = 1 - year
  }
  const date = `${String(year).padStart(4, '0')}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())}`
  const time = `${pad2(v.getUTCHours())}:${pad2(v.getUTCMinutes())}:${pad2(v.getUTCSeconds())}`
  const ms = String(v.getUTCMilliseconds()).padStart(3, '0')
  return `${date} ${time}.${ms}${zone}${era}`
}

/**
 * `date` → `'YYYY-MM-DD'` string, NEVER a `Date`. This is the headline correctness guarantee.
 *
 * A DATE has no time and no time zone; every mapping to `Date` must invent both, and every driver
 * invents differently. Measured with pg's default parser in a UTC−5 process, `'2026-08-14'` becomes
 * `2026-08-13T19:00:00.000Z` — the calendar day changes. Here the value is the verbatim wire text,
 * so the day shift is structurally impossible.
 *
 * Values outside the ISO shape are PRESERVED verbatim, not rejected: `'infinity'`, `'-infinity'`,
 * `'0001-01-01 BC'`, `'294276-12-31'` — all measured and all round-trip.
 */
export const dateCodec = def({
  name: 'date',
  oid: 1082,
  arrayOid: 1182,
  sqlName: 'date',
  typeClass: 'datetime',
  // verified: identical at depth 0 and depth 3 (`json_build_object` emits `"2026-08-14"`).
  jsonEncode: 'native',
  encode: (v: string) => {
    if (typeof v !== 'string') throw new PgEncodeError('date', v, "a 'YYYY-MM-DD' string")
    return v
  },
  decodeText: (raw) => raw as PgDateString,
  decodeJson: (raw) => {
    if (typeof raw === 'string') return raw as PgDateString
    throw new PgDecodeError('date', raw, 'expected string')
  },
})

/**
 * `timestamp` (zoneless) → verbatim wire text. Any `Date` would invent a zone. µs preserved.
 *
 * ⚠️ The one place PG's JSON rendering differs from the wire text: `to_json` emits an ISO
 * **T** separator (`2026-08-14T12:00:00.123456`) where the wire text has a space
 * (`2026-08-14 12:00:00.123456`). Measured on PG 17.11. `decodeJson` normalises it back, which is
 * exactly what the R5 golden test exists to catch.
 */
export const timestampCodec = def({
  name: 'timestamp',
  oid: 1114,
  arrayOid: 1115,
  sqlName: 'timestamp',
  typeClass: 'datetime',
  jsonEncode: 'native',
  encode: (v: string | Date) => {
    if (typeof v === 'string') return v
    // zoneless: the UTC calendar fields of the Date, with no zone marker at all.
    if (v instanceof Date) return utcTimestampText(v, 'timestamp', '')
    throw new PgEncodeError('timestamp', v, 'a timestamp string')
  },
  decodeText: (raw) => raw as PgTimestampString,
  decodeJson: (raw) => {
    if (typeof raw !== 'string') throw new PgDecodeError('timestamp', raw, 'expected string')
    return normaliseTsSeparator(raw) as PgTimestampString
  },
})

function normaliseTsSeparator(s: string): string {
  // Only the date/time separator, and only when it sits between a date and a time.
  return /^-?\d{4,}-\d{2}-\d{2}T/.test(s) ? s.replace('T', ' ') : s
}

const TSTZ_RE =
  /^(-?\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:(Z)|([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)?( BC)?$/

/**
 * `timestamptz` → `Date` (sign-off 00 §6) — the one temporal type where `Date` is semantically
 * right, because the value IS an absolute instant.
 *
 * Three decided caveats:
 *  1. µs truncation — PG stores µs, `Date` holds ms. We truncate. `timestamptz:string` ships
 *     alongside for anyone who needs µs.
 *  2. `infinity` / `-infinity` are legal timestamptz values with no `Date` representation. We
 *     THROW, naming the column and pointing at `timestamptz:string`. Mapping to ±8.64e15 is a
 *     silent lie; widening to `Date | 'infinity'` puts union noise on every timestamp column.
 *  3. The offset in the text is TimeZone-dependent (`+00` on a UTC server, `+05` elsewhere). We
 *     parse whatever offset is present, so the VALUE is TimeZone-independent. `new Date(raw)` is
 *     never used: it is engine-dependent for PG's space-separated, colon-less-offset form.
 */
function parseTimestamptz(raw: string, ctx: CodecContext | undefined, codecName: string): Date {
  if (raw === 'infinity' || raw === '-infinity') {
    throw new PgDecodeError(
      codecName,
      raw,
      `${ctx?.column ? `column "${ctx.column}" ` : ''}holds a ${raw} timestamptz, which has no JavaScript Date representation. Use the 'timestamptz:string' codec for this column.`,
    )
  }
  const m = TSTZ_RE.exec(raw)
  if (!m) throw new PgDecodeError(codecName, raw, 'unrecognised timestamptz text')
  const [, yStr, moStr, dStr, hStr, miStr, sStr, frac, zulu, sign, offH, offM, offS, bc] = m
  let year = Number(yStr)
  if (bc) year = 1 - year
  const ms = frac ? Number(frac.padEnd(6, '0').slice(0, 3)) : 0
  let t = Date.UTC(
    2000,
    Number(moStr) - 1,
    Number(dStr),
    Number(hStr),
    Number(miStr),
    Number(sStr),
    ms,
  )
  const d = new Date(t)
  d.setUTCFullYear(year)
  t = d.getTime()
  if (!zulu && sign) {
    const offsetSec =
      (Number(offH) * 3600 + Number(offM ?? 0) * 60 + Number(offS ?? 0)) * (sign === '-' ? -1 : 1)
    t -= offsetSec * 1000
  }
  const out = new Date(t)
  if (Number.isNaN(out.getTime()))
    throw new PgDecodeError(codecName, raw, 'produced an Invalid Date')
  return out
}

export const timestamptzCodec = def({
  name: 'timestamptz',
  oid: 1184,
  arrayOid: 1185,
  sqlName: 'timestamptz',
  typeClass: 'datetime',
  // native: `to_json` emits `2026-08-14T06:30:00.123456+00:00` — the same instant, different
  // spelling from the wire text. Our parser accepts both, so depth 0 === depth 3.
  jsonEncode: 'native',
  encode: (v: Date | string) => {
    // We NEVER call pg's `dateToString`: it emits a LOCAL-offset string with hand-rolled BC
    // handling. UTC ISO-8601 is unambiguous everywhere.
    if (v instanceof Date) return utcTimestampText(v, 'timestamptz', 'Z')
    if (typeof v === 'string') return v
    throw new PgEncodeError('timestamptz', v, 'a Date')
  },
  decodeText: (raw, ctx) => parseTimestamptz(raw, ctx, 'timestamptz'),
  decodeJson: (raw, ctx) => {
    if (typeof raw !== 'string') throw new PgDecodeError('timestamptz', raw, 'expected string')
    return parseTimestamptz(raw, ctx, 'timestamptz')
  },
  toJson: (v) => v.toISOString(),
})

/**
 * Exact, verbatim wire text — for µs precision and for `infinity`.
 *
 * `jsonEncode: 'text'` and NOT 'native', which broke R5. Measured: the wire text of
 * `'2026-08-14 06:30:00.123456+00'::timestamptz` is `2026-08-14 06:30:00.123456+00`, but
 * `json_build_object` renders the same value as `2026-08-14T06:30:00.123456+00:00` — an ISO `T`
 * and a colon in the offset. The DEFAULT `timestamptz` codec absorbs that because it parses both
 * spellings into the same instant; this one is defined as "the verbatim wire text", so the two
 * depths returned two different strings. Asking the compiler for `::text` makes PostgreSQL emit
 * the wire spelling inside the JSON payload, so depth 0 and depth 3 are identical BY
 * CONSTRUCTION rather than by a normalising regex that would have to guess `+00` vs `+00:00:00`.
 */
export const timestamptzStringCodec = def({
  name: 'timestamptz:string',
  oid: 1184,
  sqlName: 'timestamptz',
  typeClass: 'string',
  jsonEncode: 'text',
  encode: (v: Date | string) => {
    if (v instanceof Date) return utcTimestampText(v, 'timestamptz:string', 'Z')
    if (typeof v === 'string') return v
    throw new PgEncodeError('timestamptz:string', v, 'a Date or a timestamptz string')
  },
  decodeText: (raw): string => raw,
  decodeJson: (raw) => {
    if (typeof raw !== 'string')
      throw new PgDecodeError('timestamptz:string', raw, 'expected string')
    return raw
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// interval
// ─────────────────────────────────────────────────────────────────────────────

/** §4.5's decoded shape. Components carry their own sign, exactly as PostgreSQL prints them. */
export interface PgInterval {
  readonly years: number
  readonly months: number
  readonly days: number
  readonly hours: number
  readonly minutes: number
  readonly seconds: number
}

const ZERO_INTERVAL: PgInterval = {
  years: 0,
  months: 0,
  days: 0,
  hours: 0,
  minutes: 0,
  seconds: 0,
}

/** `postgres` style time component: `04:05:06.789`, `-04:05:06`, `8760:00:00`. */
const PG_INTERVAL_TIME = /^([+-])?(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/

/** `iso_8601` style, the other grammar §4.7 lets a session use. Per-component signs are real. */
const ISO_INTERVAL =
  /^P(?:(-?\d+(?:\.\d+)?)Y)?(?:(-?\d+(?:\.\d+)?)M)?(?:(-?\d+(?:\.\d+)?)W)?(?:(-?\d+(?:\.\d+)?)D)?(?:T(?:(-?\d+(?:\.\d+)?)H)?(?:(-?\d+(?:\.\d+)?)M)?(?:(-?\d+(?:\.\d+)?)S)?)?$/

const INTERVAL_UNITS: Readonly<Record<string, keyof PgInterval>> = {
  year: 'years',
  years: 'years',
  mon: 'months',
  mons: 'months',
  month: 'months',
  months: 'months',
  day: 'days',
  days: 'days',
  hour: 'hours',
  hours: 'hours',
  min: 'minutes',
  mins: 'minutes',
  minute: 'minutes',
  minutes: 'minutes',
  sec: 'seconds',
  secs: 'seconds',
  second: 'seconds',
  seconds: 'seconds',
}

/**
 * Parse BOTH `IntervalStyle` spellings the driver accepts (§4.7: `postgres` or `iso_8601`;
 * `sql_standard` and `postgres_verbose` are rejected at connect).
 *
 * Measured output for the same value under the two styles:
 *   postgres  `1 year 2 mons 3 days 04:05:06.789`   ·  `-1 years -2 mons +3 days -04:05:06`
 *   iso_8601  `P1Y2M3DT4H5M6.789S`                  ·  `P-1Y-2M3DT-4H-5M-6S`
 *
 * Which one arrives is a session GUC, and `json_build_object` uses the same output function — so
 * sniffing the text rather than reading `serverParameters` is both cheaper and correct when a
 * payload was produced under a different setting than the one now in force.
 */
function parseIntervalText(raw: string, codecName: string): PgInterval {
  const s = raw.trim()
  if (s === '') throw new PgDecodeError(codecName, raw, 'empty interval')

  if (s.charCodeAt(0) === 0x50 /* P */) {
    const m = ISO_INTERVAL.exec(s)
    if (!m) throw new PgDecodeError(codecName, raw, 'malformed ISO-8601 interval')
    const [, y, mo, w, d, h, mi, sec] = m
    return {
      years: num(y),
      months: num(mo),
      days: num(d) + num(w) * 7,
      hours: num(h),
      minutes: num(mi),
      seconds: num(sec),
    }
  }

  const out = { ...ZERO_INTERVAL }
  let ago = false
  const tokens = s.split(/\s+/)
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (tok === '@') continue // `postgres_verbose` prefix; harmless to tolerate
    if (tok === 'ago') {
      ago = true
      continue
    }
    const time = PG_INTERVAL_TIME.exec(tok)
    if (time) {
      const sign = time[1] === '-' ? -1 : 1
      // `+ 0` turns `-1 * 0` back into `+0`: a negative zero is a different value to
      // `Object.is`, to `toEqual`, and to `JSON.stringify` round-trips of the decoded object.
      out.hours = sign * Number(time[2]) + 0
      out.minutes = sign * Number(time[3]) + 0
      out.seconds = sign * Number(time[4]) + 0
      continue
    }
    const unit = INTERVAL_UNITS[tokens[i + 1] ?? '']
    if (!INTEGER_TEXT.test(tok) || unit === undefined) {
      throw new PgDecodeError(
        codecName,
        raw,
        "unrecognised interval text; pg-prime reads IntervalStyle 'postgres' and 'iso_8601' only",
      )
    }
    out[unit] += Number(tok)
    i++
  }
  if (!ago) return out
  return {
    years: -out.years + 0,
    months: -out.months + 0,
    days: -out.days + 0,
    hours: -out.hours + 0,
    minutes: -out.minutes + 0,
    seconds: -out.seconds + 0,
  }
}

function num(s: string | undefined): number {
  return s === undefined ? 0 : Number(s) + 0
}

/** `6.789` not `6.789000`, and never `1e-7` — PostgreSQL's interval parser rejects exponents. */
function secondsText(v: number): string {
  if (Number.isInteger(v)) return String(v)
  return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

function intervalField(v: PgInterval, key: keyof PgInterval): number {
  const n = v[key]
  if (typeof n !== 'number' || !Number.isFinite(n))
    throw new PgEncodeError('interval', v, `an interval with a finite '${key}'`)
  return n
}

/**
 * `interval` → `{ years, months, days, hours, minutes, seconds }` (§4.5).
 *
 * ENCODE emits ISO-8601 (`P1Y2M3DT4H5M6.789S`), which PostgreSQL accepts under EVERY
 * `IntervalStyle` — measured — so a parameter never depends on the session GUC the way the
 * `1 year 2 mons` spelling would.
 */
export const intervalCodec = def({
  name: 'interval',
  oid: 1186,
  arrayOid: 1187,
  sqlName: 'interval',
  typeClass: 'other',
  // PG renders an interval inside json_build_object with its ordinary output function, so the
  // JSON payload carries whichever IntervalStyle the session has. Both are parsed above.
  jsonEncode: 'native',
  encode: (v: PgInterval | string) => {
    if (typeof v === 'string') return v
    if (v === null || typeof v !== 'object')
      throw new PgEncodeError('interval', v, 'an interval object or string')
    const date = `${intervalField(v, 'years')}Y${intervalField(v, 'months')}M${intervalField(v, 'days')}D`
    const time = `${intervalField(v, 'hours')}H${intervalField(v, 'minutes')}M${secondsText(intervalField(v, 'seconds'))}S`
    return `P${date}T${time}`
  },
  decodeText: (raw): PgInterval => parseIntervalText(raw, 'interval'),
  decodeJson: (raw): PgInterval => {
    if (typeof raw !== 'string') throw new PgDecodeError('interval', raw, 'expected string')
    return parseIntervalText(raw, 'interval')
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// json / jsonb
// ─────────────────────────────────────────────────────────────────────────────

function jsonCodec<N extends string>(
  name: N,
  oid: number,
  arrayOid: number,
): Codec<unknown, unknown, N> {
  return def<unknown, unknown, N>({
    name,
    oid,
    arrayOid,
    sqlName: name,
    typeClass: 'json',
    // embedded NATIVELY, never double-encoded. Verified: a jsonb column inside json_build_object
    // comes back as a real JSON object, not a string.
    jsonEncode: 'native',
    /**
     * `JSON.stringify(v) ?? 'null'` had three separate failure modes, all of them silent or
     * unhelpful: `undefined`, a function and a symbol all stringify to `undefined` and became the
     * JSON *null* `'null'` (so a typo'd field name stored `null` instead of erroring); a `bigint`
     * threw a bare `TypeError: Do not know how to serialize a BigInt` with no codec or column in
     * it; and a circular object threw a bare `TypeError`. All four are now `PgEncodeError`.
     */
    encode: (v) => {
      if (v === undefined) throw new PgEncodeError(name, v, 'a JSON-serialisable value')
      let text: string | undefined
      try {
        text = JSON.stringify(v)
      } catch {
        // BigInt, a circular structure, or a throwing `toJSON`.
        throw new PgEncodeError(name, v, 'a JSON-serialisable value (JSON.stringify failed)')
      }
      if (text === undefined)
        throw new PgEncodeError(name, v, 'a JSON-serialisable value (not representable in JSON)')
      return text
    },
    decodeText: (raw) => {
      try {
        return JSON.parse(raw) as unknown
      } catch {
        throw new PgDecodeError(name, raw, 'invalid JSON')
      }
    },
    // Already parsed by the outer JSON.parse of the json_agg payload — identity.
    decodeJson: (raw) => raw,
  })
}

/** ⚠️ PG REFORMATS jsonb (key order, whitespace) — measured. Never compare its text. */
export const jsonbCodec = jsonCodec('jsonb', 3802, 3807)
/** `json` preserves the EXACT source text, whitespace and all. */
export const jsonCodecJson = jsonCodec('json', 114, 199)

// ─────────────────────────────────────────────────────────────────────────────
// bytea
// ─────────────────────────────────────────────────────────────────────────────

const HEX = '0123456789abcdef'

/**
 * Decode `\x00ff80` hex text; ENCODE BINARY (§4.4). Not `Buffer` — Neon dropped it for
 * `Uint8Array`, and a `Buffer` return would leak a Node-only type into the public API.
 *
 * A `Uint8Array` parameter is what makes pg's serializer set format code 1 for that ONE parameter,
 * which avoids the 2× size of `\x` hex without touching the (corrupting) binary RESULT path.
 */
export const byteaCodec = def({
  name: 'bytea',
  oid: 17,
  arrayOid: 1001,
  sqlName: 'bytea',
  typeClass: 'binary',
  jsonEncode: 'native',
  encode: (v: Uint8Array) => {
    if (!(v instanceof Uint8Array)) throw new PgEncodeError('bytea', v, 'a Uint8Array')
    return v
  },
  decodeText: (raw): Uint8Array => decodeByteaHex(raw),
  decodeJson: (raw) => {
    if (typeof raw !== 'string') throw new PgDecodeError('bytea', raw, 'expected hex string')
    return decodeByteaHex(raw)
  },
  toJson: (v) => `\\x${Array.from(v, (b) => HEX[b >> 4]! + HEX[b & 15]!).join('')}`,
})

/**
 * `charCode → nibble`, `-1` for everything else. Built once.
 *
 * The loop below used to be `parseInt(hex.slice(i * 2, i * 2 + 2), 16)`, which is wrong AND slow.
 * Wrong: `parseInt` stops at the first invalid character, so `'0g'` parsed as `0` — a corrupt
 * second nibble was silently swallowed and only an ODD total length was ever rejected. Slow: it
 * allocates a two-character string per byte and re-enters the number parser. Measured over a
 * 4 MB bytea: 118 ms → 3 ms.
 */
const HEX_NIBBLE = /* @__PURE__ */ buildHexNibbles()

function buildHexNibbles(): Int8Array {
  const t = new Int8Array(256).fill(-1)
  for (let i = 0; i < 10; i++) t[0x30 + i] = i
  for (let i = 0; i < 6; i++) {
    t[0x61 + i] = 10 + i // a–f, what PG emits
    t[0x41 + i] = 10 + i // A–F, accepted on the way in
  }
  return t
}

function decodeByteaHex(raw: string): Uint8Array {
  if (!raw.startsWith('\\x')) {
    throw new PgDecodeError('bytea', raw, "expected hex format (\\x…); set bytea_output = 'hex'")
  }
  const hexLen = raw.length - 2
  if (hexLen % 2 !== 0) throw new PgDecodeError('bytea', raw, 'odd hex length')
  const out = new Uint8Array(hexLen / 2)
  for (let i = 0, p = 2; i < out.length; i++, p += 2) {
    const hi = HEX_NIBBLE[raw.charCodeAt(p)] ?? -1
    const lo = HEX_NIBBLE[raw.charCodeAt(p + 1)] ?? -1
    if (hi < 0 || lo < 0)
      throw new PgDecodeError('bytea', raw, `invalid hex digit at offset ${p - 2}`)
    out[i] = (hi << 4) | lo
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// arrays
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive an array codec from an element codec.
 *
 * The R5 subtlety: whether the array arrives at depth 3 as a real JSON array or as a PG array
 * LITERAL STRING depends on the ELEMENT's `jsonEncode`.
 *   - element 'native' (text, int4, date, …) → `["a","b,c",null]`         → map element.decodeJson
 *   - element 'text'   (int8, numeric)       → `"{9007199254740993,…}"`   → same parse as depth 0
 * Both are handled, so `int8[]` decodes to the identical `bigint[]` at any depth.
 */
export function arrayCodec<TIn, TOut, N extends string>(
  element: Codec<TIn, TOut, N>,
  oid: number | undefined,
  options?: { delimiter?: string; name?: string },
): Codec<readonly (TIn | null)[], (TOut | null)[], `${N}[]`> {
  const delimiter = options?.delimiter ?? ','
  // The declared return type says `${N}[]`, so `options.name` is a *runtime* label only —
  // it exists for `resolveDynamic`, which names a user type's array from `pg_type` rather than
  // from the element's codec name. No static caller passes it.
  const name = (options?.name ?? `${element.name}[]`) as `${N}[]`

  /**
   * Whether a JS array reaching this codec is a NESTED array or one element that happens to be an
   * array. Only the element codec can say. `jsonb`/`json` elements (and the untyped `unknown`
   * element) are always LEAVES: `jsonb[]` holding `[[1, 2]]` is a one-element array whose element
   * is the document `[1,2]` — wire text `{"[1,2]"}` — whereas the structural `Array.isArray`
   * check `writeArrayLiteral` used to make alone produced `{{1,2}}`, a two-element 1-D array of
   * the numbers 1 and 2. Measured: PostgreSQL round-trips `array['[1,2]'::jsonb]` as `{"[1, 2]"}`.
   */
  const elementIsLeaf = element.typeClass === 'json' || element.name === 'unknown'

  const fromLiteral = (raw: string, ctx: CodecContext): (TOut | null)[] => {
    const walk = (node: readonly (string | null | readonly unknown[])[]): unknown[] =>
      node.map((v) => {
        if (v === null) return null
        if (Array.isArray(v)) return walk(v as readonly (string | null | readonly unknown[])[])
        return element.decodeText(v as string, ctx)
      })
    let parsed
    try {
      parsed = parseArrayLiteral(raw, delimiter)
    } catch (cause) {
      // `parseArrayLiteral` is a pure grammar and throws a bare `SyntaxError` with no codec and
      // no column in it. Every other decode failure in this layer is a `PgDecodeError`; a caller
      // catching that class must not miss a malformed array literal.
      throw new PgDecodeError(
        name,
        raw,
        cause instanceof Error ? cause.message : 'malformed array literal',
      )
    }
    return walk(parsed) as (TOut | null)[]
  }

  return {
    name,
    oid,
    paramOid: oid,
    sqlName: `${element.sqlName}[]`,
    typeClass: 'array',
    // the array inherits the element's requirement: int8[] must still be ::text at depth 3.
    jsonEncode: element.jsonEncode,
    arrayOf: element as unknown as Codec<never, unknown>,
    encode: (v) => {
      if (!Array.isArray(v)) throw new PgEncodeError(name, v, 'an array')
      return writeArrayLiteral(
        v as readonly (string | null)[],
        delimiter,
        (leaf) => {
          // `undefined` is NOT SQL NULL. It is a hole in the caller's array — usually an
          // off-by-one or a `map` that forgot to return — and writing NULL for it stores a lie.
          if (leaf === undefined)
            throw new PgEncodeError(
              name,
              leaf,
              'an array element (undefined is not SQL NULL — use null)',
            )
          return leaf === null ? null : asText(element.encode(leaf as TIn), name)
        },
        () => elementIsLeaf,
      )
    },
    decodeText: fromLiteral,
    decodeJson: (raw, ctx) => {
      // element jsonEncode 'text' ⇒ the whole array was cast ::text ⇒ a PG array literal.
      if (typeof raw === 'string') return fromLiteral(raw, ctx)
      if (Array.isArray(raw)) {
        const walk = (node: readonly unknown[]): unknown[] =>
          node.map((v) => {
            if (v === null || v === undefined) return null
            if (Array.isArray(v) && !elementIsLeaf) return walk(v)
            return element.decodeJson(v, ctx)
          })
        return walk(raw) as (TOut | null)[]
      }
      throw new PgDecodeError(name, raw, 'expected a JSON array or a PG array literal')
    },
    // recurses: `int8[][]` used to hand `serialize()` the strings '1,2' and '3,' because
    // `element.toJson` ran on the nested ARRAY rather than on its elements.
    toJson: (v) => {
      const walk = (node: readonly unknown[]): unknown[] =>
        node.map((e) => {
          if (e === null || e === undefined) return null
          if (Array.isArray(e) && !elementIsLeaf) return walk(e)
          return element.toJson ? element.toJson(e as TOut) : e
        })
      return walk(v)
    },
  }
}

/**
 * An array literal is TEXT, so an element that normally goes out in binary format (`bytea` is the
 * only one — §4.4) has to fall back to its text spelling here. `\x00ff` inside the literal is then
 * escaped by `writeArrayLiteral` to `"\\x00ff"`, which is byte-for-byte what PG itself emits.
 */
function asText(p: PgParam, codecName: string): string {
  if (typeof p === 'string') return p
  if (p === null) return ''
  if (p instanceof Uint8Array)
    return `\\x${Array.from(p, (b) => HEX[b >> 4]! + HEX[b & 15]!).join('')}`
  throw new PgEncodeError(codecName, p, 'a text-encodable array element')
}

/**
 * Resolve the ARRAY codec whose element is `element`.
 *
 * Prefers the registry (so `text[]` is the *same object* every time and carries OID 1009), and
 * falls back to deriving one from `element.arrayOid`. `oid: undefined` is the honest outcome for
 * an element we cannot name an array type for — `assertShape` then has nothing to compare, which
 * is correct, whereas inventing an OID would make it compare against a lie.
 */
export function arrayCodecOf(element: AnyCodec, registry?: CodecRegistry): AnyCodec {
  const named = registry?.byName(`${element.name}[]`)
  if (named) return named
  const hit = DERIVED_ARRAYS.get(element)
  if (hit !== undefined) return hit
  const built = arrayCodec(
    element as Codec<never, unknown>,
    element.arrayOid,
  ) as unknown as AnyCodec
  DERIVED_ARRAYS.set(element, built)
  return built
}

/**
 * The derived-array memo, added in WS4 for two reasons that turned out to be the same one.
 *
 * Correctness first: `toStrictEqual` on two ASTs compares a codec's closures by *reference*, so
 * the AST-equivalence oracle (`test/query/ast-equivalence.test.ts`) can only hold if
 * `arrayCodecOf(textCodec)` is the same object twice. Then performance: `inList` and every array
 * operator call this on the hot path, so without the memo `inList(u.role, [...])` allocated a
 * fresh codec — five closures — per invocation. A `WeakMap` keyed on the element keeps both
 * properties without pinning anything alive.
 *
 * `builtinCodecs()` goes through the SAME memo, which is what makes the two arms of
 * `arrayCodecOf` agree: before, `arrayCodecOf(textCodec)` (derived) and
 * `arrayCodecOf(textCodec, registry)` (`registry.byName('text[]')`, derived independently inside
 * every `new Registry()`) were different objects with identical behaviour, so an AST built with a
 * registry never compared equal to one built without, and every extra `Registry` allocated a
 * fresh set of ~40 array codecs. A user type's array codec is still per-registry, which is
 * correct: `mood[]`'s OID is not stable across databases.
 */
const DERIVED_ARRAYS = new WeakMap<AnyCodec, AnyCodec>()

// ─────────────────────────────────────────────────────────────────────────────
// the untyped parameter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The codec on a bare `${value}` hole in the `sql` tag when the caller supplies none.
 *
 * `oid: undefined` — it claims no PostgreSQL type, so it is registered by NAME only and can never
 * shadow a real type in `forOid`. `paramOid: 0` is the wire spelling of "unspecified, infer from
 * context", which is what lets `where "email" = $1` work with a JS string.
 *
 * MEASURED (`test/live-query/codec-seam.test.ts`): 0 and 705 (`unknown`) are **indistinguishable**
 * — twelve parameter positions, including the two PostgreSQL refuses to infer at all (`$1 is null`,
 * `json_build_object($1, 1)` → 42P18), resolve identically under both. So this is a
 * protocol-spelling preference, not a behavioural one: 0 is what the protocol itself means by
 * "unspecified" and needs nothing to exist in `pg_type`. The pinned test is there so a future
 * PostgreSQL that *does* diverge tells us.
 *
 * It never affects SQL text — only how a value reaches the wire — so it is safe by construction:
 * a value in a template hole is ALWAYS a parameter regardless of its JavaScript type.
 */
export const unknownCodec: Codec<unknown, unknown> = {
  name: 'unknown',
  oid: undefined,
  paramOid: 0,
  sqlName: 'unknown',
  typeClass: 'other',
  jsonEncode: 'native',
  encode: (v) => {
    if (v === null) return null
    if (Array.isArray(v)) {
      // §4.5: "arrays → our own array-literal writer, using the element codec". There is no
      // element codec here, so every leaf goes through the SAME scalar rules as a top-level
      // value. It used to be `String(leaf)`, which turned a `Date` into a locale string
      // ('Thu Jan 01 1970 …'), a `Uint8Array` into '1,2' and an object into '[object Object]',
      // all three of which PostgreSQL then either rejected or, worse, stored.
      return writeArrayLiteral(v as readonly (string | null)[], ',', (leaf) =>
        leaf === null ? null : asText(encodeUnknownScalar(leaf), 'unknown'),
      )
    }
    return encodeUnknownScalar(v)
  },
  decodeText: (raw) => raw,
  decodeJson: (raw) => raw,
}

/**
 * §4.5, verbatim: "Everything else → the codec's `encode`. **No `JSON.stringify` fallback and no
 * `toPostgres()` duck-typing** … `pg`'s implicit `JSON.stringify(obj)` fallback is exactly the
 * kind of silent coercion we exist to remove."
 *
 * So an object is an ERROR here, not a JSON document: `${{ a: 1 }}` in a `sql` template is
 * ambiguous (jsonb? a composite? a range?) and the fix is one word — `val(obj, jsonbCodec)`.
 * `undefined`, a function and a symbol are errors for a sharper reason: the first used to become
 * SQL NULL and the last two used to return `undefined` from `encode`, which `pg` ALSO sends as
 * NULL. A forgotten `await` (a `Promise` is an object) or a mistyped property name then wrote
 * NULL into a column instead of failing.
 */
function encodeUnknownScalar(v: unknown): PgParam {
  switch (typeof v) {
    case 'string':
      return v
    case 'number':
    case 'bigint':
      return String(v)
    case 'boolean':
      return v ? 't' : 'f'
    case 'object':
      if (v === null) return null
      if (v instanceof Date) return utcTimestampText(v, 'unknown', 'Z')
      if (v instanceof Uint8Array) return v
      throw new PgEncodeError(
        'unknown',
        v,
        'a value with no codec — pick one explicitly, e.g. val(x, jsonbCodec)',
      )
    default:
      throw new PgEncodeError(
        'unknown',
        v,
        'a value with no codec — pick one explicitly, e.g. val(x, jsonbCodec)',
      )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// the shipped set
// ─────────────────────────────────────────────────────────────────────────────

const SCALARS = [
  boolCodec,
  int2Codec,
  int4Codec,
  int8Codec,
  oidCodec,
  float4Codec,
  float8Codec,
  numericCodec,
  textCodec,
  varcharCodec,
  bpcharCodec,
  nameCodec,
  xmlCodec,
  inetCodec,
  cidrCodec,
  moneyCodec,
  uuidCodec,
  dateCodec,
  timeCodec,
  timetzCodec,
  timestampCodec,
  timestamptzCodec,
  intervalCodec,
  charCodec,
  macaddrCodec,
  macaddr8Codec,
  bitCodec,
  varbitCodec,
  pgLsnCodec,
  jsonbCodec,
  jsonCodecJson,
  byteaCodec,
  tsvectorCodec,
  tsqueryCodec,
  jsonpathCodec,
  int4rangeCodec,
  int8rangeCodec,
  numrangeCodec,
  tsrangeCodec,
  tstzrangeCodec,
  daterangeCodec,
] as const

/** Named alternatives, registered by NAME only (they collide on OID with the defaults). */
export const ALTERNATE_CODECS: readonly AnyCodec[] = [
  int8NumberCodec,
  int8StringCodec,
  numericNumberCodec,
  timestamptzStringCodec,
] as unknown as readonly AnyCodec[]

/** Every default scalar codec, plus the array codec derived from each `arrayOid`. */
export function builtinCodecs(): readonly AnyCodec[] {
  const out: AnyCodec[] = []
  for (const c of SCALARS) {
    const scalar = c as unknown as AnyCodec
    out.push(scalar)
    // via `arrayCodecOf`, not `arrayCodec`, so every registry shares ONE `text[]` object and it
    // is the same one `arrayCodecOf(textCodec)` hands the compiler. See `DERIVED_ARRAYS`.
    if (scalar.arrayOid !== undefined) out.push(arrayCodecOf(scalar))
  }
  return out
}
