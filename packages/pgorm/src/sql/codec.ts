/**
 * SPIKE-LOCAL `Codec`.
 *
 * Agent 02 owns the real `Codec` (03 §7). This file declares the *structural minimum* the
 * compiler consumes so that the SQL-tag / compiler spike can be built and tested in
 * isolation, plus a handful of placeholder instances used by the golden tests. When the
 * real codec package lands, delete `spikeCodecs` and re-point the `Codec` import; nothing
 * else in `src/sql` or `src/compile` should need to change, because everything consumes
 * `Codec` structurally.
 *
 * The two load-bearing members (03 §7, R5 in design/00):
 *  - `decodeJson` is REQUIRED, not optional — it is what makes "a column decodes identically
 *    at any nesting depth" true.
 *  - `jsonEncode` declares how the value must be rendered *inside* `json_build_object`.
 *    `int8` and `numeric` MUST be `'text'`; a JSON number silently loses precision past 2^53.
 */

import type { Expr } from '../compile/ast.js'

export type TypeClass =
  | 'text'
  | 'int'
  | 'numeric'
  | 'bool'
  | 'temporal'
  | 'json'
  | 'array'
  | 'unknown'

/** How a value must be rendered inside `json_build_object` so `decodeJson` can be exact. */
export type JsonEncode = 'native' | 'text' | ((e: Expr) => Expr)

export interface Codec<T = unknown> {
  readonly name: string
  /** For the dev-mode `RowDescription.dataTypeID` assertion (03 §3.2). */
  readonly oid: number
  /** Drives operator-method dispatch in the type layer (03 §2.9). */
  readonly typeClass: TypeClass
  /** For VALUES / unnest casts (03 §2.6). */
  readonly pgType: string
  encode(v: T): string | Uint8Array | null
  /** Top-level wire value (text format). */
  decodeText(s: string): T
  /** REQUIRED: value as it arrives inside a `json_agg` payload. */
  decodeJson(v: unknown): T
  readonly jsonEncode: JsonEncode
  /** Element codec when this codec is an array type. */
  readonly arrayOf?: Codec
}

// ─────────────────────────────────────────────────────────────────────────────
// Placeholder instances. TEMPORARY — agent 02 replaces these wholesale.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PostgreSQL array-literal encoding. Every element is quoted unconditionally (the same
 * always-quote rule as identifiers, for the same reason): an unquoted fast path is where
 * `NULL`, `{`, `}` and `,` handling bugs live.
 */
export function encodeTextArray(items: readonly unknown[]): string {
  let out = '{'
  for (let i = 0; i < items.length; i++) {
    if (i > 0) out += ','
    const v = items[i]
    out +=
      v === null || v === undefined
        ? 'NULL'
        : `"${String(v).replace(/(["\\])/g, '\\$1')}"`
  }
  return out + '}'
}

function def<T>(c: Codec<T>): Codec<T> {
  return Object.freeze(c)
}

export const spikeCodecs = {
  text: def<string>({
    name: 'text',
    oid: 25,
    typeClass: 'text',
    pgType: 'text',
    jsonEncode: 'native',
    encode: (v) => v,
    decodeText: (s) => s,
    decodeJson: (v) => v as string,
  }),

  citext: def<string>({
    name: 'citext',
    oid: 0,
    typeClass: 'text',
    pgType: 'citext',
    jsonEncode: 'native',
    encode: (v) => v,
    decodeText: (s) => s,
    decodeJson: (v) => v as string,
  }),

  int4: def<number>({
    name: 'int4',
    oid: 23,
    typeClass: 'int',
    pgType: 'int4',
    jsonEncode: 'native',
    encode: (v) => String(v),
    decodeText: (s) => Number(s),
    decodeJson: (v) => Number(v),
  }),

  /** `jsonEncode: 'text'` is not a style choice — int8 > 2^53 is lossy as a JSON number. */
  int8: def<bigint>({
    name: 'int8',
    oid: 20,
    typeClass: 'int',
    pgType: 'int8',
    jsonEncode: 'text',
    encode: (v) => String(v),
    decodeText: (s) => BigInt(s),
    decodeJson: (v) => BigInt(v as string),
  }),

  /** numeric → string, precision-preserving (design/00 sign-off #6). */
  numeric: def<string>({
    name: 'numeric',
    oid: 1700,
    typeClass: 'numeric',
    pgType: 'numeric',
    jsonEncode: 'text',
    encode: (v) => v,
    decodeText: (s) => s,
    decodeJson: (v) => String(v),
  }),

  bool: def<boolean>({
    name: 'bool',
    oid: 16,
    typeClass: 'bool',
    pgType: 'bool',
    jsonEncode: 'native',
    encode: (v) => (v ? 't' : 'f'),
    decodeText: (s) => s === 't' || s === 'true',
    decodeJson: (v) => Boolean(v),
  }),

  /** timestamptz → Date; `to_json` emits ISO 8601 with offset, so 'native' is exact. */
  timestamptz: def<Date>({
    name: 'timestamptz',
    oid: 1184,
    typeClass: 'temporal',
    pgType: 'timestamptz',
    jsonEncode: 'native',
    encode: (v) => v.toISOString(),
    decodeText: (s) => new Date(s),
    decodeJson: (v) => new Date(v as string),
  }),

  /** date → branded 'YYYY-MM-DD' string; 'native' can never shift a day. */
  date: def<string>({
    name: 'date',
    oid: 1082,
    typeClass: 'temporal',
    pgType: 'date',
    jsonEncode: 'native',
    encode: (v) => v,
    decodeText: (s) => s,
    decodeJson: (v) => String(v),
  }),

  jsonb: def<unknown>({
    name: 'jsonb',
    oid: 3802,
    typeClass: 'json',
    pgType: 'jsonb',
    jsonEncode: 'native',
    encode: (v) => JSON.stringify(v),
    decodeText: (s) => JSON.parse(s) as unknown,
    decodeJson: (v) => v,
  }),

  json: def<unknown>({
    name: 'json',
    oid: 114,
    typeClass: 'json',
    pgType: 'json',
    jsonEncode: 'native',
    encode: (v) => JSON.stringify(v),
    decodeText: (s) => JSON.parse(s) as unknown,
    decodeJson: (v) => v,
  }),

  textArray: def<readonly string[]>({
    name: 'text[]',
    oid: 1009,
    typeClass: 'array',
    pgType: 'text[]',
    jsonEncode: 'native',
    encode: (v) => encodeTextArray(v),
    decodeText: (s) => s as unknown as readonly string[],
    decodeJson: (v) => v as readonly string[],
  }),

  /**
   * The codec applied to a bare `${value}` interpolation in the `sql` tag when the caller
   * supplies no codec. It never affects SQL text — only how the value is encoded for the
   * wire — so it is safe by construction; the point of this spike is that a value in a
   * template hole is ALWAYS a parameter regardless of its JavaScript type.
   */
  unknownParam: def<unknown>({
    name: 'unknown',
    oid: 0,
    typeClass: 'unknown',
    pgType: 'unknown',
    jsonEncode: 'native',
    encode: (v) => {
      if (v === null || v === undefined) return null
      switch (typeof v) {
        case 'string':
          return v
        case 'number':
        case 'bigint':
          return String(v)
        case 'boolean':
          return v ? 't' : 'f'
        default:
          if (v instanceof Date) return v.toISOString()
          if (Array.isArray(v)) {
            return encodeTextArray(v.map((x) => (x === null ? null : String(x))))
          }
          return JSON.stringify(v)
      }
    },
    decodeText: (s) => s,
    decodeJson: (v) => v,
  }),
} as const
