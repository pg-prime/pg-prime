// The published-artifact size gates (design/08 §1.2, §3.2).
//
//   node tools/size-budget.mjs [--json]
//
// Measured from `npm pack --dry-run --json` run inside each package — i.e. from the actual file
// list npm would put in the tarball, with `files: ["dist"]` and the implicit README/LICENSE
// applied. Not from `du dist/`: the two differ (npm adds README.md and LICENSE and rewrites
// package.json), and the number that matters to a user is the one they download.
//
// ─── R9's three-way print ────────────────────────────────────────────────────
//
// Every line prints as `design / measured / budget`, the shape bench/types/run.mjs established, so
// a number drifting away from design/08 §1.2 is visible in the log while it is still inside budget.
// A budget that is looser than its design value must be named in `budgets.json._overDesign` with a
// reason, or this tool fails even when the measurement passes — the same machine-checkable version
// of "loosening a budget is a reviewed act" that bench/runtime/budget.json uses.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

export const KB = 1024
const kb = (n) => `${(n / KB).toFixed(1)} KB`

/** The file list npm would ship, straight from npm. */
export function packList(pkgDir) {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: pkgDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const [meta] = JSON.parse(raw)
  if (!meta) throw new Error(`size-budget: npm pack --dry-run produced nothing for ${pkgDir}`)
  return meta
}

export function measure(pkgDir) {
  if (!existsSync(join(pkgDir, 'dist'))) {
    throw new Error(`size-budget: ${pkgDir}/dist is missing — run \`pnpm build\` first`)
  }
  const meta = packList(pkgDir)
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const files = meta.files
  const of = (pred) => files.filter(pred)
  const sum = (list) => list.reduce((n, f) => n + f.size, 0)
  const dts = of((f) => f.path.endsWith('.d.ts'))
  const js = of((f) => f.path.endsWith('.js'))
  const maps = of((f) => f.path.endsWith('.map'))
  const largest = [...dts].sort((a, b) => b.size - a.size)
  return {
    name: pkgJson.name,
    tarballBytes: meta.size,
    unpackedBytes: meta.unpackedSize,
    fileCount: files.length,
    dtsBytes: sum(dts),
    dtsFiles: dts.length,
    largestDtsBytes: largest[0]?.size ?? 0,
    largestDtsPath: largest[0]?.path ?? '(none)',
    jsBytes: sum(js),
    jsFiles: js.length,
    mapBytes: sum(maps),
    dependencies: Object.keys(pkgJson.dependencies ?? {}),
    peerDependencies: Object.keys(pkgJson.peerDependencies ?? {}),
    /**
     * Peers the package declares AND marks optional. Design/08 §6.2 #7's "zero peer dependencies"
     * is about what a consumer is FORCED to install; an optional peer forces nothing, and
     * design/12 §1 decision 2 makes `pg` one so that `connection:` can build a pool. The gate
     * below still fails on a REQUIRED peer, and on an optional one the budget does not name.
     */
    optionalPeerDependencies: Object.entries(pkgJson.peerDependenciesMeta ?? {})
      .filter(([, v]) => v?.optional === true)
      .map(([k]) => k),
    top10Dts: largest.slice(0, 10).map((f) => [f.path, f.size]),
  }
}

/**
 * The gate. `design` is design/08 §1.2's own number where there is one; `budget` is what this repo
 * actually enforces. They differ only where `_overDesign` says why.
 */
