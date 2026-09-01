/**
 * The two extension types this package ships, as reference users of `definePgType()`
 * (design/01 §3 rows 44-`citext`, 61, 62 · design/14 decision 5).
 *
 * They are here rather than in `./builtins.ts` for one measured reason: **neither has a fixed
 * OID.** `builtins.ts` says so at the head of its full-text section — "unlike `citext` and
 * `vector` they need no `resolveDynamic` round trip" — and this file is the other side of that
 * sentence. `CREATE EXTENSION` allocates from `pg_type`, so the number differs per database and
 * `Registry.resolveDynamic` is the only place it may be learned (02 §4.6).
 *
 * They are also the proof of row 61's acceptance sentence. Everything below goes through the
 * public `definePgType` and nothing else: no privileged branch, no `builtinCodecs()` edit, no
 * second registry. A third party's `hstore` or `postgis.geometry` is the same eight lines.
 *
 * ⚠️ Both are registered by NAME ONLY (`Registry`'s constructor), like `ALTERNATE_CODECS` and
 * `unknown`, and for the same reason: `forOid` must not be able to answer with a codec whose OID
 * is `undefined`, and `test/codec/r5-golden.test.ts` requires a live round trip for every codec in
 * `builtinCodecs()` — which neither of these has on a server without the extension.
 */

import { definePgType } from './define.js'
import { PgDecodeError, PgEncodeError } from './types.js'
import type { Codec } from './types.js'

/**
 * `citext` — case-insensitive text (design/01 §3 row 44's last unbuilt name).
 *
 * Decode is identity, exactly like `text`: the case-insensitivity is a property of the type's
 * *comparison operators*, not of its representation, so `'AbC'` comes back `'AbC'` and
 * `where email = 'ADA@example.com'` matches all the same. `citext` is already one of the string
 * type families in `src/schema/relations.ts` and one of `TextPg`'s members in
 * `src/query/ops.types.ts`, so every text operator gates on it the moment a column can be
 * declared with it.
 */
export const citextCodec: Codec<string, string, 'citext'> = definePgType({
  name: 'citext',
  typeClass: 'string',
  encode: (v: string) => {
    if (typeof v !== 'string') throw new PgEncodeError('citext', v, 'a string')
    return v
  },
  decode: (raw): string => raw,
})

/**
 * `vector` — pgvector's dense float32 vector (design/01 §3 row 62).
 *
 * Wire form is `[1,2,3]` — square brackets, no spaces, which is neither a PostgreSQL array
 * literal (`{1,2,3}`) nor JSON-with-a-cast. Decoded as `number[]`, because unlike `numeric` there
 * is nothing to lose: pgvector stores float4 and a JS `number` is a float64, so every value the
 * server can hold survives the round trip exactly.
 *
 * `typeClass: 'vector'` is load-bearing, not decoration — see `arrayCodec` in `./builtins.ts`:
 * it is what makes `vector[]` carrying `[[1,2],[3,4]]` two vectors (`{"[1,2]","[3,4]"}`) instead
 * of the 2-D array of four numbers a structural `Array.isArray` check would write.
 */
export const vectorCodec: Codec<readonly number[], number[], 'vector'> = definePgType({
  name: 'vector',
  typeClass: 'vector',
  encode: (v: readonly number[]) => {
    if (!Array.isArray(v)) throw new PgEncodeError('vector', v, 'an array of numbers')
    let out = '['
    for (let i = 0; i < v.length; i++) {
      const n = v[i]
      // pgvector rejects NaN and ±Infinity server-side ("NaN not allowed in vector"). Rejecting
      // them here names the offending index instead of failing three layers away with a 22000.
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw new PgEncodeError('vector', v, `a finite number at index ${i} (got ${String(n)})`)
      }
      if (i > 0) out += ','
      out += String(n)
    }
    return `${out}]`
  },
  decode: (raw): number[] => {
    if (raw.length < 2 || raw.charCodeAt(0) !== 0x5b || raw.charCodeAt(raw.length - 1) !== 0x5d) {
      throw new PgDecodeError('vector', raw, "expected pgvector's `[1,2,3]` bracket form")
    }
    const body = raw.slice(1, -1)
    if (body === '') return []
    const parts = body.split(',')
    const out = new Array<number>(parts.length)
    for (let i = 0; i < parts.length; i++) {
      const n = Number(parts[i])
      if (Number.isNaN(n)) {
        throw new PgDecodeError('vector', raw, `component ${i} ("${parts[i]}") is not a number`)
      }
      out[i] = n
    }
    return out
  },
})

/**
 * Every extension codec this package ships, registered by NAME only.
 *
 * Read once, by `Registry`'s constructor. The list is exported so a test can assert that a fresh
 * registry knows all of them and that none of them claims an OID (the two halves of the pending
 * window).
 */
export const EXTENSION_CODECS: readonly Codec<never, unknown, string>[] = Object.freeze([
  citextCodec as unknown as Codec<never, unknown, string>,
  vectorCodec as unknown as Codec<never, unknown, string>,
])
