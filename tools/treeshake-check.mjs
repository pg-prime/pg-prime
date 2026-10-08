// Tree-shaking verification (design/08 §2.4). Not "we set `sideEffects: false` and hope".
//
//   node tools/treeshake-check.mjs [--update] [--case NAME]
//
//   --update   rewrite every fixture's expected-modules.json (review the diff — that IS the point)
//   --case     run one fixture
//
// ─── Method ──────────────────────────────────────────────────────────────────
//
//  1. Each package a fixture imports is staged into a throwaway `node_modules/<name>` in
//     os.tmpdir() — `package.json` plus `dist/`, i.e. exactly what `files: ["dist"]` publishes —
//     together with its `dependencies`. Fixtures import packages by NAME, so resolution goes through
//     the export maps. Bundling `../../packages/*/src` instead would test a thing we do not ship,
//     and would silently pass if an export map pointed at nothing.
//  2. esbuild `--bundle --format=esm --minify --platform=node --metafile`, then gzip. That is
//     §2.4 step 1 and step 2.
//  3. **The exact set of included input modules is asserted against a committed golden**
//     (§2.4 step 3) — derived from the metafile. This is the part that actually works: a size
//     budget alone drifts silently, while "the query builder now pulls in the DDL differ" shows up
//     here as a reviewable diff on the PR that introduces it.
//  4. rollup + @rollup/plugin-node-resolve is run as §2.4's independent second DCE opinion. Its
//     output is minified with esbuild's transform (rollup ships no minifier and adding terser for
//     one number is not worth a dependency), so the two numbers are comparable. It is REPORTED,
//     and its module set is diffed against esbuild's; the gate is esbuild's, because esbuild is
//     what the golden is derived from and two bundlers on one gate is two ways to go red for a
//     reason that is not ours. A rollup/esbuild module-set disagreement is printed loudly.
//  5. An add-on fixture's budget is `{ "delta": bytes }`: the gate is the min+gz of the same entry
//     bundled with `pg-prime` external, i.e. what the add-on adds over the pg-prime an app already
//     ships. The module-set golden still covers the whole bundle.
//  6. A golden of `{ "modules": null }` is a seeded slot whose API does not exist yet: while its
//     entry fails to bundle it is reported as pending; once it bundles, the golden must be recorded.
import { build as esbuild, transform } from 'esbuild'
import { rollup } from 'rollup'
import nodeResolve from '@rollup/plugin-node-resolve'
import { gzipSync } from 'node:zlib'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACKAGES } from './packages.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const FIXTURES = join(ROOT, 'fixtures', 'treeshake')

const gz = (text) => gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).length
const posix = (p) => p.split(sep).join('/')

/**
 * The packages the fixtures import, plus their `dependencies` (workspace or third-party), under
 * `tmp/node_modules`. Only what is imported: a staged `pg` (the kit's dependency) would turn
 * pg-prime's lazy `import('pg')` into a bundled one.
 */
