/**
 * Builder-level fuzz — the public API under the compiler fuzzer's invariants (design/09 WS7;
 * design/03 Appendix B).
 *
 * `compiler-fuzz.test.ts` generates `SelectNode`s with the constructors in `compile/nodes.ts`, so
 * everything a user actually types — the scope, join widening, the relation resolver, the
 * projection compiler, `nest`, CTEs, set operations, windows — is above the line it tests. This
 * file starts at `db.from(...)` and only ever calls exported methods (R11), with no casts (R12);
 * `builder-generator.ts` explains how a *random* chain stays typed.
 *
 * ## The invariants
 *
 *  (a) `binds.length` equals the highest `$n` in the SQL, and `$1..$n` each appear exactly once,
 *      in order — numbering is one left-to-right pass with no gaps.
 *  (b) no bind's *value* appears as a substring of the SQL text.
 *  (c) the statement count is exactly 1 (`;` outside string and identifier tokens).
 *  (d) PostgreSQL parses and plans it (`planProbe`: `EXPLAIN (GENERIC_PLAN)` on 16+, `PREPARE` /
 *      `DEALLOCATE` below).
 *  (e) PostgreSQL accepts and runs it **with the parameter types the codecs declare** — the
 *      oracle that puts the codec seam under test, because `GENERIC_PLAN` plans every `$n` as
 *      untyped and can therefore never disagree with a codec.
 *  (e′) **determinism** — two chains built from the same seed compile to byte-equal SQL and
 *      byte-equal binds.
 *  (f) **immutability** — every intermediate builder compiles to the same thing before and after
 *      the chain continued past it.
 *
 * ## The third outcome: a refusal
 *
 * Since the distinct follow-up of 2026-08-27 a chain has three possible answers, not two. It can
 * compile; it can throw something unexpected (a finding); or the builder can **refuse** it with a
 * `BuilderError` — which is what `.distinct()` with an `ORDER BY` on an unprojected expression now
 * gets, because there is no repair for it that is not a different query. `CompiledFacts.refused`
 * carries the sentence. (e′) and (f) are asserted over it unchanged — a refusal must be
 * deterministic and must not depend on what the chain did *after* the prefix — while (a)-(c) and
 * the live oracle skip it, there being no statement. The count is printed on every run and floored,
 * so a fix that quietly stopped refusing anything cannot pass as a clean run.
 *
 * ## How (e′) and (f) are actually checked, and the trap in the obvious version
 *
 * `.compile()` is memoised on the instance (`03` §1.4a). So the naive (f) — compile a prefix, keep
 * going, compile it again, compare — compares a memo with itself and passes even if `.where()`
 * mutates in place. And a prefix cannot simply be compiled anyway: `.select()` is mandatory, so
 * `db.from(users).where(…).compile()` throws.
 *
 * The protocol is therefore two passes over the same seed:
 *
 *   pass EAGER — build the chain, and compile every prefix **at the moment it is created**,
 *                through a fixed projection lens (`Prefix.probe`);
 *   pass LATE  — build the same chain touching nothing, then compile every prefix **afterwards**,
 *                through the same lens.
 *
 * (f) is `eager[k] === late[k]` for every k: the only way they can differ is if continuing the
 * chain changed a builder that had already been made. (e′) is the two passes' final statements
 * being byte-equal, which is a real re-compile because the second pass is a different instance.
 *
 * R10 mutation M-B2 ("make `.where()` mutate in place") is caught here and by nothing else.
 *
 * ## Budget
 *
 * `PG_PRIME_FUZZ_CASES` chains per run (10 000 on a PR, 1 000 000 nightly), each generated twice.
 * The live invariants (d) and (e) are sampled — `PG_PRIME_FUZZ_PG_CASES`, default 300 — because a
 * server round trip per case is minutes, not seconds. The sample size is **printed on every run**
 * (R9: no silent caps) and the numbers behind the default are in design/09 §3.7.
 *
 * The committed corpus (`corpus/builder.json`) is replayed before the random stream, always.
 */

