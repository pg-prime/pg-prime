/**
 * The decode bench's oracle is checked in tier 0, not only by the bench (design/09 WS7).
 *
 * `bench/runtime` measures `buildDecoder` against the hand-written positional mapper in
 * `bench/runtime/hand-mapper.mjs` and reports the ratio as an Appendix B gate. That number means
 * nothing unless the two sides produce the *same values* — a mapper that returned `Number` where
 * the decoder returns `bigint`, or that skipped the microsecond truncation, would look like a fast
 * oracle and would in fact be a different job.
 *
 * The bench asserts the equivalence itself before it starts the clock, but a bench runs nightly and
 * on a label. This file is the same assertion in `pnpm test`, so the day someone edits the mapper
 * the failure is in the tier-0 run they already look at. It is the ONE thing from WS7's bench that
 * belongs in tier 0 (benches are not tests); everything else there is timing.
 *
 * It also pins the two conversions that make the oracle non-trivial, each with the negative control
 * R4 asks for: an id past 2^53 that `Number` would round, and a microsecond timestamp that a naive
 * `new Date(raw)` would parse to a different instant on a machine whose locale is not UTC.
 *
 * ## Three implementations, not two (R1)
 *
 * Since `{ decoder: 'codegen' }` exists (`03` §1.3 AS BUILT), every assertion below runs for
 * **both** builders — the closure tree and the `new Function` one — so the property under test is
 * "the two builders and the hand mapper all agree", which is the strongest form of R1 available
 * here: three independent implementations, one of which (the mapper) was written to be readable
 * rather than general, and one of which (the generated code) shares no row-materialisation code
 * with the other two at all. A codegen bug that dropped a null check, mis-ordered a key or
 * inlined the wrong codec cannot pass this file.
 */

import { describe, expect, it } from 'vitest'
import {
  DECODE_KEYS,
  decodeRows,
  handMapRows,
  handMapRowsChecked,
  handMapRowsPlain,
} from '../../../../bench/runtime/hand-mapper.mjs'
import { textCodec } from '../../src/codec/index.js'
import type { ResultShape } from '../../src/compile/contract.js'
import type { DecoderMode } from '../../src/compile/decode.js'
import { assertCodegenAvailable, buildDecoder } from '../../src/compile/decode.js'
import { DecodePlanError, PgPrimeError } from '../../src/sql/errors.js'
import { compileOnly, pgPrime } from '../../src/query/run.js'
import { mockDriver } from '../query/_mock-driver.js'
import * as q from '../../src/query/types.js'
import { makeFixture } from '../live/fixture.js'

const fx = makeFixture('pgprime_decode_oracle')
const h = fx.schema.h
const db = compileOnly(fx.schema)

/**
 * The bench's decode projection, rebuilt here through the public API.
 *
 * Written out a second time on purpose: the assertion below is that its compiled column ORDER is
 * `DECODE_KEYS`, which is the mapper's own contract. If the bench's projection and this one ever
 * drift, that assertion fails here — in tier 0 — rather than producing a silently mismatched
 * benchmark.
 */
const compiled = db
  .from(h.posts)
  .innerJoin(h.users, 'author', ({ posts: p, author: a }) => q.eq(p.authorId, a.id))
  .leftJoin(h.comments, 'c', ({ posts: p, c }) => q.eq(c.postId, p.id))
  .select(({ posts: p, author: a, c }) => ({
    id: p.id,
    authorId: p.authorId,
    title: p.title,
    body: p.body,
    amount: p.amount,
    published: p.published,
    createdAt: p.createdAt,
    authorEmail: a.email,
    authorName: a.name,
    authorBalance: a.balance,
    commentId: c.id,
    commentBody: c.body,
  }))
  .compile()

/** 200 rows is enough for every branch (nulls arrive every eighth row) and costs ~2 ms. */
const rows = decodeRows(200)

const MODES: readonly DecoderMode[] = ['closure', 'codegen']

/** Twelve `text` codecs: nothing converts, so any difference is the row loop's alone. */
const identityShape: ResultShape = {
  k: 'row',
  fields: DECODE_KEYS.map((key, idx) => ({ k: 'col' as const, key, idx, codec: textCodec })),
}

