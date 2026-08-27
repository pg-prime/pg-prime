/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  R5 — THE GOLDEN TEST (design/00-overview.md §Reconciliations R5)
 *
 *  "The differentiator claim 'a column types and decodes identically at any nesting depth'
 *   holds only if 03's compiler emits per-codec JSON casts *and* every codec implements
 *   `decodeJson`. Contract adopted: `decodeJson` is a required `Codec` member (not optional),
 *   plus a CI golden test decoding every built-in codec at depth 0 and depth 3 and asserting
 *   identical values. No `ShallowDehydrate` fallback types will be written — if the test fails,
 *   the build fails."
 *
 *  This is that test. For EVERY codec `builtinCodecs()` ships (25 scalars + the 25 array codecs
 *  derived from their `typarray` OIDs) it runs the same SQL expression twice:
 *
 *    depth 0 — `select <expr>`                       → raw wire text → `registry.planFor()`
 *    depth 3 — json_agg(json_build_object(           → JSON.parse   → `registry.jsonPlanFor()`
 *                json_agg(json_build_object(
 *                  json_agg(json_build_object('v', <expr><cast>))))))
 *
 *  and asserts the two decoded values are identical.
 *
 *  Three things make it a real test rather than a tautology:
 *   1. `<cast>` is NOT hard-coded — it is read from `codec.jsonEncode`, which is the exact
 *      contract the compiler (agent 03) will consume. `'text'` ⇒ emit `::text`, `'native'` ⇒
 *      emit nothing. int8 and numeric are the codecs that need it (see the NEGATIVE CONTROL
 *      at the bottom: without the cast PG emits a JSON *number* and JSON.parse silently
 *      destroys the value).
 *   2. Depth 0 goes through `registry.forOid(field.dataTypeID)`, so the shipped OID map is
 *      checked against what PostgreSQL actually puts in the RowDescription — a wrong OID in
 *      the table fails here, not in production.
 *   3. Every codec is covered or the suite fails (`covers every codec` below).
 * ══════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeHarness, type Harness } from '../live/_harness.js'
import { ALTERNATE_CODECS, builtinCodecs, createRegistry } from '../../src/codec/index.js'
import type { AnyCodec } from '../../src/codec/index.js'
import type { PgConnection } from '../../src/driver/index.js'

const registry = createRegistry()

let h: Harness
let conn: PgConnection

beforeAll(async () => {
  h = await makeHarness()
  conn = await h.driver.acquire()
  registry.setServerParameters(conn.serverParameters)
})
afterAll(async () => {
  await h?.driver.release(conn)
  await h?.end()
})

/**
 * One SQL expression per interesting shape, per codec. Values were chosen to break naive
 * implementations: 2^53+1 for int8, a trailing-zero scale for numeric, NaN/±Infinity for the
 * float and numeric families, µs precision and BC years for the temporal family, and the full
 * array-literal escaping zoo (`,` `"` `\` `{}` the *string* 'NULL' and a real NULL) for text[].
 */
