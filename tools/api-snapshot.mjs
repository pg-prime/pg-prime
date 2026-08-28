// The public-surface golden (design/08 §2.3) and the generator for the `types@<5.9` stubs (§2.2).
//
//   node tools/api-snapshot.mjs            # rewrite the goldens and the stubs
//   node tools/api-snapshot.mjs --check    # fail on any drift (this is the CI gate)
//
// ─── What it records ─────────────────────────────────────────────────────────
//
// For every entry of every package's `exports` map (`./package.json` excepted) it records two
// sorted lists:
//
//   values  the RUNTIME export names — read by importing the built `dist` entry and taking
//           `Object.keys()`. Not parsed, not inferred: what Node actually gives a consumer.
//   types   the TYPE export names — read out of the entry's `.d.ts` with the real TypeScript
//           compiler API (`typescript59`, the consumer floor, TS 5.9.3), via
//           `checker.getExportsOfModule()` with aliases resolved. No regex: a re-export chain
//           (`export { X } from './y.js'` → `export { X } from './z.js'`) is exactly the case a
//           regex over the entry file gets wrong, and every barrel in this repo is one.
//
// The two are cross-checked against each other: the checker's value-flagged symbols must equal the
// runtime keys, or one of the two readings is wrong and the tool says which names disagree.
//
// ─── The invariants it asserts, beyond "nothing changed" ─────────────────────
//
//   1. Every subpath's names are a SUBSET of the root's. `pg-prime/driver` must never be able to
//      say something `pg-prime` does not — that is why `src/entry/driver.ts` exists instead of a
//      map straight at the internal `src/driver/index.ts` barrel (which exports two `@internal`
//      names that `test/query/index.test.ts` asserts are absent from the public surface).
//   2. `dist/unsupported-typescript.d.ts` — the stub every `types@<5.9` condition points at —
//      declares EXACTLY the root entry's value and type names. A stub that has drifted from the
//      surface it gates turns "your TypeScript is too old" into "this package is broken", which is
//      the failure §2.2 exists to prevent. The stub is generated from these lists, so it cannot
//      drift silently; `--check` re-generates in memory and diffs.
//
// design/08 §2.3 also names an `oxlint` `no-default-export` rule. There is no oxlint in the repo
// yet, so this tool carries that half too: a `default` key in any entry's value list is an error.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const GOLDEN_DIR = join(HERE, 'api-snapshot')
const require = createRequire(import.meta.url)
/** The consumer floor's own compiler API. TS 7 does not ship one (design/08 F1). */
const ts = require('typescript59')

/** The brand text design §2.2 settles on, after the refinement note under the verified output. */
const errorText = (pkgName) => `${pkgName} requires TypeScript >= 5.9 — see https://pg-prime.dev/ts`

export const PACKAGES = [
  { dir: 'packages/pg-prime', name: 'pg-prime', golden: 'pg-prime.json' },
  { dir: 'packages/pg-prime-kit', name: '@pg-prime/kit', golden: 'pg-prime-kit.json' },
]

/** The entries of an `exports` map that carry code, in map order. `./package.json` is not one. */
export function entriesOf(pkgJson) {
  return Object.entries(pkgJson.exports)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([subpath, cond]) => ({ subpath, types: cond.types, js: cond.default, stub: cond['types@<5.9'] }))
}

/**
 * The exported symbols of one `.d.ts`, split into values and types.
 *
 * `arity` is the declared type-parameter count, kept because the stub needs it: a stub that
 * declares `type Loaded = …` where the real one is `Loaded<S, T>` turns every use into
 * "Type 'Loaded' is not generic", which is a worse message than the one we are trying to deliver.
 */
export function readDts(entryDts) {
  const program = ts.createProgram([entryDts], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  })
  const source = program.getSourceFile(entryDts)
  if (!source) throw new Error(`api-snapshot: could not load ${entryDts}`)
  const checker = program.getTypeChecker()
  const moduleSymbol = checker.getSymbolAtLocation(source)
  if (!moduleSymbol) throw new Error(`api-snapshot: ${entryDts} is not a module`)

  // `export type * from './x.js'` (the kit's index does this for `catalog/payloads.js`) puts every
  // name of the target module into the entry's export list with NO marker on the resulting symbol:
  // it is not an alias, `getTypeOnlyAliasDeclaration` returns undefined, and a `const` re-exported
  // that way still carries `SymbolFlags.Value` even though nothing is exported at run time. So the
  // export declarations are read directly. (One level, on the entry file itself — a type-only star
  // nested inside another barrel would slip through, and the runtime cross-check below is what
  // would catch it, loudly.)
  const typeOnly = new Set()
  for (const st of source.statements) {
    if (!ts.isExportDeclaration(st)) continue
    if (st.exportClause && ts.isNamedExports(st.exportClause)) {
      // `export type { A }` and the per-specifier `export { type A, b }` both count.
      for (const spec of st.exportClause.elements) {
        if (st.isTypeOnly || spec.isTypeOnly) typeOnly.add(spec.name.text)
      }
    } else if (st.isTypeOnly && st.moduleSpecifier) {
      const target = checker.getSymbolAtLocation(st.moduleSpecifier)
      if (target) for (const s of checker.getExportsOfModule(target)) typeOnly.add(s.getName())
    }
  }

  const values = []
  const types = []
  const arity = {}
  for (const raw of checker.getExportsOfModule(moduleSymbol)) {
    const sym = raw.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(raw) : raw
    const name = raw.getName()
    if (sym.flags & ts.SymbolFlags.Value && !typeOnly.has(name)) values.push(name)
    if (sym.flags & ts.SymbolFlags.Type) {
      types.push(name)
      let n = 0
      for (const d of sym.getDeclarations() ?? []) n = Math.max(n, d.typeParameters?.length ?? 0)
      arity[name] = n
    }
  }
  return { values: values.sort(), types: types.sort(), arity }
}