describe.each(MODES)('bench/runtime hand mapper is an oracle (decoder: %s)', (mode) => {
  it('the compiled projection is the twelve columns the mapper expects, in order', () => {
    const keys = compiled.shape.k === 'row' ? compiled.shape.fields.map((f) => f.key) : []
    expect(keys).toStrictEqual([...DECODE_KEYS])
  })

  it('the unchecked mapper decodes to exactly what buildDecoder decodes to', () => {
    const ours = buildDecoder<Record<string, unknown>>(compiled.shape, undefined, mode)(rows)
    expect(ours).toStrictEqual(handMapRows(rows))
  })

  it('so does the checked mapper — the one the dispatch-cost ratio is measured against', () => {
    const ours = buildDecoder<Record<string, unknown>>(compiled.shape, undefined, mode)(rows)
    expect(ours).toStrictEqual(handMapRowsChecked(rows))
  })

  it('and the identity pair agrees too, which is what makes the dispatch ratio a ratio', () => {
    expect(buildDecoder(identityShape, undefined, mode)(rows)).toStrictEqual(handMapRowsPlain(rows))
  })

  it('key ORDER is the projection order, not the plan-walk order', () => {
    // The generated code writes an object literal and the closure tree writes properties one by
    // one; `toStrictEqual` does not compare key order, so it is asserted on its own. A consumer
    // that `JSON.stringify`s a row sees this order.
    const row = buildDecoder<Record<string, unknown>>(compiled.shape, undefined, mode)(rows)[0]
    expect(Object.keys(row as object)).toStrictEqual([...DECODE_KEYS])
  })

  it('R4 negative control: a mapper that used Number would NOT be an oracle', () => {
    // The fixture's ids start at 2^53+1, so `Number` loses the last digit — which is the whole
    // reason the mapper says `BigInt`. Without this control, "the two agree" could be true because
    // neither side is exercised. Compared as TEXT, because `Number(x) !== 9007199254740993` is
    // vacuously false: the literal on the right rounds to the same float.
    const first = String(rows[0]?.[0])
    expect(first).toBe('9007199254740993')
    expect(String(Number(first))).toBe('9007199254740992')
    expect(handMapRows(rows)[0]?.['id']).toBe(9007199254740993n)
  })

  it('R4 negative control: sub-millisecond digits are TRUNCATED, on both sides, not rounded', () => {
    const raw = String(rows[0]?.[6])
    expect(raw).toMatch(/\.\d{6}\+00$/)

    // Two timestamps that differ only below the millisecond must decode to the same instant —
    // JavaScript `Date` has no finer resolution, and that loss is the documented behaviour of
    // `timestamptzCodec`. `.123999` is the discriminating value: truncation gives 123 ms, and a
    // mapper that ROUNDED (the plausible alternative) would give 124 and disagree with the codec.
    const at = (frac: string): readonly (string | null)[] => {
      const row = [...(rows[0] ?? [])]
      row[6] = `2026-03-01 12:34:56.${frac}+00`
      return row
    }
    const decode = buildDecoder<Record<string, unknown>>(compiled.shape, undefined, mode)
    const lo = decode([at('123456')])[0]?.['createdAt']
    const hi = decode([at('123999')])[0]?.['createdAt']
    expect(lo).toBeInstanceOf(Date)
    expect(lo).toStrictEqual(hi)
    expect((lo as Date).getTime() % 1000).toBe(123)
    expect(handMapRows([at('123456')])[0]?.['createdAt']).toStrictEqual(lo)
    expect(handMapRows([at('123999')])[0]?.['createdAt']).toStrictEqual(hi)
  })
})

