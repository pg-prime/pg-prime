// design/12 §4 D's third gate: the reference is mechanically consistent with the code.
//
//   node tools/docs-coverage.mjs           # the gate
//   node tools/docs-coverage.mjs --write   # regenerate the CLI `--help` blocks in place
//
// Three checks, each a two-way comparison against something that is not prose:
//
//   1. **API coverage.** Every name in `tools/api-snapshot/*.json` has a reference entry, and every
//      reference entry names something the goldens contain. A page opts in by declaring
//      `apiEntry: pg-prime#./schema` in its frontmatter; an "entry" is an anchor — a
//      `### \`name\`` heading or an `<a id="name">`, which is what makes the check mechanical
//      rather than a reading of the prose (design/12 §4 D: "an anchor per name").
//   2. **The CLI reference.** Every block marked `cli="migrate generate --help"` must be, verbatim,
//      what the built `pg-prime` binary prints. An option added to a command and not to the page
//      fails here.
//   3. **The hazard-code table.** Its rows must be exactly the codes the kit implements —
//      `HAZARD_SEVERITY` in `src/plan/plan.ts` plus `STYLE_CODES` in `src/lint/rules.ts` — and each
//      row's severity must be what the built `hazardSeverity()` returns for that code.

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, readAllPages } from './docs-blocks.mjs'

const WRITE = process.argv.includes('--write')
/** `--missing <entry>` prints one name per line, for whoever is writing that page. */
const MISSING_FOR = process.argv[process.argv.indexOf('--missing') + 1]
/**
 * The binaries a `cli=` block can be goldened against.
 *
 * `cli="migrate generate --help"` is the kit's, which is the default and what every block written
 * before `@pg-prime/create` existed means. A block whose FIRST word is a bin name selects that
 * binary instead — `cli="create-pg-prime --help"` — which needs no new directive and leaves
 * `docs/README.md`'s description ("what the built binary prints") true as written.
 */
const BINS = {
  'pg-prime': join(ROOT, 'packages', 'pg-prime-kit', 'dist', 'cli.js'),
  'create-pg-prime': join(ROOT, 'packages', 'pg-prime-create', 'dist', 'cli.js'),
}
const DEFAULT_BIN = 'pg-prime'

const ANCHOR_HEADING = /^#{2,5}\s+`([A-Za-z_$][\w$]*)`\s*$/
const ANCHOR_TAG = /<a id="([A-Za-z_$][\w$]*)"\s*(?:\/>|><\/a>)/g

const failures = []
const notes = []

const pages = readAllPages()

// ── 1. API coverage ──────────────────────────────────────────────────────────
const entries = new Map()
for (const file of ['pg-prime.json', 'pg-prime-kit.json', 'pg-prime-create.json']) {
  const golden = JSON.parse(readFileSync(join(ROOT, 'tools', 'api-snapshot', file), 'utf8'))
  for (const [subpath, entry] of Object.entries(golden.entries)) {
    entries.set(`${golden.package}#${subpath}`, {
      key: `${golden.package}#${subpath}`,
      spec: subpath === '.' ? golden.package : `${golden.package}/${subpath.slice(2)}`,
      names: new Set([...entry.values, ...entry.types]),
      covered: new Set(),
      pages: [],
    })
  }
}

for (const page of pages) {
  const declared = [page.frontmatter.apiEntry ?? []].flat().filter(Boolean)
  if (declared.length === 0) continue
  const mine = []
  for (const key of declared) {
    const entry = entries.get(key)
    if (!entry) {
      failures.push(
        `${page.page}: apiEntry '${key}' is not an entry point in the api-snapshot goldens`,
      )
      continue
    }
    entry.pages.push(page.page)
    mine.push(entry)
  }
  for (const anchor of anchorsOf(page)) {
    // A name may belong to more than one declared entry — `pgTable` is exported from both
    // `pg-prime/schema` and the root — and one anchor covers it in every entry that has it.
    const owners = mine.filter((e) => e.names.has(anchor.name))
    if (owners.length === 0) {
      failures.push(
        `${page.page}:${anchor.line}: reference entry \`${anchor.name}\` is not exported by ` +
          `${mine.map((e) => e.spec).join(' / ')} — the api-snapshot goldens do not contain it`,
      )
      continue
    }
    for (const owner of owners) owner.covered.add(anchor.name)
  }
}

