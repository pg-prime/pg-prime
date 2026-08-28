// The decode oracle (design/09 WS7): a hand-written positional mapper for the twelve columns
// `cases.mjs` projects, against which the closure-tree decoder is measured (design/03 Appendix B:
// "within 15% of a hand-written positional mapper").
//
// **It is an oracle, so it has to be right, not just fast.** `run.mjs` asserts that every row it
// produces is `toStrictEqual`-identical to `buildDecoder`'s before it times either — an oracle that
// produces different values is not an oracle, it is a second implementation with a shorter loop.
// `test/compile/hand-mapper-oracle.test.ts` pins the same equivalence in tier 0, so the claim is
// checked by `pnpm test` and not only by a bench nobody runs locally.
//
// **It is deliberately the fastest honest thing.** No dispatch, no per-cell branch on a codec, no
// registry, no context object: twelve inline conversions in a fixed order. That is the bar — the
// point of the 1.15x budget is that the decoder's generality must cost almost nothing, so the
// comparison is only meaningful if the other side gives up all of it.
//
// The two conversions worth reading twice:
//
//   `int8` → `BigInt(raw)`, never `Number(raw)`. The bench's ids start at 2^53+1 (the live
//   fixture's `FIRST_POST_ID`), so a mapper that used `Number` would return a different value and
//   the equivalence assertion would fail — which is the negative control for this file existing.
//
//   `timestamptz` → the bench's rows always carry PostgreSQL's canonical UTC spelling
//   (`2026-03-01 12:34:56.123456+00`), so slicing is the whole of it. JavaScript `Date` is
//   millisecond-resolution, so `.123456` truncates to `.123` — which is exactly what
//   `timestamptzCodec` does (`frac.padEnd(6,'0').slice(0,3)`), and the assertion is what proves it
//   rather than this comment.

/**
 * `'2026-03-01 12:34:56.123456+00'` → `Date`, and `'2026-02-04 10:00:00+00'` too — PostgreSQL omits
 * the fraction when it is zero, which the first version of this line did not survive. Canonical UTC
 * spelling only (`+00`, always three characters, because the harness asserts the session is UTC
 * rather than SET-ting it — `02` §4.7); `slice(11, -3)` is therefore the time with its fraction and
 * without the offset. V8 truncates sub-millisecond digits, which is what `timestamptzCodec` does.
 */
const at = (s) => new Date(`${s.slice(0, 10)}T${s.slice(11, -3)}Z`)

/**
 * `(string | null)[][]` → the twelve-key row objects `cases.mjs`'s decode projection promises.
 *
 * Column order is the projection's order and is asserted in `run.mjs`; it is repeated here rather
 * than derived, because a mapper that read the plan would be the decoder again.
 */
export function handMapRows(rows) {
  const out = new Array(rows.length)
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const commentId = r[10]
    out[i] = {
      id: BigInt(r[0]),
      authorId: BigInt(r[1]),
      title: r[2],
      body: r[3],
      amount: r[4],
      published: r[5] === 't',
      createdAt: at(r[6]),
      authorEmail: r[7],
      authorName: r[8],
      authorBalance: r[9],
      commentId: commentId === null ? null : BigInt(commentId),
      commentBody: r[11],
    }
  }
  return out
}

/**
 * The same twelve columns, for the end-to-end cases where the raw side is `pg`'s
 * `query({ rowMode: 'array' })`. `pg` hands back strings for these OIDs unless a type parser is
 * registered, so it is the identical input and the identical mapper — which is what makes the
 * `orm() / raw()` ratio a measurement of *our* overhead rather than of two different jobs.
 */
/** The narrower mapper the point-select and 1000-row cases use: `id`, `email`, `name`. */
export function handMapUsers(rows) {
  const out = new Array(rows.length)
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    out[i] = { id: BigInt(r[0]), email: r[1], name: r[2] }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// The other two oracles, and why one mapper is not enough
// ─────────────────────────────────────────────────────────────────────────────
//
// design/03 Appendix B asks for "within 15% of a hand-written positional mapper" and does not say
// what the mapper is allowed to skip. Measured, that turns out to be the whole question: the
// mapper above is 2.6x faster than `buildDecoder`, and 45 % of that gap is work the mapper simply
// does not do (validate that an `int8` is digits; parse a `timestamptz` rather than trusting
// `Date`'s parser). Comparing a checking decoder with a non-checking mapper answers "what does
// correctness cost", not "what does the closure tree cost", so the bench measures three pairs and
// prints all three:
//
//   1. {@link handMapRows}         — unchecked. What a person would actually write by hand, which
//                                    is the literal reading of Appendix B.
//   2. {@link handMapRowsChecked}  — the same conversions the codecs perform, written out. This
//                                    isolates the DISPATCH cost of the closure tree.
//   3. {@link handMapRowsPlain}    — no conversion at all, against a decoder whose codecs are all
//                                    `text` (identity). Both sides then do the same nothing, and
//                                    what is left is purely the shape of the row loop: a literal
//                                    object versus twelve dynamic key assignments.
//
// Reporting only (1) would have hidden where the cost is; reporting only (2) would have quietly
// moved the goalposts. design/09 §3.7 records what the three numbers turned out to be.

/** `int8` is digits, or the codec throws. `BigInt('0x10')` is 16n, which is why this exists. */
const INT8_TEXT = /^-?\d+$/

/**
 * PostgreSQL's canonical `timestamptz` text, parsed the way `timestamptzCodec` parses it —
 * field by field, never handed to `Date`'s parser, and truncated to millisecond resolution because
 * that is all a JavaScript `Date` has.
 */
const TSTZ =
  /^(\d{4,})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.(\d+))?(?:(Z)|([+-])(\d\d)(?::?(\d\d))?)?$/

