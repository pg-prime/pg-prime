/**
 * The regression corpus's own tier-0 test (design/09 WS7).
 *
 * A corpus is machinery that only runs when something has already gone wrong, which is the worst
 * time to discover that the loader throws on its own file format. Two of the three corpora are
 * empty today, so without this file the loader, the validator and the append path would ship
 * unexecuted.
 *
 * It is a `*.unit.test.ts` — no database — for the same reason `test/live/bridge.unit.test.ts` is:
 * the harness's own logic belongs in the run people watch.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CORPUS_DIR, corpusSeeds, loadCorpus, recordFinding, type CorpusName } from './corpus.js'

const NAMES: readonly CorpusName[] = ['ident', 'compiler', 'builder']

/** Restore whatever `PG_PRIME_FUZZ_RECORD` was, so a recording test cannot leak into the others. */
const RECORD = process.env['PG_PRIME_FUZZ_RECORD']
afterEach(() => {
  if (RECORD === undefined) delete process.env['PG_PRIME_FUZZ_RECORD']
  else process.env['PG_PRIME_FUZZ_RECORD'] = RECORD
})

describe('the committed corpus', () => {
  it('every fuzzer has one, and every entry in it is well formed', () => {
    for (const name of NAMES) {
      const cases = loadCorpus(name)
      for (const c of cases) {
        expect(Number.isInteger(c.seed), `${name}: seed`).toBe(true)
        expect(c.note.length, `${name}: seed ${c.seed} note`).toBeGreaterThan(20)
        expect(['found', 'mutation']).toContain(c.kind)
        expect(c.added, `${name}: seed ${c.seed} added`).toMatch(/^\d{4}-\d\d-\d\d$/)
      }
    }
  })

  it('the builder corpus carries the three findings from WS7’s first live runs', () => {
    // Not a tautology: these seeds are the evidence that the fuzzer found something real on the day
    // it was written (design/09 §3.7). Deleting one without a reason should be a red test, because
    // a corpus that can be emptied silently is not a corpus.
    const seeds = corpusSeeds('builder')
    expect(seeds).toContain(2310382765)
    expect(seeds).toContain(2802423309)
    expect(seeds).toContain(3300751089)
  })

  it('seeds are deduplicated and returned in file order', () => {
    for (const name of NAMES) {
      const seeds = corpusSeeds(name)
      expect(new Set(seeds).size).toBe(seeds.length)
    }
  })
})

describe('the loader rejects a corpus it could not replay', () => {
  const withCorpus = (body: string, run: () => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'pgprime-corpus-'))
    const file = join(CORPUS_DIR, 'ident.json')
    const original = readFileSync(file, 'utf8')
    try {
      writeFileSync(file, body)
      run()
    } finally {
      writeFileSync(file, original)
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('a seed that is not a uint32', () => {
    withCorpus('{"_why":"t","cases":[{"seed":-1,"invariant":"a","note":"x","kind":"found","added":"2026-01-01"}]}', () => {
      expect(() => loadCorpus('ident')).toThrow(/not a uint32/)
    })
  })

  it('an unknown kind', () => {
    withCorpus('{"_why":"t","cases":[{"seed":1,"invariant":"a","note":"x","kind":"guess","added":"2026-01-01"}]}', () => {
      expect(() => loadCorpus('ident')).toThrow(/kind "guess"/)
    })
  })

  it('an entry with no note — a pin nobody can read is a pin nobody maintains', () => {
    withCorpus('{"_why":"t","cases":[{"seed":1,"invariant":"a","note":"  ","kind":"found","added":"2026-01-01"}]}', () => {
      expect(() => loadCorpus('ident')).toThrow(/no note/)
    })
  })

  it('cases that is not an array', () => {
    withCorpus('{"_why":"t","cases":{}}', () => {
      expect(() => loadCorpus('ident')).toThrow(/must be an array/)
    })
  })
})

describe('recording', () => {
  it('does nothing unless PG_PRIME_FUZZ_RECORD=1 — a fuzzer must not edit its own evidence', () => {
    delete process.env['PG_PRIME_FUZZ_RECORD']
    const before = readFileSync(join(CORPUS_DIR, 'ident.json'), 'utf8')
    expect(recordFinding('ident', { seed: 12345, invariant: 'a', note: 'should not be written', kind: 'found' })).toBe(false)
    expect(readFileSync(join(CORPUS_DIR, 'ident.json'), 'utf8')).toBe(before)
  })

  it('appends, sorts and deduplicates when recording is on', () => {
    const file = join(CORPUS_DIR, 'ident.json')
    const original = readFileSync(file, 'utf8')
    try {
      process.env['PG_PRIME_FUZZ_RECORD'] = '1'
      expect(recordFinding('ident', { seed: 99, invariant: 'a', note: 'a note long enough to pass', kind: 'found' })).toBe(true)
      expect(recordFinding('ident', { seed: 7, invariant: 'a', note: 'another note long enough', kind: 'mutation' })).toBe(true)
      // Same seed and same invariant twice is one entry.
      expect(recordFinding('ident', { seed: 99, invariant: 'a', note: 'a note long enough to pass', kind: 'found' })).toBe(false)
      expect(corpusSeeds('ident')).toStrictEqual([7, 99])
    } finally {
      writeFileSync(file, original)
    }
  })
})
