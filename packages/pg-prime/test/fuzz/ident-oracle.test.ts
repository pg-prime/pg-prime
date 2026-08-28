/**
 * `sql.ident` differential fuzz against a live PostgreSQL — the dual oracle of 03 §3.4.
 *
 * **Oracle A — `format('%I')`.** The canonical server-side quoter. It differs from us in
 * exactly one *intended* way: `%I` omits the quotes when the identifier is already a safe
 * bare word, and we always quote. So the comparison is `ourOutput === addQuotesIfBare(pgOut)`,
 * and the always-quote difference is asserted explicitly rather than papered over.
 *
 * **Oracle B — `CREATE TEMP TABLE` round trip.** Create the table using our quoted output,
 * then read `pg_class.relname` back and assert **byte equality** with the input. This is the
 * stronger oracle: it catches truncation, normalisation, and escaping errors that a string
 * comparison against `format` would miss, because it goes all the way through the parser and
 * the catalog.
 *
 * **Divergence, documented and pinned.** We reject identifiers longer than 63 UTF-8 bytes;
 * `format('%I')` happily quotes them and lets the *parser* truncate later. That is the one
 * deliberate difference, and the `reject-vs-truncate` block below proves why it is the safe
 * side to err on.
 */

import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { InvalidIdentifierError } from '../../src/sql/errors.js'
import { MAX_IDENT_BYTES, quoteIdentPart } from '../../src/sql/ident.js'
import { connect } from '../live/_harness.js'
import { announceSample, FUZZ_CASES, FUZZ_ORACLE_CASES, FUZZ_SEED } from './_budget.js'
import { announceCorpus, corpusSeeds, recordFinding } from './corpus.js'
import type { Case } from './generator.js'
import { cases, makeCase, utf8Bytes } from './generator.js'

interface Accepted {
  readonly input: string
  readonly quoted: string
  readonly seed: number
  readonly strategy: string
}

interface Rejected {
  readonly seed: number
  readonly strategy: string
  readonly reason: string
  readonly bytes: number
}

interface Mismatch {
  readonly oracle: 'format' | 'roundtrip'
  readonly seed: number
  readonly input: string
  readonly ours: string
  readonly theirs: string
}

const accepted: Accepted[] = []
const rejected: Rejected[] = []
const mismatches: Mismatch[] = []
let client: pg.Client

/** `%I` skips quoting for safe bare words; normalise that away, keep everything else. */
const normaliseFormatOutput = (pgOut: string): string =>
  pgOut.startsWith('"') ? pgOut : `"${pgOut}"`

beforeAll(async () => {
  client = await connect()

  // ── Phase 1: run every case through the sanitizer, offline. ───────────────
  //
  // The committed regression corpus runs FIRST (design/09 WS7). `generator.ts` has said since the
  // spike that a case "can be pinned into the regression corpus without storing the string
  // itself"; `corpus/ident.json` is that corpus, and `makeCase(seed)` is what rebuilds the string.
  const pinnedSeeds = corpusSeeds('ident')
  announceCorpus('ident', pinnedSeeds)
  const stream: Iterable<Case> = (function* () {
    for (const seed of pinnedSeeds) yield makeCase(seed)
    yield* cases(FUZZ_CASES, FUZZ_SEED)
  })()
  const seen = new Set<string>()
  for (const c of stream) {
    try {
      const quoted = quoteIdentPart(c.value)
      const input = c.value as string
      if (!seen.has(input)) {
        seen.add(input)
        accepted.push({ input, quoted, seed: c.seed, strategy: c.strategy })
      }
    } catch (e) {
      if (!(e instanceof InvalidIdentifierError)) {
        recordFinding('ident', {
          seed: c.seed,
          invariant: 'sanitizer threw a non-InvalidIdentifierError',
          note: `${c.strategy}: ${(e as Error).message}`,
          kind: 'found',
        })
      }
      expect(e, `seed ${c.seed}`).toBeInstanceOf(InvalidIdentifierError)
      rejected.push({
        seed: c.seed,
        strategy: c.strategy,
        reason: (e as InvalidIdentifierError).reason,
        bytes: typeof c.value === 'string' ? utf8Bytes(c.value) : -1,
      })
    }
  }
}, 120_000)

