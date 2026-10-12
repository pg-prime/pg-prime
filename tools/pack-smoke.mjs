// "Is it installable?" — the proof, end to end (design/08 §2.1, §2.2, §2.4 step 5).
//
//   node tools/pack-smoke.mjs [--keep]
//
// Nothing in this repo's own test suites goes through the export map: `packages/pg-prime/test/**`
// imports `../../src/…` by relative path, which is right for a test suite and useless as evidence
// that the published package resolves. So this tool does what a user does.
//
//   1. `pnpm pack` pg-prime, the kit, @pg-prime/testing and every add-on into a temp dir.
//   2. `npm init -y` a throwaway ESM project there and `npm install` the first three TARBALLS (not
//      the workspace directories — a workspace link would resolve through `src/`) plus typescript@5.9.3.
//   3. Write `consumer.ts` that imports from `pg-prime`, `pg-prime/schema`, `pg-prime/sql`,
//      `pg-prime/codecs`, `pg-prime/driver`, `@pg-prime/kit` and `@pg-prime/testing`; declares a
//      one-table schema; compiles a select with `compileOnly` and asserts the exact SQL text; uses
//      the `sql` tag; and drives `@pg-prime/testing`'s two tier-0 helpers — `createMockPool` behind
//      a real `pgPrime({ pool })` and `expectSql` on both its passing and its failing branch. Those
//      two are the package's whole no-I/O surface, and they are the ones a consumer meets first.
//   4. `tsc --strict --module nodenext --moduleResolution nodenext` it, then RUN the emitted
//      JavaScript with node. Both must succeed. That is one command each for "the types resolve"
//      and "the code runs".
//   5. Re-install `typescript@5.8.3` and compile the same file again. It must FAIL, with an error
//      containing `requires TypeScript >= 5.9`. That is the `types@<5.9` gate of §2.2 being proved
//      rather than asserted — a negative control, because a gate nobody has seen fire is a gate
//      that might be misconfigured.
//   6. `publint --strict` and `attw --pack --profile esm-only` on each tarball (§2.4 step 5).
//   7. Run `pg-prime --help` from `node_modules/.bin` of the same throwaway project. `@pg-prime/kit`
//      declares a `bin`, and whether a shebang'd `dist/cli.js` keeps its 0755 through `pnpm pack` →
//      `npm install` is not something any other check here would notice.
//   8. Every add-on (a package with `test/pack-smoke.ts`) gets its own throwaway project holding
//      only its tarball, its in-repo dependencies, pg-prime, @pg-prime/testing and any registry
//      peers named in REGISTRY_PEERS (Nest for @pg-prime/nestjs). Its consumer
//      body is compiled with TypeScript 5.9.3 and run, and its install footprint — the package
//      plus its runtime dependencies, excluding pg-prime — is held to `installBytes` in
//      tools/budgets.json.
//
// Network: step 2 and step 5 install from the npm registry.
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listFiles, TSC_59 } from './build-package.mjs'
import { PACKAGES as ALL } from './packages.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BIN = join(ROOT, 'node_modules', '.bin')

const BUDGETS = JSON.parse(readFileSync(join(HERE, 'budgets.json'), 'utf8'))

const CORE = ['pg-prime', '@pg-prime/kit', '@pg-prime/testing']
const ADDONS = ALL.filter((p) => existsSync(join(ROOT, p.dir, 'test', 'pack-smoke.ts')))
const PACKAGES = ALL.filter((p) => CORE.includes(p.name) || ADDONS.includes(p))
/** Registry packages an add-on's consumer needs beside the tarballs, at its devDependency ranges. */
const REGISTRY_PEERS = {
  '@pg-prime/nestjs': ['@nestjs/common', '@nestjs/core', 'rxjs', 'reflect-metadata'],
}
const tarballName = (p) => `${p.name.replace('@', '').replace('/', '-')}-${p.pkg.version}.tgz`

