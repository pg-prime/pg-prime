/**
 * `sql.ident` — the one remaining sanitizer (03 §3.4, D8).
 *
 * The live differential fuzz lives in `test/fuzz/`; this file pins the *rules* so a
 * regression names the rule it broke.
 */

import { describe, expect, it } from 'vitest'
import { InvalidIdentifierError } from '../../src/sql/errors.js'
import { sql } from '../../src/sql/fragment.js'
import {
  MAX_IDENT_BYTES,
  hasLoneSurrogate,
  hasNul,
  isValidIdentPart,
  quoteIdentPart,
  quoteIdentPath,
  utf8ByteLength,
} from '../../src/sql/ident.js'
import { text } from './_helpers.js'

const NUL = String.fromCharCode(0)
const LONE_HIGH = String.fromCharCode(0xd83d)
const LONE_LOW = String.fromCharCode(0xdc00)

describe('rule 1 — parts, never a dotted string', () => {
  it('a dot inside a part stays inside ONE identifier', () => {
    // The overload that splits on `.` is precisely how an attacker turns one identifier into
    // two, so it does not exist. `my.table` is a single (weird) table name.
    expect(text(sql.ident('public', 'my.table'))).toBe('"public"."my.table"')
    expect(text(sql.ident('a.b'))).toBe('"a.b"')
  })

  it('accepts both the varargs and the array call shape, identically', () => {
    expect(text(sql.ident('public', 'users'))).toBe('"public"."users"')
    expect(text(sql.ident(['public', 'users']))).toBe('"public"."users"')
  })

  it('requires at least one part', () => {
    expect(() => sql.ident(...([] as unknown as [string]))).toThrow(InvalidIdentifierError)
    expect(() => sql.ident([] as unknown as [string])).toThrow(InvalidIdentifierError)
  })
})

describe('rule 2 — always quote', () => {
  it('quotes even a boring lowercase identifier', () => {
    // No "is this safe bare?" fast path: an unquoted-when-safe optimisation is where
    // quote_ident-style bugs live, and quoting is free.
    expect(quoteIdentPart('users')).toBe('"users"')
    expect(quoteIdentPart('_x')).toBe('"_x"')
  })

  it('quotes reserved keywords without special-casing them', () => {
    for (const kw of ['select', 'from', 'table', 'user', 'order', 'group', 'all', 'end']) {
      expect(quoteIdentPart(kw)).toBe(`"${kw}"`)
    }
  })

  it('preserves case exactly (no folding)', () => {
    expect(quoteIdentPart('MixedCase')).toBe('"MixedCase"')
    expect(quoteIdentPart('ÄÖÜ')).toBe('"ÄÖÜ"')
  })
})

