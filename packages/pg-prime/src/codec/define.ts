/**
 * `definePgType()` — the extension-type descriptor (design/01 §3 row 61, design/14 decision 5).
 *
 * ## What it is for
 *
 * Every built-in in `./builtins.ts` has a **fixed** OID: `text` is 25 in every PostgreSQL that has
 * ever shipped, so a codec can bake the number in. An EXTENSION type cannot: `vector` is 16389 in
 * the container this was measured against and something else in the next database, because
 * `CREATE EXTENSION` allocates from `pg_type` like any other user type (02 §4.6). That is the same
 * fact that makes an enum's OID per-database, and the answer is the same mechanism —
 * `Registry.resolveDynamic` reads the number off `pg_type` once per physical database.
 *
 * So this module adds no second mechanism. It adds the **descriptor** a third party writes:
 *
 * ```ts
 * const hstore = definePgType({
 *   name: 'hstore',
 *   encode: (v: Record<string, string>) => …,
 *   decode: (raw) => …,
 * })
 * registry.register(hstore)
 * await registry.resolveDynamic(conn, [{ name: 'hstore', kind: 'base' }])
 * ```
 *
 * and `resolveDynamic`'s `base` branch is "take the codec registered under this name and stamp the
 * catalogue's OID onto it" — one branch beside `enum` (which takes labels from the catalogue) and
 * `domain` (which takes the base type). Row 61's acceptance sentence, *zero forks*, is that the
 * three lines above are the whole story: no fork, no patch to `builtinCodecs()`, no new registry.
 *
 * ## The two derivations, and why they are total
 *
 * A descriptor gives `encode` and `decode`. A `Codec` needs four more things, and each is derived
 * rather than asked for, because asking would be asking for a measurement the author cannot make:
 *
 *  - **`oid` / `paramOid` are `undefined`.** That is not a placeholder — it is 02 §4.6's promise
 *    that a user type's OID is never baked into anything. Until `resolveDynamic` runs, the codec
 *    is in the same *pending window* an enum's is (`src/query/meta.ts`): it encodes and decodes
 *    correctly, and `Parse` sends `0` for the parameter so PostgreSQL infers the type from context.
 *  - **`jsonEncode` is `'text'`,** i.e. the compiler emits `::text` inside `json_build_object`.
 *    Every type with an output function has a `::text` cast, so the value at depth 3 is *by
 *    construction* the same string `decodeText` reads at depth 0 — which makes R5's
 *    "`decodeJson` equals `decodeText` of the same datum" true without a per-type measurement.
 *    `'native'` would be a bet on `to_json`'s rendering of a type this package has never seen.
 *  - **`decodeJson` is `decode` of that string,** for the same reason.
 *  - **`sqlName`** is the quoted (and, when `schema` is given, qualified) spelling the compiler
 *    splices for a `::type` cast. `resolveDynamic` keeps it verbatim, so a golden taken before the
 *    registry has met the database is byte-identical to one taken after.
 */

import { PgDecodeError } from './types.js'
import type { Codec, CodecContext, TypeClass } from './types.js'
import type { PgParam } from '../driver/types.js'
// Same edge `./registry.ts` takes, and it closes no cycle: `../sql/ident.ts` imports nothing.
import { quoteIdentPart } from '../sql/ident.js'

/**
 * What a third party writes to teach this library one PostgreSQL type (design/01 §3 row 61).
 *
 * Six fields, four of them optional. Anything a `Codec` needs and this does not carry is derived —
 * see the module docblock for why each derivation is total rather than a guess.
 */
