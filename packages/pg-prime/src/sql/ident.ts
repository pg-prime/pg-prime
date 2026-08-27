/**
 * Identifier sanitization — the one remaining sanitizer in the library (03 §3.4, D8).
 *
 * The other two CVE positions from Kysely's 2026 advisories are designed out rather than
 * patched: JSON paths are bind parameters (never text in the SQL), and `sql.lit` refuses
 * strings. That leaves identifier quoting, which is implemented here and fuzzed against a
 * live PostgreSQL with a dual oracle (`format('%I')` + CREATE TEMP TABLE roundtrip).
 *
 * ## Rules (03 §3.4, all enforced, all fuzzed)
 *
 * 1. **Parts, never a dotted string.** `ident('public', 'my.table')` is
 *    `"public"."my.table"` — two identifiers, the second of which contains a dot. There is
 *    no overload anywhere that splits a string on `.`; that overload is precisely how an
 *    attacker turns one identifier into two.
 * 2. **Always quote.** No "is this a safe bare identifier" fast path.
 * 3. **Escape by doubling `"`.** Applied to the whole part. Note that PostgreSQL — unlike
 *    MySQL — performs *no* backslash processing inside a quoted identifier, so `\` needs no
 *    special handling. (MySQL's differing rule is the root of GHSA-8cpq-38p9-67gx.)
 * 4. **Reject rather than mangle.** See the byte-limit note below.
 * 5. **Nothing else is transformed.** No case folding, trimming, or Unicode normalization —
 *    NFC would make two *distinct* PostgreSQL identifiers compare equal.
 *
 * ## The 63-byte decision: REJECT, do not truncate
 *
 * PostgreSQL's `NAMEDATALEN` is 64, so an identifier is silently truncated to **63 bytes**
 * (`pg_mbcliplen`, which additionally clips on a UTF-8 character boundary, so a 64-byte name
 * ending in a multi-byte character truncates to 62 bytes). Truncation is a *correctness*
 * hazard for a query builder, not a cosmetic one: two distinct identifiers that share a
 * 63-byte prefix collapse into the same catalog name, so `ident(a) !== ident(b)` in our
 * output but `a === b` in the database. A builder that truncates would emit a query that
 * silently addresses the wrong object. We therefore **throw `InvalidIdentifierError`**, and
 * accept the documented divergence from `format('%I')` (which does not truncate either — it
 * quotes the full string and lets the *parser* truncate later). The fuzz suite asserts this
 * divergence explicitly rather than papering over it.
 *
 * The limit is measured in **UTF-8 bytes**, not code units and not code points.
 */

import { InvalidIdentifierError, UnsafeLiteralError } from './errors.js'

/** `NAMEDATALEN - 1`. The maximum number of UTF-8 bytes PostgreSQL stores in a `name`. */
export const MAX_IDENT_BYTES = 63

/**
 * UTF-8 byte length of a string that is already known to contain no lone surrogates.
 * Computed rather than delegated to `TextEncoder` so that no allocation happens on the
 * hot path and so that the lone-surrogate → U+FFFD substitution can never mask a length.
 */
export function utf8ByteLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      // High surrogate. Callers validate pairing first, so this is a 4-byte astral char.
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** True iff `s` contains an unpaired UTF-16 surrogate code unit. */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1
      if (next < 0xdc00 || next > 0xdfff) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true // low surrogate with no preceding high surrogate
    }
  }
  return false
}

/**
 * True iff `s` contains U+0000. Written as a code-unit scan rather than a literal so that
 * no source file in this package ever needs to contain a raw NUL byte.
 */
export function hasNul(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0) return true
  }
  return false
}

/**
 * Validate and quote a single identifier part.
 *
 * This is one of exactly two functions in the library that can place a non-`$n`,
 * non-compile-time-constant string into the output SQL (the other is `unsafeRaw`).
 * The whole injection audit surface for identifiers is these ~15 lines.
 */
