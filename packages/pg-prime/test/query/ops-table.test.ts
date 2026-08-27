/**
 * `03` §2.9's operator table is **generated from `OPS`** and checked in (design/09 WS3 exit gate:
 * "`03` §2.9's table is regenerated from the manifest — docs cannot drift from code").
 *
 * A design document that lists an API is a second source of truth, and second sources of truth
 * rot silently: `03` §2.9 said `avg(anything) → numeric`, which is wrong for `float4`/`float8`,
 * and nothing could ever have told us. Now the markdown between the two markers is a pure
 * function of the manifest, and the manifest's result codecs are confirmed against a live
 * PostgreSQL by `test/live-query/ops.test.ts`. The chain runs docs ← manifest ← server.
 *
 * Regenerate after an intentional change:
 *
 *     PG_PRIME_UPDATE_DOCS=1 pnpm test -- ops-table
 *
 * and review the diff, because that diff is the public vocabulary.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { OPS } from '../../src/query/ops.manifest.js'
import type { OpClass } from '../../src/query/ops.manifest.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOC = join(HERE, '..', '..', '..', '..', 'design', '03-query-builder.md')
const START = '<!-- ops-table:start — generated from src/query/ops.manifest.ts; do not edit -->'
const END = '<!-- ops-table:end -->'

/** The human-readable name of each class, in `03` §2.9's own order. */
const CLASS_LABEL: Readonly<Record<OpClass, string>> = {
  all: 'all',
  text: 'text / citext',
  array: 'array `T[]`',
  jsonb: 'json / jsonb',
  numeric: 'numeric / int',
  tsvector: 'tsvector',
  range: 'range',
  net: 'net (inet / cidr)',
  vector: 'vector (pgvector)',
  boolean: 'boolean / ordering',
  aggregate: 'aggregates & full text',
}

const ORDER: readonly OpClass[] = [
  'all',
  'text',
  'array',
  'jsonb',
  'numeric',
  'tsvector',
  'range',
  'net',
  'vector',
  'boolean',
  'aggregate',
]

/** Markdown table cells must not break the pipe grammar. */
const cell = (s: string): string => s.replaceAll('|', '\\|')

function render(): string {
  const lines = [
    START,
    '',
    '| Class | Function | SQL | Result codec |',
    '|---|---|---|---|',
  ]
  for (const klass of ORDER) {
    const rows = OPS.filter((o) => o.class === klass)
    for (const [i, o] of rows.entries()) {
      const label = i === 0 ? `**${CLASS_LABEL[klass]}**` : ''
      const name = o.deferred ? `~~\`${o.name}\`~~` : `\`${o.name}\``
      lines.push(`| ${label} | ${name} | \`${cell(o.sql)}\` | ${cell(o.result)} |`)
    }
  }
  const deferred = OPS.filter((o) => o.deferred)
  if (deferred.length > 0) {
    lines.push('')
    lines.push('Struck-through rows are declared but have no live differential yet:')
    lines.push('')
    for (const reason of new Set(deferred.map((o) => o.deferred as string))) {
      const names = deferred
        .filter((o) => o.deferred === reason)
        .map((o) => `\`${o.name}\``)
        .join(', ')
      lines.push(`- ${names} — ${reason}.`)
    }
  }
  lines.push('')
  lines.push(END)
  return lines.join('\n')
}

it('`03` §2.9 matches the OPS manifest byte for byte', () => {
  const doc = readFileSync(DOC, 'utf8')
  const from = doc.indexOf(START)
  const to = doc.indexOf(END)
  expect(from, `${START} not found in design/03-query-builder.md`).toBeGreaterThan(-1)
  expect(to).toBeGreaterThan(from)

  const generated = render()
  const current = doc.slice(from, to + END.length)

  if (process.env['PG_PRIME_UPDATE_DOCS'] === '1') {
    writeFileSync(DOC, doc.slice(0, from) + generated + doc.slice(to + END.length))
    return
  }
  expect(current).toBe(generated)
})

it('every manifest row is uniquely named and belongs to a known class', () => {
  const names = OPS.map((o) => o.name)
  expect(new Set(names).size).toBe(names.length)
  for (const o of OPS) expect(ORDER).toContain(o.class)
})
