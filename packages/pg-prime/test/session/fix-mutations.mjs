// R10 for design/12 §4 F1: fourteen mutations of the code this round wrote or changed, each
// applied to the working tree, run against the check that is supposed to notice, then reverted.
//
//   node packages/pg-prime/test/session/fix-mutations.mjs           all of them
//   node packages/pg-prime/test/session/fix-mutations.mjs M7        one
//
// Every fix in this round is of the same shape — **a feature that was recorded and never applied**
// — so every mutation here undoes exactly one application and asks whether anything notices. That
// is the failure mode the round exists to close: `.$default()` was on the column, `paramCount` was
// on the error, `TlsError` was in the file. Being present is not being wired up.
//
// Tiers matter here more than usual. `#restoreValue` can be pinned on the wire at tier 0 (which
// `set_config` parameter went out) but only PostgreSQL can say what that parameter MEANS, so M6
// and M7 are answered by both. The pooled-handle mutation (M11) is invisible at tier 0 by
// construction: the mock driver has no pool to hold a connection in.
//
// It edits files in place and restores them in a `finally`. Run it on a clean tree.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..', '..')
const ROOT = join(PKG, '..', '..')

const only = process.argv[2]

const PG_URL = process.env['PG_PRIME_TEST_URL']
const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')

const run = (args, env) => () =>
  execFileSync(process.execPath, args, {
    cwd: PKG,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, ...env },
  })

/** `vitest run --project unit <file>` — the tier-0 check. */
const unit = (file) => ({
  what: `tier 0 · ${file}`,
  run: run([vitest, 'run', '--project', 'unit', file]),
})

/** Tier 1 — PGlite behind the wire-protocol bridge, with no `PG_PRIME_TEST_URL`. */
const live = (file) => ({
  what: `tier 1 · ${file}`,
  run: run([vitest, 'run', '--project', 'live', file], { PG_PRIME_TEST_URL: '' }),
})

/** Tier 2 — a real server. Skipped loudly when `PG_PRIME_TEST_URL` is unset (R19's rule). */
const pg = (file) => ({
  what: `tier 2 · ${file}`,
  needsServer: true,
  run: run([vitest, 'run', '--project', 'pg', file]),
})

