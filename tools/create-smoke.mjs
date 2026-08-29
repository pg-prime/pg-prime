// "Does `npm create @pg-prime` work?" — the proof (design/13 decision 9, first half).
//
//   node tools/create-smoke.mjs [--keep]
//
// `tools/pack-smoke.mjs` proves the two library tarballs resolve for a consumer. This proves the
// SCAFFOLDER: that the bin survives `pnpm pack` → `npm install`, that what it writes is a project
// npm can install and TypeScript 5.9.3 can compile, and that the templates on the getting-started
// page are not merely byte-equal to the docs (tier 0 asserts that) but actually *build*.
//
//   1. `pnpm pack` `pg-prime`, `@pg-prime/kit`, `@pg-prime/create` — and `@pg-prime/testing` when
//      it has a `dist` (design/13 §5 lands it first; until then the scaffold is written with
//      `--no-testing` and this script says so).
//   2. `npm install` the create TARBALL into a throwaway project and run the bin npm linked, which
//      is the one thing no unit test can do: `create-pg-prime app --yes --no-install --no-git`.
//   3. Rewrite the scaffold's `pg-prime` / `@pg-prime/*` ranges to `file:` those tarballs, so the
//      compile is against the code in this checkout rather than whatever is on the registry.
//   4. `npm install`, then `tsc --noEmit` on typescript@5.9.3 — the consumer floor (design/08
//      §2.2), not the tsgo that builds the packages.
//
// Network: steps 2 and 4 install from the npm registry.
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BIN = join(ROOT, 'node_modules', '.bin')

/** The consumer floor. Pinned, not `^5.9`: "compiles on 5.9.3" is the claim the docs make. */
const TYPESCRIPT = 'typescript@5.9.3'

/** Packed always. `@pg-prime/testing` is appended when this checkout has built one. */
const PACKAGES = [
  { dir: 'packages/pg-prime', name: 'pg-prime' },
  { dir: 'packages/pg-prime-kit', name: '@pg-prime/kit' },
  { dir: 'packages/pg-prime-create', name: '@pg-prime/create' },
]

const TESTING = { dir: 'packages/pg-prime-testing', name: '@pg-prime/testing' }

/** Every file the scaffold must contain before anything is installed. */
const EXPECTED = [
  '.env.example',
  '.gitignore',
  'README.md',
  'db.ts',
  'index.ts',
  'migrations/.gitkeep',
  'package.json',
  'pg-prime.config.ts',
  'schema.ts',
  'tsconfig.json',
]

const sh = (cmd, args, cwd, env) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })

