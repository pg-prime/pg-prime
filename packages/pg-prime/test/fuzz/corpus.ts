/**
 * The committed regression corpus for all three fuzzers (design/09 WS7; R8).
 *
 * ## What it is for
 *
 * A seeded fuzzer's coverage is a property of its seed stream. Change the generator — add one
 * operator, reorder a `switch` — and the 10 000 cases a PR runs are a *different* 10 000. Anything
 * a previous run found is then rediscovered only by luck. The corpus is the fix: a seed that once
 * discriminated a real bug is replayed **first**, on every run, for ever, at zero marginal cost.
 *
 * `test/fuzz/generator.ts` has said since the spike that a case "can be pinned into the regression
 * corpus without storing the string itself" — the corpus was the intent from day one and this is
 * the file that finally exists. All three fuzzers read it; none of them had one before.
 *
 * ## What goes in it
 *
 * Two kinds of entry, and the `kind` field says which:
 *
 *   `found`      — a seed that failed against the shipped code. It is pinned together with the
 *                  invariant it broke, so a re-break is legible in the test name rather than as
 *                  "some seed failed".
 *   `mutation`   — a seed that failed against a deliberately MUTATED build during an R10
 *                  mutation spot-check (design/09 §1 R10). The shipped code passes it, which is
 *                  the point: it is an input known to *discriminate* that class of bug, so
 *                  replaying it guarantees the class stays caught even after the generator's seed
 *                  stream moves. Without these the corpus would be empty until the first
 *                  production bug, i.e. exactly when it is too late to have been useful.
 *
 * ## Recording
 *
 * `PG_PRIME_FUZZ_RECORD=1` makes a failing run append its seed instead of only reporting it, so the
 * loop is `run → fail → record → fix → replay`. The file is JSON with a stable key order so the
 * diff a reviewer sees is one line per seed.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const CORPUS_DIR = join(HERE, 'corpus')

/** Which fuzzer a corpus file belongs to. One file each, so the diffs never collide. */
export type CorpusName = 'ident' | 'compiler' | 'builder'

export interface CorpusEntry {
  /** The 32-bit seed. Everything else about the case is a pure function of it. */
  readonly seed: number
  /** `a`..`f`, or the fuzzer's own name for the property that broke. */
  readonly invariant: string
  /** One line: what went wrong, or which mutation this seed discriminates. */
  readonly note: string
  readonly kind: 'found' | 'mutation'
  /** ISO date the entry was added, so an old pin can be read in context. */
  readonly added: string
}

interface CorpusFile {
  readonly _why: string
  readonly cases: readonly CorpusEntry[]
}

const pathOf = (name: CorpusName): string => join(CORPUS_DIR, `${name}.json`)

export function loadCorpus(name: CorpusName): readonly CorpusEntry[] {
  const raw = readFileSync(pathOf(name), 'utf8')
  const parsed = JSON.parse(raw) as CorpusFile
  if (!Array.isArray(parsed.cases)) {
    throw new Error(`test/fuzz/corpus/${name}.json: "cases" must be an array`)
  }
  for (const c of parsed.cases) {
    if (!Number.isInteger(c.seed) || c.seed < 0 || c.seed > 0xffffffff) {
      throw new Error(`test/fuzz/corpus/${name}.json: seed ${String(c.seed)} is not a uint32`)
    }
    if (c.kind !== 'found' && c.kind !== 'mutation') {
      throw new Error(`test/fuzz/corpus/${name}.json: seed ${c.seed} has kind "${String(c.kind)}"`)
    }
    if (c.note.trim() === '') {
      throw new Error(`test/fuzz/corpus/${name}.json: seed ${c.seed} has no note — a pin nobody can read is a pin nobody will maintain`)
    }
  }
  return parsed.cases
}

/** The pinned seeds, replayed before the random stream. Deduplicated, in file order. */
export function corpusSeeds(name: CorpusName): readonly number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const c of loadCorpus(name)) {
    if (seen.has(c.seed)) continue
    seen.add(c.seed)
    out.push(c.seed)
  }
  return out
}

/**
 * Append a finding. Only ever called when `PG_PRIME_FUZZ_RECORD=1`; a fuzzer that wrote to its own
 * corpus on every failure would turn a red build green by editing the evidence.
 */
export function recordFinding(name: CorpusName, entry: Omit<CorpusEntry, 'added'>): boolean {
  if (process.env['PG_PRIME_FUZZ_RECORD'] !== '1') return false
  const file = JSON.parse(readFileSync(pathOf(name), 'utf8')) as CorpusFile
  if (file.cases.some((c) => c.seed === entry.seed && c.invariant === entry.invariant)) return false
  const next: CorpusFile = {
    _why: file._why,
    cases: [...file.cases, { ...entry, added: new Date().toISOString().slice(0, 10) }].sort(
      (a, b) => a.seed - b.seed,
    ),
  }
  writeFileSync(pathOf(name), `${JSON.stringify(next, null, 2)}\n`)
  return true
}

/**
 * The line every fuzzer prints, so "the corpus ran" is visible in CI output rather than assumed.
 * design/09 §2.2's rule for skips — say it out loud, on stderr, where vitest does not swallow it.
 */
export function announceCorpus(name: CorpusName, seeds: readonly number[]): void {
  process.stderr.write(
    `[fuzz] ${name}: replaying ${seeds.length} pinned corpus seed${seeds.length === 1 ? '' : 's'} ` +
      `from test/fuzz/corpus/${name}.json before the random stream\n`,
  )
}
