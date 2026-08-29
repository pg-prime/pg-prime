// design/08 §6.4 ("docs examples are tests") and design/12 §4 D, rule R20: **every fenced `ts`
// block tagged `title=` on the docs site is executed**, against tier-1 PGlite, in CI.
//
//   node tools/docs-examples.mjs                 # the gate
//   node tools/docs-examples.mjs guides/queries  # only pages whose path contains this
//   node tools/docs-examples.mjs --keep          # leave docs/.gen/examples for inspection
//   node tools/docs-examples.mjs --pg            # the real-server tier: the `pg-only` blocks
//
// How an example runs unchanged
// -----------------------------
// The runner starts one PGlite behind the repo's own wire-protocol bridge
// (`packages/pg-prime/test/live/_pglite.ts`, bundled here with esbuild because Node cannot resolve
// that file's `./x.js` specifiers to their `.ts` sources) and exports its `postgres://` URL as
// `DATABASE_URL`. Examples read `process.env['DATABASE_URL']`, which is what an application does
// anyway, so **nothing on the page is rewritten**. A block that hard-codes a URL literal instead
// is still run: the runner substitutes exactly that one line, and says so in its output — the one
// documented substitution design/12 §4 D allows.
//
// Isolation: `drop schema public cascade` between examples, because PGlite is one backend and one
// database. Ordering is page order, and each example is its own process, so an example that leaks
// a handle or hangs fails on its own timeout rather than poisoning the run.
//
// The real-server tier (`--pg`, design/13 decision 10)
// ----------------------------------------------------
// PGlite is one backend, and a handful of things a reader needs to see cannot be shown on one:
// COPY, a notification crossing two sessions, a `CancelRequest` somebody honours, the pooler
// probes. Those blocks are marked `pg-only` (or `pg-only="pgbouncer"`), are skipped by the gate
// above, and run here instead — same composition, same one-line URL substitution, same per-example
// process and timeout. What changes is the isolation:
//
//   `pg-only`             one scratch database per example, `docs_ex_<pid>_<n>`, created from
//                         `PG_PRIME_TEST_URL` and dropped after — its backends terminated first,
//                         because an example that left one behind is a finding and is printed.
//   `pg-only="pgbouncer"` `DATABASE_URL` is `PG_PRIME_TEST_PGBOUNCER_URL` and there is no scratch
//                         database to make: PgBouncer's `DB_NAME` is fixed at its own startup, so
//                         a database this process invents is not reachable through it. Isolation
//                         is `drop schema public cascade; create schema public`, before and after.
//
// Both tiers also export `DIRECT_URL` — the direct server in the pooled case, the scratch database
// itself otherwise — because that is the second URL `directConnection:` is documented with.
//
// This is NOT part of `docs:check`: that gate needs no server, and keeping it that way is what
// makes it runnable on a laptop and in the `docs` CI job. `docs:examples:pg` rides the `pg` job.
//
// `sh` blocks (the CLI walkthroughs) are NOT executed — they need a real server, a project
// directory and a migrations history, which is `packages/pg-prime-kit/test`'s job, not a docs
// gate's.

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DOCS,
  ROOT,
  compose,
  isExample,
  isPgExample,
  pageSetupsOf,
  readAllPages,
  readSnippets,
} from './docs-blocks.mjs'

const args = process.argv.slice(2)
const KEEP = args.includes('--keep')
const PG = args.includes('--pg')
const FILTER = args.find((a) => !a.startsWith('--'))
const GEN = join(DOCS, '.gen', `examples-${process.pid}`)
const TIMEOUT_MS = Number(process.env.PG_PRIME_DOCS_EXAMPLE_TIMEOUT_MS ?? 60_000)
/** What every line of output is prefixed with, so two tiers in one log are told apart. */
const LABEL = PG ? 'docs-examples --pg' : 'docs-examples'

const RUNNER = `// Written by tools/docs-examples.mjs. Imports one composed example and exits.
import { pathToFileURL } from 'node:url'
await import(pathToFileURL(process.argv[2]).href)
process.exit(0)
`