function parseTstz(raw) {
  const m = TSTZ.exec(raw)
  if (m === null) throw new Error(`not a timestamptz: ${raw}`)
  const ms = m[7] ? Number(m[7].padEnd(6, '0').slice(0, 3)) : 0
  let t = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    ms,
  )
  if (m[8] === undefined && m[9] !== undefined) {
    const off = (Number(m[10]) * 3600 + Number(m[11] ?? 0) * 60) * (m[9] === '-' ? -1 : 1)
    t -= off * 1000
  }
  return new Date(t)
}

/** Oracle 2: identical output, identical checking, no dispatch. */
export function handMapRowsChecked(rows) {
  const out = new Array(rows.length)
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!INT8_TEXT.test(r[0])) throw new Error(`not an int8: ${r[0]}`)
    if (!INT8_TEXT.test(r[1])) throw new Error(`not an int8: ${r[1]}`)
    const commentId = r[10]
    if (commentId !== null && !INT8_TEXT.test(commentId))
      throw new Error(`not an int8: ${commentId}`)
    out[i] = {
      id: BigInt(r[0]),
      authorId: BigInt(r[1]),
      title: r[2],
      body: r[3],
      amount: r[4],
      published: r[5] === 't' ? true : r[5] === 'f' ? false : rejectBool(r[5]),
      createdAt: parseTstz(r[6]),
      authorEmail: r[7],
      authorName: r[8],
      authorBalance: r[9],
      commentId: commentId === null ? null : BigInt(commentId),
      commentBody: r[11],
    }
  }
  return out
}

function rejectBool(v) {
  throw new Error(`not a bool: ${v}`)
}

/**
 * Oracle 3: the twelve cells copied into a literal object, no conversion of any kind. Paired
 * against a decoder built over twelve `text` codecs, so both sides convert nothing and the ratio is
 * the row loop alone.
 */
export function handMapRowsPlain(rows) {
  const out = new Array(rows.length)
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    out[i] = {
      id: r[0],
      authorId: r[1],
      title: r[2],
      body: r[3],
      amount: r[4],
      published: r[5],
      createdAt: r[6],
      authorEmail: r[7],
      authorName: r[8],
      authorBalance: r[9],
      commentId: r[10],
      commentBody: r[11],
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// The column contract and the row fixture
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The twelve columns `hand-mapper.mjs` is the oracle for: two `int8`, five `text`, two `numeric`,
 * one `bool`, one `timestamptz`, and two nullable columns off the left join so the null branch is
 * on the measured path.
 *
 * Column ORDER is the contract between this projection and the hand mapper; `run.mjs` asserts the
 * compiled `shape` has exactly these keys in exactly this order before it times anything.
 */
export const DECODE_KEYS = [
  'id',
  'authorId',
  'title',
  'body',
  'amount',
  'published',
  'createdAt',
  'authorEmail',
  'authorName',
  'authorBalance',
  'commentId',
  'commentBody',
]

/**
 * 10 000 rows x 12 columns of PostgreSQL wire text (design/03 Appendix B).
 *
 * Every value is the *text* a real server sends, because that is the decoder's input: `int8` as
 * digits past 2^53, `numeric` with a trailing zero that must survive, `bool` as `t`/`f`,
 * `timestamptz` in PostgreSQL's canonical UTC spelling with microseconds. One row in eight has a
 * NULL left-join pair, so both branches are exercised in the ratio rather than one.
 */
export function decodeRows(n = 10_000) {
  const rows = new Array(n)
  const FIRST = 9007199254740993n
  for (let i = 0; i < n; i++) {
    const nullish = i % 8 === 0
    rows[i] = [
      String(FIRST + BigInt(i)),
      String(FIRST + BigInt(i % 97)),
      `post title ${i}`,
      `body text for post number ${i}, long enough to look like prose rather than a token`,
      `${1000 + (i % 9000)}.${String(i % 100).padStart(2, '0')}`,
      i % 3 === 0 ? 'f' : 't',
      `2026-03-${String((i % 28) + 1).padStart(2, '0')} 12:34:56.${String(100000 + (i % 899999))}+00`,
      `user${i % 97}@example.com`,
      `User Number ${i % 97}`,
      `${i % 500}.50`,
      nullish ? null : String(FIRST + BigInt(i * 3)),
      nullish ? null : `comment body ${i}`,
    ]
  }
  return rows
}
