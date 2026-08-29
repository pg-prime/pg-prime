// The emit-parity guard (design/08 §3.1).
//
//   node tools/emit-parity.mjs [--package packages/pg-prime] [--keep]
//
// Builds a package twice into two temp trees — once with the build compiler and once with the
// consumer floor — and diffs the two trees file by file, failing on any difference. That converts
// "is the new compiler's emit trustworthy?" from an unknown into a test, and gives a one-line
// fallback if it ever fires.
//
// ─── Which two compilers, and why not design's pair ──────────────────────────
//
// design §3.1 says `typescript@6.0.3` vs `tsgo@7.0.2`. This repo has never installed 6.0.3; it
// installs `typescript@7.0.2` (the build compiler) and `typescript59` = `npm:typescript@5.9.3`,
// which is the CONSUMER FLOOR (§2.2, §8 resolution 2) and is already what bench/types and
// tools/type-errors gate on. 5.9.3 against 7.0.2 is the STRONGER of the two comparisons — 5.9 is
// further from 7.0 than 6.0 is, and it is the version whose behaviour we actually promise — so the
// pair is 5.9.3 / 7.0.2 and design §3.1 gets an AS BUILT note saying so.
//
// ─── What is compared, what is tolerated, and what was measured ──────────────
//
// Three categories, and every file in the second and third is PRINTED by name, with a count, on
// every run. Nothing is excluded silently and nothing is excluded by file extension.
//
//   1. `.js` — byte for byte. Any difference fails. MEASURED 2026-08-28: zero differences, in
//      both packages. The compiled JavaScript tsgo 7.0.2 produces is identical to 5.9.3's.
//
//   2. `.d.ts` — byte for byte, and any difference fails, EXCEPT a difference that survives
//      nothing but swapping `"…"` for `'…'` in string literals. MEASURED: exactly one file in
//      either package, `packages/pg-prime/dist/compile/nodes.d.ts`, where an inferred parameter
//      type prints as `nulls?: 'first' | 'last'` under 7.0.2 and `nulls?: "first" | "last"` under
//      5.9.3 — same length, same type, different quote character. The normalisation only rewrites
//      a double-quoted run that contains no quote, backslash or newline, it is applied to BOTH
//      sides, and the affected files are listed. A `.d.ts` that differs in any other way fails.
//
//   3. `.js.map` / `.d.ts.map` — compared key by key as JSON. A difference in `mappings` or
//      `sourcesContent` is reported and tolerated; a difference in `version`, `file`, `sources`,
//      `sourceRoot` or `names` fails. MEASURED: 29 of 114 maps in `pg-prime` and 20 of 56 in the
//      kit differ, all of them in `mappings` alone — the two compilers pick slightly different
//      source positions for the same construct (e.g. `sql/errors.js.map`, 2 581 vs 2 586 VLQ
//      characters over identical `sources` and `names`). This is the debug payload, it does not
//      change a byte of what runs or of what the checker reads, and it is the one thing this
//      guard cannot ask two independent compilers to agree on. It is tolerated with the list
//      printed, not hidden.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPackage, listFiles, TSC_59, TSC_7 } from './build-package.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

export const COMPILERS = { '7.0.2': TSC_7, '5.9.3': TSC_59 }