const URL_LITERAL = /(['"])postgres(?:ql)?:\/\/[^'"\s]+\1/

function main() {
  const pages = readAllPages().filter((p) => !FILTER || p.page.includes(FILTER))
  const snippets = readSnippets()

  rmSync(GEN, { recursive: true, force: true })
  mkdirSync(GEN, { recursive: true })
  writeFileSync(join(GEN, '_run.mjs'), RUNNER)

  const examples = []
  for (const page of pages) {
    const setups = pageSetupsOf(page)
    for (const block of page.blocks) {
      if (!['ts', 'tsx'].includes(block.lang)) continue
      if (block.attrs['skip-check'] || block.attrs['expect-error'] || block.attrs.signature)
        continue
      const tier = PG ? isPgExample(block) : isExample(block) ? 'pglite' : null
      if (tier === null) continue
      if (typeof block.attrs.title !== 'string') {
        throw new Error(
          `${block.page}:${block.line}: pg-only needs a title= — a block without a file name is ` +
            'not an example and nothing would ever run it',
        )
      }
      const composed = compose(block, snippets, setups)
      examples.push({ block, composed, tier })
    }
  }

  if (examples.length === 0) {
    console.log(`${LABEL}: no ${PG ? '`pg-only`' : '`title=`'} blocks to run`)
    return
  }

  if (!PG) bundleHarness()
  const run = PG ? runAllPg(examples) : runAll(examples)
  run.catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

/** The tier-1 harness, bundled so its `./_pglite-bridge.js` specifier resolves to the `.ts` source. */
function bundleHarness() {
  const esbuild = join(ROOT, 'node_modules', '.bin', 'esbuild')
  const res = spawnSync(
    esbuild,
    [
      join(ROOT, 'packages', 'pg-prime', 'test', 'live', '_pglite.ts'),
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--external:pg',
      '--external:@electric-sql/pglite',
      `--outfile=${join(GEN, '_pglite.mjs')}`,
    ],
    { encoding: 'utf8' },
  )
  if (res.status !== 0) {
    console.error(res.stdout + res.stderr)
    throw new Error('docs-examples: could not bundle the PGlite harness')
  }
}

/**
 * The bridge's own alarm, made into a gate.
 *
 * PGlite is one backend: when a second connection runs a message while another holds an open
 * transaction, the bridge prints `[live] PGlite is ONE backend …` and drops it (design/08 F8). The
 * pool then reconnects and the example carries on **without its `BEGIN`** — measured here: with the
 * default pool of 10, two `txid_current()` calls inside one `db.transaction` returned 753 and 754.
 * An example that reads as a transaction and is not one is worse than a failing example, so a drop
 * during an example fails it.
 */
function watchForDrops() {
  const original = console.error
  const state = { count: 0 }
  console.error = (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('PGlite is ONE backend')) state.count++
    else original(...args)
  }
  return state
}

async function runAll(examples) {
  const drops = watchForDrops()
  const { startPglite } = await import(pathToFileURL(join(GEN, '_pglite.mjs')).href)
  const started = Date.now()
  const server = await startPglite()
  const bootMs = Date.now() - started
  console.log(`${LABEL}: ${server.version.split(' on ')[0]} at ${server.url} (boot ${bootMs} ms)`)

  const pg = await loadPg()
  const admin = new pg.Client({ connectionString: server.url })
  await admin.connect()

  const failures = []
  const substitutions = []
  let ran = 0
  const t0 = Date.now()

  try {
    for (const [i, ex] of examples.entries()) {
      const id = String(i).padStart(4, '0')
      const dir = join(GEN, id)
      mkdirSync(dir, { recursive: true })

      const entry = join(dir, 'index.ts')
      const maps = materialise(ex, dir, server.url, substitutions)

      await reset(admin)
      const before = drops.count
      const result = await runOne(dir, entry, { DATABASE_URL: server.url })
      ran++
      if (result.code === 0 && drops.count > before && !ex.block.attrs['allow-drops']) {
        failures.push({
          where: `${ex.block.page}:${ex.block.line}`,
          title: ex.block.attrs.title,
          output:
            `the PGlite bridge dropped ${drops.count - before} connection(s) while this example ran: it opened a\n` +
            `second physical connection while a transaction was in flight, and PGlite is ONE backend\n` +
            `(design/08 F8). The example may have passed while its transaction silently did not isolate.\n` +
            `Fix: build the handle with poolOptions: { max: 1 } and devGuard: false (what\n` +
            `docs/src/snippets/blog.ts does — the dev-mode pooler probe of design/07 §5.4 opens up to\n` +
            `three connections of its own), mark the block no-run if it genuinely needs two sessions,\n` +
            `or, if the drops are harmless here because the example opens no transaction, say so with\n` +
            'allow-drops="the reason".',
        })
      }
      if (result.code !== 0) {
        failures.push({
          where: `${ex.block.page}:${ex.block.line}`,
          title: ex.block.attrs.title,
          output: remap(result.output.trimEnd(), maps),
        })
      }
    }
  } finally {
    await admin.end()
    await server.stop()
  }

  const pages = new Set(examples.map((e) => e.block.page)).size
  report({ pages, ran, ms: Date.now() - t0, substitutions, failures })
}

/**
 * The real-server tier: the `pg-only` blocks, against `PG_PRIME_TEST_URL`.
 *
 * One scratch database per example, so an example that creates a table, a type or an extension
 * cannot be seen by the next one and there is no `drop schema` ordering to get right. The pooled
 * blocks cannot have that — PgBouncer's `DB_NAME` is decided when the pooler starts, so a database
 * invented here is not reachable through it — and are isolated by resetting the schema instead.
 */
async function runAllPg(examples) {
  const adminUrl = process.env['PG_PRIME_TEST_URL']
  if (!adminUrl) {
    console.error(
      `${LABEL}: PG_PRIME_TEST_URL is unset, and this tier is the one that needs a server — it ` +
        'creates a scratch database per example. `pnpm docs:examples` is the tier that needs none.',
    )
    process.exit(1)
  }
  const bouncerUrl = process.env['PG_PRIME_TEST_PGBOUNCER_URL']

  const pg = await loadPg()
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  const { rows } = await admin.query('select version() as version')
  console.log(
    `${LABEL}: ${rows[0].version.split(' on ')[0]} at ${redact(adminUrl)}` +
      (bouncerUrl ? `, pooler at ${redact(bouncerUrl)}` : ''),
  )

  const failures = []
  const substitutions = []
  const notes = []
  const ranPages = new Set()
  let ran = 0
  const t0 = Date.now()

  try {
    for (const [i, ex] of examples.entries()) {
      const where = `${ex.block.page}:${ex.block.line}`
      const title = ex.block.attrs.title
      if (ex.tier === 'pgbouncer' && !bouncerUrl) {
        notes.push(
          `skipped ${where} (${title}): it is pg-only="pgbouncer" and PG_PRIME_TEST_PGBOUNCER_URL ` +
            'is unset, so there is no pooler to prove anything against',
        )
        continue
      }

      const id = String(i).padStart(4, '0')
      const dir = join(GEN, id)
      mkdirSync(dir, { recursive: true })

      const database = `docs_ex_${process.pid}_${id}`
      const url = ex.tier === 'pgbouncer' ? bouncerUrl : withDatabase(adminUrl, database)
      // `directConnection:`'s second URL, which is the whole point of the pooled examples.
      const directUrl = ex.tier === 'pgbouncer' ? adminUrl : url

      const entry = join(dir, 'index.ts')
      const maps = materialise(ex, dir, url, substitutions)

      if (ex.tier === 'pgbouncer') await resetPooled(pg, bouncerUrl)
      else await admin.query(`create database ${quoteIdent(database)}`)

      let result
      try {
        result = await runOne(dir, entry, { DATABASE_URL: url, DIRECT_URL: directUrl })
        ran++
        ranPages.add(ex.block.page)
      } finally {
        if (ex.tier === 'pgbouncer') {
          await resetPooled(pg, bouncerUrl)
        } else {
          const terminated = await dropScratch(admin, database)
          if (terminated > 0) {
            notes.push(
              `${where} (${title}): ${terminated} backend(s) were still connected two seconds ` +
                'after the example process exited and had to be terminated before the scratch ' +
                'database could be dropped — the example leaks a handle',
            )
          }
        }
      }

      if (result.code !== 0) {
        failures.push({ where, title, output: remap(result.output.trimEnd(), maps) })
      }
    }
  } finally {
    await admin.end()
  }

  report({ pages: ranPages.size, ran, ms: Date.now() - t0, substitutions, failures, notes })
}

/** `pg` as the docs workspace resolves it — the same copy an example gets. */
async function loadPg() {
  const require = createRequire(pathToFileURL(join(DOCS, 'package.json')).href)
  return (await import(pathToFileURL(require.resolve('pg')).href)).default
}

/** The same server, a different database. */
function withDatabase(url, database) {
  const u = new URL(url)
  u.pathname = `/${encodeURIComponent(database)}`
  return u.toString()
}

/** A connection URL is fine to print except for the one field in it that is a secret. */
function redact(url) {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return url
  }
}

function quoteIdent(name) {
  return `"${name.replaceAll('"', '""')}"`
}

/**
 * Drop the scratch database, and say how many backends had to be killed for it.
 *
 * The example's process is already dead — `runOne` waited for `close` — so its sockets are closed
 * and PostgreSQL reaps the backends within milliseconds. Two seconds of polling is therefore not a
 * grace period for the normal case but the threshold above which "still connected" means the
 * example really did leave something behind, which is worth a line of output.
 */
async function dropScratch(admin, database) {
  const deadline = Date.now() + 2_000
  const count = async () => {
    const { rows } = await admin.query(
      'select count(*)::int as n from pg_stat_activity where datname = $1',
      [database],
    )
    return rows[0].n
  }
  while ((await count()) > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
  const { rowCount } = await admin.query(
    'select pg_terminate_backend(pid) from pg_stat_activity ' +
      'where datname = $1 and pid <> pg_backend_pid()',
    [database],
  )
  // A terminated backend leaves `pg_stat_activity` a moment after `pg_terminate_backend` returns,
  // and `DROP DATABASE` refuses while it is there — hence a retry rather than a flaky gate.
  for (let attempt = 0; ; attempt++) {
    try {
      await admin.query(`drop database if exists ${quoteIdent(database)}`)
      break
    } catch (err) {
      if (attempt >= 20) throw err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  return rowCount ?? 0
}

/** What `reset()` is for the pooled database: everything the last example made, gone. */
async function resetPooled(pg, url) {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query('drop schema if exists public cascade')
    await client.query('drop schema if exists pgprime cascade')
    await client.query('create schema public')
  } finally {
    await client.end()
  }
}

/**
 * The last twelve lines of both tiers: how many ran, what was substituted or skipped, what failed.
 *
 * `notes` is where a tier says something true that is not a failure — a `pg-only="pgbouncer"` block
 * with no pooler URL, an example that left a backend behind.
 */
function report({ pages, ran, ms, substitutions, failures, notes = [] }) {
  console.log(`${LABEL}: ${ran} example(s) from ${pages} page(s) in ${(ms / 1000).toFixed(1)} s`)
  for (const s of substitutions) console.log(`  substituted ${s}`)
  for (const n of notes) console.log(`  ${n}`)

  if (failures.length > 0) {
    console.error(`\n${LABEL}: ${failures.length} example(s) failed\n`)
    for (const f of failures) {
      console.error(`  ${f.where} (${f.title}):`)
      for (const line of f.output.split('\n')) console.error(`    ${line}`)
      console.error('')
    }
    if (!KEEP) rmSync(GEN, { recursive: true, force: true })
    process.exit(1)
  }
  if (!KEEP) rmSync(GEN, { recursive: true, force: true })
  console.log(`${LABEL}: OK`)
}

/**
 * The entry module and any sibling file the block's `use=` produced, written into `dir`.
 *
 * The one documented rewrite happens here, per file, so a `setup=` block that hard-codes a URL is
 * substituted exactly like the entry is — and reported against the block that used it.
 */
function materialise(ex, dir, url, substitutions) {
  const maps = new Map()
  for (const file of [
    ...ex.composed.files,
    { name: 'index.ts', text: ex.composed.text, map: ex.composed.map },
  ]) {
    const { text, substituted } = substitute(file.text, url)
    if (substituted) substitutions.push(`${ex.block.page}:${ex.block.line} — ${substituted}`)
    writeFileSync(join(dir, file.name), text + '\n')
    maps.set(join(dir, file.name), file.map)
  }
  return maps
}

/**
 * Node reports a stack against the composed temp files (through the bundle's inline source map).
 * Rewrite every mention of one back to the page — or the snippet — the line came from, so a failure
 * reads as `guides/queries.mdx:88`.
 */
function remap(output, maps) {
  let out = output
  for (const [file, map] of maps) {
    const re = new RegExp(`(?:file://)?${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`, 'g')
    out = out.replaceAll(re, (_m, line) => {
      const origin = map[Number(line) - 1]
      return origin
        ? `${relative(ROOT, origin.file)}:${origin.line}`
        : `${relative(ROOT, file)}:${line}`
    })
  }
  return out
}

/** One documented rewrite: a hard-coded connection URL becomes the bridge's. */
function substitute(text, url) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    if (lines[i].includes('process.env')) continue
    const m = URL_LITERAL.exec(lines[i])
    if (!m) continue
    const before = lines[i]
    lines[i] = lines[i].replace(URL_LITERAL, `'${url}'`)
    return {
      text: lines.join('\n'),
      substituted: `one line rewritten to the PGlite URL: ${before.trim()}`,
    }
  }
  return { text, substituted: undefined }
}

async function reset(admin) {
  await admin.query('drop schema if exists public cascade')
  await admin.query('drop schema if exists pgprime cascade')
  await admin.query('create schema public')
  // PGlite is one backend, so a TEMP table outlives the process that created it — `pg_temp` is not
  // in `public` and the next example would meet a `42P07` it did not cause. `DISCARD ALL` is the
  // one place in this repository that statement is correct: this is a test harness resetting a
  // single shared backend, not a pooler recycling somebody's connection (design/07 §5.2).
  await admin.query('discard all')
}

/**
 * Bundle, then run.
 *
 * Node's own type stripping would do for a single file, but it cannot resolve `./db.js` to the
 * `db.ts` beside it — the ESM specifier a TypeScript project actually writes — and rewriting the
 * page's import line is exactly what this gate exists not to do. esbuild resolves it, leaves every
 * package import external (so `pg-prime` still comes from `docs/node_modules`, i.e. the built
 * package), and an inline source map plus `--enable-source-maps` keeps the stack on the `.ts`.
 */
function runOne(dir, entry, env) {
  const bundle = join(dir, 'bundle.mjs')
  const built = spawnSync(
    join(ROOT, 'node_modules', '.bin', 'esbuild'),
    [
      entry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node22',
      '--packages=external',
      '--sourcemap=inline',
      `--outfile=${bundle}`,
    ],
    { encoding: 'utf8' },
  )
  if (built.status !== 0) {
    return Promise.resolve({ code: built.status ?? 1, output: built.stdout + built.stderr })
  }
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--enable-source-maps',
        '--disable-warning=ExperimentalWarning',
        join(GEN, '_run.mjs'),
        bundle,
      ],
      {
        cwd: dir,
        env: { ...process.env, ...env, NODE_ENV: 'test' },
      },
    )
    let output = ''
    child.stdout.on('data', (b) => (output += b))
    child.stderr.on('data', (b) => (output += b))
    const timer = setTimeout(() => {
      output += `\n[docs-examples] killed after ${TIMEOUT_MS} ms — the example never finished`
      child.kill('SIGKILL')
    }, TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, output })
    })
  })
}

main()
