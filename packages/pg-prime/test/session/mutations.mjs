/**
 * R10 for design/12 §3 S: mutate one line, run the suite that claims to catch it, assert RED.
 *
 * Not a mutation-testing framework — a recorded, re-runnable list. Each entry names the file, the
 * exact line it rewrites, the tier that must go red, and why that mutation is the one worth making:
 * a mutation nothing catches is a test that does not exist, and three of the twenty here were
 * exactly that when first run (M4, M7, M19 — see the RESULT table in design/12).
 *
 *     cd packages/pg-prime
 *     node test/session/mutations.mjs            # all twenty
 *     node test/session/mutations.mjs M7 M13     # a subset
 *
 * It restores the file in a `finally`, so an interrupted run leaves nothing behind, and
 * `git diff src` afterwards is the check. Deliberately not a `.test.ts`: it edits the source tree,
 * so it must never be something `pnpm test` picks up.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const MUTATIONS = [
  // ── §3.1 the BEGIN text ────────────────────────────────────────────────────
  {
    id: 'M1',
    file: 'src/session/transaction.ts',
    from: '  if (opts.accessMode !== undefined) sql += ` ${opts.accessMode}`',
    to: '  // accessMode dropped',
    why: 'BEGIN silently loses READ ONLY — the transaction would be writable when the caller asked for a read.',
    run: 'unit:test/session/session.test.ts',
  },
  {
    id: 'M2',
    file: 'src/session/transaction.ts',
    from: "    if (opts.isolation !== 'serializable' || opts.accessMode !== 'read only') {",
    to: '    if (false) {',
    why: 'DEFERRABLE accepted where PostgreSQL silently IGNORES it — the exact lie 07 §3.1 refuses to tell.',
    run: 'unit:test/session/session.test.ts',
  },
  // ── §3.3 savepoints ────────────────────────────────────────────────────────
  {
    id: 'M3',
    file: 'src/session/transaction.ts',
    from: '  return `"pgprime_sp_${depth}"`',
    to: '  return `pgprime_sp_${depth}`',
    why: 'Savepoint names stop being identifier-quoted — 07 §3.3 says "always", and a name that needs quoting breaks.',
    run: 'unit:test/session/session.test.ts',
  },
  {
    id: 'M4',
    file: 'src/session/handles.ts',
    from: '    // The rollback un-poisoned the enclosing transaction; a later 25P02 would now be a lie.\n    parent.poison.error = undefined',
    to: '    void parent',
    why: 'A savepoint rollback stops un-poisoning the transaction, so a later 25P02 blames a stale error.',
    run: 'unit:test/session/session.test.ts',
  },
  // ── §3.4 retry ─────────────────────────────────────────────────────────────
  {
    id: 'M5',
    file: 'src/session/transaction.ts',
    from: "const DEFAULT_ON: readonly string[] = Object.freeze(['40001'])",
    to: "const DEFAULT_ON: readonly string[] = Object.freeze(['40001', '40P01'])",
    why: 'Deadlocks retried by default — 07 §3.4 turns a reproducible lock-ordering bug into a latency spike.',
    run: 'unit:test/session/session.test.ts',
  },
  {
    id: 'M6',
    file: 'src/session/transaction.ts',
    from: '      return random() * ceiling',
    to: '      return ceiling',
    why: 'Full jitter becomes plain exponential — correlated 40001s then retry in lockstep and re-conflict.',
    run: 'unit:test/session/session.test.ts',
  },
  {
    id: 'M7',
    file: 'src/session/handles.ts',
    from: '  if (e instanceof IndeterminateCommitError) return undefined',
    to: '  if (false) return undefined',
    why: 'A transaction that MAY HAVE COMMITTED is retried. This is the double-charge, and 07 §3.4 calls it the single most important correctness decision in the section.',
    run: 'unit:test/session/session.test.ts',
  },
  {
    id: 'M8',
    file: 'src/session/handles.ts',
    from: '    if (commitWritten && lostConnection(raw)) {',
    to: '    if (false) {',
    why: 'The COMMIT window stops being detected at all; a lost acknowledgement looks like an ordinary connection error.',
    run: 'unit:test/session/session.test.ts',
  },
  // ── §3.5 set_config ────────────────────────────────────────────────────────
  {
    id: 'M9',
    file: 'src/session/transaction.ts',
    from: '  for (let i = 0; i < count; i++) calls.push(`set_config($${i * 2 + 1},$${i * 2 + 2},${local})`)',
    to: '  for (let i = 0; i < count; i++) calls.push(`set_config($${i * 2 + 1},$${i * 2 + 2},false)`)',
    why: 'SET LOCAL becomes SET — a tenant id leaks out of the transaction and, behind a pooler, onto another client.',
    run: 'unit:test/session/session.test.ts',
  },
  {
    id: 'M10',
    file: 'src/session/runner.ts',
    from: "      params: ['statement_timeout', want === undefined ? null : String(want)],",
    to: "      params: ['statement_timeout', want === undefined ? '0' : String(want)],",
    why: 'Restoring a per-statement timeout DISABLES the transaction s own instead of putting it back.',
    run: 'unit:test/session/session.test.ts',
  },
  // ── §1.5 the dev guard ─────────────────────────────────────────────────────
  {
    id: 'M11',
    file: 'src/session/runner.ts',
    from: "    if (this.#handle !== 'db') return",
    to: '    return',
    why: 'The outer-db-inside-a-transaction guard never fires — Drizzle s #1 bug, unguarded.',
    run: 'unit:test/session/session.test.ts',
  },
  // ── §4 error mapping ───────────────────────────────────────────────────────
  {
    id: 'M12',
    file: 'src/errors/sqlstate.ts',
    from: '  return SQLSTATE_MAP[code] ?? SQLSTATE_CLASS_FALLBACK[code.slice(0, 2)] ?? UnknownQueryError',
    to: '  return SQLSTATE_MAP[code] ?? UnknownQueryError',
    why: 'An unmodelled SQLSTATE stops landing on its class ancestor — 07 §4.1 rule 3, the thing that makes adding a leaf later non-breaking.',
    run: 'unit:test/session/session.test.ts',
  },
  {
    id: 'M13',
    file: 'src/errors/redact.ts',
    from: "  if (sqlstate === '40P01') return { detail, detailRedacted: false }",
    to: '  if (false) return { detail, detailRedacted: false }',
    why: 'A deadlock loses the DETAIL that names both processes and both relations — the only thing that makes 40P01 diagnosable.',
    run: 'pg:test/pg/session.test.ts',
  },
  {
    id: 'M14',
    file: 'src/errors/redact.ts',
    from: '  return { detail: `Key (${cols})=(…) [values redacted]${suffix}`, detailRedacted: true }',
    to: '  return { detail, detailRedacted: true }',
    why: 'The duplicate-signup leak: a unique violation puts the user s email address in the log line.',
    run: 'unit:test/session/session.test.ts',
  },
  // ── §6.5 LISTEN ────────────────────────────────────────────────────────────
  {
    id: 'M15',
    file: 'src/session/listen.ts',
    from: '  if (bytes < MAX_NOTIFY_PAYLOAD_BYTES) return',
    to: '  if (bytes <= MAX_NOTIFY_PAYLOAD_BYTES) return',
    why: 'The off-by-one PostgreSQL actually has: 8000 bytes is already too long, so the client check stops catching it.',
    run: 'pg:test/pg/session-listen.test.ts',
  },
  {
    id: 'M16',
    file: 'src/session/listen.ts',
    from: "          for (const channel of this.#channels.keys()) {\n            this.#emit(channel, 'reconnect', { attempt, downMs })\n            this.#emit(channel, 'gap', { downMs })\n          }",
    to: "          for (const channel of this.#channels.keys()) {\n            this.#emit(channel, 'reconnect', { attempt, downMs })\n          }",
    why: 'The reconnect stops emitting `gap` — notifications lost during the outage become silently lost, which 07 §6.5 calls the correctness feature.',
    run: 'pg:test/pg/session-listen.test.ts',
  },
  // ── §5 pooler ──────────────────────────────────────────────────────────────
  {
    id: 'M17',
    file: 'src/session/gucs.ts',
    from: "  if (profile.sessionGucsAtConnect === 'unsafe') {",
    to: '  if (false) {',
    why: 'Session GUCs are SET at connect behind a transaction pooler — the setting leaks across tenants (07 §3.6).',
    run: 'pg:test/pg/session-pooler.test.ts',
  },
  {
    id: 'M18',
    file: 'src/session/handles.ts',
    from: "  if (state.profile.sessionHandle === 'unsupported') {",
    to: '  if (false) {',
    why: 'db.session() is allowed under a transaction pooler, where "the same backend" is exactly the guarantee it does not make.',
    run: 'unit:test/session/session.test.ts',
  },
  // ── §6.6 COPY ──────────────────────────────────────────────────────────────
  {
    id: 'M19',
    file: 'src/session/copy.ts',
    from: "    else if (c === 9) esc = '\\\\t'",
    to: '    else if (c === 9) continue',
    why: 'A tab inside a value stops being escaped, so one COPY row silently becomes a different number of columns.',
    run: 'live:test/live/session.test.ts',
  },
  {
    id: 'M20',
    file: 'src/session/handles.ts',
    from: '      const encoded = col.codec.encode(value as never)',
    to: '      const encoded = String(value)',
    why: 'COPY stops encoding through the codecs — a numeric rounds and a timestamptz localises.',
    run: 'pg:test/pg/session-copy.test.ts',
    fileOverride: 'src/session/copy.ts',
  },
]

const args = process.argv.slice(2)
const only = args.length > 0 ? new Set(args) : undefined

function runSuite(spec) {
  const [project, files] = spec.split(':')
  const env = { ...process.env }
  if (project === 'pg') {
    env['PG_PRIME_TEST_URL'] ??= 'postgres://postgres:postgres@127.0.0.1:54334/postgres'
    env['PG_PRIME_TEST_PGBOUNCER_URL'] ??= 'postgres://postgres:postgres@127.0.0.1:56434/postgres'
  }
  if (project === 'live')
    env['PG_PRIME_TEST_URL'] ??= 'postgres://postgres:postgres@127.0.0.1:54334/postgres'
  try {
    execFileSync(
      'npx',
      ['vitest', 'run', '--project', project === 'unit' ? 'unit' : project, ...files.split('+')],
      { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    )
    return { red: false }
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    const m = /(\d+) failed/.exec(out)
    const first = /FAIL\s+\|[a-z]+\|\s+(.*)/.exec(out)
    return { red: true, failed: m?.[1] ?? '?', where: first?.[1]?.trim() ?? '' }
  }
}

const rows = []
for (const mut of MUTATIONS) {
  if (only && !only.has(mut.id)) continue
  const file = mut.fileOverride ?? mut.file
  const original = readFileSync(file, 'utf8')
  if (!original.includes(mut.from)) {
    rows.push({ ...mut, status: 'NOT APPLIED (line not found)' })
    console.log(`${mut.id}  !! line not found in ${file}`)
    continue
  }
  writeFileSync(file, original.replace(mut.from, mut.to))
  try {
    const r = runSuite(mut.run)
    rows.push({ id: mut.id, file, why: mut.why, run: mut.run, ...r })
    console.log(
      `${mut.id}  ${r.red ? `RED (${r.failed} failed) ${r.where}` : '*** GREEN — NOTHING CAUGHT IT ***'}`,
    )
  } finally {
    writeFileSync(file, original)
  }
}
console.log(`\n${rows.filter((r) => r.red).length}/${rows.length} caught`)
