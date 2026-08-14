/**
 * Hostile identifier generator (03 §3.4).
 *
 * Hand-written, no dependency, ~1 file. Deterministic: every case is a pure function of a
 * 32-bit seed, so a failing case is reproducible from the seed printed in the report and can
 * be pinned into the regression corpus without storing the string itself.
 *
 * The bias is deliberate — a uniform Unicode sampler would spend 10 000 cases proving that
 * `ᔗ㵨` quotes fine. The interesting content is: quote/backslash runs, statement separators
 * and comment openers, NULs, lone surrogates, zero-width and bidi controls, combining marks,
 * astral (4-byte) characters, PostgreSQL keywords, and lengths straddling the 62/63/64
 * **byte** boundary (not the character boundary — that difference is the bug).
 */

// ─────────────────────────── deterministic PRNG ───────────────────────────

/** mulberry32 — small, fast, good enough for fuzzing, and exactly reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T
const int = (r: () => number, lo: number, hi: number): number =>
  lo + Math.floor(r() * (hi - lo + 1))

// ─────────────────────────── the adversarial alphabet ───────────────────────────

const NUL = String.fromCharCode(0)
const LONE_HIGH = String.fromCharCode(0xd83d)
const LONE_LOW = String.fromCharCode(0xdc00)

/** Every fragment here is either a known escape hazard or a known encoding hazard. */
export const HOSTILE_FRAGMENTS: readonly string[] = [
  // quoting / escaping
  '"',
  '""',
  '"""',
  '\\',
  '\\\\',
  '\\"',
  "'",
  "''",
  "\\'",
  // statement and comment structure
  ';',
  '--',
  '/*',
  '*/',
  ')',
  '(',
  ',',
  // whitespace and control
  '\n',
  '\r',
  '\r\n',
  '\t',
  '\v',
  '\f',
  ' ',
  '  ',
  // parameter and format-string lookalikes
  '$1',
  '$$',
  '%I',
  '%s',
  '%%',
  '::',
  '.',
  '*',
  '@',
  '#',
  '?',
  '|',
  '&',
  // Unicode: zero-width, bidi, combining, astral
  '​', // ZWSP
  '‌', // ZWNJ
  '‍', // ZWJ
  '﻿', // BOM / ZWNBSP
  '‮', // RTL override
  '‭', // LTR override
  '⁦', // LRI
  '́', // combining acute
  '̀́̂', // combining stack
  'é', // é precomposed
  'é', // é decomposed — MUST NOT compare equal to the above
  '中文', // 3-byte CJK
  '\u{1f600}', // 4-byte astral
  '\u{10000}',
  '\u{1d400}',
  'İ', // dotted capital I (Turkish casing trap)
  'ß', // ß (uppercases to SS)
  'ﷺ', // expands hugely under compatibility normalisation
  // plain content
  'a',
  'z',
  '_',
  '0',
  '9',
  'AbC',
]

/** Identifiers that are reserved words, or that `format('%I')` must quote for other reasons. */
export const PG_KEYWORDS: readonly string[] = [
  'select',
  'from',
  'where',
  'table',
  'user',
  'order',
  'group',
  'all',
  'analyse',
  'array',
  'as',
  'asc',
  'both',
  'case',
  'cast',
  'check',
  'collate',
  'column',
  'constraint',
  'create',
  'current_date',
  'default',
  'do',
  'else',
  'end',
  'except',
  'false',
  'for',
  'grant',
  'having',
  'in',
  'initially',
  'intersect',
  'into',
  'lateral',
  'leading',
  'limit',
  'localtime',
  'not',
  'null',
  'offset',
  'on',
  'only',
  'or',
  'placing',
  'primary',
  'references',
  'returning',
  'to',
  'trailing',
  'true',
  'union',
  'unique',
  'using',
  'variadic',
  'when',
  'with',
  // not reserved, but %I still quotes these because of case or leading digit
  'SELECT',
  'Select',
  '1abc',
  '_ok',
  'ok',
]

/** UTF-8 byte length (mirrors `src/sql/ident.ts`, kept separate so a bug can't cancel out). */
export function utf8Bytes(s: string): number {
  let n = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return n
}