export function run({ json = false } = {}) {
  const budgets = JSON.parse(readFileSync(join(HERE, 'budgets.json'), 'utf8'))
  const over = budgets._overDesign
  const checks = []
  const report = {}

  for (const [dir, spec] of Object.entries(budgets.packages)) {
    const m = measure(join(ROOT, dir))
    report[m.name] = m
    console.log(`\n${m.name}  —  ${kb(m.unpackedBytes)} unpacked in ${m.fileCount} files (tarball ${kb(m.tarballBytes)})`)
    console.log(`  ${'metric'.padEnd(30)} ${'design'.padStart(12)} ${'measured'.padStart(12)} ${'budget'.padStart(12)}`)

    const line = (label, key, actual, format = kb) => {
      const limit = spec[key]
      if (limit === undefined) return
      const designed = spec._design?.[key]
      const ok = actual <= limit
      const flagKey = `${dir}.${key}`
      if (designed !== undefined && limit > designed && !over[flagKey]) {
        checks.push({ label: `${m.name} ${label}`, ok: false, why: `budget ${format(limit)} is looser than design's ${format(designed)} and is not named in budgets.json._overDesign` })
      }
      checks.push({ label: `${m.name} ${label}`, ok, actual, limit, format })
      console.log(
        `  ${label.padEnd(30)} ${(designed === undefined ? '—' : format(designed)).padStart(12)} ` +
          `${format(actual).padStart(12)} ${format(limit).padStart(12)}  ${ok ? 'ok' : 'FAIL'}`,
      )
    }

    line('unpacked bytes', 'unpackedBytes', m.unpackedBytes)
    line('file count', 'fileCount', m.fileCount, String)
    line('total .d.ts bytes', 'dtsBytes', m.dtsBytes)
    line('.d.ts file count', 'dtsFiles', m.dtsFiles, String)
    line('largest single .d.ts', 'largestDtsBytes', m.largestDtsBytes)
    line('total .js bytes', 'jsBytes', m.jsBytes)

    if (spec.dtsWarnBytes !== undefined && m.dtsBytes > spec.dtsWarnBytes) {
      console.log(`  WARN total .d.ts ${kb(m.dtsBytes)} is past the ${kb(spec.dtsWarnBytes)} warn line (design/08 §1.2)`)
    }
    if (spec.zeroDependencies) {
      const allowed = spec.optionalPeers ?? []
      const requiredPeers = m.peerDependencies.filter((d) => !m.optionalPeerDependencies.includes(d))
      const unlistedOptional = m.optionalPeerDependencies.filter((d) => !allowed.includes(d))
      const ok = m.dependencies.length === 0 && requiredPeers.length === 0 && unlistedOptional.length === 0
      checks.push({
        label: `${m.name} zero runtime deps / zero REQUIRED peer deps`,
        ok,
        why: ok
          ? undefined
          : `dependencies=[${m.dependencies}] requiredPeers=[${requiredPeers}] unlistedOptionalPeers=[${unlistedOptional}]`,
      })
      const shown = `${m.dependencies.length} / ${requiredPeers.length}${m.optionalPeerDependencies.length > 0 ? ` (+${m.optionalPeerDependencies.length} opt)` : ''}`
      console.log(`  ${'deps / required peerDeps'.padEnd(30)} ${'0 / 0'.padStart(12)} ${shown.padStart(12)} ${'0 / 0'.padStart(12)}  ${ok ? 'ok' : 'FAIL'}`)
    }
    const failedDts = checks.some((c) => !c.ok && c.label.includes('.d.ts'))
    if (failedDts) {
      console.log(`  top 10 .d.ts by size:`)
      for (const [p, n] of m.top10Dts) console.log(`    ${kb(n).padStart(10)}  ${p}`)
    }
  }

  const failed = checks.filter((c) => !c.ok)
  if (json) console.log(JSON.stringify(report, null, 2))
  console.log('')
  for (const f of failed) {
    console.error(`FAIL ${f.label}${f.why ? `: ${f.why}` : `: ${f.format ? f.format(f.actual) : f.actual} > ${f.format ? f.format(f.limit) : f.limit}`}`)
  }
  console.log(`${checks.length - failed.length}/${checks.length} size gates ok`)
  return { report, failed }
}

if (process.argv[1] && process.argv[1].endsWith('size-budget.mjs')) {
  const { failed } = run({ json: process.argv.includes('--json') })
  if (failed.length) process.exit(1)
}