export function quoteIdentPart(part: unknown, index = 0): string {
  if (typeof part !== 'string') {
    throw new InvalidIdentifierError(
      'not-a-string',
      index,
      part,
      `expected a string, received ${part === null ? 'null' : typeof part}`,
    )
  }
  if (part.length === 0) {
    throw new InvalidIdentifierError(
      'empty',
      index,
      part,
      'the empty string is not a valid identifier (PostgreSQL rejects `""`)',
    )
  }
  if (hasNul(part)) {
    throw new InvalidIdentifierError(
      'nul-byte',
      index,
      part,
      'contains U+0000, which cannot be transmitted in the PostgreSQL wire protocol',
    )
  }
  if (hasLoneSurrogate(part)) {
    throw new InvalidIdentifierError(
      'lone-surrogate',
      index,
      part,
      'contains an unpaired UTF-16 surrogate, which has no UTF-8 encoding',
    )
  }
  const bytes = utf8ByteLength(part)
  if (bytes > MAX_IDENT_BYTES) {
    throw new InvalidIdentifierError(
      'too-long',
      index,
      part,
      `is ${bytes} UTF-8 bytes; PostgreSQL truncates identifiers to ${MAX_IDENT_BYTES} bytes ` +
        `(NAMEDATALEN - 1), which can silently collide two distinct names, so it is rejected`,
    )
  }
  return `"${part.replaceAll('"', '""')}"`
}

/**
 * Validate and quote a dotted path of identifier parts, e.g. `["public", "users"]` →
 * `"public"."users"`. Each part is quoted independently; the `.` separators are the only
 * characters the caller does not control.
 */
export function quoteIdentPath(parts: readonly unknown[]): string {
  if (parts.length === 0) {
    throw new InvalidIdentifierError('no-parts', 0, parts, 'at least one part is required')
  }
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) out += '.'
    out += quoteIdentPart(parts[i], i)
  }
  return out
}

/**
 * The **only** string-literal quoter on the query path, and it is not reachable from user
 * input: it exists solely so the compiler can emit `json_build_object('key', …)` key names,
 * which are projection keys from a compile-time object literal (03 §2.3 point 2).
 * `sql.lit` still refuses strings; nothing routes caller data here.
 *
 * It is nevertheless written to be correct under both settings of
 * `standard_conforming_strings`, because that is the exact difference that produced Kysely's
 * GHSA-8cpq-38p9-67gx (their quoter doubled `'` but did not handle `\`):
 *
 *  - no backslash present → plain `'…'` with `'` doubled. Safe under either setting, since
 *    `''` is the only escape a standard string has.
 *  - backslash present → PostgreSQL's `E'…'` form with `'` doubled *and* `\` doubled, which
 *    pins escape processing on regardless of the server setting.
 *
 * NUL and lone surrogates are rejected rather than mangled, same as identifiers.
 */
export function quoteStringLiteral(s: string): string {
  // The package's own hierarchy, with a `code`, rather than TypeError/RangeError: a consumer
  // catching `PgPrimeError` should not have to know that one quoter throws host errors.
  if (typeof s !== 'string') {
    throw new UnsafeLiteralError(
      `quoteStringLiteral: expected a string, received ${typeof s}`,
    )
  }
  if (hasNul(s)) {
    throw new UnsafeLiteralError(
      'quoteStringLiteral: string contains U+0000, which cannot be transmitted in the ' +
        'PostgreSQL wire protocol',
    )
  }
  if (hasLoneSurrogate(s)) {
    throw new UnsafeLiteralError(
      'quoteStringLiteral: string contains an unpaired UTF-16 surrogate, which has no UTF-8 ' +
        'encoding',
    )
  }
  const quoted = s.replaceAll("'", "''")
  return s.includes('\\') ? `E'${quoted.replaceAll('\\', '\\\\')}'` : `'${quoted}'`
}

/** Non-throwing probe, used by tests and by tooling that wants to report rather than throw. */
export function isValidIdentPart(part: unknown): part is string {
  try {
    quoteIdentPart(part)
    return true
  } catch {
    return false
  }
}