afterAll(async () => {
  await client?.end()
})

describe('the corpus itself', () => {
  it(`runs at least 10 000 generated cases`, () => {
    expect(FUZZ_CASES).toBeGreaterThanOrEqual(10_000)
    expect(accepted.length + rejected.length).toBeGreaterThan(0)
    // Both halves must be well populated or the generator has drifted into uselessness.
    expect(accepted.length).toBeGreaterThan(1000)
    expect(rejected.length).toBeGreaterThan(100)
  })

  it('covers every rejection reason and every generator strategy', () => {
    const reasons = new Set(rejected.map((r) => r.reason))
    expect([...reasons].sort()).toEqual(
      ['empty', 'lone-surrogate', 'not-a-string', 'nul-byte', 'too-long'].sort(),
    )
    const strategies = new Set([
      ...accepted.map((a) => a.strategy),
      ...rejected.map((r) => r.strategy),
    ])
    for (const s of [
      'hostile-mix',
      'byte-boundary',
      'keyword',
      'quote-storm',
      'safe-ascii',
      'sql-payload',
      'nul',
      'lone-surrogate',
      'empty',
      'non-string',
    ]) {
      expect(strategies.has(s), `strategy ${s} never generated`).toBe(true)
    }
  })

  it('every rejection is justified — never a false positive', () => {
    for (const r of rejected) {
      if (r.reason === 'too-long') expect(r.bytes).toBeGreaterThan(MAX_IDENT_BYTES)
    }
  })

  it('exercises both sides of the 63-byte boundary', () => {
    const lens = accepted.map((a) => utf8Bytes(a.input))
    expect(lens.some((n) => n === 62)).toBe(true)
    expect(lens.some((n) => n === 63)).toBe(true)
    // `Math.max(...lens)` spreads one argument per case, which is a `RangeError: Maximum call
    // stack size exceeded` somewhere above ~125 000 arguments. Found by WS7's first 1 000 000-case
    // nightly rehearsal (design/09 §3.7): the assertion was correct and simply could not run at the
    // scale design/03 Appendix B asks for.
    expect(lens.reduce((a, b) => (b > a ? b : a), 0)).toBeLessThanOrEqual(MAX_IDENT_BYTES)
    expect(rejected.some((r) => r.reason === 'too-long' && r.bytes === 64)).toBe(true)
  })
})

/**
 * The slice of `accepted` the two server oracles look at.
 *
 * Uncapped this is fine at 10 000 cases and impossible at 1 000 000: oracle B creates one temp
 * table per identifier, and one backend will not hold ~800 000 of them. `announceSample` prints
 * what was dropped (R9).
 */
const sampled = (): readonly Accepted[] => accepted.slice(0, FUZZ_ORACLE_CASES)

describe("oracle A — format('%I')", () => {
  it('agrees with PostgreSQL on every accepted identifier', async () => {
    const pool = sampled()
    announceSample("ident/oracle A format('%I')", pool.length, accepted.length)
    const BATCH = 1000
    for (let i = 0; i < pool.length; i += BATCH) {
      const batch = pool.slice(i, i + BATCH)
      const res = await client.query<{ ord: string; q: string }>(
        `select ord, format('%I', s) as q
         from json_array_elements_text($1::json) with ordinality as t(s, ord)
         order by ord`,
        [JSON.stringify(batch.map((b) => b.input))],
      )
      expect(res.rows).toHaveLength(batch.length)
      for (let j = 0; j < batch.length; j++) {
        const a = batch[j] as Accepted
        const theirs = normaliseFormatOutput((res.rows[j] as { q: string }).q)
        if (a.quoted !== theirs) {
          mismatches.push({
            oracle: 'format',
            seed: a.seed,
            input: a.input,
            ours: a.quoted,
            theirs,
          })
          recordFinding('ident', {
            seed: a.seed,
            invariant: "oracle A — format('%I')",
            note: `ours ${a.quoted} vs PostgreSQL ${theirs}`,
            kind: 'found',
          })
        }
      }
    }
    expect(mismatches.filter((m) => m.oracle === 'format')).toEqual([])
  }, 300_000)

  it('the always-quote divergence is real and intentional', async () => {
    const bare = ['users', 'created_at', 'x1', '_x']
    const res = await client.query<{ q: string }>(
      `select format('%I', s) as q from json_array_elements_text($1::json) with ordinality as t(s, ord) order by ord`,
      [JSON.stringify(bare)],
    )
    for (let i = 0; i < bare.length; i++) {
      // PostgreSQL leaves these bare; we quote unconditionally. No fast path means no
      // "is this safe?" predicate to get wrong.
      expect((res.rows[i] as { q: string }).q).toBe(bare[i])
      expect(quoteIdentPart(bare[i] as string)).toBe(`"${bare[i] as string}"`)
    }
  })
})

