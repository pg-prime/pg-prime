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
import { buildDecoder } from '../../src/compile/decode.js'
import { compileOnly } from '../../src/query/run.js'
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

describe('bench/runtime hand mapper is an oracle', () => {
  it('the compiled projection is the twelve columns the mapper expects, in order', () => {
    const keys = compiled.shape.k === 'row' ? compiled.shape.fields.map((f) => f.key) : []
    expect(keys).toStrictEqual([...DECODE_KEYS])
  })

  it('the unchecked mapper decodes to exactly what buildDecoder decodes to', () => {
    const ours = buildDecoder<Record<string, unknown>>(compiled.shape)(rows)
    expect(ours).toStrictEqual(handMapRows(rows))
  })

  it('so does the checked mapper — the one the dispatch-cost ratio is measured against', () => {
    const ours = buildDecoder<Record<string, unknown>>(compiled.shape)(rows)
    expect(ours).toStrictEqual(handMapRowsChecked(rows))
  })

  it('and the identity pair agrees too, which is what makes the dispatch ratio a ratio', () => {
    // Twelve `text` codecs: both sides convert nothing, so any difference is the row loop's.
    const shape: ResultShape = {
      k: 'row',
      fields: DECODE_KEYS.map((key, idx) => ({ k: 'col' as const, key, idx, codec: textCodec })),
    }
    expect(buildDecoder(shape)(rows)).toStrictEqual(handMapRowsPlain(rows))
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
    const decode = buildDecoder<Record<string, unknown>>(compiled.shape)
    const lo = decode([at('123456')])[0]?.['createdAt']
    const hi = decode([at('123999')])[0]?.['createdAt']
    expect(lo).toBeInstanceOf(Date)
    expect(lo).toStrictEqual(hi)
    expect((lo as Date).getTime() % 1000).toBe(123)
    expect(handMapRows([at('123456')])[0]?.['createdAt']).toStrictEqual(lo)
    expect(handMapRows([at('123999')])[0]?.['createdAt']).toStrictEqual(hi)
  })
})
