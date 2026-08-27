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
    super(`pgorm: cannot decode ${codec} value ${describeRaw(raw)}: ${detail}`)
    this.name = 'PgDecodeError'
    this.codec = codec
    this.raw = raw
  }
}

/** Longest raw excerpt an error message may carry. A wire value can be megabytes. */
const MAX_RAW_CHARS = 200

/**
 * `JSON.stringify` cannot be used here for two independent reasons, both reachable from a decode
 * failure and both measured: it THROWS on a `bigint` (so the error about a bad value would be
 * replaced by a `TypeError` about the error), and it materialises the whole value — a 10 MB
 * `bytea` hex string produced a 10 MB exception message. This formatter is total and bounded.
 */
function describeRaw(raw: unknown): string {
  let s: string
  if (typeof raw === 'string') {
    // slice BEFORE quoting: never build a copy of a multi-megabyte wire value
    s = JSON.stringify(raw.length > MAX_RAW_CHARS ? `${raw.slice(0, MAX_RAW_CHARS)}…` : raw)
  } else if (typeof raw === 'bigint') {
    s = `${raw}n`
  } else if (raw instanceof Uint8Array) {
    s = `<${raw.length} bytes>`
  } else if (raw === null || typeof raw !== 'object') {
    s = String(raw)
  } else {
    let json: string | undefined
    try {
      json = JSON.stringify(raw)
    } catch {
      json = undefined
    }
    s = json ?? Object.prototype.toString.call(raw)
  }
  return s.length > MAX_RAW_CHARS ? `${s.slice(0, MAX_RAW_CHARS)}…` : s
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

/**
 * The PostgreSQL type family a codec belongs to.
 *
 * ⚠️ It does NOT drive operator-method dispatch, which is what this docblock claimed until the
 * WS-audit checked: `03` §2.9's gate is a *type-level* one over `Codec['name']` literals
 * (`NumPg`, `StrPg`, … in `src/query/ops.ts`), so nothing reads `typeClass` at runtime for
 * dispatch. What it is really for is the two places that need a family rather than a name:
 * `arrayCodec` (a `json`-classed element is a LEAF, so `jsonb[]` can carry an array-valued
 * element) and consumers that group codecs for display/diagnostics. Keep it accurate; do not
 * grow a second dispatch mechanism on it without also making `03` read it.
 */
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
 * **Deviation from 03 §7, decided in WS2:** that sketch also allows a custom `(e: Expr) => Expr`
 * wrapper. It is not implemented and the union deliberately has two members, because a codec that
 * builds compiler AST inverts the layering — `src/compile` depends on `src/codec`, so the reverse
 * edge would be a cycle. Anything the wrapper could express is already expressible as a codec with
 * `jsonEncode: 'text'` whose `decodeJson` parses the text spelling, which is exactly how `int8`,
 * `numeric` and every array of them work. If a case ever needs more, the cheap extension is a
 * `{ cast: string }` member (a named SQL cast the compiler applies), not a function.
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
 *  N    — the codec's own `name`, kept as a LITERAL on every built-in (see below)
 *
 * **Why `N` exists (WS3).** `03` §2.9's operator gate reads a PG type-class off `[META]['pg']`,
 * which only a schema `Ref` carries — so `` sql`lower(x)`.as(textCodec) `` could not be a
 * class-specific operand. `09` §3.0 records that hole and requires WS3 to close it. It closes
 * here: `.as(c)` reads `c['name']` and republishes it as the fragment's `pg` slot, so a fragment
 * and a column reach the gate through the same door.
 *
 * `name` and not `sqlName`, which is what `09` §3.0 guessed: `int4`'s `sqlName` is `'integer'`
 * and `int8`'s is `'bigint'`, neither of which is in the `NumPg` gate. `name` is the field that
 * already agrees with `ColMeta['pg']` by construction, because `metaOf` resolves a column by
 * `registry.byName(ddl.pgType)` — the same string on both sides.
 */
export interface Codec<TIn = never, TOut = unknown, N extends string = string> {
  /** Stable identifier: error messages, config overrides, schema DSL. e.g. 'int8', 'numeric:number'. */
  readonly name: N

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
  readonly arrayOf?: Codec<never, unknown, string>

  /**
   * OID of the ARRAY type whose element is this codec (`text` → 1009). Present on every built-in
   * scalar; `undefined` for a codec we cannot name an array for. Read by `arrayCodecOf` so the
   * compiler can type an `array[...]` expression without a registry round-trip.
   */
  readonly arrayOid?: number

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
export type AnyCodec = Codec<never, unknown, string>

export type CodecIn<C> = C extends Codec<infer I, unknown, string> ? I : never
export type CodecOut<C> = C extends Codec<never, infer O, string> ? O : never
/** The codec's name as a literal — an indexed access, never a conditional (04 §1.3 rule 1). */
export type CodecPg<C extends AnyCodec> = C['name']

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

  /**
   * Bumped by every `register` / `resolveDynamic`. Consumers that memoise a *derived* view of the
   * registry — `metaOf` in `src/query/meta.ts` is the only one today — store this alongside the
   * cached value and recompute when it moves. Without it, a `TableMeta` built before
   * `resolveDynamic` keeps an enum codec whose `oid` is `undefined` forever, and `assertShape`
   * then compares a real `dataTypeID` against nothing.
   */
  readonly generation: number
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