const FIXTURES: Readonly<Record<string, readonly string[]>> = {
  // ── scalars ────────────────────────────────────────────────────────────────
  bool: ['true', 'false'],
  int2: ['32767::int2', '(-32768)::int2'],
  int4: ['128::int4', '(-2147483648)::int4'],
  // 9007199254740993 is a real, storable int8 that Number cannot hold.
  int8: ['9007199254740993::int8', "'-9223372036854775808'::int8"],
  oid: ['1259::oid'],
  float4: ['1.5::float4'],
  float8: [
    '(0.1::float8 + 0.2::float8)',
    "'NaN'::float8",
    "'Infinity'::float8",
    "'-Infinity'::float8",
  ],
  // `1.10` is the whole point: numeric(10,2) renders the scale, a JS number does not.
  numeric: [
    '1.10::numeric(10,2)',
    "'123456789012345678901234567890.12345'::numeric",
    "'NaN'::numeric",
    "'-Infinity'::numeric",
  ],
  text: [`'a"b\\c'::text`, `''::text`, `'ünïcödé ✓'::text`],
  varchar: [`'abc'::varchar(30)`],
  // PG SPACE-PADS bpchar — measured `"ab   "`. Do not trim.
  bpchar: [`'ab'::char(5)`],
  name: [`'somename'::name`],
  xml: [`'<a/>'::xml`],
  inet: [`'10.1.0.5/16'::inet`],
  cidr: [`'10.1.0.0/16'::cidr`],
  money: [`'12.34'::money`],
  uuid: [`'550E8400-E29B-41D4-A716-446655440000'::uuid`],
  // the headline guarantee: never a Date, and the out-of-ISO values survive verbatim.
  date: [`'2026-08-14'::date`, `'infinity'::date`, `'0001-01-01 BC'::date`, `'294276-12-31'::date`],
  time: [`'04:05:06.789'::time`],
  timetz: [`'04:05:06+05:30'::timetz`],
  // WS-audit: `interval` is the one type in §4.5's table with a STRUCTURED decoding, and the one
  // whose wire spelling depends on a session GUC (`IntervalStyle`) — both grammars are parsed,
  // and `json_build_object` uses the same output function, so depth 3 is the same text.
  interval: [
    `'1 year 2 mons 3 days 04:05:06.789'::interval`,
    `'-1 year -2 mons +3 days -04:05:06'::interval`,
    `'00:00:00'::interval`,
  ],
  // the string-like remainder of §4.5's table, registered by the WS-audit so their OIDs stop
  // falling through `planFor`'s unknown-OID escape hatch.
  char: [`'a'::"char"`],
  macaddr: [`'08:00:2b:01:02:03'::macaddr`],
  macaddr8: [`'08:00:2b:01:02:03:04:05'::macaddr8`],
  bit: [`'101'::bit(3)`],
  varbit: [`'10101'::varbit`],
  pg_lsn: [`'16/B374D848'::pg_lsn`],
  // ⚠️ PG's to_json inserts an ISO `T` where the wire text has a space. decodeJson normalises.
  timestamp: [
    `'2026-08-14 12:00:00.123456'::timestamp`,
    `'0001-01-01 12:00:00 BC'::timestamp`,
  ],
  timestamptz: [
    `'2026-08-14 06:30:00.123456+00'::timestamptz`,
    // a NON-UTC offset in the text: the decoded instant must be offset-driven, not assumed +00
    `'2026-08-14 06:30:00.123456+09'::timestamptz`,
    `'0001-01-01 12:00:00+00 BC'::timestamptz`,
  ],
  jsonb: [`'{"a":1,"b":[1,2],"c":null}'::jsonb`, `'[1,"two",3.5]'::jsonb`],
  json: [`'{"a": 1,   "b":2}'::json`],
  bytea: [`'\\x00ff80'::bytea`, `''::bytea`],

  // ── full text + ranges (WS3: `03` §2.9's tsvector and range operator classes) ──
  // All built-in, all wire-text in and out, all `jsonEncode: 'native'` because PostgreSQL
  // renders each as a JSON *string* — which this file is the proof of, not the claim.
  tsvector: [`to_tsvector('english', 'a fat cat sat')`],
  tsquery: [`websearch_to_tsquery('english', 'fat cat')`],
  jsonpath: [`'$.a[*] > 1'::jsonpath`],
  // `empty` is the case a naive `{lower, upper}` decoding cannot represent at all.
  int4range: [`'[1,5)'::int4range`, `'empty'::int4range`, `'(,5]'::int4range`],
  int8range: [`'[1,9223372036854775807)'::int8range`],
  // the trailing zero again: a range of numerics keeps the scale its text form carries
  numrange: [`'[1.10,2.20)'::numrange`, `'(,)'::numrange`],
  tsrange: [`'[2026-01-01 00:00:00,2026-02-01 00:00:00)'::tsrange`],
  tstzrange: [`'[2026-01-01 00:00:00+00,2026-02-01 00:00:00+00)'::tstzrange`],
  daterange: [`'[2026-01-01,2026-02-01)'::daterange`],

  // ── arrays (derived from each scalar's `typarray`) ─────────────────────────
  'bool[]': [`'{t,f,NULL}'::bool[]`],
  'int2[]': [`'{1,-2,NULL}'::int2[]`],
  'int4[]': [`'{1,2,NULL}'::int4[]`, `'{{1,2},{3,4}}'::int4[]`],
  'int8[]': [`'{9007199254740993,-1,NULL}'::int8[]`],
  'oid[]': [`'{1259,0}'::oid[]`],
  'float4[]': [`'{1.5,NULL}'::float4[]`],
  'float8[]': [
    `array[0.1::float8+0.2::float8, 'NaN'::float8, 'Infinity'::float8, null]`,
  ],
  'numeric[]': [`'{1.10,2.20,NULL}'::numeric(10,2)[]`],
  // the escaping zoo. Note the *string* 'NULL' must survive as a string while a real NULL
  // must decode to null — the single most-failed case in hand-rolled array parsers.
  'text[]': [
    `array['a','b,c',null,'NULL','{}','he said "hi"','back\\slash','  pad  ','']::text[]`,
    `'{}'::text[]`,
    `'{{a,b},{c,NULL}}'::text[]`,
  ],
  'varchar[]': [`'{ab,NULL}'::varchar[]`],
  'bpchar[]': [`'{ab}'::char(5)[]`],
  'name[]': [`'{somename}'::name[]`],
  'xml[]': [`array['<a/>'::xml]`],
  'inet[]': [`'{10.1.0.5/16}'::inet[]`],
  'cidr[]': [`'{10.1.0.0/16}'::cidr[]`],
  'money[]': [`'{12.34}'::money[]`],
  'uuid[]': [`array['550e8400-e29b-41d4-a716-446655440000'::uuid]`],
  'date[]': [`'{2026-08-14,2026-01-01,NULL}'::date[]`],
  'time[]': [`'{04:05:06.789}'::time[]`],
  'timetz[]': [`'{04:05:06+05:30}'::timetz[]`],
  'timestamp[]': [`array['2026-08-14 12:00:00.123456'::timestamp, null]`],
  'interval[]': [`array['1 day 02:03:04'::interval, '-1 mons'::interval, null]`],
  'char[]': [`array['a'::"char", null]`],
  'macaddr[]': [`array['08:00:2b:01:02:03'::macaddr]`],
  'macaddr8[]': [`array['08:00:2b:01:02:03:04:05'::macaddr8]`],
  'bit[]': [`array['101'::bit(3)]`],
  'varbit[]': [`array['10101'::varbit]`],
  'pg_lsn[]': [`array['16/B374D848'::pg_lsn]`],
  'timestamptz[]': [`array['2026-08-14 06:30:00.123456+00'::timestamptz, null]`],
  'jsonb[]': [`array['{"a":1}'::jsonb]`],
  'json[]': [`array['{"a": 1}'::json]`],
  'bytea[]': [`array['\\x00ff'::bytea, null]`],
  'tsvector[]': [`array[to_tsvector('english', 'a fat cat')]`],
  'tsquery[]': [`array[websearch_to_tsquery('english', 'cat')]`],
  'jsonpath[]': [`array['$.a'::jsonpath]`],
  'int4range[]': [`array['[1,5)'::int4range, 'empty'::int4range, null]`],
  'int8range[]': [`array['[1,5)'::int8range]`],
  'numrange[]': [`array['[1.10,2.20)'::numrange]`],
  'tsrange[]': [`array['[2026-01-01 00:00:00,2026-02-01 00:00:00)'::tsrange]`],
  'tstzrange[]': [`array['[2026-01-01 00:00:00+00,2026-02-01 00:00:00+00)'::tstzrange]`],
  'daterange[]': [`array['[2026-01-01,2026-02-01)'::daterange]`],
}

