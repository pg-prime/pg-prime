// `check:dts` (design/08 §3.2): type-check the EMITTED declarations with `skipLibCheck: false`,
// under every supported TypeScript.
//
//   node tools/check-dts.mjs [--keep]
//
// The normal build runs with `skipLibCheck: true` because it is faster and because the sources are
// checked anyway. That leaves one gap, and it is the gap that reaches users: a `.d.ts` the compiler
// happily EMITS but no compiler ever READS. A declaration that references a type it cannot resolve,
// or that needs a `lib` we do not require, or that TypeScript 5.9 parses differently from 7.0, is
// invisible until someone installs the package.
//
// So: a generated tsconfig per package per compiler that `include`s `dist/**/*.d.ts` with
// `noEmit` + `skipLibCheck: false`, compiled by TS 5.9.3 (the consumer floor, §2.2) and TS 7.0.2
// (the build compiler). The tsconfig is written into os.tmpdir() with an absolute `include`, so
// nothing lands in the repo and nothing is left behind.
//
// It also asserts the thing `pg-prime`'s zero-dependency promise rests on: the emitted `.d.ts`
// tree of `pg-prime` may not name a single non-relative module. `size-budget.mjs` checks that
// `dependencies` is empty; this checks that the declarations do not need one anyway.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listFiles, TSC_59, TSC_7 } from './build-package.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const ts = createRequire(import.meta.url)('typescript59')

export const COMPILERS = { '5.9.3': TSC_59, '7.0.2': TSC_7 }

export const PACKAGES = [
  { dir: 'packages/pg-prime', zeroDeps: true },
  { dir: 'packages/pg-prime-kit', zeroDeps: false },
  // Zero dependencies, and the declarations say so. It is also the gate that shaped the API:
  // `types: []` below means `node:stream` does not resolve and `NodeJS.*` is not a namespace, so
  // `PromptIo` takes an `ask` function and two writers instead of streams, and `src/cli.ts` — the
  // one file that touches `node:readline/promises` — exports nothing.
  { dir: 'packages/pg-prime-create', zeroDeps: true },
]

/**
 * Every non-relative module specifier named by a package's emitted declarations.
 *
 * Parsed, not grepped. `src/driver/pg-like.ts` and `src/driver/types.ts` both carry a doc comment
 * that says, in prose, `import type { Pool } from 'pg'` — explaining why they do NOT do that — and
 * `src/query/delete.ts` documents a CTE spelled `... as (delete from ...)`. A regex reads all three
 * as dependencies and reports the seam that guarantees zero deps as a violation of it.
 */
export function externalSpecifiers(distDir) {
  const found = new Map()
  const add = (spec, file) => {
    if (!spec || spec.startsWith('.')) return
    if (!found.has(spec)) found.set(spec, [])
    found.get(spec).push(file)
  }
  for (const f of listFiles(distDir)) {
    if (!f.endsWith('.d.ts')) continue
    const text = readFileSync(join(distDir, f), 'utf8')
    const source = ts.createSourceFile(f, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS)
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        add(node.moduleSpecifier.text, f)
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        add(node.argument.literal.text, f)
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        add(node.moduleReference.expression.text, f)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return found
}

function tsconfigFor(pkgDir, tmp, name) {
  const path = join(tmp, `tsconfig.${name}.json`)
  writeFileSync(
    path,
    JSON.stringify(
      {
        // Not `extends: tsconfig.base.json`: the point is to read the declarations the way a
        // CONSUMER's compiler reads them, so this is a plain strict nodenext project.
        compilerOptions: {
          target: 'es2023',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: false,
          noEmit: true,
          types: [],
        },
        include: [join(pkgDir, 'dist', '**', '*.d.ts').split('\\').join('/')],
      },
      null,
      2,
    ),
  )
  return path
}

if (process.argv[1] && process.argv[1].endsWith('check-dts.mjs')) {
  const tmp = mkdtempSync(join(tmpdir(), 'pg-prime-check-dts-'))
  let bad = 0
  try {
    for (const pkg of PACKAGES) {
      const pkgDir = join(ROOT, pkg.dir)
      const dist = join(pkgDir, 'dist')
      const dtsCount = listFiles(dist).filter((f) => f.endsWith('.d.ts')).length
      const externals = externalSpecifiers(dist)
      const externalList = [...externals.keys()].sort()
      console.log(
        `${pkg.dir}: ${dtsCount} .d.ts, external specifiers: ${externalList.length ? externalList.join(', ') : '(none)'}`,
      )
      if (pkg.zeroDeps && externalList.length) {
        bad++
        for (const spec of externalList) {
          console.error(
            `  FAIL the emitted declarations name \`${spec}\` (in ${externals.get(spec).slice(0, 3).join(', ')}) — pg-prime ships zero dependencies`,
          )
        }
      }
      for (const [version, tsc] of Object.entries(COMPILERS)) {
        const cfg = tsconfigFor(pkgDir, tmp, `${pkg.dir.replace(/[\\/]/g, '_')}.${version}`)
        const started = Date.now()
        let out = ''
        let ok = true
        try {
          out = execFileSync(process.execPath, [tsc, '-p', cfg, '--pretty', 'false'], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: ROOT,
          })
        } catch (e) {
          out = `${e.stdout ?? ''}${e.stderr ?? ''}`
          ok = false
        }
        const errors = out.split('\n').filter((l) => /error TS\d+/.test(l))
        console.log(
          `  TypeScript ${version}: ${errors.length ? `${errors.length} error(s)` : 'clean'} (${Date.now() - started} ms, skipLibCheck: false)`,
        )
        for (const e of errors.slice(0, 20)) console.error(`    ${e}`)
        if (!ok || errors.length) bad++
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  if (bad) {
    console.error('\ncheck:dts FAILED')
    process.exit(1)
  }
  console.log('\ncheck:dts ok')
}