const coverageRows = []
for (const entry of entries.values()) {
  const missing = [...entry.names].filter((n) => !entry.covered.has(n)).sort()
  if (process.argv.includes('--missing') && entry.spec === MISSING_FOR) {
    for (const n of missing) console.log(n)
    process.exit(0)
  }
  const pct = ((entry.covered.size / entry.names.size) * 100).toFixed(1)
  coverageRows.push(
    `  ${entry.spec.padEnd(18)} ${String(entry.covered.size).padStart(4)}/${String(entry.names.size).padEnd(4)} ` +
      `${pct.padStart(5)} %  ${entry.pages.join(', ') || '(no page claims this entry)'}`,
  )
  if (missing.length > 0) {
    // Truncated: a full 500-name dump buries every other failure in the same run.
    const head = missing.slice(0, 30).join(', ')
    failures.push(
      `${entry.spec}: ${missing.length} exported name(s) have no reference entry:\n      ` +
        head +
        (missing.length > 30
          ? `, … (+${missing.length - 30} more; \`node tools/docs-coverage.mjs --missing ${entry.spec}\` lists them)`
          : ''),
    )
  }
}

function anchorsOf(page) {
  const out = []
  let fence = false
  for (let i = 0; i < page.lines.length; i++) {
    const line = page.lines[i]
    if (/^\s*```/.test(line)) {
      fence = !fence
      continue
    }
    if (fence) continue
    const h = ANCHOR_HEADING.exec(line)
    if (h) out.push({ name: h[1], line: i + 1 })
    for (const m of line.matchAll(ANCHOR_TAG)) out.push({ name: m[1], line: i + 1 })
  }
  return out
}

// ── 2. The CLI reference ─────────────────────────────────────────────────────
let cliBlocks = 0
for (const page of pages) {
  const edits = []
  for (const block of page.blocks) {
    if (typeof block.attrs.cli !== 'string') continue
    cliBlocks++
    const argv = block.attrs.cli.split(/\s+/)
    const bin = Object.hasOwn(BINS, argv[0]) ? argv.shift() : DEFAULT_BIN
    const res = spawnSync(process.execPath, [BINS[bin], ...argv], { encoding: 'utf8' })
    const actual = (res.stdout + res.stderr).replace(/\s+$/, '')
    const expected = block.text.replace(/\s+$/, '')
    if (actual === expected) continue
    if (WRITE) {
      edits.push({
        from: block.bodyLine - 1,
        to: block.bodyLine - 1 + block.text.split('\n').length,
        text: actual,
      })
      continue
    }
    failures.push(
      `${page.page}:${block.line}: the block for \`${bin} ${argv.join(' ')}\` is not what the ` +
        `binary prints. Run \`node tools/docs-coverage.mjs --write\`.\n` +
        diff(expected, actual)
          .map((l) => `      ${l}`)
          .join('\n'),
    )
  }
  if (edits.length > 0) {
    const lines = [...page.lines]
    for (const edit of edits.sort((a, b) => b.from - a.from)) {
      lines.splice(edit.from, edit.to - edit.from, ...edit.text.split('\n'))
    }
    writeFileSync(page.file, lines.join('\n'))
    notes.push(`rewrote ${edits.length} CLI block(s) in ${page.page}`)
  }
}

function diff(expected, actual) {
  const a = expected.split('\n')
  const b = actual.split('\n')
  const out = []
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < 12; i++) {
    if (a[i] === b[i]) continue
    if (a[i] !== undefined) out.push(`- ${a[i]}`)
    if (b[i] !== undefined) out.push(`+ ${b[i]}`)
  }
  return out
}

