// The publish build for one workspace package (design/08 §3.1: unbundled ESM, 1:1 source→output,
// `tsc` only, no bundler).
//
//   node tools/build-package.mjs [--clean] [--out DIR] [--tsc PATH] [--quiet] [pkgDir]
//
// `pkgDir` defaults to the cwd, which is what `pnpm --filter … build` gives us. Two things happen
// that `tsc -p tsconfig.build.json` alone does not do:
//
//   1. `dist/` is removed first. An incremental emit that keeps a file whose source was deleted is
//      a file that ships, and `files: ["dist"]` would ship it.
//   2. Hand-written `.d.ts` inputs under `src/` are COPIED into `dist/`. tsc treats a `.d.ts` as an
//      input and never emits it, so `src/unsupported-typescript.d.ts` — the `types@<5.9` gate of
//      design §2.2, which the export map points every subpath at — would otherwise be missing from
//      the tarball and every subpath would resolve to nothing on an old TypeScript.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** tsgo, `typescript@7.0.2` — the build compiler (design/08 §3.1, F1). */
export const TSC_7 = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
/** `typescript59` = `npm:typescript@5.9.3` — the consumer floor, used by `emit-parity.mjs`. */
export const TSC_59 = join(ROOT, 'node_modules', 'typescript59', 'bin', 'tsc')

/** Every `.d.ts` under `dir`, as paths relative to it. */
export function handWrittenDts(dir) {
  const out = []
  const walk = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) walk(join(abs, e.name), rel ? `${rel}/${e.name}` : e.name)
      else if (e.name.endsWith('.d.ts')) out.push(rel ? `${rel}/${e.name}` : e.name)
    }
  }
  walk(dir, '')
  return out
}

/** Every file under `dir`, relative, sorted — the shape the size budget and the diff both want. */
export function listFiles(dir) {
  const out = []
  const walk = (abs) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = join(abs, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(relative(dir, p).split(sep).join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

export function buildPackage(pkgDir, { out = join(pkgDir, 'dist'), tsc = TSC_7, quiet = false } = {}) {
  rmSync(out, { recursive: true, force: true })
  const args = [tsc, '-p', join(pkgDir, 'tsconfig.build.json'), '--pretty', 'false']
  if (out !== join(pkgDir, 'dist')) args.push('--outDir', out)
  const started = Date.now()
  execFileSync(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'], encoding: 'utf8' })

  const copied = []
  for (const rel of handWrittenDts(join(pkgDir, 'src'))) {
    const dest = join(out, ...rel.split('/'))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(pkgDir, 'src', ...rel.split('/')), dest)
    copied.push(rel)
  }

  const files = listFiles(out)
  const bytes = files.reduce((n, f) => n + statSync(join(out, f)).size, 0)
  if (!quiet) {
    const ms = Date.now() - started
    console.log(
      `${relative(ROOT, pkgDir).split(sep).join('/')} → ${relative(ROOT, out).split(sep).join('/')}  ` +
        `${files.length} files, ${(bytes / 1024).toFixed(1)} KB, ${ms} ms` +
        (copied.length ? `  (+${copied.length} hand-written .d.ts copied: ${copied.join(', ')})` : ''),
    )
  }
  return { out, files, bytes, copied }
}

if (process.argv[1] && process.argv[1].endsWith('build-package.mjs')) {
  const argv = process.argv.slice(2)
  const flag = (name) => {
    const i = argv.indexOf(name)
    return i === -1 ? undefined : argv[i + 1]
  }
  const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))
  const pkgDir = resolve(positional[0] ?? process.cwd())
  if (argv.includes('--clean')) {
    rmSync(join(pkgDir, 'dist'), { recursive: true, force: true })
    console.log(`cleaned ${relative(ROOT, join(pkgDir, 'dist')).split(sep).join('/')}`)
  } else {
    const opts = { quiet: argv.includes('--quiet') }
    const out = flag('--out')
    if (out) opts.out = resolve(out)
    const tsc = flag('--tsc')
    if (tsc) opts.tsc = resolve(tsc)
    buildPackage(pkgDir, opts)
  }
}