export interface PgTypeDescriptor<TIn, TOut, N extends string = string> {
  /**
   * The type's name in `pg_type.typname` — `'vector'`, `'citext'`, `'hstore'`.
   *
   * It is also the registry key, the string a column's `pgType` must match, and the string
   * `03` §2.9's operator gate reads as the operand's class. One name, three jobs, by design:
   * `metaOf` resolves a column's codec with `registry.byName(ddl.pgType)`.
   */
  readonly name: N
  /**
   * The schema the type lives in, when it is not on `search_path`.
   *
   * Only affects the `::type` cast the compiler splices — `"extensions"."vector"` rather than
   * `"vector"`. Leave it out for the usual case (`CREATE EXTENSION vector` in `public`).
   */
  readonly schema?: string
  /** JS value → wire. MUST throw `PgEncodeError` for a value outside `TIn` (02 §4.2). */
  encode(value: TIn): PgParam
  /** Wire text → JS value. `null` never arrives here; the registry short-circuits it. */
  decode(raw: string, ctx: CodecContext): TOut
  /**
   * The family this type belongs to. Defaults to `'other'`.
   *
   * It does not drive operator dispatch (that is a type-level gate over the codec's `name` — see
   * `TypeClass` in `./types.ts`). It matters in one place: `'vector'` tells `arrayCodec` that the
   * decoded value is ITSELF an array, so `vector[]` holding `[[1,2],[3,4]]` is two vectors and
   * not a 2-D array of four numbers.
   */
  readonly typeClass?: TypeClass
  /**
   * Whether `resolveDynamic` also derives and registers `<name>[]` from the catalogue's
   * `pg_type.typarray`. Default `true`.
   *
   * Set `false` for a type whose array form you model yourself — the derived codec is the generic
   * `arrayCodec`, which is right for every type whose elements round-trip through their own
   * `encode`/`decode`, and wrong for one that needs a bespoke literal.
   */
  readonly arrayOf?: boolean
}

/**
 * Codecs whose descriptor said `arrayOf: false`.
 *
 * A `WeakSet` and not a field on `Codec`, because "should the registry derive my array?" is a
 * fact about the *registration*, not about the type — nothing downstream of `resolveDynamic` has
 * any use for it, and a public field would have to be documented on all fifty built-ins.
 */
const NO_DERIVED_ARRAY = new WeakSet<object>()

/** Internal: `Registry.resolveDynamic` asks this before deriving `<name>[]`. */
export function derivesArrayCodec(codec: object): boolean {
  return !NO_DERIVED_ARRAY.has(codec)
}

/**
 * Build a codec for an extension type from its descriptor.
 *
 * The result has **no OID** and is registered by name only until
 * `Registry.resolveDynamic(conn, [{ name, kind: 'base' }])` reads this database's `pg_type`.
 * Registering it is the caller's move (`registry.register(codec)`), exactly as for any codec;
 * `citext` and `vector` are registered for you because this package ships them (`./extensions.ts`).
 */
export function definePgType<TIn, TOut, N extends string>(
  descriptor: PgTypeDescriptor<TIn, TOut, N>,
): Codec<TIn, TOut, N> {
  const name = descriptor.name
  if (typeof name !== 'string' || name === '') {
    throw new TypeError(`pg-prime: definePgType() needs a PostgreSQL type name, e.g. 'vector'.`)
  }
  const { encode, decode } = descriptor
  if (typeof encode !== 'function' || typeof decode !== 'function') {
    throw new TypeError(
      `pg-prime: definePgType('${name}') needs both an encode and a decode function.`,
    )
  }
  const codec: Codec<TIn, TOut, N> = {
    name,
    // 02 §4.6: an extension type's OID is per-database and is NEVER baked in. `resolveDynamic`
    // fills both of these from `pg_type`; until then `Parse` sends 0 and PostgreSQL infers.
    oid: undefined,
    paramOid: undefined,
    sqlName:
      descriptor.schema === undefined
        ? quoteIdentPart(name)
        : `${quoteIdentPart(descriptor.schema)}.${quoteIdentPart(name)}`,
    typeClass: descriptor.typeClass ?? 'other',
    // See the module docblock: `::text` is defined for every type with an output function, so the
    // depth-3 payload is the depth-0 wire text and R5's equality holds by construction.
    jsonEncode: 'text',
    encode,
    decodeText: decode,
    decodeJson: (raw, ctx) => {
      if (typeof raw !== 'string') {
        throw new PgDecodeError(name, raw, 'expected the ::text rendering of this type, a string')
      }
      return decode(raw, ctx)
    },
  }
  if (descriptor.arrayOf === false) NO_DERIVED_ARRAY.add(codec)
  return codec
}