/** What Node hands a consumer: the built entry's own runtime keys. */
export async function readRuntime(entryJs) {
  const mod = await import(pathToFileURL(entryJs).href)
  return Object.keys(mod).sort()
}

export async function snapshot(pkg) {
  const pkgDir = join(ROOT, pkg.dir)
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const entries = {}
  const problems = []
  for (const e of entriesOf(pkgJson)) {
    const dts = join(pkgDir, e.types)
    const js = join(pkgDir, e.js)
    if (!existsSync(dts) || !existsSync(js)) {
      throw new Error(`api-snapshot: ${pkg.name}${e.subpath} points at ${e.types} / ${e.js}, which do not exist — run \`pnpm build\` first`)
    }
    const declared = readDts(dts)
    const runtime = await readRuntime(js)
    const onlyDeclared = declared.values.filter((n) => !runtime.includes(n))
    const onlyRuntime = runtime.filter((n) => !declared.values.includes(n))
    if (onlyDeclared.length || onlyRuntime.length) {
      problems.push(
        `${pkg.name}${e.subpath}: .d.ts and .js disagree on the runtime names — ` +
          `only in .d.ts: [${onlyDeclared}], only in .js: [${onlyRuntime}]`,
      )
    }
    if (runtime.includes('default')) problems.push(`${pkg.name}${e.subpath}: has a default export (design/08 §2.3 forbids it)`)
    entries[e.subpath] = { values: runtime, types: declared.types }
    entries[e.subpath]._arity = declared.arity
  }

  // Invariant 1 — every subpath is a subset of the root.
  const root = entries['.']
  for (const [subpath, rec] of Object.entries(entries)) {
    if (subpath === '.') continue
    const extraV = rec.values.filter((n) => !root.values.includes(n))
    const extraT = rec.types.filter((n) => !root.types.includes(n))
    if (extraV.length || extraT.length) {
      problems.push(
        `${pkg.name}${subpath}: exports names the root entry does not — values [${extraV}], types [${extraT}]. ` +
          `A subpath must be a slice of the root, never a superset (design/08 §2.1 + tools/api-snapshot.mjs invariant 1).`,
      )
    }
  }
  return { entries, problems }
}

/** The `types@<5.9` stub of design §2.2, rendered from the root entry's own name lists. */
export function renderStub(pkgName, root) {
  const brand = 'Unsupported'
  const lines = [
    `// GENERATED by tools/api-snapshot.mjs — do not edit by hand.`,
    `//`,
    `// The \`types@<5.9\` gate of design/08 §2.2, first in every condition object of every subpath in`,
    `// package.json. A consumer on TypeScript < 5.9 resolves \`${pkgName}\` to THIS file instead of the`,
    `// real declarations, so every name still exists and every USE of one lands the message in the`,
    `// error text. Verified against TypeScript 5.8.3 by tools/pack-smoke.mjs on every run:`,
    `//`,
    `//   consumer.ts(12,15): error TS2349: This expression is not callable.`,
    `//     Type '{ ERROR: "${errorText(pkgName)}"; }' has no call signatures.`,
    `//`,
    `// Naming the key \`ERROR\` rather than a \`__dunder__\` is §2.2's own refinement over Kysely's`,
    `// version: it reads first in a truncated hover.`,
    `//`,
    `// ## \`${brand}<M = …> = M\` is an identity alias ON PURPOSE — do not "simplify" it`,
    `//`,
    `// Written the obvious way, \`type ${brand} = { ERROR: '…' }\`, TypeScript prints the ALIAS NAME`,
    `// in the diagnostic — "Type '${brand}' has no call signatures" — and the message never`,
    `// reaches the user, which defeats the entire file. A generic alias whose body is just its own`,
    `// parameter has no alias symbol to print, so the checker falls back to the structural form and`,
    `// the sentence appears. Measured, both shapes, on 5.9.3 and 5.8.3.`,
    `//`,
    `// The lists are the root entry's value and type exports, taken from tools/api-snapshot/*.json.`,
    `// \`node tools/api-snapshot.mjs --check\` fails if this file and that golden disagree, which is`,
    `// what stops the stub from silently rotting into "this package has no exported member 'x'".`,
    `// The type parameters are optional and are only as many as the real declaration has, so that a`,
    `// generic use resolves to the brand instead of erroring with "is not generic".`,
    ``,
    `type ${brand}<Message = { ERROR: '${errorText(pkgName)}' }> = Message`,
    ``,
  ]
  for (const name of root.values) lines.push(`export declare const ${name}: ${brand}`)
  lines.push('')
  for (const name of root.types) {
    const n = root._arity[name] ?? 0
    const params = n === 0 ? '' : `<${Array.from({ length: n }, (_, i) => `T${i} = any`).join(', ')}>`
    lines.push(`export type ${name}${params} = ${brand}`)
  }
  lines.push('')
  return lines.join('\n')
}