import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { paramTypesOf } from '../../src/compile/contract.js'
import type { Bind } from '../../src/compile/contract.js'
import type { PgConnection } from '../../src/driver/index.js'
import type { Db } from '../../src/query/types.js'
import { connect, makeHarness, planProbe, sqlState, type Harness } from '../live/_harness.js'
import { makeFixture, type Fixture } from '../live/fixture.js'
import { Registry } from '../../src/codec/index.js'
import { pgPrime } from '../../src/query/run.js'
import { announceSample, FUZZ_CASES, FUZZ_ORACLE_CASES, FUZZ_SEED } from './_budget.js'
import { denseRange, placeholderNumbers, statementCount } from './_invariants.js'
import { announceCorpus, corpusSeeds, recordFinding } from './corpus.js'
import { makeChain, seeds, type CompiledFacts } from './builder-generator.js'

/** This file owns its own schema: vitest runs test files in parallel against one container (R6). */
const NS = 'pgprime_fz_builder'
const fx: Fixture = makeFixture(NS)

let client: pg.Client
let h: Harness
/** The adapter connection: only it can declare `paramTypes` in `Parse` (invariant (e)). */
let conn: PgConnection
let db: Db<Fixture['schema']>

beforeAll(async () => {
  client = await connect()
  await client.query(fx.drop)
  await client.query(fx.ddl)
  await client.query(fx.seed)
  h = await makeHarness(2)
  conn = await h.driver.acquire()
  const registry = new Registry()
  registry.setServerParameters(conn.serverParameters)
  // `role` is an enum and an enum's OID is per database, so the registry has to be resolved before
  // anything compiles or the codec has no OID to declare in `Parse` (`02` §4.6).
  await registry.resolveDynamic(conn, [
    { schema: NS, name: 'user_role', kind: 'enum', enumLabels: ['admin', 'owner', 'member'] },
  ])
  db = pgPrime({ driver: h.driver, schema: fx.schema, registry })
}, 120_000)

afterAll(async () => {
  if (h !== undefined && conn !== undefined) await h.driver.release(conn)
  await h?.end()
  await client?.query(fx.drop).catch(() => {})
  await client?.end()
})

/**
 * The refusals this generator is *allowed* to provoke, by prefix.
 *
 * Without this list `factsOf`'s `catch` would be a hole: every `BuilderError` the builder learns to
 * throw would turn from a red run into a silently skipped chain, which is the opposite of what a
 * fuzzer is for. One entry, and it is the `.distinct()` ordering rule of 2026-08-27 — the column
 * name varies, the sentence does not.
 */
const EXPECTED_REFUSALS: readonly string[] = ['pg-prime: .distinct() cannot order by ']

/** Everything (a)-(c) needs, in one place, so a failure names the invariant rather than a line. */
function assertShapeInvariants(facts: CompiledFacts, where: string): void {
  // A refused chain has no SQL to hold invariants over; (e′) and (f) still apply to the sentence.
  if (facts.refused !== undefined) {
    const refused = facts.refused
    expect(
      EXPECTED_REFUSALS.some((prefix) => refused.startsWith(prefix)),
      `${where} — refused with a sentence this generator does not expect: ${refused}`,
    ).toBe(true)
    return
  }
  // (a) numbering is dense, ordered, and matches binds.length exactly.
  expect(placeholderNumbers(facts.sql), `${where} — (a) $n numbering`).toEqual(
    denseRange(facts.binds.length),
  )
  // (b) no bind VALUE ever appears in the SQL text. Every minted value carries the «bf marker.
  expect(facts.sql, `${where} — (b) bind value in SQL`).not.toContain('«bf')
  expect(facts.sql, `${where} — (b) bind value in SQL`).not.toContain('drop table')
  // (c) exactly one statement.
  expect(statementCount(facts.sql), `${where} — (c) statement count`).toBe(1)
}

const bindKey = (bs: readonly Bind[]): string =>
  JSON.stringify(bs.map((b) => (b.k === 'value' ? ['v', b.encoded, b.oid] : ['s', b.name])))

