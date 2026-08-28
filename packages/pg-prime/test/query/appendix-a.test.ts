/**
 * **`03` Appendix A is generated from the builder** (design/09 WS4 exit gate: "every `03` §2
 * example compiles byte-identically to Appendix A *from the builder*").
 *
 * Appendix A was written by hand before a builder existed, so it was a second source of truth for
 * the one thing that must not have one: the exact SQL this library emits. WS3 hit the same problem
 * with §2.9's operator table and solved it the same way — the markdown between the two markers is
 * now a pure function of the builder expressions below, and any drift fails here.
 *
 * Regenerate after an intentional change:
 *
 *     PG_PRIME_UPDATE_DOCS=1 pnpm test -- appendix-a
 *
 * and review the diff, because that diff *is* the compiled output of the public API.
 *
 * Four differences from the hand-written original are permanent and were the point of doing this:
 * the `do update set` list is one line rather than three aligned ones; `::int8` is `::bigint`
 * (the cast comes from `codec.sqlName`, a WS2 finding); a CTE reference is `"moved" as "moved"`
 * because the emitter aliases every FROM item; and every projection item is aliased, including
 * inside an `insert … select`.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { compileOnly } from '../../src/query/run.js'
import { makeAppendixA } from './_appendix-a.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOC = join(HERE, '..', '..', '..', '..', 'design', '03-query-builder.md')
const START =
  '<!-- appendix-a:start — generated from test/query/appendix-a.test.ts; do not edit -->'
const END = '<!-- appendix-a:end -->'

// ─────────────────────────────────────────────────────────────────────────────
// The schema and the statements live in `./_appendix-a.ts`, so WS6's tier-1 suite can run
// `EXPLAIN` over the SAME list against a real server rather than a second copy of it.
// ─────────────────────────────────────────────────────────────────────────────

const { schema, statements: STATEMENTS } = makeAppendixA()
const db = compileOnly(schema)

/**
 * `-- params:` shows the ENCODED wire values, not the JavaScript that produced them.
 *
 * That is the honest artifact: `['billing','country']` reaches PostgreSQL as the `text[]` literal
 * `{billing,country}`, and the whole security claim of `03` §3.4 is about what is in the *bind
 * slot*, not about what the caller typed.
 */
function render(): string {
  const out: string[] = [START, '', '```sql']
  for (const [i, entry] of STATEMENTS.entries()) {
    if (i > 0) out.push('')
    const compiled = entry.build(db).compile()
    out.push(`-- ${entry.label}`)
    out.push(compiled.sql)
    const params = compiled.binds.map((b) => (b as { encoded?: unknown }).encoded)
    if (params.length > 0) out.push(`-- params: ${JSON.stringify(params)}`)
  }
  out.push('```', '', END)
  return out.join('\n')
}

it('`03` Appendix A matches what the builder compiles, byte for byte', () => {
  const doc = readFileSync(DOC, 'utf8')
  const from = doc.indexOf(START)
  const to = doc.indexOf(END)
  expect(from, `${START} not found in design/03-query-builder.md`).toBeGreaterThan(-1)
  expect(to).toBeGreaterThan(from)

  const generated = render()
  if (process.env['PG_PRIME_UPDATE_DOCS'] === '1') {
    writeFileSync(DOC, doc.slice(0, from) + generated + doc.slice(to + END.length))
    return
  }
  expect(doc.slice(from, to + END.length)).toBe(generated)
})

it('every statement compiles to exactly one statement with no stray semicolon', () => {
  for (const entry of STATEMENTS) {
    const { sql } = entry.build(db).compile()
    expect(sql, entry.label).not.toContain(';')
    expect(sql.trim(), entry.label).toBe(sql)
  }
})