function stubPathOf(pkg) {
  return join(ROOT, pkg.dir, 'src', 'unsupported-typescript.d.ts')
}

function goldenBody(pkgName, entries) {
  return {
    _source:
      'design/08 §2.3 — the committed public-surface golden. `node tools/api-snapshot.mjs` rewrites it; ' +
      '`--check` is the gate. `values` is Object.keys() of the built entry; `types` is the entry .d.ts read ' +
      'through the TypeScript 5.9.3 compiler API. `_arity` is each type\'s declared type-parameter count and ' +
      'exists only so the types@<5.9 stub can mirror it.',
    package: pkgName,
    entries,
  }
}

const stable = (v) => JSON.stringify(v, null, 2) + '\n'

function diffLists(label, a, b) {
  const missing = a.filter((x) => !b.includes(x))
  const added = b.filter((x) => !a.includes(x))
  const out = []
  if (missing.length) out.push(`    ${label}: removed ${missing.map((x) => `\`${x}\``).join(', ')}`)
  if (added.length) out.push(`    ${label}: added ${added.map((x) => `\`${x}\``).join(', ')}`)
  return out
}

if (process.argv[1] && process.argv[1].endsWith('api-snapshot.mjs')) {
  const check = process.argv.includes('--check')
  mkdirSync(GOLDEN_DIR, { recursive: true })
  let drift = 0
  let problems = 0

  for (const pkg of PACKAGES) {
    const { entries, problems: probs } = await snapshot(pkg)
    for (const p of probs) {
      console.error(`  FAIL ${p}`)
      problems++
    }
    const goldenPath = join(GOLDEN_DIR, pkg.golden)
    const next = stable(goldenBody(pkg.name, entries))
    const prev = existsSync(goldenPath) ? readFileSync(goldenPath, 'utf8') : null

    const counts = Object.entries(entries)
      .map(([k, v]) => `${k} ${v.values.length}v/${v.types.length}t`)
      .join('  ')
    console.log(`${pkg.name.padEnd(16)} ${counts}`)

    if (check) {
      if (prev !== next) {
        drift++
        console.error(`  DRIFT ${pkg.golden}`)
        if (prev) {
          const before = JSON.parse(prev).entries
          for (const [subpath, rec] of Object.entries(entries)) {
            const was = before[subpath]
            if (!was) {
              console.error(`    entry \`${subpath}\`: added`)
              continue
            }
            for (const line of diffLists(`${subpath} values`, was.values, rec.values)) console.error(line)
            for (const line of diffLists(`${subpath} types`, was.types, rec.types)) console.error(line)
          }
          for (const subpath of Object.keys(before)) {
            if (!entries[subpath]) console.error(`    entry \`${subpath}\`: removed`)
          }
        }
      }
    } else {
      writeFileSync(goldenPath, next)
    }

    // Invariant 2 — the stub mirrors the root entry exactly.
    const stubPath = stubPathOf(pkg)
    const stub = renderStub(pkg.name, entries['.'])
    if (check) {
      const onDisk = existsSync(stubPath) ? readFileSync(stubPath, 'utf8') : null
      if (onDisk !== stub) {
        drift++
        console.error(`  DRIFT ${pkg.dir}/src/unsupported-typescript.d.ts (the types@<5.9 stub no longer mirrors the root entry)`)
      }
    } else {
      writeFileSync(stubPath, stub)
    }
  }

  if (problems) {
    console.error(`\n${problems} invariant failure(s)`)
    process.exit(1)
  }
  if (check && drift) {
    console.error(`\n${drift} file(s) drifted — run \`pnpm api-snapshot\` and review the diff (design/08 §2.3)`)
    process.exit(1)
  }
  console.log(check ? '\nno drift' : `\nrecorded → ${GOLDEN_DIR} and the two types@<5.9 stubs`)
}