describe('oracle B — CREATE TEMP TABLE round trip', () => {
  it('round-trips every accepted identifier byte for byte through the catalog', async () => {
    const pool = sampled()
    announceSample('ident/oracle B temp-table round trip', pool.length, accepted.length)
    const BATCH = 200
    for (let i = 0; i < pool.length; i += BATCH) {
      const batch = pool.slice(i, i + BATCH)

      // One simple-query call creating the whole batch: if ANY quoting were wrong, this is
      // where an injected statement would execute, so a syntax error here is also a finding.
      const ddl = batch.map((b) => `create temp table ${b.quoted} (x int)`).join(';\n')
      await client.query(ddl)

      const back = await client.query<{ relname: string }>(
        // `pg_my_temp_schema()`, not `nspname like 'pg_temp%'`: every session's temp schema is
        // visible in pg_class, and the whole suite now shares one server (design/09 §2.2), so the
        // wildcard counts other test files' tables as ours.
        `select c.relname from pg_class c
         where c.relnamespace = pg_my_temp_schema() and c.relkind = 'r'`,
      )
      const names = new Set(back.rows.map((r) => r.relname))
      for (const b of batch) {
        if (!names.has(b.input)) {
          mismatches.push({
            oracle: 'roundtrip',
            seed: b.seed,
            input: b.input,
            ours: b.quoted,
            theirs: [...names].find((n) => n.startsWith(b.input.slice(0, 8))) ?? '<absent>',
          })
          recordFinding('ident', {
            seed: b.seed,
            invariant: 'oracle B — CREATE TEMP TABLE round trip',
            note: 'pg_class.relname did not come back byte-equal to the input',
            kind: 'found',
          })
        }
      }
      expect(back.rows).toHaveLength(batch.length)

      await client.query(batch.map((b) => `drop table ${b.quoted}`).join(';\n'))
    }
    expect(mismatches.filter((m) => m.oracle === 'roundtrip')).toEqual([])
  }, 600_000)

  it('the catalog performs no normalisation — NFC and NFD stay distinct', async () => {
    const composed = 'café' // café, precomposed
    const decomposed = 'café' // café, e + combining acute
    expect(composed).not.toBe(decomposed)
    await client.query(
      `create temp table ${quoteIdentPart(composed)} (x int);` +
        `create temp table ${quoteIdentPart(decomposed)} (x int)`,
    )
    const back = await client.query<{ relname: string }>(
      `select c.relname from pg_class c
       where c.relnamespace = pg_my_temp_schema() and c.relkind = 'r' order by 1`,
    )
    expect(back.rows).toHaveLength(2)
    expect(new Set(back.rows.map((r) => r.relname))).toEqual(new Set([composed, decomposed]))
    await client.query(
      `drop table ${quoteIdentPart(composed)}; drop table ${quoteIdentPart(decomposed)}`,
    )
  })
})