/** The exact SQL `consumer.ts` asserts. Spelled here too so a change shows up in this file's diff. */
const EXPECTED_SQL = [
  'select "users"."id" as "id", "users"."email" as "email"',
  'from "public"."users" as "users"',
  'where "users"."email" = $1',
].join('\n')

const CONSUMER_TS = `// Written by tools/pack-smoke.mjs. A consumer, not a test fixture: every import below is a
// package specifier that has to go through the published \`exports\` map.
import { compileOnly, defineSchema, eq, pgPrime, sql } from 'pg-prime'
import { pgTable } from 'pg-prime/schema'
import { isFragment, quoteIdentPart } from 'pg-prime/sql'
import { textCodec } from 'pg-prime/codecs'
import { pgDriver } from 'pg-prime/driver'
import { MIGRATION_NAME, migrationId } from '@pg-prime/kit'
import { createMockPool, expectSql, requiresConcurrency } from '@pg-prime/testing'
import type { Db, PgLikePool } from 'pg-prime'
import type { Plan } from '@pg-prime/kit'
import type { MockPool, TestDecl } from '@pg-prime/testing'

const users = pgTable('users', (t) => ({
  id: t.bigint().primaryKey().generatedAlways(),
  email: t.text(),
}))

const schema = defineSchema({ users })

/** Type-level only: the driver entry's types have to line up with the root's. */
export type Handle = Db<typeof schema>
export type PoolShape = PgLikePool
export type KitPlan = Plan
export type TestingPool = MockPool
export type TestingDecl = TestDecl

const compiled = compileOnly(schema)
  .from(schema.h.users)
  .select(({ users: u }) => ({ id: u.id, email: u.email }))
  .where(({ users: u }) => eq(u.email, 'someone@example.com'))
  .compile()

const EXPECTED = ${JSON.stringify(EXPECTED_SQL)}

function assert(ok: boolean, what: string): void {
  if (!ok) throw new Error('pack-smoke: ' + what)
}

assert(compiled.sql === EXPECTED, 'compiled SQL was\\n' + compiled.sql + '\\nexpected\\n' + EXPECTED)
assert(compiled.binds.length === 1, 'expected one bind, got ' + String(compiled.binds.length))
assert(isFragment(sql\`select \${1} as n\`), 'the sql tag did not produce a Fragment')
assert(quoteIdentPart('we"ird') === '"we""ird"', 'quoteIdentPart did not double the quote')
assert(typeof pgDriver === 'function', 'pgDriver is not a function')
assert(textCodec.name === 'text', 'textCodec.name is ' + String(textCodec.name))
assert(migrationId(7, 'add_users') === '0007_add_users', 'migrationId is wrong')
assert(MIGRATION_NAME.test('ok_name'), 'MIGRATION_NAME is wrong')

// ── @pg-prime/testing, through its own export map ────────────────────────────
// The mock pool has to satisfy \`pgPrime({ pool })\` across the PACKAGE boundary, which is the one
// thing the workspace's own suites cannot prove: they import both sides from \`src/\`, so a
// structural mismatch between the published \`PgLikePool\` and the published \`MockPool\` would
// only ever be found by a user.
const mock: MockPool = createMockPool({ script: [{ rows: [['1', 'someone@example.com']] }] })
const mockDb = pgPrime({ pool: mock, schema })
const mockRows = await mockDb
  .from(mockDb.h.users)
  .select(({ users: u }) => ({ id: u.id, email: u.email }))
  .execute()
assert(mockRows.length === 1, 'the mock pool replayed ' + String(mockRows.length) + ' rows, not 1')
assert(mockRows[0]!.id === 1n, 'the schema codec did not decode the mocked bigint')
assert(mock.queries.length === 1, 'the mock pool recorded ' + String(mock.queries.length))
assert(mock.queries[0]!.mode === 'unnamed', 'the recorded mode was ' + String(mock.queries[0]!.mode))
await mockDb.end()

// The guard is runner-agnostic, so the consumer supplies its own two-line \`it\`. With no
// PG_PRIME_TEST_URL set this must hand back the SKIP half, and say so on stderr.
const declare = (_name: string, _fn: () => unknown): void => {}
const runner = Object.assign(declare, { skip: Object.assign(declare, {}) }) as unknown as TestDecl
const guarded: TestDecl = requiresConcurrency(runner)
assert(guarded === runner.skip, 'requiresConcurrency did not skip with no PG_PRIME_TEST_URL set')

// expectSql, both branches: the golden matches, and a wrong golden throws a diff.
expectSql(
  compileOnly(schema)
    .from(schema.h.users)
    .select(({ users: u }) => ({ id: u.id, email: u.email }))
    .where(({ users: u }) => eq(u.email, 'someone@example.com')),
  { text: EXPECTED, values: ['someone@example.com'] },
)
let diffed = ''
try {
  expectSql(
    compileOnly(schema)
      .from(schema.h.users)
      .select(({ users: u }) => ({ id: u.id })),
    { text: 'select "users"."nope" from "public"."users"' },
  )
} catch (e) {
  diffed = (e as Error).message
}
assert(diffed.includes('--- expected sql'), 'expectSql did not fail with a unified diff')

console.log('pack-smoke consumer OK — ' + compiled.sql.split('\\n')[0])
`