function stagePackages(tmp, names) {
  const staged = new Set()
  const stage = (name, from) => {
    if (staged.has(name)) return
    staged.add(name)
    const ws = PACKAGES.find((p) => p.name === name)
    const dest = join(tmp, 'node_modules', name)
    if (!ws) {
      cpSync(realpathSync(join(from, 'node_modules', name)), dest, { recursive: true })
      return
    }
    const src = join(ROOT, ws.dir)
    if (!existsSync(join(src, 'dist', 'index.js'))) {
      throw new Error(`treeshake-check: ${ws.dir}/dist is missing — run \`pnpm build\` first`)
    }
    mkdirSync(dest, { recursive: true })
    cpSync(join(src, 'dist'), join(dest, 'dist'), { recursive: true })
    cpSync(join(src, 'package.json'), join(dest, 'package.json'))
    for (const dep of Object.keys(ws.pkg.dependencies ?? {})) stage(dep, src)
  }
  for (const n of names) {
    const entry = readFileSync(join(FIXTURES, n, 'entry.ts'), 'utf8')
    for (const [, spec] of entry.matchAll(/from '((?:@[^/']+\/)?[^/']+)/g)) stage(spec, ROOT)
  }
}

export function caseNames() {
  return readdirSync(FIXTURES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

/** Metafile input keys → stable module ids, relative to the staged tmp dir. */
const normalise = (paths) => [...new Set(paths.map(posix))].sort()

async function bundleWithEsbuild(tmp, name, external = []) {
  const result = await esbuild({
    external,
    absWorkingDir: tmp,
    entryPoints: [join(tmp, name, 'entry.ts')],
    bundle: true,
    format: 'esm',
    minify: true,
    platform: 'node',
    target: 'node22',
    metafile: true,
    write: false,
    logLevel: 'silent',
    logOverride: { 'empty-import-meta': 'silent' },
  })
  const code = result.outputFiles[0]?.text ?? ''
  // `metafile.inputs` is every module esbuild *scanned* — for `side-effects-only` that is all 48 of
  // them, and a golden built from it would be identical for every fixture and therefore worthless.
  // `metafile.outputs[…].inputs` is what each module contributed to the bundle, so a module that
  // was shaken out has `bytesInOutput: 0`. That set, with its byte counts, is the golden.
  const out = Object.values(result.metafile.outputs)[0]
  const contributions = Object.entries(out?.inputs ?? {}).filter(([, v]) => v.bytesInOutput > 0)
  return {
    code,
    modules: normalise(contributions.map(([k]) => k)),
    bytes: Object.fromEntries(contributions.map(([k, v]) => [posix(k), v.bytesInOutput])),
  }
}

/**
 * The second opinion. rollup cannot read TypeScript, so the entry is transpiled by esbuild first
 * (types are erased, nothing else changes) and rollup does the resolution and the DCE.
 */
async function bundleWithRollup(tmp, name) {
  const src = readFileSync(join(tmp, name, 'entry.ts'), 'utf8')
  const js = await transform(src, { loader: 'ts', format: 'esm', target: 'node22' })
  const entryJs = join(tmp, name, 'entry.rollup.mjs')
  writeFileSync(entryJs, js.code)
  const bundle = await rollup({
    input: entryJs,
    plugins: [
      nodeResolve({ exportConditions: ['node', 'import', 'default'], preferBuiltins: true }),
    ],
    onwarn: () => {},
    treeshake: { moduleSideEffects: false },
  })
  const { output } = await bundle.generate({ format: 'esm' })
  await bundle.close()
  const code = output.map((c) => (c.type === 'chunk' ? c.code : '')).join('')
  // rollup reports absolute, realpath'd module ids; on macOS `os.tmpdir()` is `/var/folders/…` and
  // its realpath is `/private/var/folders/…`, so `tmp` has to be realpath'd before `relative()` or
  // every id normalises to a `../../..` walk and no id ever matches esbuild's.
  const realTmp = realpathSync(tmp)
  const modules = normalise(
    output
      .flatMap((c) => (c.type === 'chunk' ? Object.entries(c.modules) : []))
      // `renderedLength === 0` is rollup's way of saying "shaken out", the same distinction
      // esbuild draws with `bytesInOutput`.
      .filter(([, m]) => m.renderedLength > 0)
      .map(([id]) => relative(realTmp, id)),
  ).filter((m) => !m.endsWith('entry.rollup.mjs'))
  const min = await transform(code, { minify: true, format: 'esm', target: 'node22' })
  return { code: min.code, modules }
}

function diffSets(golden, actual) {
  const missing = golden.filter((m) => !actual.includes(m))
  const added = actual.filter((m) => !golden.includes(m))
  return { missing, added }
}

export async function run({ update = false, only = undefined } = {}) {
  const all = JSON.parse(readFileSync(join(HERE, 'budgets.json'), 'utf8'))
  const budgets = all.treeshake
  const over = all._overDesign
  const tmp = mkdtempSync(join(tmpdir(), 'pg-prime-treeshake-'))
  const results = []
  try {
    const names = caseNames().filter((n) => !only || n === only)
    stagePackages(tmp, names)
    for (const name of names) {
      cpSync(join(FIXTURES, name), join(tmp, name), { recursive: true })
      const spec = budgets[name]
      if (spec === undefined)
        throw new Error(`treeshake-check: no budget for fixture \`${name}\` in tools/budgets.json`)
      const goldenPath = join(FIXTURES, name, 'expected-modules.json')
      const golden = existsSync(goldenPath)
        ? JSON.parse(readFileSync(goldenPath, 'utf8')).modules
        : undefined
      let es
      try {
        es = await bundleWithEsbuild(tmp, name)
      } catch (e) {
        if (golden !== null) throw e
        results.push({ name, pending: true })
        continue
      }
      const ro = await bundleWithRollup(tmp, name)
      const delta = typeof spec === 'object'
      const budget = delta ? spec.delta : spec
      if (update) {
        writeFileSync(
          goldenPath,
          JSON.stringify(
            {
              _why:
                'design/08 §2.4 step 3 — the exact set of input modules esbuild pulled into this fixture, ' +
                'bundled through the published export map. A diff here on a PR is the signal; `node ' +
                'tools/treeshake-check.mjs --update` re-records it and the diff goes in the review.',
              _bundler: 'esbuild --bundle --format=esm --minify --platform=node --metafile',
              modules: es.modules,
            },
            null,
            2,
          ) + '\n',
        )
      }
      const recorded = update ? es.modules : (golden ?? null)
      const gzEs = delta
        ? gz((await bundleWithEsbuild(tmp, name, ['pg-prime', 'pg-prime/*'])).code)
        : gz(es.code)
      const gzRo = gz(ro.code)
      const sizeOk = gzEs <= budget
      const setDiff = recorded ? diffSets(recorded, es.modules) : { missing: [], added: [] }
      const setOk = recorded !== null && setDiff.missing.length === 0 && setDiff.added.length === 0
      // The entry itself is `entry.ts` for esbuild and the transpiled `entry.rollup.mjs` for
      // rollup, so it is dropped from BOTH sides of the second-opinion comparison — it is the same
      // file twice, not a disagreement.
      const notEntry = (m) => !m.startsWith(`${name}/entry.`)
      const bundlersAgree = diffSets(es.modules.filter(notEntry), ro.modules.filter(notEntry))
      results.push({
        name,
        delta,
        gzEs,
        gzRo,
        budget,
        sizeOk,
        setOk,
        setDiff,
        golden: recorded,
        modules: es.modules,
        bytes: es.bytes,
        bundlersAgree,
      })
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  console.log(
    `  ${'fixture'.padEnd(22)} ${'design'.padStart(9)} ${'esbuild'.padStart(9)} ${'budget'.padStart(9)}  ${'rollup'.padStart(9)}  modules`,
  )
  for (const r of results) {
    if (r.pending) {
      console.log(`  ${r.name.padEnd(22)} pending (the entry does not bundle yet: a seeded slot)`)
      continue
    }
    const design = budgets._design?.[r.name]
    console.log(
      `  ${r.name.padEnd(22)} ${String(design ?? '—').padStart(9)} ${String(r.gzEs).padStart(9)} ${String(r.budget).padStart(9)}  ` +
        `${String(r.gzRo).padStart(9)}  ${String(r.modules.length).padStart(3)}  ${r.sizeOk ? 'ok' : 'FAIL'} ${r.setOk ? 'golden ok' : 'GOLDEN DRIFT'}${r.delta ? '  (delta over pg-prime)' : ''}`,
    )
  }
  console.log(`  (bytes, min+gz. design = design/08 §1.2; ${budgets._baselined})`)

  const failed = []
  for (const r of results) {
    if (r.pending) continue
    // Same rule as size-budget.mjs and bench/runtime: a budget looser than its design number must
    // be named in `_overDesign` with a reason, or the tool fails even though the measurement passes.
    const design = budgets._design?.[r.name]
    if (design !== undefined && r.budget > design && !over[`treeshake.${r.name}`]) {
      failed.push(
        `${r.name}: budget ${r.budget} B is looser than design's ${design} B and is not named in budgets.json._overDesign`,
      )
    }
    if (!r.sizeOk) {
      failed.push(`${r.name}: ${r.gzEs} B min+gz${r.delta ? ' delta' : ''} > budget ${r.budget} B`)
      console.error(`  top 10 contributors to \`${r.name}\` (pre-gzip bytes in the bundle):`)
      for (const [m, n] of Object.entries(r.bytes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)) {
        console.error(`    ${String(n).padStart(7)}  ${m}`)
      }
    }
    if (r.golden === null)
      failed.push(
        `${r.name}: no expected-modules.json — run \`node tools/treeshake-check.mjs --update\``,
      )
    else if (!r.setOk) {
      failed.push(`${r.name}: the included module set changed`)
      for (const m of r.setDiff.added) console.error(`    + ${m}`)
      for (const m of r.setDiff.missing) console.error(`    - ${m}`)
    }
    if (r.bundlersAgree.added.length || r.bundlersAgree.missing.length) {
      console.log(
        `  note ${r.name}: rollup and esbuild disagree on ${r.bundlersAgree.added.length + r.bundlersAgree.missing.length} module(s)`,
      )
      for (const m of r.bundlersAgree.added) console.log(`    rollup only: ${m}`)
      for (const m of r.bundlersAgree.missing) console.log(`    esbuild only: ${m}`)
    }
  }
  return { results, failed }
}

if (process.argv[1] && process.argv[1].endsWith('treeshake-check.mjs')) {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--case')
  const { failed } = await run({
    update: argv.includes('--update'),
    only: i === -1 ? undefined : argv[i + 1],
  })
  console.log('')
  for (const f of failed) console.error(`FAIL ${f}`)
  if (failed.length) process.exit(1)
  console.log('tree-shake gates ok')
}
