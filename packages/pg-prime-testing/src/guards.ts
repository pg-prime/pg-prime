/**
 * The two skip guards — design/08 §4.2, design/13 decision 1.
 *
 * PGlite is **one backend**. Two "connections" report the same `pg_backend_pid()`, `set_config`
 * and temp tables leak between them, and `pg_try_advisory_lock()` on the second returns `true`
 * where real PostgreSQL returns `false`. A test for anything that needs a second session does not
 * merely fail to be meaningful against it — **it passes, for the wrong reason**. So the answer is
 * a guard that skips *loudly*, not a comment nobody reads.
 *
 * ## Runner-agnostic on purpose
 *
 * These take the runner's own `it` and hand one back. Nothing here imports vitest — a test-helper
 * package that pins a runner is a test-helper package half its users cannot install — and
 * {@link TestDecl} is the smallest shape both `it` and `it.skip` satisfy, which is all the guard
 * needs to be able to return either.
 *
 * ```ts
 * import { it } from 'vitest'
 * import { requiresConcurrency } from '@pg-prime/testing'
 *
 * requiresConcurrency(it)('two sessions contend for the advisory lock', async () => {
 *   // …only runs when PG_PRIME_TEST_URL points at a real server
 * })
 * ```
 */

/**
 * Just enough of a runner's `it` that both `it` and `it.skip` are assignable to it.
 *
 * `vitest`'s `it`, `node:test`'s `test` and Jest's `it` all satisfy this: a callable taking
 * `(name, fn, timeout?)` with a `.skip` of the same shape. The callback's return type is
 * `unknown` rather than `void | Promise<void>` so that a runner whose callback may return a
 * fixture object (or `node:test`'s `TestContext` overload) still matches.
 */
export interface TestDecl {
  (name: string, fn: () => unknown, timeout?: number): void
  /** The same shape again, so a guard can return `it.skip` where a `TestDecl` is expected. */
  readonly skip: TestDecl
}

/**
 * The one environment variable this repository and this package read: a connection URL for a real
 * PostgreSQL. Unset means the in-process PGlite, and everything on the ban list is skipped.
 */
export const TEST_URL_ENV = 'PG_PRIME_TEST_URL'

/** Is the suite pointed at a real server? Read at call time, so a test may set it and re-ask. */
export function onRealPostgres(): boolean {
  const url = process.env[TEST_URL_ENV]
  return url !== undefined && url !== ''
}

/**
 * `it` against a real server, `it.skip` — with `reason` written to stderr — against PGlite.
 *
 * **Say why.** A skip whose reason is "PGlite" is a skip nobody can ever re-evaluate; a skip whose
 * reason is "needs a second backend to hold the row lock" is a line in a bug report.
 *
 * stderr, not `console.*`: a guard runs during *collection*, and vitest drops console output from
 * that phase unless a running task owns it — so every "loud" skip would in fact be silent.
 */
export function requiresRealPostgres(it: TestDecl, reason: string): TestDecl {
  if (onRealPostgres()) return it
  process.stderr.write(`[test] skip: ${reason} (set ${TEST_URL_ENV} to run it)\n`)
  return it.skip
}

/**
 * The specialisation for the design/08 F8 ban list: advisory-lock contention, `40001` and the
 * retry policy, deadlock detection, `SKIP LOCKED`, row- and DDL-lock waiting, `lock_timeout` under
 * contention, a killed backend, cross-session `LISTEN`/`NOTIFY`, pool semantics and pooler modes.
 */
export function requiresConcurrency(it: TestDecl): TestDecl {
  return requiresRealPostgres(
    it,
    'needs a second backend session; PGlite multiplexes every socket onto one',
  )
}
