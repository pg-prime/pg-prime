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
  JsonEncode,
  PgDateString,
  PgTimestampString,
  TypeClass,
} from './types.js'
import type { PgParam } from '../driver/types.js'

interface Spec<TIn, TOut> {
  name: string
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

function def<TIn, TOut>(s: Spec<TIn, TOut>): Codec<TIn, TOut> & { arrayOid?: number } {
  const c: Codec<TIn, TOut> & { arrayOid?: number } = {
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

export const boolCodec = def<boolean, boolean>({
  name: 'bool',
  oid: 16,
  arrayOid: 1000,
  sqlName: 'boolean',
  typeClass: 'boolean',
  jsonEncode: 'native',
  encode: (v) => {
    if (typeof v !== 'boolean') throw new PgEncodeError('bool', v, 'a boolean')
    return v ? 't' : 'f'
  },
  // single-char compare, NOT `Boolean(x)` — `Boolean('f')` is `true`.
  decodeText: (raw) => raw === 't' || raw === 'true' || raw === 'y' || raw === '1',
  decodeJson: (raw) => {
    if (typeof raw === 'boolean') return raw
    if (typeof raw === 'string') return raw === 't' || raw === 'true'
    throw new PgDecodeError('bool', raw, 'expected boolean')
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// integers
// ─────────────────────────────────────────────────────────────────────────────

function intCodec(
  name: string,
  oid: number,
  arrayOid: number,
  sqlName: string,
  min: number,
  max: number,
): Codec<number, number> & { arrayOid?: number } {
  const decodeText = (raw: string): number => {
    const n = Number(raw)
    if (!Number.isInteger(n)) throw new PgDecodeError(name, raw, 'not an integer')
    return n
  }
  return def<number, number>({
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
export const int8Codec = def<bigint | number | string, bigint>({
  name: 'int8',
  oid: 20,
  arrayOid: 1016,
  sqlName: 'bigint',
  typeClass: 'bigint',
  jsonEncode: 'text',
  encode: (v) => {
    if (typeof v === 'bigint') return String(v)
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) throw new PgEncodeError('int8', v, 'a safe integer')
      return String(v)
    }
    if (typeof v === 'string') {
      try {
        return String(BigInt(v))
      } catch {
        throw new PgEncodeError('int8', v, 'an integer string')
      }
    }
    throw new PgEncodeError('int8', v, 'a bigint')
  },
  decodeText: (raw) => {
    try {
      return BigInt(raw)
    } catch {
      throw new PgDecodeError('int8', raw, 'not an integer')
    }
  },
  decodeJson: (raw) => {
    if (typeof raw === 'bigint') return raw
    if (typeof raw === 'string') {
      try {
        return BigInt(raw)
      } catch {
        throw new PgDecodeError('int8', raw, 'not an integer')
      }
    }
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

/** Ships in the box: `int8:number`, range-checked. `count()` binds this explicitly. */
export const int8NumberCodec = def<bigint | number, number>({
  name: 'int8:number',
  oid: 20,
  sqlName: 'bigint',
  typeClass: 'number',
  jsonEncode: 'text',
  encode: (v) => String(v),
  decodeText: (raw) => {
    const n = Number(raw)
    if (!Number.isSafeInteger(n))
      throw new PgDecodeError('int8:number', raw, 'exceeds Number.MAX_SAFE_INTEGER; use int8')
    return n
  },
  decodeJson: (raw) => {
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isSafeInteger(n))
      throw new PgDecodeError('int8:number', raw, 'exceeds Number.MAX_SAFE_INTEGER; use int8')
    return n
  },
})

/** Ships in the box: `int8:string`. */
export const int8StringCodec = def<bigint | number | string, string>({
  name: 'int8:string',
  oid: 20,
  sqlName: 'bigint',
  typeClass: 'string',
  jsonEncode: 'text',
  encode: (v) => String(v),
  decodeText: (raw) => raw,
  decodeJson: (raw) => String(raw),
})

// ─────────────────────────────────────────────────────────────────────────────
// floats
// ─────────────────────────────────────────────────────────────────────────────

function floatCodec(
  name: string,
  oid: number,
  arrayOid: number,
  sqlName: string,
): Codec<number, number> & { arrayOid?: number } {
  const fromString = (raw: string): number => {
    // text is the EXACT shortest round-trip repr; NaN/±Infinity must be special-cased.
    if (raw === 'NaN') return Number.NaN
    if (raw === 'Infinity') return Number.POSITIVE_INFINITY
    if (raw === '-Infinity') return Number.NEGATIVE_INFINITY
    const n = Number(raw)
    if (Number.isNaN(n)) throw new PgDecodeError(name, raw, 'not a number')
    return n
  }
  return def<number, number>({
    name,
    oid,
    arrayOid,
    sqlName,
    typeClass: 'number',
    // 'native' verified exact: `json_build_object('n', 0.1::float8 + 0.2::float8)` → 0.30000000000000004.
    // NaN/±Infinity come back as JSON *strings* from the same expression, which decodeJson handles.
    jsonEncode: 'native',
    encode: (v) => {
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
export const numericCodec = def<string | number | bigint, string>({
  name: 'numeric',
  oid: 1700,
  arrayOid: 1231,
  sqlName: 'numeric',
  typeClass: 'string',
  jsonEncode: 'text',
  encode: (v) => {
    if (typeof v === 'string') {
      if (!/^-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$|^-?(NaN|Infinity)$/.test(v))
        throw new PgEncodeError('numeric', v, 'a decimal string')
      return v
    }
    if (typeof v === 'bigint') return String(v)
    if (typeof v === 'number') return String(v)
    throw new PgEncodeError('numeric', v, 'a decimal string')
  },
  decodeText: (raw) => raw,
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

export const numericNumberCodec = def<string | number, number>({
  name: 'numeric:number',
  oid: 1700,
  sqlName: 'numeric',
  typeClass: 'number',
  jsonEncode: 'text',
  encode: (v) => String(v),
  decodeText: (raw) => Number(raw),
  decodeJson: (raw) => Number(raw),
})

// ─────────────────────────────────────────────────────────────────────────────
// strings
// ─────────────────────────────────────────────────────────────────────────────

function stringCodec(
  name: string,
  oid: number,
  arrayOid: number | undefined,
  sqlName: string,
): Codec<string, string> & { arrayOid?: number } {
  const spec: Spec<string, string> = {
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

/** PG normalises UUID case on output — measured: `550E8400-…` in, `550e8400-…` out. */
export const uuidCodec = def<string, string>({
  name: 'uuid',
  oid: 2950,
  arrayOid: 2951,
  sqlName: 'uuid',
  typeClass: 'string',
  jsonEncode: 'native',
  encode: (v) => {
    if (typeof v !== 'string' || !/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(v))
      throw new PgEncodeError('uuid', v, 'a UUID string')
    return v.toLowerCase()
  },
  decodeText: (raw) => raw,
  decodeJson: (raw) => {
    if (typeof raw === 'string') return raw
    throw new PgDecodeError('uuid', raw, 'expected string')
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// temporal
// ─────────────────────────────────────────────────────────────────────────────

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
export const dateCodec = def<string, PgDateString>({
  name: 'date',
  oid: 1082,
  arrayOid: 1182,
  sqlName: 'date',
  typeClass: 'datetime',
  // verified: identical at depth 0 and depth 3 (`json_build_object` emits `"2026-08-14"`).
  jsonEncode: 'native',
  encode: (v) => {
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
export const timestampCodec = def<string | Date, PgTimestampString>({
  name: 'timestamp',
  oid: 1114,
  arrayOid: 1115,
  sqlName: 'timestamp',
  typeClass: 'datetime',
  jsonEncode: 'native',
  encode: (v) => {
    if (typeof v === 'string') return v
    if (v instanceof Date) return v.toISOString().replace('T', ' ').replace('Z', '')
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
  let t = Date.UTC(2000, Number(moStr) - 1, Number(dStr), Number(hStr), Number(miStr), Number(sStr), ms)
  const d = new Date(t)
  d.setUTCFullYear(year)
  t = d.getTime()
  if (!zulu && sign) {
    const offsetSec =
      (Number(offH) * 3600 + Number(offM ?? 0) * 60 + Number(offS ?? 0)) * (sign === '-' ? -1 : 1)
    t -= offsetSec * 1000
  }
  const out = new Date(t)
  if (Number.isNaN(out.getTime())) throw new PgDecodeError(codecName, raw, 'produced an Invalid Date')
  return out
}

export const timestamptzCodec = def<Date | string, Date>({
  name: 'timestamptz',
  oid: 1184,
  arrayOid: 1185,
  sqlName: 'timestamptz',
  typeClass: 'datetime',
  // native: `to_json` emits `2026-08-14T06:30:00.123456+00:00` — the same instant, different
  // spelling from the wire text. Our parser accepts both, so depth 0 === depth 3.
  jsonEncode: 'native',
  encode: (v) => {
    // We NEVER call pg's `dateToString`: it emits a LOCAL-offset string with hand-rolled BC
    // handling. UTC ISO-8601 is unambiguous everywhere.
    if (v instanceof Date) {
      if (Number.isNaN(v.getTime())) throw new PgEncodeError('timestamptz', v, 'a valid Date')
      return v.toISOString()
    }
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

/** Exact, verbatim wire text — for µs precision and for `infinity`. */
export const timestamptzStringCodec = def<Date | string, string>({
  name: 'timestamptz:string',
  oid: 1184,
  sqlName: 'timestamptz',
  typeClass: 'string',
  jsonEncode: 'native',
  encode: (v) => (v instanceof Date ? v.toISOString() : String(v)),
  decodeText: (raw) => raw,
  decodeJson: (raw) => String(raw),
})

// ─────────────────────────────────────────────────────────────────────────────
// json / jsonb
// ─────────────────────────────────────────────────────────────────────────────

function jsonCodec(name: string, oid: number, arrayOid: number): Codec<unknown, unknown> {
  return def<unknown, unknown>({
    name,
    oid,
    arrayOid,
    sqlName: name,
    typeClass: 'json',
    // embedded NATIVELY, never double-encoded. Verified: a jsonb column inside json_build_object
    // comes back as a real JSON object, not a string.
    jsonEncode: 'native',
    encode: (v) => JSON.stringify(v) ?? 'null',
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
export const byteaCodec = def<Uint8Array, Uint8Array>({
  name: 'bytea',
  oid: 17,
  arrayOid: 1001,
  sqlName: 'bytea',
  typeClass: 'binary',
  jsonEncode: 'native',
  encode: (v) => {
    if (!(v instanceof Uint8Array)) throw new PgEncodeError('bytea', v, 'a Uint8Array')
    return v
  },
  decodeText: (raw) => decodeByteaHex(raw),
  decodeJson: (raw) => {
    if (typeof raw !== 'string') throw new PgDecodeError('bytea', raw, 'expected hex string')
    return decodeByteaHex(raw)
  },
  toJson: (v) => `\\x${Array.from(v, (b) => HEX[b >> 4]! + HEX[b & 15]!).join('')}`,
})

function decodeByteaHex(raw: string): Uint8Array {
  if (!raw.startsWith('\\x')) {
    throw new PgDecodeError('bytea', raw, "expected hex format (\\x…); set bytea_output = 'hex'")
  }
  const hex = raw.slice(2)
  if (hex.length % 2 !== 0) throw new PgDecodeError('bytea', raw, 'odd hex length')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const b = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(b)) throw new PgDecodeError('bytea', raw, 'invalid hex')
    out[i] = b
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
export function arrayCodec<TIn, TOut>(
  element: Codec<TIn, TOut>,
  oid: number,
  options?: { delimiter?: string; name?: string },
): Codec<readonly (TIn | null)[], (TOut | null)[]> {
  const delimiter = options?.delimiter ?? ','
  const name = options?.name ?? `${element.name}[]`

  const fromLiteral = (raw: string, ctx: CodecContext): (TOut | null)[] => {
    const walk = (node: readonly (string | null | readonly unknown[])[]): unknown[] =>
      node.map((v) => {
        if (v === null) return null
        if (Array.isArray(v)) return walk(v as readonly (string | null | readonly unknown[])[])
        return element.decodeText(v as string, ctx)
      })
    return walk(parseArrayLiteral(raw, delimiter)) as (TOut | null)[]
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
      return writeArrayLiteral(v as readonly (string | null)[], delimiter, (leaf) =>
        leaf === null ? null : asText(element.encode(leaf as TIn), name),
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
            if (Array.isArray(v)) return walk(v)
            return element.decodeJson(v, ctx)
          })
        return walk(raw) as (TOut | null)[]
      }
      throw new PgDecodeError(name, raw, 'expected a JSON array or a PG array literal')
    },
    toJson: (v) => v.map((e) => (e === null ? null : (element.toJson?.(e) ?? e))),
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
  if (p instanceof Uint8Array) return `\\x${Array.from(p, (b) => HEX[b >> 4]! + HEX[b & 15]!).join('')}`
  throw new PgEncodeError(codecName, p, 'a text-encodable array element')
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
  jsonbCodec,
  jsonCodecJson,
  byteaCodec,
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
    out.push(c as unknown as AnyCodec)
    const arrayOid = (c as { arrayOid?: number }).arrayOid
    if (arrayOid !== undefined) {
      out.push(
        arrayCodec(c as unknown as Codec<never, unknown>, arrayOid) as unknown as AnyCodec,
      )
    }
  }
  return out
}