/** `select <expr>` — the raw RowDescription + wire text an ordinary query yields. */
async function atDepth0(expr: string): Promise<unknown> {
  const r = await conn.execute({ text: `select ${expr} as v`, params: [] })
  const field = r.fields[0]!
  const codec = registry.forOid(field.dataTypeID)
  return { field, codec, value: registry.planFor([field])[0]!(r.rows[0]![0]!) }
}

/**
 * Three levels of `json_agg(json_build_object(...))`, exactly the shape 03's LATERAL nesting
 * emits for `with: { a: { with: { b: { with: { c: true } } } } }`.
 */
async function atDepth3(expr: string, cast: string): Promise<unknown> {
  const sql = `
    select json_agg(l1)::text as payload
    from (
      select json_build_object('l2', (
        select json_agg(l2) from (
          select json_build_object('l3', (
            select json_agg(l3) from (
              select json_build_object('v', ${expr}${cast}) as l3
            ) s3
          )) as l2
        ) s2
      )) as l1
    ) s1`
  const r = await conn.execute({ text: sql, params: [] })
  const payload = JSON.parse(String(r.rows[0]![0])) as [{ l2: [{ l3: [{ v: unknown }] }] }]
  return payload[0]!.l2[0]!.l3[0]!.v
}

describe('R5 — decodeJson is required, and depth 0 === depth 3 for every built-in codec', () => {
  it('covers EVERY codec builtinCodecs() ships (this is the CI gate)', () => {
    const shipped = builtinCodecs().map((c) => c.name)
    const missing = shipped.filter((n) => !(n in FIXTURES))
    expect(missing).toEqual([])
    // 41 scalars + 41 array codecs derived from `typarray`. WS3 added nine scalars — tsvector,
    // tsquery, jsonpath and the six built-in range types — so `03` §2.9's `tsvector` and `range`
    // operator classes have a real codec to be gated on and a real OID to be differentiated
    // against. `vector` and `citext` are deliberately absent: extension types, per-database OIDs,
    // `resolveDynamic` path (09 §3.2 deviation 3).
    // The WS-audit added seven more: `interval` (the last structured decoding in §4.5's table)
    // plus the string-like set `"char"` / macaddr / macaddr8 / bit / varbit / pg_lsn, which were
    // decoding as untyped raw text with no `typeClass` and no `sqlName`.
    expect(shipped.length).toBe(82)
    expect(new Set(shipped).size).toBe(82)
  })

  for (const [name, exprs] of Object.entries(FIXTURES)) {
    it(`${name}: identical at depth 0 and depth 3`, async () => {
      const codec = registry.byName(name) as AnyCodec | undefined
      expect(codec, `no codec registered under the name ${name}`).toBeDefined()
      // The per-codec JSON cast the compiler must emit. NOT hard-coded — read from the codec.
      const cast = codec!.jsonEncode === 'text' ? '::text' : ''

      for (const expr of exprs) {
        const d0 = (await atDepth0(expr)) as {
          field: { dataTypeID: number }
          codec: AnyCodec | undefined
          value: unknown
        }
        // The shipped OID map agrees with the live RowDescription.
        expect(d0.codec?.name, `OID ${d0.field.dataTypeID} for ${expr}`).toBe(name)

        const raw3 = await atDepth3(expr, cast)
        const d3 = registry.jsonPlanFor([codec!])[0]!(raw3)

        expect(d3, `${name} :: ${expr}`).toEqual(d0.value)
      }
    })
  }

  it('NULL decodes to null at BOTH depths, for every codec', async () => {
    for (const name of Object.keys(FIXTURES)) {
      const codec = registry.byName(name)!
      // `sqlName` is the DSL's DDL contract; using it here also asserts sqlName ↔ OID agreement.
      const expr = `null::${codec.sqlName}`
      const cast = codec.jsonEncode === 'text' ? '::text' : ''
      const d0 = (await atDepth0(expr)) as { codec: AnyCodec | undefined; value: unknown }
      expect(d0.codec?.name, `sqlName '${codec.sqlName}' resolved to the wrong OID`).toBe(name)
      expect(d0.value).toBeNull()
      const d3 = registry.jsonPlanFor([codec])[0]!(await atDepth3(expr, cast))
      expect(d3).toBeNull()
    }
  })
})

