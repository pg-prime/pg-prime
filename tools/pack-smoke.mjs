// "Is it installable?" — the proof, end to end (design/08 §2.1, §2.2, §2.4 step 5).
//
//   node tools/pack-smoke.mjs [--keep]
//
// Nothing in this repo's own test suites goes through the export map: `packages/pg-prime/test/**`
// imports `../../src/…` by relative path, which is right for a test suite and useless as evidence
// that the published package resolves. So this tool does what a user does.
//
//   1. `pnpm pack` both packages into a temp dir.
//   2. `npm init -y` a throwaway ESM project there and `npm install` the two TARBALLS (not the
//      workspace directories — a workspace link would resolve through `src/`) plus typescript@5.9.3.
//   3. Write `consumer.ts` that imports from `pg-prime`, `pg-prime/schema`, `pg-prime/sql`,
//      `pg-prime/codecs`, `pg-prime/driver` and `@pg-prime/kit`; declares a one-table schema;
//      compiles a select with `compileOnly` and asserts the exact SQL text; uses the `sql` tag.
//   4. `tsc --strict --module nodenext --moduleResolution nodenext` it, then RUN the emitted
//      JavaScript with node. Both must succeed. That is one command each for "the types resolve"
//      and "the code runs".
//   5. Re-install `typescript@5.8.3` and compile the same file again. It must FAIL, with an error
//      containing `requires TypeScript >= 5.9`. That is the `types@<5.9` gate of §2.2 being proved
//      rather than asserted — a negative control, because a gate nobody has seen fire is a gate
//      that might be misconfigured.
//   6. `publint --strict` and `attw --pack --profile esm-only` on each tarball (§2.4 step 5).
//
// Network: step 2 and step 5 install from the npm registry.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BIN = join(ROOT, 'node_modules', '.bin')

const PACKAGES = ['packages/pg-prime', 'packages/pg-prime-kit']

/** The exact SQL `consumer.ts` asserts. Spelled here too so a change shows up in this file's diff. */
const EXPECTED_SQL = [
  'select "users"."id" as "id", "users"."email" as "email"',
  'from "public"."users" as "users"',
  'where "users"."email" = $1',
].join('\n')

const CONSUMER_TS = `// Written by tools/pack-smoke.mjs. A consumer, not a test fixture: every import below is a
// package specifier that has to go through the published \`exports\` map.
import { compileOnly, defineSchema, eq, sql } from 'pg-prime'
import { pgTable } from 'pg-prime/schema'
import { isFragment, quoteIdentPart } from 'pg-prime/sql'
import { textCodec } from 'pg-prime/codecs'
import { pgDriver } from 'pg-prime/driver'
import { MIGRATION_NAME, migrationId } from '@pg-prime/kit'
import type { Db, PgLikePool } from 'pg-prime'
import type { Plan } from '@pg-prime/kit'

const users = pgTable('users', (t) => ({
  id: t.bigint().primaryKey().generatedAlways(),
  email: t.text(),
}))

const schema = defineSchema({ users })

/** Type-level only: the driver entry's types have to line up with the root's. */
export type Handle = Db<typeof schema>
export type PoolShape = PgLikePool
export type KitPlan = Plan

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
  execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })

function tryRun(cmd, args, cwd) {
  try {
    return { ok: true, out: sh(cmd, args, cwd) }
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

export function packAll(dest) {
  const tarballs = []
  for (const rel of PACKAGES) {
    if (!existsSync(join(ROOT, rel, 'dist'))) {
      throw new Error(`pack-smoke: ${rel}/dist is missing — run \`pnpm build\` first`)
    }
    sh('pnpm', ['pack', '--pack-destination', dest], join(ROOT, rel))
  }
  for (const f of readdirSync(dest)) if (f.endsWith('.tgz')) tarballs.push(join(dest, f))
  return tarballs.sort()
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
    for (const rel of PACKAGES) {
      const dir = join(ROOT, rel)
      const name = JSON.parse(sh('node', ['-p', 'JSON.stringify(require("./package.json").name)'], dir))
      const tarball = tarballs.find((t) => t.endsWith(`${name.replace('@', '').replace('/', '-')}-0.0.0.tgz`)) ?? tarballs[0]
      const pl = tryRun(join(BIN, 'publint'), ['run', '--strict', tarball], ROOT)
      console.log(`publint --strict ${name}: ${pl.ok ? 'clean' : 'FAILED'}`)
      if (!pl.ok) {
        failures.push(`publint --strict ${name}`)
        console.error(pl.out)
      }
      const at = tryRun(join(BIN, 'attw'), ['--pack', '--profile', 'esm-only', '--format', 'ascii', '--no-emoji', dir], ROOT)
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
      JSON.stringify({ name: 'pg-prime-pack-smoke', version: '0.0.0', private: true, type: 'module' }, null, 2),
    )
    writeFileSync(join(app, 'consumer.ts'), CONSUMER_TS)
    writeFileSync(join(app, 'tsconfig.json'), JSON.stringify(CONSUMER_TSCONFIG, null, 2))

    console.log('\nnpm install <tarballs> typescript@5.9.3 …')
    sh('npm', ['install', '--no-audit', '--no-fund', ...tarballs, 'typescript@5.9.3'], app)

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

    // ── the negative control: TypeScript 5.8.3 must be refused ───────────────
    console.log('\nnpm install typescript@5.8.3 (the negative control) …')
    sh('npm', ['install', '--no-audit', '--no-fund', 'typescript@5.8.3'], app)
    const old = tryRun(tsc, ['-p', 'tsconfig.json', '--pretty', 'false'], app)
    const said = old.out.includes('requires TypeScript >= 5.9')
    console.log(`tsc 5.8.3: ${old.ok ? 'COMPILED (the types@<5.9 gate did not fire)' : 'refused, as designed'}`)
    const firstLines = old.out.split('\n').filter((l) => l.includes('requires TypeScript >= 5.9')).slice(0, 2)
    for (const l of firstLines) console.log(`    ${l.trim()}`)
    if (old.ok || !said) {
      failures.push('the types@<5.9 gate did not produce "requires TypeScript >= 5.9" under TypeScript 5.8.3')
      console.error(old.out.split('\n').slice(0, 20).join('\n'))
    }
  } finally {
    if (keep) console.log(`\nkept ${tmp}`)
    else rmSync(tmp, { recursive: true, force: true })
  }

  console.log('')
  for (const f of failures) console.error(`FAIL ${f}`)
  if (failures.length) process.exit(1)
  console.log('pack smoke ok')
}