describe('the 63-byte divergence — reject vs truncate', () => {
  /** Temp tables are session-scoped, so a leftover from a previous case would pollute this. */
  async function tempTables(): Promise<string[]> {
    const back = await client.query<{ relname: string }>(
      `select c.relname from pg_class c
       where c.relnamespace = pg_my_temp_schema() and c.relkind = 'r' order by 1`,
    )
    return back.rows.map((r) => r.relname)
  }
  async function dropAllTemp(): Promise<void> {
    const names = await tempTables()
    if (names.length > 0) {
      await client.query(names.map((n) => `drop table ${quoteIdentPart(n)}`).join(';\n'))
    }
  }

  beforeEach(async () => {
    await dropAllTemp()
  })

  it('format(%I) does NOT truncate — the parser does, silently, later', async () => {
    const long = 'a'.repeat(64)
    const res = await client.query<{ q: string }>(`select format('%I', $1::text) as q`, [long])
    // All-lowercase-ASCII, so `%I` leaves it bare; either way it is 64 bytes, untruncated.
    expect(normaliseFormatOutput((res.rows[0] as { q: string }).q)).toBe(`"${long}"`)
    expect(utf8Bytes((res.rows[0] as { q: string }).q)).toBe(64)

    await client.query(`create temp table "${long}" (x int)`)
    // The PARSER clipped it to 63 bytes. The name in the catalog is NOT the name we asked for.
    expect(await tempTables()).toEqual(['a'.repeat(63)])
    await dropAllTemp()

    // Which is why we refuse it at the call site rather than emitting it.
    expect(() => quoteIdentPart(long)).toThrowError(/too-long/)
  })

  it('truncation collides two DISTINCT identifiers into one catalog name', async () => {
    const a = `${'z'.repeat(63)}_alpha`
    const b = `${'z'.repeat(63)}_beta`
    expect(a).not.toBe(b)
    expect(utf8Bytes(a)).toBe(69)
    expect(utf8Bytes(b)).toBe(68)

    await client.query(`create temp table "${a}" (x int)`)
    // The second CREATE fails as a DUPLICATE, because PostgreSQL clipped both to `z`×63. A
    // builder that truncated would have emitted this silently — and in the SELECT case there
    // is no error at all, just a query addressing the wrong object.
    await expect(client.query(`create temp table "${b}" (x int)`)).rejects.toMatchObject({
      code: '42P07',
    })
    expect(await tempTables()).toEqual(['z'.repeat(63)])
    await dropAllTemp()

    expect(() => quoteIdentPart(a)).toThrowError(/too-long/)
    expect(() => quoteIdentPart(b)).toThrowError(/too-long/)
  })

  it('clipping is on a UTF-8 character boundary, so 64 bytes can become 61', async () => {
    // `pg_mbcliplen` never splits a character, so a 64-byte name ending in a 3-byte character
    // truncates to 61 bytes, not 63. Any length arithmetic done in code units would be wrong
    // twice over.
    const name = `${'a'.repeat(61)}中` // 61 + 3 = 64 bytes, 62 code units
    expect(utf8Bytes(name)).toBe(64)
    expect(name.length).toBe(62)

    await client.query(`create temp table "${name}" (x int)`)
    const got = (await tempTables())[0] as string
    expect(utf8Bytes(got)).toBe(61)
    expect(got).toBe('a'.repeat(61))
    await dropAllTemp()

    expect(() => quoteIdentPart(name)).toThrowError(/too-long/)
  })
})

describe('report', () => {
  it('summarises the run (target: 0 mismatches)', () => {
    const byReason = new Map<string, number>()
    for (const r of rejected) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1)
    const nastiest = accepted.reduce(
      (best, a) => {
        const score =
          (a.input.match(/"/g)?.length ?? 0) * 3 +
          (a.input.match(/\\/g)?.length ?? 0) * 2 +
          // oxlint-disable-next-line no-control-regex -- control characters are what this scores
          (a.input.match(/[;\u0000-\u001f\u200B-\u200F\u202A-\u202E]/gu)?.length ?? 0) * 2 +
          utf8Bytes(a.input) / 32
        return score > best.score ? { score, a } : best
      },
      { score: -1, a: accepted[0] as Accepted },
    )

    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        '── sql.ident fuzz report ─────────────────────────────────────────',
        `cases generated : ${FUZZ_CASES} (seed 0x${FUZZ_SEED.toString(16)})`,
        `accepted unique : ${accepted.length}`,
        `rejected        : ${rejected.length}  {${[...byReason]
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ')}}`,
        `mismatches      : ${mismatches.length}`,
        `nastiest input  : ${JSON.stringify(nastiest.a.input)}`,
        `           ours : ${JSON.stringify(nastiest.a.quoted)}`,
        '──────────────────────────────────────────────────────────────────',
      ].join('\n'),
    )

    expect(mismatches).toEqual([])
  })
})