/** Build a string of *exactly* `target` UTF-8 bytes using a mix of 1/2/3/4-byte characters. */
function exactBytes(r: () => number, target: number): string {
  const units: readonly [string, number][] = [
    ['a', 1],
    ['é', 2],
    ['中', 3],
    ['\u{1f600}', 4],
  ]
  let out = ''
  let n = 0
  while (n < target) {
    const remaining = target - n
    const usable = units.filter(([, w]) => w <= remaining)
    const [ch, w] = pick(r, usable)
    out += ch
    n += w
  }
  return out
}

export type Strategy =
  | 'keyword'
  | 'hostile-mix'
  | 'byte-boundary'
  | 'safe-ascii'
  | 'quote-storm'
  | 'nul'
  | 'lone-surrogate'
  | 'empty'
  | 'non-string'
  | 'sql-payload'

const STRATEGY_WEIGHTS: readonly (readonly [Strategy, number])[] = [
  ['hostile-mix', 30],
  ['byte-boundary', 18],
  ['keyword', 12],
  ['quote-storm', 12],
  ['safe-ascii', 8],
  ['sql-payload', 8],
  ['nul', 4],
  ['lone-surrogate', 4],
  ['empty', 2],
  ['non-string', 2],
]

const TOTAL_WEIGHT = STRATEGY_WEIGHTS.reduce((a, [, w]) => a + w, 0)

function chooseStrategy(r: () => number): Strategy {
  let x = r() * TOTAL_WEIGHT
  for (const [s, w] of STRATEGY_WEIGHTS) {
    x -= w
    if (x <= 0) return s
  }
  return 'hostile-mix'
}

export interface Case {
  readonly seed: number
  readonly strategy: Strategy
  readonly value: unknown
}

/** One deterministic case. */
export function makeCase(seed: number): Case {
  const r = rng(seed)
  const strategy = chooseStrategy(r)
  return { seed, strategy, value: build(r, strategy) }
}

function build(r: () => number, strategy: Strategy): unknown {
  switch (strategy) {
    case 'empty':
      return ''

    case 'non-string':
      return pick(r, [null, undefined, 42, 42n, true, {}, [], Symbol('s')] as const)

    case 'keyword': {
      const kw = pick(r, PG_KEYWORDS)
      // Half plain, half decorated — a keyword with a trailing quote is the interesting case.
      return r() < 0.5 ? kw : kw + pick(r, HOSTILE_FRAGMENTS)
    }

    case 'safe-ascii': {
      const alphabet = 'abcdefghijklmnopqrstuvwxyz_0123456789'
      let s = pick(r, 'abcdefghijklmnopqrstuvwxyz_'.split(''))
      for (let i = int(r, 0, 20); i > 0; i--) s += pick(r, alphabet.split(''))
      return s
    }

    case 'quote-storm': {
      let s = ''
      for (let i = int(r, 1, 12); i > 0; i--) {
        s += pick(r, ['"', '""', '\\', '\\"', '"\\', 'a', "'", '"""'])
      }
      return s
    }

    case 'nul': {
      const base = build(r, 'hostile-mix') as string
      const at = int(r, 0, base.length)
      return base.slice(0, at) + NUL + base.slice(at)
    }

    case 'lone-surrogate': {
      const base = build(r, 'safe-ascii') as string
      const at = int(r, 0, base.length)
      const lone = r() < 0.5 ? LONE_HIGH : LONE_LOW
      return base.slice(0, at) + lone + base.slice(at)
    }

    case 'byte-boundary': {
      // Straddle NAMEDATALEN - 1. 61..66 bytes exercises accept/reject on both sides, and
      // the astral cases exercise PostgreSQL's clip-on-character-boundary behaviour.
      return exactBytes(r, int(r, 61, 66))
    }

    case 'sql-payload':
      return pick(r, [
        '"; drop table users; --',
        'x" from users; select pg_sleep(5); --',
        "'; drop table users; --",
        'a"; create role hacker superuser; --',
        '*/; drop table t; /*',
        '" or 1=1 --',
        'users\\"; delete from users; --',
        '$1); drop table users; --',
        'a‮; drop table users; --',
      ])

    case 'hostile-mix':
    default: {
      let s = ''
      for (let i = int(r, 1, 10); i > 0; i--) s += pick(r, HOSTILE_FRAGMENTS)
      return s
    }
  }
}

/** A lazy stream of `count` cases starting at `baseSeed`. */
export function* cases(count: number, baseSeed = 0x5eed): Generator<Case> {
  for (let i = 0; i < count; i++) yield makeCase((baseSeed + i * 0x9e3779b1) >>> 0)
}
