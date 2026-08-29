// design/08 §6.4 and design/12 §4 D, rule R20: **every fenced `ts`/`tsx` block in the docs site
// compiles**, on TypeScript 5.9.3 — the consumer floor, not the compiler that builds the packages —
// against the BUILT `pg-prime` / `@pg-prime/kit` in `packages/*/dist`, under `strict` and
// `exactOptionalPropertyTypes`.
//
//   node tools/docs-typecheck.mjs           # the gate
//   node tools/docs-typecheck.mjs --keep    # leave docs/.gen/typecheck for inspection
//
// Resolution is deliberately boring: the composed blocks are written under `docs/.gen/typecheck/`,
// so Node's own algorithm walks up to `docs/node_modules`, where pnpm has already linked
// `pg-prime` → `packages/pg-prime` and `@pg-prime/kit` → `packages/pg-prime-kit`. Those packages'
// `exports` maps point at `dist`, so a block that compiles here compiles for a consumer, and a
// block that names something the build does not emit fails here first. No `paths` map, no tarball
// install, nothing to keep in sync with the packages' own export conditions.
//
// Three block shapes exist, all documented in `docs/README.md`:
//
//   (plain)         compiled as a module, exactly as written on the page.
//   signature       compiled inside `declare namespace`, with the page's `apiEntry` types in
//                   scope — this is how a reference page's bodiless signature is a checked thing
//                   rather than a picture of one.
//   expect-error    compiled as a module that MUST produce at least one error; a block that starts
//                   compiling is a failure, because the page claims the code is refused.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { DOCS, ROOT, compose, pageSetupsOf, readAllPages, readSnippets } from './docs-blocks.mjs'

const require = createRequire(import.meta.url)
const KEEP = process.argv.includes('--keep')
// One directory per process: the gates are run in parallel by more than one person and by CI.
const GEN = join(DOCS, '.gen', `typecheck-${process.pid}`)

/** `typescript59` is the repo's alias for the consumer floor (root `package.json`). */
const TSC = require.resolve('typescript59/bin/tsc')
const TS_VERSION = JSON.parse(
  readFileSync(require.resolve('typescript59/package.json'), 'utf8'),
).version

/**
 * Every exported name per entry point, from the committed api-snapshot goldens.
 *
 * Values as well as types: a reference signature often says `uuid: typeof uuid`, and `import type`
 * can import a *value* name for exactly that use. What a signature block cannot do is call one.
 */
function typeNamesByEntry() {
  const out = new Map()
  for (const file of ['pg-prime.json', 'pg-prime-kit.json', 'pg-prime-create.json']) {
    const golden = JSON.parse(readFileSync(join(ROOT, 'tools', 'api-snapshot', file), 'utf8'))
    for (const [subpath, entry] of Object.entries(golden.entries)) {
      const spec = subpath === '.' ? golden.package : `${golden.package}/${subpath.slice(2)}`
      out.set(`${golden.package}#${subpath}`, {
        spec,
        types: [...new Set([...entry.types, ...entry.values])].sort(),
      })
    }
  }
  return out
}

