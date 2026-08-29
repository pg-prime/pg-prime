// The pooler compatibility matrix, generated from the BUILT `pg-prime`'s `POOLER_PROFILES`
// (design/07 §5.2, and decision 6 of design/12 §1: "pooler profiles are data … D generates
// docs/…/poolers from it").
//
//   node tools/pooler-matrix.mjs           # rewrite the generated region of the page
//   node tools/pooler-matrix.mjs --check   # fail if the page has drifted (the CI gate)
//
// It runs as the first step of `docs:build` and `docs:dev`, so the published page cannot be older
// than the code it describes; `--check` exists so a stale committed page is also a *diff*, visible
// in review, rather than something only the build knows about.
//
// Only the rows the profile table actually carries are generated. design/07 §5.2's other rows
// (`SET LOCAL`, `notify`, `WITHOUT HOLD` cursors, COPY, migrations) are behaviour that is not
// encoded in `PoolerProfile`, so they stay hand-written *outside* the generated region — writing
// them here would be inventing data.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DOCS, ROOT } from './docs-blocks.mjs'

const CHECK = process.argv.includes('--check')
const PAGE = join(DOCS, 'src', 'content', 'docs', 'operations', 'poolers.mdx')
const BEGIN =
  '{/* GENERATED:pooler-matrix — tools/pooler-matrix.mjs, from POOLER_PROFILES. Do not edit. */}'
const END = '{/* /GENERATED:pooler-matrix */}'

/** Field → the row label and the phrasing of each value. Every field of `PoolerProfile` appears. */
const ROWS = [
  {
    field: 'namedPreparedStatements',
    label: "Named prepared statements (`execMode: { statement: 'named' }`)",
    render: {
      ok: '✅ ok',
      'shared-lru':
        "⚠️ shared-lru — allowed; the pooler's per-server cache is shared across clients",
      unsupported: '❌ unsupported — `ConfigError` at construction',
    },
  },
  {
    field: 'sessionGucsAtConnect',
    label: 'Session GUCs at connect (`session: { … }`)',
    render: {
      ok: '✅ ok',
      unsafe: '❌ unsafe — skipped, with one `info` line naming the `ALTER ROLE` fix',
    },
  },
  {
    field: 'listen',
    label: '`db.listen()`',
    render: {
      ok: '✅ ok',
      unsupported:
        '❌ unsupported — routed to `directConnection`; `UnsupportedInPoolerModeError` if there is none',
    },
  },
  {
    field: 'sessionAdvisoryLocks',
    label: 'Session advisory locks (`session.advisoryLock()`)',
    render: { ok: '✅ ok', unsupported: '❌ unsupported — use `tx.advisoryLock()`' },
  },
  {
    field: 'withHoldCursors',
    label: '`WITH HOLD` cursors',
    render: { ok: '✅ ok', unsupported: '❌ unsupported' },
  },
  {
    field: 'sessionHandle',
    label: '`db.session()`',
    render: { ok: '✅ ok', unsupported: '❌ unsupported — `UnsupportedInPoolerModeError`' },
  },
  {
    field: 'cancelRequest',
    label: 'Cancel request (abort mid-query)',
    render: { ok: '✅ ok', 'best-effort': '⚠️ best-effort' },
  },
  {
    field: 'resetQuery',
    label: 'Reset query (`DISCARD ALL`)',
    render: { never: 'never emitted' },
  },
]

const dist = join(ROOT, 'packages', 'pg-prime', 'dist', 'index.js')
const { POOLER_MODES, POOLER_PROFILES } = await import(pathToFileURL(dist).href)

const header = `| Capability | ${POOLER_MODES.map((m) => `\`${m}\``).join(' | ')} |`
const rule = `|---|${POOLER_MODES.map(() => '---').join('|')}|`
const body = ROWS.map((row) => {
  const cells = POOLER_MODES.map((mode) => {
    const value = POOLER_PROFILES[mode][row.field]
    const text = row.render[value]
    if (!text) {
      console.error(
        `pooler-matrix: POOLER_PROFILES.${mode}.${row.field} is '${value}', which this generator has no wording for. ` +
          `Add it to tools/pooler-matrix.mjs — a new capability value must be described, not silently printed.`,
      )
      process.exit(1)
    }
    return text
  })
  return `| ${row.label} | ${cells.join(' | ')} |`
})

const table = [header, rule, ...body].join('\n')
const generated = `${BEGIN}\n\n${table}\n\n${END}`

const page = readFileSync(PAGE, 'utf8')
const start = page.indexOf(BEGIN)
const end = page.indexOf(END)
if (start === -1 || end === -1) {
  console.error(
    `pooler-matrix: ${PAGE} has no generated region. It must contain the marker line\n  ${BEGIN}\nand\n  ${END}`,
  )
  process.exit(1)
}
const next = page.slice(0, start) + generated + page.slice(end + END.length)

if (next === page) {
  console.log(
    `pooler-matrix: up to date (${ROWS.length} capabilities × ${POOLER_MODES.length} modes)`,
  )
  process.exit(0)
}
if (CHECK) {
  console.error(
    'pooler-matrix: operations/poolers.mdx has drifted from POOLER_PROFILES. Run `node tools/pooler-matrix.mjs`.',
  )
  process.exit(1)
}
writeFileSync(PAGE, next)
console.log(
  `pooler-matrix: wrote ${ROWS.length} capabilities × ${POOLER_MODES.length} modes into operations/poolers.mdx`,
)