const CONSUMER_TSCONFIG = {
  compilerOptions: {
    strict: true,
    target: 'es2023',
    module: 'nodenext',
    moduleResolution: 'nodenext',
    verbatimModuleSyntax: true,
    skipLibCheck: true,
    outDir: 'out',
    rootDir: '.',
  },
  files: ['consumer.ts'],
}

const sh = (cmd, args, cwd, env) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })

function tryRun(cmd, args, cwd) {
  try {
    return { ok: true, out: sh(cmd, args, cwd) }
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

export function packAll(dest) {
  for (const p of PACKAGES) {
    if (!existsSync(join(ROOT, p.dir, 'dist'))) {
      throw new Error(`pack-smoke: ${p.dir}/dist is missing — run \`pnpm build\` first`)
    }
    sh('pnpm', ['pack', '--pack-destination', dest], join(ROOT, p.dir))
  }
  return readdirSync(dest)
    .filter((f) => f.endsWith('.tgz'))
    .map((f) => join(dest, f))
    .sort()
}

/** The package and its runtime `dependencies`, transitively, as installed under `app`. */
function footprint(app, name, seen = new Set()) {
  if (seen.has(name)) return 0
  seen.add(name)
  const dir = join(app, 'node_modules', name)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const own = listFiles(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0)
  return Object.keys(pkg.dependencies ?? {}).reduce((n, d) => n + footprint(app, d, seen), own)
}

const workspaceDeps = (p) =>
  Object.keys(p.pkg.dependencies ?? {}).flatMap((d) => {
    const dep = ALL.find((x) => x.name === d)
    return dep ? [dep, ...workspaceDeps(dep)] : []
  })

/** One add-on's own project: install, footprint, then compile and run its consumer body. */
function smokeAddon(addon, tmp, tars, failures) {
  const peers = ALL.filter((p) => p.name === 'pg-prime' || p.name === '@pg-prime/testing')
  const members = [addon, ...workspaceDeps(addon), ...peers]
  const app = join(tmp, addon.golden.replace(/\.json$/, ''))
  mkdirSync(app)
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'pack-smoke-addon', private: true, type: 'module' }),
  )
  writeFileSync(
    join(app, 'consumer.ts'),
    readFileSync(join(ROOT, addon.dir, 'test', 'pack-smoke.ts')),
  )
  writeFileSync(join(app, 'tsconfig.json'), JSON.stringify(CONSUMER_TSCONFIG, null, 2))
  console.log(`\n${addon.name}: npm install ${members.map((p) => p.name).join(' ')} …`)
  // `--legacy-peer-deps`: an add-on's peer floor names the release that ships it, which the
  // in-tree pg-prime only becomes at `changeset version`. size-budget.mjs asserts the peers.
  const tarballs = members.map((p) => join(tars, tarballName(p)))
  const registry = (REGISTRY_PEERS[addon.name] ?? []).map(
    (n) => `${n}@${addon.pkg.devDependencies[n]}`,
  )
  sh(
    'npm',
    ['install', '--no-audit', '--no-fund', '--legacy-peer-deps', ...tarballs, ...registry],
    app,
  )

  const bytes = footprint(app, addon.name)
  const limit = BUDGETS.packages[addon.dir]?.installBytes
  const fits = limit !== undefined && bytes <= limit
  const shown = limit === undefined ? 'no installBytes budget' : `${(limit / 1024).toFixed(1)} KB`
  console.log(`  install footprint, excl. peers: ${(bytes / 1024).toFixed(1)} KB / ${shown}`)
  if (!fits) failures.push(`${addon.name} install footprint ${bytes} B > installBytes ${limit}`)

  const tsc = tryRun(process.execPath, [TSC_59, '-p', 'tsconfig.json', '--pretty', 'false'], app)
  const ran = tsc.ok ? tryRun(process.execPath, [join(app, 'out', 'consumer.js')], app) : tsc
  console.log(`  tsc 5.9.3 + node: ${ran.ok ? ran.out.trim() : 'FAILED'}`)
  if (!ran.ok) {
    failures.push(`${addon.name} consumer`)
    console.error(ran.out)
  }
}