describe('rule 3 — escape by doubling the double quote', () => {
  it('doubles every double quote in the part', () => {
    expect(quoteIdentPart('a"b')).toBe('"a""b"')
    expect(quoteIdentPart('""')).toBe('""""""')
    expect(quoteIdentPart('"')).toBe('""""')
    expect(quoteIdentPart('a""b')).toBe('"a""""b"')
  })

  it('leaves backslashes alone — PostgreSQL does no backslash processing in "..."', () => {
    // This is the exact difference behind GHSA-8cpq-38p9-67gx (a MySQL-shaped bug). Doubling
    // a backslash here would MANGLE the identifier, not protect it.
    expect(quoteIdentPart('a\\b')).toBe('"a\\b"')
    expect(quoteIdentPart('\\')).toBe('"\\"')
    expect(quoteIdentPart('\\"')).toBe('"\\"""')
  })

  it('never lets an injection payload escape the quotes', () => {
    const payloads = [
      '"; drop table users; --',
      'x" from users; select pg_sleep(10); --',
      "'; drop table users; --",
      'a"; create role hacker superuser; --',
      '*/; drop table users; /*',
    ]
    for (const payload of payloads) {
      const out = quoteIdentPart(payload)
      expect(out.startsWith('"')).toBe(true)
      expect(out.endsWith('"')).toBe(true)
      // The token invariant: every internal `"` run has even length, so no run can terminate
      // the token early.
      const inner = out.slice(1, -1)
      for (const run of inner.match(/"+/g) ?? []) expect(run.length % 2).toBe(0)
    }
  })
})

describe('rule 4 — reject rather than mangle', () => {
  it('rejects non-strings', () => {
    for (const bad of [null, undefined, 1, 1n, true, {}, [], Symbol('x')]) {
      expect(() => quoteIdentPart(bad)).toThrow(InvalidIdentifierError)
    }
    expect(() => quoteIdentPart(null)).toThrowError(/not-a-string/)
  })

  it('rejects the empty string', () => {
    expect(() => quoteIdentPart('')).toThrowError(/empty/)
  })

  it('rejects U+0000 anywhere in the part', () => {
    expect(() => quoteIdentPart(NUL)).toThrowError(/nul-byte/)
    expect(() => quoteIdentPart(`a${NUL}b`)).toThrowError(/nul-byte/)
    // A NUL after a valid prefix is the classic truncation smuggle.
    expect(() => quoteIdentPart(`users${NUL}; drop table x`)).toThrowError(/nul-byte/)
  })

  it('rejects unpaired surrogates (they have no UTF-8 encoding)', () => {
    expect(() => quoteIdentPart(LONE_HIGH)).toThrowError(/lone-surrogate/)
    expect(() => quoteIdentPart(LONE_LOW)).toThrowError(/lone-surrogate/)
    expect(() => quoteIdentPart(`a${LONE_HIGH}`)).toThrowError(/lone-surrogate/)
    expect(() => quoteIdentPart(`${LONE_LOW}${LONE_HIGH}`)).toThrowError(/lone-surrogate/)
    // A well-formed astral pair is fine.
    expect(quoteIdentPart('\u{1F600}')).toBe('"\u{1F600}"')
  })

  it('reports the offending index in a multi-part path', () => {
    try {
      quoteIdentPath(['ok', 'also_ok', ''])
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidIdentifierError)
      expect((e as InvalidIdentifierError).index).toBe(2)
      expect((e as InvalidIdentifierError).reason).toBe('empty')
    }
  })
})

describe('the 63-byte decision — REJECT, do not truncate', () => {
  it('MAX_IDENT_BYTES is NAMEDATALEN - 1', () => {
    expect(MAX_IDENT_BYTES).toBe(63)
  })

  it('accepts exactly 63 bytes and rejects 64', () => {
    expect(quoteIdentPart('a'.repeat(63))).toBe(`"${'a'.repeat(63)}"`)
    expect(() => quoteIdentPart('a'.repeat(64))).toThrowError(/too-long/)
  })

  it('measures BYTES, not code units and not code points', () => {
    // 'é' is 2 UTF-8 bytes: 32 chars = 64 bytes => rejected, 31 chars = 62 bytes => fine.
    expect(utf8ByteLength('é')).toBe(2)
    expect(() => quoteIdentPart('é'.repeat(32))).toThrowError(/too-long/)
    expect(isValidIdentPart('é'.repeat(31))).toBe(true)

    // '漢' is 3 bytes; '😀' is 4.
    expect(utf8ByteLength('漢')).toBe(3)
    expect(utf8ByteLength('\u{1F600}')).toBe(4)
    expect(isValidIdentPart('漢'.repeat(21))).toBe(true) // 63
    expect(isValidIdentPart('漢'.repeat(22))).toBe(false) // 66
    expect(isValidIdentPart('\u{1F600}'.repeat(15))).toBe(true) // 60
    expect(isValidIdentPart('\u{1F600}'.repeat(16))).toBe(false) // 64
  })

  it('is a correctness rule, not a cosmetic one: truncation collides distinct names', () => {
    // PostgreSQL clips to 63 bytes, so these two DISTINCT identifiers name the SAME object in
    // the catalog. A builder that truncated would emit a query addressing the wrong table
    // with no error anywhere. Rejecting is the only lossless answer.
    const a = `${'x'.repeat(63)}_alpha`
    const b = `${'x'.repeat(63)}_beta`
    expect(a).not.toBe(b)
    expect(a.slice(0, 63)).toBe(b.slice(0, 63))
    expect(() => quoteIdentPart(a)).toThrow(InvalidIdentifierError)
    expect(() => quoteIdentPart(b)).toThrow(InvalidIdentifierError)
  })
})

describe('rule 5 — nothing else is transformed', () => {
  it('does not NFC-normalise (which would merge two distinct PG identifiers)', () => {
    const composed = 'é' // é
    const decomposed = 'é' // e + combining acute
    expect(composed).not.toBe(decomposed)
    expect(quoteIdentPart(composed)).toBe(`"${composed}"`)
    expect(quoteIdentPart(decomposed)).toBe(`"${decomposed}"`)
    expect(quoteIdentPart(composed)).not.toBe(quoteIdentPart(decomposed))
  })

  it('does not trim, case-fold, or strip zero-width / bidi characters', () => {
    for (const s of [' x ', '\tx', 'a​b', 'a‍b', 'a‮b', 'a⁦b', 'x\n']) {
      expect(quoteIdentPart(s)).toBe(`"${s}"`)
    }
  })
})

describe('helper predicates', () => {
  it('hasNul / hasLoneSurrogate agree with the rejection rules', () => {
    expect(hasNul('')).toBe(false)
    expect(hasNul(`a${NUL}`)).toBe(true)
    expect(hasLoneSurrogate('\u{1F600}')).toBe(false)
    expect(hasLoneSurrogate(LONE_HIGH)).toBe(true)
    expect(hasLoneSurrogate(`${LONE_HIGH}a`)).toBe(true)
  })

  it('isValidIdentPart never throws', () => {
    for (const bad of [null, '', NUL, LONE_HIGH, 'a'.repeat(64), 42]) {
      expect(isValidIdentPart(bad)).toBe(false)
    }
    expect(isValidIdentPart('users')).toBe(true)
  })
})

describe('validation happens at sql.ident() call time, not at compile() time', () => {
  it('throws at the call site so the stack points at the caller', () => {
    // A reused fragment also quotes once rather than once per compile.
    expect(() => sql.ident('a'.repeat(64))).toThrow(InvalidIdentifierError)
  })

  it('the compiled fragment splices the pre-quoted text verbatim', () => {
    expect(text(sql`select * from ${sql.ident('public', 'a"b')}`)).toBe(
      'select * from "public"."a""b"',
    )
  })
})
