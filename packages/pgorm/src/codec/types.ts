/**
 * The codec boundary — design/02-driver.md §4.2/§4.3, reconciled with design/03 §7.
 *
 * A codec is the ONLY place a PostgreSQL type meets a TypeScript type. Nothing below this layer
 * ever interprets a value: adapters return raw wire text and `null`, and every driver's own
 * parsers are neutralised to identity (D7), because `pg`, PGlite and postgres.js each get `DATE`
 * wrong in a different way.
 */

import type { PgField, PgParam, PgRawValue } from '../driver/types.js'
import type { PgConnection } from '../driver/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Branded scalars. §4.5: a DATE is NOT a Date, and a naive timestamp is NOT a Date.
// ─────────────────────────────────────────────────────────────────────────────

declare const dateBrand: unique symbol
declare const timestampBrand: unique symbol

/** `'YYYY-MM-DD'`, lossless, sorts lexicographically, JSON-safe, CANNOT shift a day. */
export type PgDateString = string & { readonly [dateBrand]: 'date' }

/** Zoneless `'YYYY-MM-DD HH:mm:ss[.ffffff]'`, verbatim wire text. µs preserved. */
export type PgTimestampString = string & { readonly [timestampBrand]: 'timestamp' }

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class PgDecodeError extends Error {
  readonly codec: string
  readonly raw: unknown
  constructor(codec: string, raw: unknown, detail: string) {
    super(`pgorm: cannot decode ${codec} value ${JSON.stringify(raw)}: ${detail}`)
    this.name = 'PgDecodeError'
    this.codec = codec
    this.raw = raw
  }
}

export class PgEncodeError extends Error {
  readonly codec: string
  readonly value: unknown
  constructor(codec: string, value: unknown, detail: string) {
    super(`pgorm: cannot encode ${detail} as ${codec} (got ${typeOf(value)})`)
    this.name = 'PgEncodeError'
    this.codec = codec
    this.value = value
  }
}

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

// ─────────────────────────────────────────────────────────────────────────────
// Codec
// ─────────────────────────────────────────────────────────────────────────────

/** Drives operator-method dispatch in the query builder (03 §2.9). */
export type TypeClass =
  | 'boolean'
  | 'number'
  | 'bigint'
  | 'string'
  | 'datetime'
  | 'json'
  | 'binary'
  | 'array'
  | 'enum'
  | 'composite'
  | 'range'
  | 'other'

/**
 * REQUIRED (R5). How this column must be rendered inside `json_build_object` so `decodeJson` can
 * be exact.
 *  - 'native' — embed as-is; PG's `to_json` conversion is lossless for this type
 *  - 'text'   — the compiler MUST emit `::text`; a JSON number would lose information
 *
 * `int8` and `numeric` MUST be 'text' — measured: `json_build_object('a', 9007199254740993::int8)`
 * emits the JSON *number* `9007199254740993`, which `JSON.parse` silently rounds to
 * `9007199254740992`; and `numeric(10,2)` `1.10` becomes the JSON number `1.10` → `1.1`, losing
 * the scale that `numeric(10,2)` exists to carry.
 *
 * (03 also allows a custom `(e: Expr) => Expr` wrapper. `Expr` belongs to agent 03; this spike
 * carries the two cases the built-ins need.)
 */
export type JsonEncode = 'native' | 'text'

export interface CodecContext {
  /** typmod from `PgField.dataTypeModifier`. `numeric(10,2)` codecs read scale from here. */
  readonly typmod: number
  /** The live registry, so container codecs (array/range/composite) can recurse. */
  readonly registry: CodecRegistry
  /** Session ParameterStatus. Codecs assert on DateStyle/IntervalStyle rather than guessing (§4.7). */
  readonly serverParameters: Readonly<Record<string, string>>
  /** Column name, for error messages that name the offending column. */
  readonly column?: string
}

/**
 *  TIn  — what a user may pass as a parameter / insert value (a superset, e.g. `bigint | number | string`)
 *  TOut — what a SELECT of this column yields (exactly one type)
 */
export interface Codec<TIn = never, TOut = unknown> {
  /** Stable identifier: error messages, config overrides, schema DSL. e.g. 'int8', 'numeric:number'. */
  readonly name: string

  /** The OID this codec claims. `undefined` until `resolveDynamic` fills it in for a user type. */
  readonly oid: number | undefined

  /**
   * OID sent in `Parse` for a parameter carrying this codec. Usually === `oid`. Differs when we
   * deliberately widen (we send `unknown` (705) for domains so PG applies the domain's own cast).
   */
  readonly paramOid: number | undefined