// ── 3. The hazard-code table ─────────────────────────────────────────────────
const planSrc = readFileSync(join(ROOT, 'packages/pg-prime-kit/src/plan/plan.ts'), 'utf8')
const rulesSrc = readFileSync(join(ROOT, 'packages/pg-prime-kit/src/lint/rules.ts'), 'utf8')
const severityBlock = /const HAZARD_SEVERITY[^{]*\{([\s\S]*?)\n\};/.exec(planSrc)
if (!severityBlock) {
  failures.push(
    'docs-coverage: could not find HAZARD_SEVERITY in packages/pg-prime-kit/src/plan/plan.ts',
  )
}
const hazardCodes = new Set(
  [...(severityBlock?.[1] ?? '').matchAll(/([A-Z]{2}\d{3}):/g)].map((m) => m[1]),
)
const styleCodes = new Set(
  [
    ...(/STYLE_CODES[^=]*=\s*\[([^\]]*)\]/.exec(rulesSrc)?.[1] ?? '').matchAll(
      /"([A-Z]{2}\d{3})"/g,
    ),
  ].map((m) => m[1]),
)
const allCodes = new Set([...hazardCodes, ...styleCodes])

const { hazardSeverity, isStyleCode } = await import(
  pathToFileURL(join(ROOT, 'packages', 'pg-prime-kit', 'dist', 'index.js')).href
)

const HAZARD_ROW = /^\|\s*<a id="([A-Z]{2}\d{3})"\s*(?:\/>|><\/a>)\s*`?\1`?\s*\|\s*([a-z]+)\s*\|/
const documented = new Map()
for (const page of pages) {
  for (let i = 0; i < page.lines.length; i++) {
    const m = HAZARD_ROW.exec(page.lines[i])
    if (m) documented.set(m[1], { severity: m[2], where: `${page.page}:${i + 1}` })
  }
}

if (documented.size === 0) {
  failures.push(
    'docs-coverage: no hazard-code table found — expected rows of the form `| <a id="LK101"/> `LK101` | warn | … |`',
  )
}
for (const code of allCodes) {
  const row = documented.get(code)
  if (!row) {
    failures.push(
      `hazard code ${code} is implemented by the kit and has no row in the hazard-code table`,
    )
    continue
  }
  const expected = isStyleCode(code) ? 'off' : hazardSeverity(code)
  if (row.severity !== expected) {
    failures.push(
      `${row.where}: hazard ${code} is documented as \`${row.severity}\`; the kit says \`${expected}\``,
    )
  }
}
for (const code of documented.keys()) {
  if (!allCodes.has(code)) {
    failures.push(
      `${documented.get(code).where}: hazard code ${code} is documented and the kit does not implement it`,
    )
  }
}

