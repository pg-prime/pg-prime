/**
 * Error-message goldens (design/09 WS1 "Tests", design/04 §4).
 *
 * design/04 §4 makes a *measured* claim — 3 lines / 641 characters across three identical mistakes
 * against kysely@0.29.5's 10 / 1 402 and drizzle-orm@0.45.2's 14 / 3 226 — and a claim like that
 * decays silently. One extra overload, one long inferred type in a constraint, and it doubles with
 * nothing failing.
 *
 * So `tools/type-errors/cases/*.ts` is one mistake per file, `__golden__/<case>.<version>.txt` is
 * the exact `tsc --pretty false` output, and this file diffs them on both compilers. It is the
 * only place in the suite where a *diagnostic* is the artifact under test rather than a type.
 *
 * Three things it enforces, in order of how much they matter:
 *
 *  1. **Every case still fails.** A case that stops producing a diagnostic is a lost guard, and it
 *     would otherwise look exactly like a passing test.
 *  2. **The sentence is byte-identical to the golden.** These strings are public API.
 *  3. **The budgets hold** — the D9 sentence budget on our own `OrmTypeError` payloads, a
 *     per-diagnostic ceiling, and design/04 §4's own three-mistake total, printed three-way.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  budgetOf,
  caseNames,
  collect,
  COMPILERS,
  readGolden,
} from '../../../../tools/type-errors/record.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOL = join(HERE, '..', '..', '..', '..', 'tools', 'type-errors')
const budget = JSON.parse(readFileSync(join(TOOL, 'budget.json'), 'utf8')) as {
  sentence: { maxLines: number; maxChars: number }
  diagnostic: {
    maxLines: number
    maxChars: number
    exceptions: Record<string, { maxLines: number; maxChars: number }>
  }
  design04Section4: {
    cases: string[]
    design04: { lines: number; chars: number }
    kysely_0_29_5: { lines: number; chars: number }
    drizzle_0_45_2: { lines: number; chars: number }
    maxLines: number
    maxChars: number
  }
}

const NAMES = caseNames()

/** Every `OrmTypeError<"…">` payload that appears in a diagnostic — the sentence a user reads. */
function sentences(text: string): string[] {
  return [...text.matchAll(/OrmTypeError<"((?:[^"\\]|\\.)*)">/g)].map((m) => m[1]!)
}

describe.each(Object.entries(COMPILERS))('TypeScript %s', (version, bin) => {
  const byCase = collect(bin)

  it.each(NAMES)('%s produces the recorded diagnostic', (name) => {
    const lines = byCase[name] ?? []

    // (1) the case still fails. Without this, deleting a guard turns the golden into `''` and the
    //     diff below would happily pass.
    expect(
      lines.length,
      `${name} produced no diagnostic — the guard it pins is gone`,
    ).toBeGreaterThan(0)

    // (2) byte-identical to the golden.
    const golden = readGolden(name, version)
    expect(
      golden,
      `no golden for ${name} on ${version} — run: node tools/type-errors/record.mjs`,
    ).not.toBeNull()
    expect(lines.join('\n')).toBe(golden)

    // (3a) the D9 sentence budget, on our own branded messages.
    for (const s of sentences(lines.join('\n'))) {
      expect(s.split('\n')).toHaveLength(budget.sentence.maxLines)
      expect(s.length).toBeLessThan(budget.sentence.maxChars)
    }

    // (3b) the per-diagnostic ceiling.
    const limit = budget.diagnostic.exceptions[name] ?? budget.diagnostic
    const { lines: n, chars } = budgetOf(lines)
    expect(n, `${name}: ${n} lines`).toBeLessThanOrEqual(limit.maxLines)
    expect(chars, `${name}: ${chars} chars`).toBeLessThanOrEqual(limit.maxChars)
  })

  it('reproduces design/04 §4 — three mistakes, three-way', () => {
    const d = budget.design04Section4
    const all = d.cases.flatMap((c) => byCase[c] ?? [])
    const { lines, chars } = budgetOf(all)

    // R9: a three-way print (design number / measured / budget), not prose.
    const row = (label: string, l: number, c: number) =>
      `  ${label.padEnd(22)} ${String(l).padStart(3)} lines ${String(c).padStart(6)} chars`
    console.log(
      [
        `design/04 §4, TypeScript ${version}:`,
        row('design/04 measured', d.design04.lines, d.design04.chars),
        row('here', lines, chars),
        row('kysely@0.29.5', d.kysely_0_29_5.lines, d.kysely_0_29_5.chars),
        row('drizzle-orm@0.45.2', d.drizzle_0_45_2.lines, d.drizzle_0_45_2.chars),
        row('budget', d.maxLines, d.maxChars),
      ].join('\n'),
    )

    expect(lines).toBeLessThanOrEqual(d.maxLines)
    expect(chars).toBeLessThanOrEqual(d.maxChars)
    // The claim that is actually load-bearing (D9): no overload cascade, so one line per mistake.
    expect(lines).toBe(d.cases.length)
    // …and still far below both competitors on both axes.
    expect(chars).toBeLessThan(d.kysely_0_29_5.chars)
    expect(lines).toBeLessThan(d.kysely_0_29_5.lines)
  })
})