  /** For the schema DSL: the SQL type name to emit in DDL, and in VALUES/unnest casts. */
  readonly sqlName: string

  readonly typeClass: TypeClass

  /** REQUIRED (R5). See `JsonEncode`. */
  readonly jsonEncode: JsonEncode

  /** Element codec, for array codecs. */
  readonly arrayOf?: Codec<never, unknown>

  /**
   * Encode a JS value to the wire.
   *  - `string`     → text format
   *  - `Uint8Array` → binary format (currently only `bytea`)
   *  - `null`       → SQL NULL
   * MUST NOT throw for values inside TIn; MUST throw `PgEncodeError` outside it.
   */
  encode(value: TIn): PgParam

  /** Decode raw wire text. `null` never reaches here — the registry short-circuits it. */
  decodeText(raw: string, ctx: CodecContext): TOut

  /**
   * REQUIRED (R5). Decode the value as it arrives inside a `json_agg` payload, i.e. after
   * `JSON.parse`. MUST return a value `===`/deep-equal to `decodeText` of the same datum.
   * This is the no-dehydration-tax contract: a column's type is the same whether you read it at
   * the top level or five relations deep.
   */
  decodeJson(raw: unknown, ctx: CodecContext): TOut

  /** Decode raw wire bytes. Unimplemented for every built-in in v1 (§4.4 — binary results are off). */
  decodeBinary?(raw: Uint8Array, ctx: CodecContext): TOut

  /** How this value is rendered by the ORM's explicit `serialize()` — `bigint`/`Uint8Array` are not JSON-able. */
  toJson?(value: TOut): unknown
}

/** Heterogeneous codec bucket. Method params are bivariant, so concrete codecs assign freely. */
export type AnyCodec = Codec<never, unknown>

export type CodecIn<C> = C extends Codec<infer I, unknown> ? I : never
export type CodecOut<C> = C extends Codec<never, infer O> ? O : never

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export interface CodecRegistry {
  /** Hot path. Called once per column per RowDescription, never per row. */
  forOid(oid: number): AnyCodec | undefined

  /** Schema-DSL path: `registry.byName('numeric:number')`. */
  byName(name: string): AnyCodec | undefined

  /**
   * Build a decoder plan for one RowDescription: a positional array of
   * `(raw: PgRawValue) => unknown`, with nulls short-circuited and typmod already bound.
   * This is what makes decoding ~1 monomorphic call per cell.
   */
  planFor(fields: readonly PgField[]): readonly ((raw: PgRawValue) => unknown)[]

  /**
   * REQUIRED (R5), the `planFor` counterpart for values arriving inside a `json_agg` payload.
   * Positional, `null`/`undefined` short-circuited, paired with `jsonCastFor` by the compiler.
   */
  jsonPlanFor(codecs: readonly (AnyCodec | undefined)[]): readonly ((raw: unknown) => unknown)[]

  /**
   * REQUIRED (R5). The per-codec cast the compiler MUST emit inside `json_build_object`:
   * `'::text'` for `int8`/`numeric` (and any array of them), `''` otherwise. Without it PG emits
   * a JSON *number* and `JSON.parse` silently destroys precision or scale.
   */
  jsonCastFor(codec: AnyCodec): string

  /** Register or override. Throws on an OID collision unless `{ override: true }`. */
  register(codec: AnyCodec, options?: { override?: boolean }): void

  /**
   * Resolve user-defined types by qualified name → OID against the live catalogue, then derive
   * array / domain / enum codecs automatically. Idempotent; run once per physical database on
   * first connect.
   */
  resolveDynamic(connection: PgConnection, requests: readonly DynamicTypeRequest[]): Promise<void>

  /** True once every requested dynamic type has an OID. Queries are blocked until then. */
  readonly resolved: boolean
}

export interface DynamicTypeRequest {
  /** Schema-qualified. `schema` omitted ⇒ resolved via search_path. */
  readonly schema?: string
  readonly name: string
  /** What the schema DSL declared it as; a mismatch against `pg_type.typtype` is a hard error. */
  readonly kind: 'enum' | 'composite' | 'domain' | 'range' | 'multirange' | 'base'
  /** For enums: the TS union the user declared. Mismatch against `pg_enum` is a hard error at connect. */
  readonly enumLabels?: readonly string[]
  /** For composites: field name → codec name. */
  readonly fields?: Readonly<Record<string, string>>
}