describe('builder fuzz', () => {
  const CASES = Math.max(FUZZ_CASES, 1)
  const pinned = corpusSeeds('builder')

  it(`holds (a)-(c), (e′) and (f) over ${CASES.toLocaleString('en-US')} random builder chains`, () => {
    announceCorpus('builder', pinned)
    const stream = [...pinned, ...seeds(CASES, FUZZ_SEED ^ 0xb0b1)]
    const byShape: Record<string, number> = {}
    let prefixesChecked = 0
    /**
     * How many chains actually carried a bind.
     *
     * Invariant (b) is "no bind VALUE appears in the SQL", and it is vacuously true for a chain
     * whose binds do not carry the marker (b) looks for — so a generator that stopped minting
     * marked values (a `mint()` that returned a constant, a predicate list that lost its
     * parameterised leaves) would turn (b) into a tautology and every run would still be green.
     * R10 mutation M11 is exactly that. Counting *binds* is not enough: a constant `'x'` is still
     * a bind. What has to be counted is binds carrying the marker the assertion searches for.
     */
    let withBinds = 0
    let withMarkedBinds = 0
    /** Chains the builder refused (see the header's "third outcome"), and the sentences it used. */
    let refused = 0
    const refusals = new Set<string>()

    for (const seed of stream) {
      const eager = makeChain(db, h_(), seed, { eager: true })
      const late = makeChain(db, h_(), seed)
      byShape[eager.shape] = (byShape[eager.shape] ?? 0) + 1

      const factsEager = eager.compile()
      const factsLate = late.compile()
      if (factsEager.refused !== undefined) {
        refused++
        refusals.add(factsEager.refused)
      }
      if (factsEager.binds.length > 0) withBinds++
      if (
        factsEager.binds.some(
          (b) => b.k === 'value' && typeof b.encoded === 'string' && b.encoded.includes('«bf'),
        )
      ) {
        withMarkedBinds++
      }
      const where = `seed ${seed} (${eager.shape}: ${eager.labels.join(' → ')})`

      try {
        assertShapeInvariants(factsEager, where)

        // (e′) determinism: two independently built chains, byte-equal SQL and byte-equal binds
        // — or byte-equal refusals, which is the same claim about the same function.
        expect(factsLate.sql, `${where} — (e′) determinism, SQL`).toBe(factsEager.sql)
        expect(factsLate.refused, `${where} — (e′) determinism, refusal`).toBe(factsEager.refused)
        expect(bindKey(factsLate.binds), `${where} — (e′) determinism, binds`).toBe(
          bindKey(factsEager.binds),
        )

        // (f) immutability: each prefix, compiled before the chain continued, equals the same
        // prefix compiled after it did.
        expect(late.prefixes.length, `${where} — prefix count`).toBe(eager.prefixes.length)
        for (let k = 0; k < late.prefixes.length; k++) {
          const before = eager.prefixes[k]?.eager
          const after = late.prefixes[k]?.probe()
          expect(before, `${where} — prefix ${k} was not compiled eagerly`).toBeDefined()
          expect(
            after?.sql,
            `${where} — (f) immutability at prefix ${k} (${late.prefixes[k]?.label})`,
          ).toBe(before?.sql)
          expect(
            after?.refused,
            `${where} — (f) immutability, refusal at prefix ${k} (${late.prefixes[k]?.label})`,
          ).toBe(before?.refused)
          expect(
            bindKey(after?.binds ?? []),
            `${where} — (f) immutability, binds at prefix ${k}`,
          ).toBe(bindKey(before?.binds ?? []))
          prefixesChecked++
        }
      } catch (e) {
        recordFinding('builder', {
          seed,
          invariant: 'a-c/e′/f',
          note: `${eager.shape}: ${eager.labels.join(' → ')}`,
          kind: 'found',
        })
        throw e
      }
    }

    process.stderr.write(
      `[fuzz] builder: ${stream.length.toLocaleString('en-US')} chains ` +
        `(${pinned.length} pinned + ${CASES.toLocaleString('en-US')} random), ` +
        `${prefixesChecked.toLocaleString('en-US')} prefix immutability checks, ` +
        `${((100 * withBinds) / stream.length).toFixed(1)}% carried a bind ` +
        `(${((100 * withMarkedBinds) / stream.length).toFixed(1)}% a marked one), ` +
        `${refused.toLocaleString('en-US')} refused by the builder ` +
        `(${refusals.size} distinct sentence${refusals.size === 1 ? '' : 's'}), ` +
        `shapes ${JSON.stringify(byShape)}\n`,
    )
    // The generator must keep reaching every shape; a weighting bug that silently stopped emitting
    // set operations would otherwise look like a clean run.
    for (const shape of ['plain', 'grouped', 'windowed', 'cte', 'setop', 'outerjoin']) {
      expect(byShape[shape] ?? 0, `shape "${shape}" was never generated`).toBeGreaterThan(0)
    }
    // …and invariant (b) must not be vacuous. Measured: ~87% of chains carry a bind and ~46% carry
    // one holding the «bf marker that (b) searches for. The floors are deliberately far below the
    // measurement — they are there to catch a generator that stopped, not to pin a distribution.
    expect(
      withBinds / stream.length,
      'fewer than half the chains carried a bind — invariant (b) has stopped testing anything',
    ).toBeGreaterThan(0.5)
    expect(
      withMarkedBinds / stream.length,
      'fewer than a quarter of the chains bound a MARKED value — invariant (b) is now vacuous',
    ).toBeGreaterThan(0.25)
    // The refusal path is a real branch of the builder and the generator reaches it on ~0.5 % of
    // chains, measured over 50 000 (`.distinct()` drawn together with an `orderBy` the random
    // projection does not carry). A floor of one keeps it from silently disappearing — which is
    // exactly what happened for a day, when the generator was narrowed instead of the builder
    // being fixed.
    expect(
      refused,
      'no chain was refused — the .distinct()/orderBy narrowing has come back, or the check has gone',
    ).toBeGreaterThan(0)
  }, 900_000)

  it('(d)+(e) PostgreSQL plans the SQL, and runs it with the codecs’ declared param types', async () => {
    const SAMPLE = Math.min(
      Number(process.env['PG_PRIME_FUZZ_PG_CASES'] ?? 300),
      Math.max(FUZZ_ORACLE_CASES, 1),
    )
    announceSample(
      'builder/live plan+execute',
      SAMPLE,
      FUZZ_CASES,
      'PG_PRIME_FUZZ_PG_CASES / PG_PRIME_FUZZ_ORACLE_CASES',
    )
    const stream = [...pinned, ...seeds(SAMPLE, FUZZ_SEED ^ 0xb0b2)]
    let planned = 0
    let executed = 0
    let refused = 0
    const failures: {
      stage: 'plan' | 'execute'
      seed: number
      sql: string
      code?: string | undefined
      message: string
    }[] = []

    for (const seed of stream) {
      const chain = makeChain(db, h_(), seed)
      const facts = chain.compile()
      // Refused at compile time: there is no statement to send, and that is the point of the
      // refusal — the `42P10` this used to be is what the sentence replaced.
      if (facts.refused !== undefined) {
        refused++
        continue
      }
      try {
        for (const stmt of planProbe(facts.sql)) await client.query(stmt)
        planned++
      } catch (e) {
        failures.push({
          stage: 'plan',
          seed,
          sql: facts.sql,
          code: sqlState(e),
          message: (e as Error).message,
        })
        recordFinding('builder', {
          seed,
          invariant: 'd',
          note: `plan failed: ${sqlState(e) ?? '?'}`,
          kind: 'found',
        })
      }
      try {
        await conn.execute({
          text: facts.sql,
          params: facts.binds.map((b) => (b.k === 'value' ? b.encoded : null)),
          paramTypes: paramTypesOf(facts.binds),
        })
        executed++
      } catch (e) {
        failures.push({
          stage: 'execute',
          seed,
          sql: facts.sql,
          code: sqlState(e),
          message: (e as Error).message,
        })
        recordFinding('builder', {
          seed,
          invariant: 'e',
          note: `execute failed: ${sqlState(e) ?? '?'}`,
          kind: 'found',
        })
      }
    }

    // R9: the cap is printed, never silent. The offline pass above is the one that runs at full
    // `PG_PRIME_FUZZ_CASES`; this one is a sample because each case is two server round trips.
    process.stderr.write(
      `[fuzz] builder/live: planned ${planned}/${stream.length - refused}, executed with declared ` +
        `param types ${executed}/${stream.length - refused}, ${refused} refused at compile time; ` +
        `sampled from PG_PRIME_FUZZ_PG_CASES=${SAMPLE} ` +
        `(the offline invariants ran ${FUZZ_CASES.toLocaleString('en-US')})\n`,
    )
    if (failures.length > 0) {
      // eslint-disable-next-line no-console
      console.error(failures[0])
    }
    expect(failures).toEqual([])
    expect(planned).toBe(stream.length - refused)
    expect(executed).toBe(stream.length - refused)
  }, 900_000)
})

/** The handle record, read late so `beforeAll` has run. */
function h_(): Db<Fixture['schema']>['h'] {
  return db.h
}