describe('the codegen decoder is the same decoder, generated (03 §1.3 AS BUILT)', () => {
  it('the two builders agree cell for cell, including the nulls', () => {
    // Not "both agree with the mapper" — *directly* with each other, on the same rows, so a
    // change that broke both would still have to break them identically.
    const a = buildDecoder<Record<string, unknown>>(compiled.shape, undefined, 'closure')(rows)
    const b = buildDecoder<Record<string, unknown>>(compiled.shape, undefined, 'codegen')(rows)
    expect(b).toStrictEqual(a)
    // Row 0 is a NULL left-join row (`decodeRows` nulls every eighth), so the generated code's
    // null branch is on this path rather than merely present.
    expect(a[0]?.['commentId']).toBeNull()
    expect(b[0]?.['commentId']).toBeNull()
  })

  it('a pre-parsed value passes through both builders unchanged', () => {
    // `pg` with its default type parsers hands back a `Date`, not a string. Both builders must
    // pass a non-string through rather than re-parsing it, and the generated code has to spell
    // that branch out itself.
    const d = new Date('2026-03-01T12:34:56.123Z')
    const row = [...(rows[0] ?? [])] as unknown[]
    row[6] = d
    for (const mode of MODES) {
      const out = buildDecoder<Record<string, unknown>>(compiled.shape, undefined, mode)([row])
      expect(out[0]?.['createdAt']).toBe(d)
    }
  })

  it('a missing cell — `undefined`, not SQL NULL — is `null` from both builders', () => {
    // The short-circuit both builders spell is `raw === null || raw === undefined`, and the
    // `undefined` half has no oracle in the rows above, because `pg` sends SQL NULL as `null`.
    // Without this test the `undefined` half is a mutation that survives: `typeof undefined` is
    // not `'string'`, so dropping the guard returns `undefined` where the closure tree returns
    // `null`, and `toStrictEqual` is the only thing in the suite that tells those two apart.
    const row = [...(rows[0] ?? [])] as unknown[]
    row[0] = undefined
    const outs = MODES.map((mode) =>
      buildDecoder<Record<string, unknown>>(compiled.shape, undefined, mode)([row]),
    )
    expect(outs[0]?.[0]?.['id']).toBeNull()
    expect(outs[1]).toStrictEqual(outs[0])
  })

  it("a '__proto__' result key is refused by BOTH builders, at plan time", () => {
    // The generated source puts the key in a string literal, where `__proto__` would be an
    // ordinary property and *not* a prototype write — which is exactly why it must still be
    // refused: otherwise the two builders disagree, and one of them is the unsafe one.
    const shape: ResultShape = {
      k: 'row',
      fields: [{ key: '__proto__', k: 'col', idx: 0, codec: textCodec }],
    }
    for (const mode of MODES) {
      expect(() => buildDecoder(shape, undefined, mode)).toThrow(DecodePlanError)
    }
  })

  it('a column index that is not a non-negative integer never reaches the generated source', () => {
    // The one number the generator interpolates. A hand-built plan is the only way to get here,
    // and it must be a `DecodePlanError` rather than a syntax error out of `new Function`.
    for (const idx of [-1, 1.5, Number.NaN, '0' as unknown as number]) {
      const shape: ResultShape = {
        k: 'row',
        fields: [{ key: 'x', k: 'col', idx, codec: textCodec }],
      }
      expect(() => buildDecoder(shape, undefined, 'codegen')).toThrow(DecodePlanError)
    }
  })

  it('a result key full of quotes, newlines and separators is data, not code', () => {
    // Interpolated unescaped, this key would close the string literal and the object literal and
    // start a statement. `JSON.stringify` plus the U+2028/U+2029 escape is what makes it a key.
    const key = '"});globalThis.PWNED=1;({"a\n\u2028\u2029\\'
    const shape: ResultShape = {
      k: 'row',
      fields: [{ key, k: 'col', idx: 0, codec: textCodec }],
    }
    const out = buildDecoder<Record<string, unknown>>(shape, undefined, 'codegen')([['v']])
    expect(out).toStrictEqual([{ [key]: 'v' }])
    expect(
      buildDecoder<Record<string, unknown>>(shape, undefined, 'closure')([['v']]),
    ).toStrictEqual(out)
    expect((globalThis as Record<string, unknown>)['PWNED']).toBeUndefined()
  })

  it('assertCodegenAvailable() passes on a runtime that allows new Function', () => {
    expect(() => assertCodegenAvailable()).not.toThrow()
  })
})

/**
 * The CSP contract, with the runtime that forbids `eval` simulated rather than described.
 *
 * `new Function` resolves the global binding, so replacing `globalThis.Function` with one that
 * throws is what a Content-Security-Policy without `unsafe-eval` looks like from inside the
 * library — a `EvalError` at the moment code is generated. Three things have to be true then, and
 * only the first of them is obvious:
 *
 *  1. asking for the flag fails, with a message that names the option and the fix;
 *  2. it fails at `pgPrime()`, not at the first query — the whole complaint against eval-based
 *     fast paths is that they work in dev and fail under load;
 *  3. the DEFAULT is unaffected, i.e. the closure tree really does build and really does decode on
 *     a runtime with no code generation at all. Without this one the other two are a nicer
 *     spelling of the same outage.
 */
describe("a runtime that forbids `eval` (design/03 §1.3's reason for the default)", () => {
  const withoutNewFunction = <T>(f: () => T): T => {
    const real = globalThis.Function
    const refuse = function Function() {
      throw new EvalError(
        "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script",
      )
    } as unknown as FunctionConstructor
    globalThis.Function = refuse
    try {
      return f()
    } finally {
      globalThis.Function = real
    }
  }

  it('assertCodegenAvailable() refuses, naming the option and the way out', () => {
    const err = withoutNewFunction(() => {
      try {
        assertCodegenAvailable()
        return undefined
      } catch (e) {
        return e
      }
    })
    expect(err).toBeInstanceOf(DecodePlanError)
    expect(err).toBeInstanceOf(PgPrimeError)
    expect(String(err)).toContain("decoder: 'codegen'")
    expect(String(err)).toContain('Content-Security-Policy')
  })

  it("pgPrime({ decoder: 'codegen' }) throws at construction, before any query", () => {
    expect(() =>
      withoutNewFunction(() =>
        pgPrime({ driver: mockDriver(), schema: fx.schema, decoder: 'codegen' }),
      ),
    ).toThrow(DecodePlanError)
  })

  it('…and the default builds AND decodes on the same runtime — R4 negative control', () => {
    const rows2 = withoutNewFunction(() => {
      const decode = buildDecoder<Record<string, unknown>>(compiled.shape)
      return decode(rows)
    })
    expect(rows2).toStrictEqual(handMapRows(rows))
    // The other direction, in the same breath: it is code generation that is refused, not the
    // shape — the generated builder on this plan is fine the moment `new Function` is back.
    expect(() => buildDecoder(compiled.shape, undefined, 'codegen')).not.toThrow()
  })
})