/**
 * The four NAMED ALTERNATES (`ALTERNATE_CODECS`) — R5 applies to them too.
 *
 * They were outside this file's loop because they are registered by NAME only (they share an OID
 * with a default), so `registry.forOid` cannot reach them and `planFor` never selects one. That
 * gap hid a real R5 violation: `timestamptz:string` is DEFINED as the verbatim wire text, but its
 * `jsonEncode` was 'native', and `json_build_object` renders a timestamptz as
 * `2026-08-14T06:30:00.123456+00:00` where the wire says `2026-08-14 06:30:00.123456+00`. Depth 0
 * and depth 3 returned two different strings for the same datum — exactly the "no dehydration
 * tax" promise R5 exists to keep. The fix is `jsonEncode: 'text'`, which this loop now pins.
 *
 * Depth 0 here calls the alternate's own `decodeText` (it is reachable only by name), but the
 * OID assertion is kept: the alternate must still claim the OID the server actually reports.
 */
const ALTERNATE_FIXTURES: Readonly<Record<string, readonly string[]>> = {
  // NOT 2^53+1: `int8:number` is documented as throwing above MAX_SAFE_INTEGER (that is why
  // `int8` is the default), so the fixture is a value it is allowed to carry.
  'int8:number': ['1259::int8', "'-9007199254740991'::int8"],
  'int8:string': ["'9223372036854775807'::int8", "'-9223372036854775808'::int8"],
  'numeric:number': ['1.10::numeric(10,2)', "'-2.5'::numeric"],
  'timestamptz:string': [
    // µs precision and a non-UTC offset — the two reasons this codec exists.
    `'2026-08-14 06:30:00.123456+00'::timestamptz`,
    `'2026-08-14 06:30:00.123456+09'::timestamptz`,
    // and the value the default codec REFUSES, which is the other reason it exists
    `'infinity'::timestamptz`,
  ],
}