/** The narrowest possible quote-style normalisation: a double-quoted run with nothing awkward in it. */
const unifyQuotes = (text) => text.replace(/"([^"'\\\n]*)"/g, "'$1'")

/** Keys of a source map whose disagreement is a debug-payload difference, not an emit difference. */
const TOLERATED_MAP_KEYS = new Set(['mappings', 'sourcesContent'])

export function compare(aDir, bDir) {
  const a = listFiles(aDir)
  const b = listFiles(bDir)
  const onlyA = a.filter((f) => !b.includes(f))
  const onlyB = b.filter((f) => !a.includes(f))
  /** Hard failures. */
  const differ = []
  /** Reported, tolerated, and named. */
  const quoteStyleOnly = []
  const mapKeysDiffer = []
  for (const f of a) {
    if (!b.includes(f)) continue
    const ta = readFileSync(join(aDir, f))
    const tb = readFileSync(join(bDir, f))
    if (ta.equals(tb)) continue
    const sa = ta.toString('utf8')
    const sb = tb.toString('utf8')
    if (f.endsWith('.map')) {
      const ja = JSON.parse(sa)
      const jb = JSON.parse(sb)
      const keys = [...new Set([...Object.keys(ja), ...Object.keys(jb)])].sort()
      const changed = keys.filter((k) => JSON.stringify(ja[k]) !== JSON.stringify(jb[k]))
      if (changed.every((k) => TOLERATED_MAP_KEYS.has(k))) {
        mapKeysDiffer.push({ file: f, keys: changed })
        continue
      }
      differ.push({
        file: f,
        aBytes: ta.length,
        bBytes: tb.length,
        why: `map keys differ: ${changed.join(', ')}`,
      })
      continue
    }
    if (f.endsWith('.d.ts') && unifyQuotes(sa) === unifyQuotes(sb)) {
      quoteStyleOnly.push(f)
      continue
    }
    differ.push({ file: f, aBytes: ta.length, bBytes: tb.length, why: 'content differs' })
  }
  return { onlyA, onlyB, differ, quoteStyleOnly, mapKeysDiffer, fileCount: a.length }
}

export function parity(pkgDir, { keep = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'pg-prime-emit-parity-'))
  try {
    const out = {}
    for (const [version, tsc] of Object.entries(COMPILERS)) {
      const dir = join(tmp, version)
      const started = Date.now()
      buildPackage(pkgDir, { out: dir, tsc, quiet: true })
      out[version] = {
        dir,
        ms: Date.now() - started,
        bytes: listFiles(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0),
      }
    }
    const result = compare(out['7.0.2'].dir, out['5.9.3'].dir)
    return { ...result, timings: out, tmp }
  } finally {
    if (!keep) rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && process.argv[1].endsWith('emit-parity.mjs')) {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--package')
  const packages =
    i === -1
      ? ['packages/pg-prime', 'packages/pg-prime-kit', 'packages/pg-prime-create']
      ? ['packages/pg-prime', 'packages/pg-prime-kit', 'packages/pg-prime-testing']
      : [argv[i + 1]]
  let bad = 0
  for (const rel of packages) {
    const r = parity(join(ROOT, rel), { keep: argv.includes('--keep') })
    const same = r.fileCount - r.differ.length - r.quoteStyleOnly.length - r.mapKeysDiffer.length
    console.log(
      `${rel}: ${r.fileCount} files — ${same} byte-identical, ` +
        `${r.quoteStyleOnly.length} .d.ts differ only in string-literal quote style, ` +
        `${r.mapKeysDiffer.length} maps differ only in a tolerated key, ` +
        `${r.differ.length} FAIL, ${r.onlyA.length + r.onlyB.length} present in one tree only  ` +
        `(tsgo 7.0.2 ${r.timings['7.0.2'].ms} ms, tsc 5.9.3 ${r.timings['5.9.3'].ms} ms)`,
    )
    for (const f of r.quoteStyleOnly) console.log(`  tolerated (quote style)   ${f}`)
    for (const m of r.mapKeysDiffer)
      console.log(`  tolerated (${m.keys.join(', ')})       ${m.file}`)
    for (const f of r.onlyA) console.error(`  only in the 7.0.2 emit: ${f}`)
    for (const f of r.onlyB) console.error(`  only in the 5.9.3 emit: ${f}`)
    for (const d of r.differ)
      console.error(`  DIFFERS ${d.file} — ${d.why} (7.0.2 ${d.aBytes} B, 5.9.3 ${d.bBytes} B)`)
    bad += r.differ.length + r.onlyA.length + r.onlyB.length
  }
  if (bad) {
    console.error(
      `\nemit parity FAILED on ${bad} file(s) — design/08 §3.1's fallback is to build with the older compiler`,
    )
    process.exit(1)
  }
  console.log('\nemit parity ok')
}