function main() {
  const pages = readAllPages()
  const snippets = readSnippets()
  const entries = typeNamesByEntry()

  rmSync(GEN, { recursive: true, force: true })
  mkdirSync(join(GEN, 'blocks'), { recursive: true })

  const units = []
  const skipped = []
  const usedSnippets = new Set()
  let n = 0

  for (const page of pages) {
    const setups = pageSetupsOf(page)
    const apiEntries = [page.frontmatter.apiEntry ?? []].flat().filter(Boolean)
    for (const block of page.blocks) {
      if (!['ts', 'tsx'].includes(block.lang)) continue
      if (block.attrs['skip-check']) {
        if (typeof block.attrs['skip-check'] !== 'string') {
          fail(`${block.page}:${block.line}: skip-check needs a reason (skip-check="…")`)
        }
        skipped.push({ block, reason: block.attrs['skip-check'] })
        continue
      }
      const composed = compose(block, snippets, setups)
      for (const name of composed.used) usedSnippets.add(name)
      const id = String(n++).padStart(4, '0')
      const dir = `blocks/${id}`
      const name = `${dir}/index.${block.lang}`
      mkdirSync(join(GEN, dir), { recursive: true })
      for (const file of composed.files) {
        writeFileSync(join(GEN, dir, file.name), file.text + '\n')
        units.push({
          id: `${id}:${file.name}`,
          name: `${dir}/${file.name}`,
          block,
          map: file.map,
          offset: 0,
          expectError: false,
          sibling: true,
        })
      }
      const { text, offset } = wrap(block, composed, apiEntries, entries)
      writeFileSync(join(GEN, name), text)
      units.push({
        id,
        name,
        block,
        map: composed.map,
        offset,
        expectError: !!block.attrs['expect-error'],
      })
    }
  }

  writeFileSync(
    join(GEN, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          // design/12 §4 D: the consumer floor's settings, not ours. `strict` +
          // `exactOptionalPropertyTypes` are the two the brief names; the rest is what a modern
          // ESM consumer of an ESM-only package has.
          target: 'ES2023',
          lib: ['ES2023'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          // The declaration files themselves are `tools/check-dts.mjs`'s gate, on this same 5.9.3
          // and on TS 7. Re-checking them here would report the same error once per block.
          skipLibCheck: true,
          types: ['node'],
          allowJs: false,
          verbatimModuleSyntax: false,
        },
        // Only the composed blocks. A snippet is never compiled on its own — several are
        // fragments that need the `db` their caller's prelude built — so an unused one would be
        // dead code nobody checks. The unused-snippet check below is what covers that instead.
        include: ['blocks/**/*.ts', 'blocks/**/*.tsx'],
      },
      null,
      2,
    ),
  )

  const started = Date.now()
  const res = spawnSync(
    process.execPath,
    [TSC, '-p', join(GEN, 'tsconfig.json'), '--pretty', 'false'],
    {
      cwd: GEN,
      encoding: 'utf8',
    },
  )
  const ms = Date.now() - started
  const diagnostics = parse(res.stdout + res.stderr, units)

  const failures = []
  const byUnit = new Map()
  for (const d of diagnostics) {
    if (!d.unit) {
      failures.push({ where: d.raw, message: '' })
      continue
    }
    const list = byUnit.get(d.unit.id) ?? []
    list.push(d)
    byUnit.set(d.unit.id, list)
  }

  for (const unit of units) {
    const got = byUnit.get(unit.id) ?? []
    if (unit.expectError && got.length === 0) {
      failures.push({
        where: `${unit.block.page}:${unit.block.line}`,
        message:
          'expect-error block compiled clean — the page says this code is refused, and it is not',
      })
    }
    if (!unit.expectError) {
      for (const d of got) failures.push({ where: d.where, message: d.message })
    }
  }

  for (const name of snippets.keys()) {
    if (!usedSnippets.has(name)) {
      failures.push({
        where: `docs/src/snippets/${name}.ts`,
        message: 'no block uses this snippet, so nothing compiles it — delete it or use= it',
      })
    }
  }

  const real = units.filter((u) => !u.sibling)
  const total = real.length
  const executed = real.filter((u) => typeof u.block.attrs.title === 'string').length
  console.log(
    `docs-typecheck: ${total} blocks from ${pages.length} pages on TypeScript ${TS_VERSION} ` +
      `(${real.filter((u) => u.block.attrs.signature).length} signature, ${real.filter((u) => u.expectError).length} expect-error, ` +
      `${executed} runnable) in ${(ms / 1000).toFixed(1)} s`,
  )
  for (const s of skipped) console.log(`  skip-check ${s.block.page}:${s.block.line} — ${s.reason}`)

  // A `setup=` file is emitted beside every block that uses it, so one broken setup would be
  // reported once per user; the page cares about the page.
  const unique = [...new Map(failures.map((f) => [`${f.where}${f.message}`, f])).values()]

  if (unique.length > 0) {
    console.error(`\ndocs-typecheck: ${unique.length} failure(s)\n`)
    for (const f of unique) console.error(`  ${f.where}${f.message ? `: ${f.message}` : ''}`)
    console.error(`\n  (re-run with --keep to inspect the composed blocks in ${GEN})`)
    if (!KEEP) rmSync(GEN, { recursive: true, force: true })
    process.exit(1)
  }

  if (!KEEP) rmSync(GEN, { recursive: true, force: true })
  console.log('docs-typecheck: OK')
}

/**
 * The composed text, wrapped for its block shape, plus how many lines the wrapper added on top
 * (`offset`) so a diagnostic's line still points at the page.
 */
function wrap(block, composed, apiEntries, entries) {
  if (!block.attrs.signature) return { text: composed.text + '\n', offset: 0 }

  const seen = new Set()
  const imports = []
  for (const key of apiEntries) {
    const entry = entries.get(key)
    if (!entry)
      fail(`${block.page}: apiEntry ${key} is not an entry point in the api-snapshot goldens`)
    const names = entry.types.filter((t) => !seen.has(t))
    for (const t of names) seen.add(t)
    if (names.length > 0) imports.push(`import type { ${names.join(', ')} } from '${entry.spec}'`)
  }
  if (imports.length === 0) {
    fail(
      `${block.page}:${block.line}: a signature block needs the page to declare apiEntry in its frontmatter`,
    )
  }
  const head = [...imports, `declare namespace __sig {`].join('\n')
  return { text: `${head}\n${composed.text}\n}\n`, offset: head.split('\n').length }
}

/** `blocks/0007.ts(12,5): error TS2339: …` → the page and line it came from. */
function parse(output, units) {
  const byName = new Map(units.map((u) => [u.name.replaceAll('\\', '/'), u]))
  const out = []
  for (const line of output.split('\n')) {
    const m = /^(.*?)\((\d+),(\d+)\): (error|warning) (TS\d+: .*)$/.exec(line.trim())
    if (!m) {
      if (line.trim().startsWith('error TS')) out.push({ raw: line.trim() })
      continue
    }
    const file = m[1].replaceAll('\\', '/')
    const unit = byName.get(file)
    if (!unit) {
      // A snippet compiled on its own, or something outside the composed blocks.
      out.push({ raw: `${relative(ROOT, join(GEN, file))}(${m[2]},${m[3]}): ${m[5]}` })
      continue
    }
    const idx = Number(m[2]) - 1 - unit.offset
    const origin = unit.map[idx]
    const where = origin
      ? `${relative(ROOT, origin.file)}:${origin.line}:${m[3]}${origin.snippet ? ` (via snippet ${origin.snippet}, used by ${unit.block.page}:${unit.block.line})` : ''}`
      : `${unit.block.page}:${unit.block.line} (wrapper line ${m[2]})`
    out.push({ unit, where, message: m[5] })
  }
  return out
}

function fail(message) {
  console.error(`docs-typecheck: ${message}`)
  process.exit(1)
}

main()