// ── 4. Internal links ────────────────────────────────────────────────────────
// Astro does not fail a build on a dead internal link, and this site has hundreds of them. The
// slug set is the pages themselves, so a renamed page fails here rather than 404ing in production.
const slugs = new Set(pages.map((p) => p.page.replace(/\.mdx?$/, '').replace(/(^|\/)index$/, '')))
const LINK = /\]\((\/pg-prime\/[^)\s]*)\)/g
let links = 0
for (const page of pages) {
  let fence = false
  for (let i = 0; i < page.lines.length; i++) {
    if (/^\s*```/.test(page.lines[i])) {
      fence = !fence
      continue
    }
    if (fence) continue
    for (const m of page.lines[i].matchAll(LINK)) {
      links++
      const target = m[1]
        .replace(/^\/pg-prime\//, '')
        .replace(/#.*$/, '')
        .replace(/\/$/, '')
      if (slugs.has(target)) continue
      failures.push(`${page.page}:${i + 1}: link to /pg-prime/${target}/ — no page has that slug`)
    }
  }
}

// ── 5. R22: every `no-run` states why ────────────────────────────────────────
checkNoRunReasons(pages, failures, notes)

// ── Report ───────────────────────────────────────────────────────────────────
const totalNames = [...entries.values()].reduce((n, e) => n + e.names.size, 0)
const totalCovered = [...entries.values()].reduce((n, e) => n + e.covered.size, 0)
console.log(
  `docs-coverage: ${totalCovered}/${totalNames} exported names have a reference entry ` +
    `(${((totalCovered / totalNames) * 100).toFixed(1)} %), ${cliBlocks} CLI block(s), ` +
    `${documented.size}/${allCodes.size} hazard codes, ${links} internal links`,
)
for (const row of coverageRows) console.log(row)
for (const n of notes) console.log(`  ${n}`)

if (failures.length > 0) {
  console.error(`\ndocs-coverage: ${failures.length} failure(s)\n`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}
console.log('docs-coverage: OK')

// ── R22 (design/13 decision 11) ───────────────────────────────────────────────
// A `no-run` block is one the examples runner will not execute, and until this check existed the
// only way to know why was to guess. The reason is now written down in one of two places:
//
//     {/* docs: no-run="a config file: the kit loads it" */}   the attribute, for a block whose
//     ```ts title="pg-prime.config.ts" no-run="…"              reader should not see a note
//
//     // no-run: PGlite cannot host COPY.                      the block's first line, when the
//                                                              reason is worth reading on the page
//
// Both are the same attribute as far as `docs-blocks.mjs` is concerned; the difference is whether
// the page shows it, and that is an editorial choice per block.

// The two constants live inside the function on purpose: this section is appended at the end of
// the file so that two other branches can add their package-list lines at the top of it without a
// conflict, and a `const` at the end of a module is in its temporal dead zone when the checks
// above run.
function checkNoRunReasons(allPages, sink, noteSink) {
  /**
   * The pages design/13 §3 hands to another branch, which E must not edit.
   *
   * Every entry is a *claim*: that page still has an unexplained `no-run` today. When the owning
   * branch lands and the claim stops being true, this check fails and says to delete the line —
   * so the waiver cannot outlive the integration it exists for.
   */
  const PENDING_R22 = new Map([
    ['guides/testing.mdx', 'T rewrites this page around @pg-prime/testing (design/13 §3 T)'],
  ])
  /** A reason has to be a sentence; `no-run="x"` is not one. */
  const MIN_REASON = 12

  const waived = new Map()
  let explained = 0
  let unexplained = 0

  for (const page of allPages) {
    for (const block of page.blocks) {
      if (!block.attrs['no-run']) continue
      const where = `${page.page}:${block.line}`
      if (block.attrs['pg-only']) {
        sink.push(
          `${where}: the block is both no-run and pg-only — the first says nothing runs it and ` +
            'the second says the real-server tier does. Pick one.',
        )
        continue
      }
      const attr = typeof block.attrs['no-run'] === 'string' ? block.attrs['no-run'].trim() : ''
      const first = /^\s*\/\/\s*no-run:\s*(\S.*)$/.exec(block.text.split('\n')[0] ?? '')
      const reason = attr || (first?.[1] ?? '').trim()
      if (reason.length >= MIN_REASON) {
        explained++
        continue
      }
      unexplained++
      if (PENDING_R22.has(page.page)) {
        waived.set(page.page, (waived.get(page.page) ?? 0) + 1)
        continue
      }
      sink.push(
        `${where}: no-run with no reason (R22). Write it as the block's first line — ` +
          '`// no-run: <why>` — or as `no-run="<why>"` on the fence when a comment would be ' +
          'wrong for the reader.',
      )
    }
  }

  for (const [page, owner] of PENDING_R22) {
    const n = waived.get(page)
    if (n === undefined) {
      sink.push(
        `docs-coverage: ${page} has no unexplained no-run block left, so its PENDING_R22 waiver ` +
          'in tools/docs-coverage.mjs is stale — delete that line (design/13 §3, R22).',
      )
      continue
    }
    noteSink.push(`R22: ${n} no-run block(s) on ${page} waived — ${owner}`)
  }

  noteSink.push(
    `R22: ${explained} no-run block(s) state why` +
      (unexplained > 0 ? `, ${unexplained} do not` : ''),
  )
}