/** The goldens: build, then diff the shipped surface against `tools/api-snapshot/`. */
const apiSnapshot = {
  what: 'pnpm build && pnpm api-snapshot:check',
  run: () => {
    execFileSync(process.execPath, [join(ROOT, 'tools', 'build-package.mjs')], {
      cwd: PKG,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    execFileSync(process.execPath, [join(ROOT, 'tools', 'api-snapshot.mjs'), '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    })
  },
}

const MUTATIONS = [
  // ── (a) `.$default()` / `.$onUpdate()` ────────────────────────────────────
  {
    id: 'M1',
    file: 'packages/pg-prime/src/query/meta.ts',
    from: '    if (ts.defaultFn !== undefined) (clientDefaults ??= {})[ref.key] = ts.defaultFn',
    to: '    void ts.defaultFn',
    what: 'the codec seam stops carrying `$default` — the exact state before this round',
    check: unit('test/query/insert.test.ts'),
  },
  {
    id: 'M2',
    file: 'packages/pg-prime/src/query/insert.ts',
    from: '    const out = rows.map((row) => {',
    to: '    const once = new Map()\n    const out = rows.map((row) => {',
    also: {
      file: 'packages/pg-prime/src/query/insert.ts',
      from: '        copy[k] = (defaults[k] as () => unknown)()',
      to: '        if (!once.has(k)) once.set(k, (defaults[k] as () => unknown)())\n        copy[k] = once.get(k)',
    },
    what: 'the factory is called once for the whole batch instead of once per row',
    check: unit('test/query/insert.test.ts'),
  },
  {
    id: 'M3',
    file: 'packages/pg-prime/src/query/insert.ts',
    from: '        if (Object.hasOwn(row, k) && row[k] !== undefined) continue',
    to: '        if (Object.hasOwn(row, k)) continue',
    what: 'an explicit `undefined` counts as a value, so a NOT NULL column gets NULL',
    check: unit('test/query/insert.test.ts'),
  },
  {
    id: 'M4',
    file: 'packages/pg-prime/src/query/insert.ts',
    from: '    return { rows: out, keys: extra.length === 0 ? keys : [...keys, ...extra] }',
    to: '    return { rows: out, keys }',
    what: 'the filled value never reaches the column list, so the statement omits it again',
    check: unit('test/query/insert.test.ts'),
  },
  {
    id: 'M5',
    file: 'packages/pg-prime/src/query/update.ts',
    from: '      if (already.has(column.name)) continue',
    to: '      if (false) continue',
    what: '`$onUpdate` overrides an explicit `.set()` — two assignments to one column, 42701',
    check: unit('test/query/update.test.ts'),
  },
  // ── (b) what a per-statement timeout restores ─────────────────────────────
  {
    id: 'M6',
    file: 'packages/pg-prime/src/session/runner.ts',
    from: '    const value = this.state.sessionStatementTimeout\n    if (value === undefined) return null',
    to: '    const value = this.state.sessionStatementTimeout\n    if (value !== undefined) return null',
    what: 'the restore goes back to `NULL` — the reset value, not the session value we set',
    check: unit('test/session/session.test.ts'),
  },
  {
    id: 'M6b',
    file: 'packages/pg-prime/src/session/runner.ts',
    from: '    const value = this.state.sessionStatementTimeout\n    if (value === undefined) return null',
    to: '    const value = this.state.sessionStatementTimeout\n    if (value !== undefined) return null',
    what: 'the same mutation, asked of the server: SHOW is the oracle (R18)',
    check: pg('test/pg/session.test.ts'),
  },
  {
    id: 'M7',
    file: 'packages/pg-prime/src/session/runner.ts',
    from: '    return this.state.configured.has(this.conn.serverParameters as object) ? value : null',
    to: '    return value',
    what: 'a connection whose GUC batch FAILED is told to restore a value it never had',
    check: unit('test/session/session.test.ts'),
  },
  // ── (c) paramCount / params ───────────────────────────────────────────────
  {
    id: 'M8',
    file: 'packages/pg-prime/src/session/runner.ts',
    from: '    params: paramValuesOf(desc, o),',
    to: '    params: undefined,',
    what: 'the runner passes no params — finding c exactly, and paramCount reads 0 again',
    check: unit('test/session/session.test.ts'),
  },
  {
    id: 'M9',
    file: 'packages/pg-prime/src/errors/map.ts',
    from: '    ...(o.errors.includeParams && o.params !== undefined ? { params: o.params } : {}),',
    to: '    ...(o.params !== undefined ? { params: o.params } : {}),',
    what: 'the bind VALUES are published whatever the redaction policy says — the PII leak',
    check: unit('test/session/session.test.ts'),
  },
  // ── (d) TlsError ──────────────────────────────────────────────────────────
  {
    id: 'M10',
    file: 'packages/pg-prime/src/index.ts',
    from: '  TimeoutError,\n  TlsError,',
    to: '  TimeoutError,',
    what: 'TlsError leaves the root barrel again, reachable only by `e.name`',
    check: apiSnapshot,
  },
  // ── (e) the pooled handle ─────────────────────────────────────────────────
  {
    id: 'M11',
    file: 'packages/pg-prime/src/query/run.ts',
    from: '      if (stats.waiting !== 0 || stats.idle !== stats.total) {',
    to: '      if (false) {',
    also: {
      file: 'packages/pg-prime/src/query/run.ts',
      from: '    later(tick, PROBE_IDLE_POLL_MS)\n  }\n}',
      to: '    later(tick, 0)\n  }\n}',
    },
    what: 'the probe goes back to firing on the macrotask after the first acquire, ungated',
    check: live('test/live/session.test.ts'),
  },
  {
    id: 'M11b',
    file: 'packages/pg-prime/src/query/run.ts',
    from: '      if (stats.waiting !== 0 || stats.idle !== stats.total) {',
    to: '      if (false) {',
    what: 'only the GATE removed, leaving the delay: caught on the server, not by our own stats',
    check: pg('test/pg/session.test.ts'),
  },
  // ── the builder-level option methods ──────────────────────────────────────
  {
    id: 'M12',
    file: 'packages/pg-prime/src/query/select.ts',
    from: '  /** §6.2. `SET LOCAL statement_timeout` inside a transaction; a client timer plus cancel outside. */\n  timeout(ms: number): SelectBuilder {\n    return this.#next({ run: withRunOption(this.s.run, { timeoutMs: ms }) })',
    to: '  /** §6.2. `SET LOCAL statement_timeout` inside a transaction; a client timer plus cancel outside. */\n  timeout(ms: number): SelectBuilder {\n    void ms\n    return this.#next({ run: this.s.run })',
    what: '`.timeout(ms)` is a setter that sets nothing — the shape a "thin setter" fails in',
    check: unit('test/session/session.test.ts'),
  },
  {
    id: 'M13',
    file: 'packages/pg-prime/src/query/terminals.ts',
    from: '  return base === undefined ? patch : { ...base, ...patch }',
    to: '  return patch',
    what: 'a second setter REPLACES the first instead of merging, so only the last one arrives',
    check: unit('test/session/session.test.ts'),
  },
  {
    id: 'M14',
    file: 'packages/pg-prime/src/query/prepared.ts',
    from: '    const base = this.#runOptions',
    to: '    const base = undefined',
    what: 'a prepared artifact forgets the options the builder that made it carried',
    check: unit('test/session/session.test.ts'),
  },
]

const abs = (rel) => join(ROOT, rel)
const patch = (rel, from, to) => {
  const p = abs(rel)
  const s = readFileSync(p, 'utf8')
  if (!s.includes(from)) throw new Error(`${rel}: anchor not found:\n  ${from.slice(0, 90)}`)
  writeFileSync(p, s.replace(from, to))
}

let caught = 0
let survived = 0
let skipped = 0
for (const m of MUTATIONS) {
  if (only !== undefined && m.id !== only) continue
  if (m.check.needsServer === true && (PG_URL === undefined || PG_URL === '')) {
    skipped++
    console.log(`${m.id}  SKIPPED   ${m.what}\n         PG_PRIME_TEST_URL is unset (R19)`)
    continue
  }
  const touched = [[m.file, readFileSync(abs(m.file), 'utf8')]]
  if (m.also !== undefined && m.also.file !== m.file) {
    touched.push([m.also.file, readFileSync(abs(m.also.file), 'utf8')])
  }
  try {
    if (m.also !== undefined) patch(m.also.file, m.also.from, m.also.to)
    patch(m.file, m.from, m.to)
    let ok = true
    try {
      m.check.run()
    } catch {
      ok = false
    }
    if (ok) {
      survived++
      console.log(`${m.id}  SURVIVED  ${m.what}\n         nothing failed — ${m.check.what}`)
    } else {
      caught++
      console.log(`${m.id}  caught by ${m.check.what}\n         ${m.what}`)
    }
  } finally {
    for (const [rel, original] of touched) writeFileSync(abs(rel), original)
  }
}
// M10 rebuilds `dist/` from a mutated source; leaving it there would make the next `pnpm test:live`
// or `package:check` read a tree nothing in this repository produced.
if (only === undefined || only === 'M10') {
  execFileSync(process.execPath, [join(ROOT, 'tools', 'build-package.mjs')], {
    cwd: PKG,
    stdio: 'ignore',
  })
}
console.log(`\n${caught} caught, ${survived} survived, ${skipped} skipped`)
process.exit(survived === 0 ? 0 : 1)