describe('R5 — the named alternates are pinned at both depths too', () => {
  it('covers every codec in ALTERNATE_CODECS', () => {
    const shipped = ALTERNATE_CODECS.map((c) => c.name)
    expect(shipped.filter((n) => !(n in ALTERNATE_FIXTURES))).toEqual([])
    expect(shipped.length).toBe(4)
  })

  for (const [name, exprs] of Object.entries(ALTERNATE_FIXTURES)) {
    it(`${name}: identical at depth 0 and depth 3`, async () => {
      const codec = registry.byName(name)!
      expect(codec, `no codec registered under the name ${name}`).toBeDefined()
      const cast = codec.jsonEncode === 'text' ? '::text' : ''
      const ctx = { typmod: -1, registry, serverParameters: conn.serverParameters }

      for (const expr of exprs) {
        const r = await conn.execute({ text: `select ${expr} as v`, params: [] })
        // the alternate claims the OID the server really reports for this expression
        expect(r.fields[0]!.dataTypeID, `${name} :: ${expr}`).toBe(codec.oid)
        const d0 = codec.decodeText(String(r.rows[0]![0]), ctx)

        const d3 = registry.jsonPlanFor([codec])[0]!(await atDepth3(expr, cast))
        expect(d3, `${name} :: ${expr}`).toEqual(d0)
      }
    })
  }

  it('NEGATIVE CONTROL: without the ::text cast, timestamptz:string returns a DIFFERENT string', async () => {
    // This is the bug the loop above now prevents: the JSON spelling is not the wire spelling,
    // and a codec whose contract is "verbatim wire text" cannot absorb the difference.
    const expr = `'2026-08-14 06:30:00.123456+00'::timestamptz`
    const native = await atDepth3(expr, '')
    const withCast = await atDepth3(expr, '::text')
    expect(native).not.toBe(withCast)
    expect(String(native)).toMatch(/T.*\+00:00$/)
    expect(String(withCast)).toMatch(/ .*\+00$/)
    expect(registry.byName('timestamptz:string')!.jsonEncode).toBe('text')
  })
})

describe('R5 — the NEGATIVE control: the per-codec JSON cast is load-bearing', () => {
  it('int8 WITHOUT ::text arrives as a JSON number and loses the low bit', async () => {
    expect(registry.byName('int8')!.jsonEncode).toBe('text')
    const native = await atDepth3('9007199254740993::int8', '') // deliberately no cast
    expect(typeof native).toBe('number')
    expect(native).toBe(9007199254740992) // ← 9007199254740993 silently became ...992
    // and the codec REFUSES it rather than returning the wrong bigint
    expect(() => registry.jsonPlanFor([registry.byName('int8')!])[0]!(native)).toThrow(
      /must emit ::text/,
    )
    // with the cast, it is exact
    expect(await atDepth3('9007199254740993::int8', '::text')).toBe('9007199254740993')
  })

  it('numeric WITHOUT ::text arrives as a JSON number and loses the scale', async () => {
    expect(registry.byName('numeric')!.jsonEncode).toBe('text')
    const native = await atDepth3('1.10::numeric(10,2)', '')
    expect(typeof native).toBe('number')
    expect(native).toBe(1.1) // ← the `numeric(10,2)` scale is gone
    expect(() => registry.jsonPlanFor([registry.byName('numeric')!])[0]!(native)).toThrow(
      /must emit ::text/,
    )
    expect(await atDepth3('1.10::numeric(10,2)', '::text')).toBe('1.10')
  })

  it('int8[] inherits the requirement from its element', async () => {
    expect(registry.byName('int8[]')!.jsonEncode).toBe('text')
    expect(registry.byName('numeric[]')!.jsonEncode).toBe('text')
    const native = await atDepth3(`'{9007199254740993}'::int8[]`, '')
    expect(native).toEqual([9007199254740992])
  })

  it('the two PG-side JSON spelling changes are absorbed, not asserted away', async () => {
    // timestamp: space on the wire, ISO `T` inside json_build_object
    expect(await atDepth3(`'2026-08-14 12:00:00.123456'::timestamp`, '')).toBe(
      '2026-08-14T12:00:00.123456',
    )
    const d0 = await conn.execute({
      text: `select '2026-08-14 12:00:00.123456'::timestamp as v`,
      params: [],
    })
    expect(d0.rows[0]![0]).toBe('2026-08-14 12:00:00.123456')
    // timestamptz: `+00` on the wire, `+00:00` inside json_build_object
    expect(await atDepth3(`'2026-08-14 06:30:00.123456+00'::timestamptz`, '')).toBe(
      '2026-08-14T06:30:00.123456+00:00',
    )
  })
})