function tryRun(cmd, args, cwd, env) {
  try {
    return { ok: true, out: sh(cmd, args, cwd, env) }
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/** `pnpm pack` each package into `dest`, and map its name to the tarball. */
export function packInto(dest, packages) {
  const tarballs = new Map()
  for (const pkg of packages) {
    const dir = join(ROOT, pkg.dir)
    if (!existsSync(join(dir, 'dist'))) {
      throw new Error(`create-smoke: ${pkg.dir}/dist is missing — run \`pnpm build\` first`)
    }
    const before = new Set(readdirSync(dest))
    sh('pnpm', ['pack', '--pack-destination', dest], dir)
    const added = readdirSync(dest).filter((f) => f.endsWith('.tgz') && !before.has(f))
    if (added.length !== 1) {
      throw new Error(`create-smoke: \`pnpm pack\` in ${pkg.dir} produced ${added.length} tarballs`)
    }
    tarballs.set(pkg.name, join(dest, added[0]))
  }
  return tarballs
}

/** Point every workspace range at the tarball we just built. Returns the names rewritten. */
export function useTarballs(pkgJsonPath, tarballs) {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  const rewritten = []
  for (const field of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      const tarball = tarballs.get(name)
      if (!tarball) continue
      pkg[field][name] = `file:${tarball}`
      rewritten.push(name)
    }
  }
  writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
  return rewritten.sort()
}

if (process.argv[1] && process.argv[1].endsWith('create-smoke.mjs')) {
  const keep = process.argv.includes('--keep')
  const tmp = mkdtempSync(join(tmpdir(), 'pg-prime-create-smoke-'))
  const failures = []
  try {
    const tars = join(tmp, 'tarballs')
    mkdirSync(tars)

    // design/13 §5's order is T then X: until `@pg-prime/testing` is on the branch with a build,
    // the scaffold's `--testing` half cannot be installed, and saying so is better than skipping
    // quietly.
    const testing = existsSync(join(ROOT, TESTING.dir, 'dist'))
    const tarballs = packInto(tars, testing ? [...PACKAGES, TESTING] : PACKAGES)
    console.log(`packed ${[...tarballs.keys()].join(', ')}`)
    if (!testing) {
      console.log(
        `NOTE @pg-prime/testing has no dist in this checkout — scaffolding with --no-testing ` +
          `(design/13 §5: T merges before X)`,
      )
    }

    // ── publint + attw, on the create tarball ────────────────────────────────
    // `tools/pack-smoke.mjs` does this for the two library packages and its list is not ours to
    // edit (design/13 §3 X), so the scaffolder is checked here: `dist/templates/package.json` is a
    // nested manifest inside a published tarball, which is exactly the shape a packaging linter
    // exists to have an opinion about.
    const createDir = join(ROOT, 'packages/pg-prime-create')
    const pl = tryRun(
      join(BIN, 'publint'),
      ['run', '--strict', tarballs.get('@pg-prime/create')],
      ROOT,
    )
    console.log(`publint --strict @pg-prime/create: ${pl.ok ? 'clean' : 'FAILED'}`)
    if (!pl.ok) {
      failures.push('publint --strict @pg-prime/create')
      console.error(pl.out)
    }
    const at = tryRun(
      join(BIN, 'attw'),
      ['--pack', '--profile', 'esm-only', '--format', 'ascii', '--no-emoji', createDir],
      ROOT,
    )
    console.log(`attw --pack --profile esm-only @pg-prime/create: ${at.ok ? 'clean' : 'FAILED'}`)
    if (!at.ok) {
      failures.push('attw @pg-prime/create')
      console.error(at.out)
    }

    // ── the scaffolder, installed and run as a user runs it ──────────────────
    const tool = join(tmp, 'tool')
    mkdirSync(tool)
    writeFileSync(
      join(tool, 'package.json'),
      `${JSON.stringify({ name: 'create-smoke-host', version: '0.0.0', private: true, type: 'module' }, null, 2)}\n`,
    )
    console.log(`\nnpm install ${tarballs.get('@pg-prime/create')} …`)
    sh('npm', ['install', '--no-audit', '--no-fund', tarballs.get('@pg-prime/create')], tool)

    const bin = join(tool, 'node_modules', '.bin', 'create-pg-prime')
    if (!existsSync(bin)) {
      console.error(
        'FAIL node_modules/.bin/create-pg-prime is missing after installing the tarball',
      )
      failures.push('the create-pg-prime bin was not linked')
    }

    const work = join(tmp, 'work')
    mkdirSync(work)
    const args = ['app', '--yes', '--no-install', '--no-git', ...(testing ? [] : ['--no-testing'])]
    const scaffolded = tryRun(bin, args, work, { npm_config_user_agent: 'npm/11.11.0' })
    console.log(`create-pg-prime ${args.join(' ')}: ${scaffolded.ok ? 'ok' : 'FAILED'}`)
    if (!scaffolded.ok) {
      failures.push('running create-pg-prime from the installed tarball')
      console.error(scaffolded.out)
    }

    const app = join(work, 'app')
    const missing = EXPECTED.filter((f) => !existsSync(join(app, ...f.split('/'))))
    if (missing.length > 0) {
      failures.push(`the scaffold is missing ${missing.join(', ')}`)
      console.error(`FAIL missing from the scaffold: ${missing.join(', ')}`)
    } else {
      console.log(`scaffold: ${EXPECTED.length} expected files present`)
    }

    // ── the scaffold, installed from the tarballs and compiled ───────────────
    const rewritten = useTarballs(join(app, 'package.json'), tarballs)
    console.log(`\nnpm install (${rewritten.join(', ')} from tarballs) + ${TYPESCRIPT} …`)
    const installed = tryRun(
      'npm',
      ['install', '--no-audit', '--no-fund', '--install-links', TYPESCRIPT],
      app,
    )
    console.log(`npm install: ${installed.ok ? 'ok' : 'FAILED'}`)
    if (!installed.ok) {
      failures.push('npm install of the scaffold')
      console.error(installed.out)
    }

    const tsc = join(app, 'node_modules', '.bin', 'tsc')
    const compiled = tryRun(tsc, ['--noEmit', '--pretty', 'false'], app)
    const version = tryRun(tsc, ['--version'], app).out.trim()
    console.log(`tsc --noEmit (${version}): ${compiled.ok ? 'clean' : 'FAILED'}`)
    if (!compiled.ok) {
      failures.push('tsc --noEmit on the scaffold')
      console.error(compiled.out)
    }

    // The `bin` the scaffold itself depends on: `npx pg-prime` has to exist in the project the
    // README tells the user to run it in.
    const kitBin = join(app, 'node_modules', '.bin', 'pg-prime')
    const help = existsSync(kitBin)
      ? tryRun(kitBin, ['--help'], app)
      : { ok: false, out: 'not linked' }
    const helpOk = help.ok && help.out.includes('Usage: pg-prime <command> [options]')
    console.log(`pg-prime --help inside the scaffold: ${helpOk ? 'ok' : 'FAILED'}`)
    if (!helpOk) {
      failures.push('`pg-prime --help` inside the scaffold')
      console.error(help.out)
    }
  } finally {
    if (keep) console.log(`\nkept ${tmp}`)
    else rmSync(tmp, { recursive: true, force: true })
  }

  console.log('')
  for (const f of failures) console.error(`FAIL ${f}`)
  if (failures.length) process.exit(1)
  console.log('create smoke ok')
}