if (process.argv[1] && process.argv[1].endsWith('pack-smoke.mjs')) {
  const keep = process.argv.includes('--keep')
  const tmp = mkdtempSync(join(tmpdir(), 'pg-prime-pack-smoke-'))
  const failures = []
  try {
    const tars = join(tmp, 'tarballs')
    mkdirSync(tars)
    const tarballs = packAll(tars)
    console.log(`packed ${tarballs.length}: ${tarballs.map((t) => t.split('/').pop()).join(', ')}`)

    // ── publint + attw, on the tarballs ──────────────────────────────────────
    for (const p of PACKAGES) {
      const { name } = p
      const dir = join(ROOT, p.dir)
      const tarball = join(tars, tarballName(p))
      const pl = tryRun(join(BIN, 'publint'), ['run', '--strict', tarball], ROOT)
      console.log(`publint --strict ${name}: ${pl.ok ? 'clean' : 'FAILED'}`)
      if (!pl.ok) {
        failures.push(`publint --strict ${name}`)
        console.error(pl.out)
      }
      const at = tryRun(
        join(BIN, 'attw'),
        ['--pack', '--profile', 'esm-only', '--format', 'ascii', '--no-emoji', dir],
        ROOT,
      )
      const grid = at.out
        .split('\n')
        .filter((l) => /node16 \(from ESM\)|^bundler|^"/.test(l))
        .map((l) => l.trim())
      console.log(`attw --pack --profile esm-only ${name}: ${at.ok ? 'clean' : 'FAILED'}`)
      for (const l of grid) console.log(`    ${l}`)
      if (!at.ok) {
        failures.push(`attw ${name}`)
        console.error(at.out)
      }
    }

    // ── the throwaway consumer project ───────────────────────────────────────
    const app = join(tmp, 'app')
    mkdirSync(app)
    sh('npm', ['init', '-y'], app)
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify(
        { name: 'pg-prime-pack-smoke', version: '0.0.0', private: true, type: 'module' },
        null,
        2,
      ),
    )
    writeFileSync(join(app, 'consumer.ts'), CONSUMER_TS)
    writeFileSync(join(app, 'tsconfig.json'), JSON.stringify(CONSUMER_TSCONFIG, null, 2))

    const core = PACKAGES.filter((p) => CORE.includes(p.name)).map((p) =>
      join(tars, tarballName(p)),
    )
    console.log('\nnpm install <tarballs> typescript@5.9.3 …')
    sh('npm', ['install', '--no-audit', '--no-fund', ...core, 'typescript@5.9.3'], app)

    const tsc = join(app, 'node_modules', '.bin', 'tsc')
    const good = tryRun(tsc, ['-p', 'tsconfig.json', '--pretty', 'false'], app)
    console.log(`tsc 5.9.3 (strict, nodenext): ${good.ok ? 'clean' : 'FAILED'}`)
    if (!good.ok) {
      failures.push('tsc 5.9.3 on the consumer')
      console.error(good.out)
    }
    const ran = tryRun(process.execPath, [join(app, 'out', 'consumer.js')], app)
    console.log(`node out/consumer.js: ${ran.ok ? ran.out.trim() : 'FAILED'}`)
    if (!ran.ok) {
      failures.push('running the emitted consumer')
      console.error(ran.out)
    }

    // ── the `bin` — installed, executable, and it runs ───────────────────────
    // `@pg-prime/kit`'s `bin` is a file tsc emitted with a shebang and 0644, which
    // `tools/build-package.mjs` chmods to 0755. Whether the mode bit survives `pnpm pack`
    // → `npm install` is the kind of thing that is only ever discovered by a user, so it
    // is asserted here the way a user meets it: run the command npm put on the PATH.
    const bin = join(app, 'node_modules', '.bin', 'pg-prime')
    if (!existsSync(bin)) {
      failures.push('node_modules/.bin/pg-prime is missing after installing the tarball')
      console.log('pg-prime --help: FAILED (the bin was not linked)')
    } else {
      const mode =
        statSync(join(app, 'node_modules', '@pg-prime', 'kit', 'dist', 'cli.js')).mode & 0o111
      const help = tryRun(bin, ['--help'], app)
      const ok = help.ok && help.out.includes('Usage: pg-prime <command> [options]')
      console.log(
        `pg-prime --help: ${ok ? 'ok' : 'FAILED'} (dist/cli.js exec bits ${mode.toString(8)})`,
      )
      if (!ok) {
        failures.push('`pg-prime --help` from the installed tarball')
        console.error(help.out)
      }
      if (mode === 0) {
        failures.push('dist/cli.js lost its executable bit through pnpm pack → npm install')
      }
    }

    // ── the negative control: TypeScript 5.8.3 must be refused ───────────────
    console.log('\nnpm install typescript@5.8.3 (the negative control) …')
    sh('npm', ['install', '--no-audit', '--no-fund', 'typescript@5.8.3'], app)
    const old = tryRun(tsc, ['-p', 'tsconfig.json', '--pretty', 'false'], app)
    const said = old.out.includes('requires TypeScript >= 5.9')
    console.log(
      `tsc 5.8.3: ${old.ok ? 'COMPILED (the types@<5.9 gate did not fire)' : 'refused, as designed'}`,
    )
    const firstLines = old.out
      .split('\n')
      .filter((l) => l.includes('requires TypeScript >= 5.9'))
      .slice(0, 2)
    for (const l of firstLines) console.log(`    ${l.trim()}`)
    if (old.ok || !said) {
      failures.push(
        'the types@<5.9 gate did not produce "requires TypeScript >= 5.9" under TypeScript 5.8.3',
      )
      console.error(old.out.split('\n').slice(0, 20).join('\n'))
    }

    for (const addon of ADDONS) smokeAddon(addon, tmp, tars, failures)
  } finally {
    if (keep) console.log(`\nkept ${tmp}`)
    else rmSync(tmp, { recursive: true, force: true })
  }

  console.log('')
  for (const f of failures) console.error(`FAIL ${f}`)
  if (failures.length) process.exit(1)
  console.log('pack smoke ok')
}
