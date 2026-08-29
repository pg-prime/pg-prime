/**
 * Tier 0 for the guards. The interesting assertion is the first one: **vitest's own `it` is
 * assignable to `TestDecl`** — that is the whole claim of "runner-agnostic", and a type-level
 * regression in it would otherwise only surface in somebody else's repository.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { TestDecl } from '../../src/guards.js'
import {
  onRealPostgres,
  requiresConcurrency,
  requiresRealPostgres,
  TEST_URL_ENV,
} from '../../src/guards.js'

/** The claim, checked by the compiler rather than by a runtime assertion. */
const vitestIt: TestDecl = it

const original = process.env[TEST_URL_ENV]
afterEach(() => {
  if (original === undefined) delete process.env[TEST_URL_ENV]
  else process.env[TEST_URL_ENV] = original
})

/** A stand-in runner: enough of `it` to be a `TestDecl`, recording which half was handed back. */
function fakeRunner(): { decl: TestDecl; ran: string[]; skipped: string[] } {
  const ran: string[] = []
  const skipped: string[] = []
  const skip = ((name: string) => void skipped.push(name)) as unknown as TestDecl
  Object.defineProperty(skip, 'skip', { value: skip })
  const decl = ((name: string) => void ran.push(name)) as unknown as TestDecl
  Object.defineProperty(decl, 'skip', { value: skip })
  return { decl, ran, skipped }
}

describe('guards', () => {
  it("vitest's `it` satisfies TestDecl", () => {
    expect(typeof vitestIt).toBe('function')
    expect(typeof vitestIt.skip).toBe('function')
  })

  it('returns `it` when PG_PRIME_TEST_URL is set', () => {
    process.env[TEST_URL_ENV] = 'postgres://user:pass@127.0.0.1:5433/db'
    const runner = fakeRunner()
    expect(onRealPostgres()).toBe(true)
    requiresRealPostgres(runner.decl, 'needs a real server')('a case', () => {})
    expect(runner.ran).toEqual(['a case'])
    expect(runner.skipped).toEqual([])
  })

  it('returns `it.skip` and writes the reason to stderr when it is not', () => {
    delete process.env[TEST_URL_ENV]
    const runner = fakeRunner()
    const written: string[] = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      requiresRealPostgres(runner.decl, 'needs pg_terminate_backend')('a case', () => {})
    } finally {
      process.stderr.write = write
    }
    expect(runner.ran).toEqual([])
    expect(runner.skipped).toEqual(['a case'])
    // Say WHY, and say how to run it — a skip whose reason is "PGlite" is a skip nobody revisits.
    expect(written.join('')).toContain('needs pg_terminate_backend')
    expect(written.join('')).toContain(TEST_URL_ENV)
  })

  it('treats an empty PG_PRIME_TEST_URL as unset', () => {
    process.env[TEST_URL_ENV] = ''
    expect(onRealPostgres()).toBe(false)
  })

  it('requiresConcurrency says which limit it is guarding', () => {
    delete process.env[TEST_URL_ENV]
    const runner = fakeRunner()
    const written: string[] = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      requiresConcurrency(runner.decl)('contends for a row lock', () => {})
    } finally {
      process.stderr.write = write
    }
    expect(runner.skipped).toEqual(['contends for a row lock'])
    expect(written.join('')).toContain('second backend session')
  })

  it('a guard can be chained, because `it.skip` is itself a TestDecl', () => {
    delete process.env[TEST_URL_ENV]
    const runner = fakeRunner()
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      requiresConcurrency(requiresRealPostgres(runner.decl, 'needs a real server'))('x', () => {})
    } finally {
      process.stderr.write = write
    }
    expect(runner.skipped).toEqual(['x'])
  })
})
