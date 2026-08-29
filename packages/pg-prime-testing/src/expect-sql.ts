/**
 * `expectSql(query, { text, values })` — the golden-string assertion for emitted SQL
 * (design/08 §4.1: "every SQL-emitting path gets a golden-string assertion").
 *
 * ```ts
 * const q = compileOnly(schema)
 *   .from(schema.h.users)
 *   .select(({ users: u }) => ({ id: u.id }))
 *   .where(({ users: u }) => eq(u.email, 'ada@example.com'))
 *
 * expectSql(q, {
 *   text: `select "users"."id" as "id"
 *          from "public"."users" as "users"
 *          where "users"."email" = $1`,
 *   values: ['ada@example.com'],
 * })
 * ```
 *
 * ## Why `compileOnly`
 *
 * `compileOnly(schema)` builds an executor that can compile a query and cannot run one, so the
 * assertion needs no database, no pool and no `await` — which is what makes it a tier-0 test. It
 * works on anything with a `compile()`, including a query built from a live `Db`, but reaching for
 * a connection to assert a string is a slower way to learn the same thing.
 *
 * ## Whitespace
 *
 * Both sides are normalised — leading and trailing space trimmed off every line, blank lines
 * dropped, runs of spaces collapsed — so the expected text can be indented to match the code
 * around it. Nothing *inside* a string literal is touched, because the comparison happens after
 * the compiler has already produced its one-line-per-clause output and pg-prime never emits a
 * value into the SQL text (every value is a `$n`); if that ever changes, this is the assertion
 * that will report it as a diff rather than hide it.
 *
 * ## The failure message is a diff
 *
 * A thrown `Error` whose message is a unified diff, not "expected X to equal Y" with two 600-
 * character strings on one line each. A SQL golden is read by eye; the only useful failure output
 * is the two lines that differ.
 */

/** The compiled shape this assertion reads. `Compiled<Row>` from `pg-prime` satisfies it. */
export interface CompiledLike {
  readonly sql: string
  readonly binds: readonly unknown[]
}

/** Anything that compiles to SQL: every `pg-prime` query builder terminal has this. */
export interface CompilableLike {
  compile(): CompiledLike
}

export interface SqlExpectation {
  /** The SQL, whitespace-insensitive. */
  readonly text: string
  /**
   * The bind values in `$1..$n` order, **as they go on the wire** — i.e. after the codec has
   * encoded them, which is what `Compiled.binds` carries. A `bigint` column's bind is `'1'`, a
   * `jsonb` column's is the serialised document, `null` stays `null`. Omit to assert only the
   * text.
   */
  readonly values?: readonly unknown[]
}

/**
 * Assert a query's compiled SQL, and optionally its binds.
 *
 * Throws an `Error` whose message is a unified diff. Returns the compiled artifact, so a test that
 * wants to go on and assert something else about it does not have to compile twice.
 */
export function expectSql(query: CompilableLike, expected: SqlExpectation): CompiledLike {
  const compiled = query.compile()
  const actualText = normaliseSql(compiled.sql)
  const wantText = normaliseSql(expected.text)
  const problems: string[] = []
  if (actualText !== wantText) {
    problems.push(unifiedDiff('sql', wantText.split('\n'), actualText.split('\n')))
  }
  if (expected.values !== undefined) {
    const actualValues = compiled.binds.map(bindValue)
    if (!sameValues(actualValues, expected.values)) {
      problems.push(
        unifiedDiff('values', expected.values.map(showValue), actualValues.map(showValue)),
      )
    }
  }
  if (problems.length > 0) throw new Error(`expectSql: SQL did not match\n\n${problems.join('\n')}`)
  return compiled
}

/**
 * Trim every line, drop the blank ones, collapse internal runs of whitespace.
 *
 * Exported because a test that asserts something `expectSql` does not cover — a fragment, a
 * `.explain()` plan — wants the same rule rather than a second one.
 */
export function normaliseSql(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.trim().replaceAll(/[ \t]+/g, ' '))
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * The wire value of one bind.
 *
 * `Compiled.binds` is a union: `{ k: 'value', encoded, oid }` for a value the compiler has already
 * run through its codec, and `{ k: 'slot', name, codec }` for a prepared query's unfilled
 * placeholder. A slot has no value yet, so it shows as `:name` — which is both what a reader
 * expects and something no encoded value can collide with (an encoded value is a string, a
 * `Uint8Array` or `null`).
 */
function bindValue(bind: unknown): unknown {
  if (typeof bind !== 'object' || bind === null) return bind
  const b = bind as { k?: unknown; encoded?: unknown; name?: unknown }
  if (b.k === 'value') return b.encoded
  if (b.k === 'slot') return `:${String(b.name)}`
  return bind
}

function sameValues(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false
  return a.every((x, i) => sameValue(x, b[i]))
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((byte, i) => byte === b[i])
  }
  return Object.is(a, b) || showValue(a) === showValue(b)
}

function showValue(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'bigint') return `${v}n`
  if (v instanceof Uint8Array) {
    return `\\x${Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('')}`
  }
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/**
 * A unified diff of two small line lists.
 *
 * Hand-rolled rather than pulled from a package: this package ships zero runtime dependencies, and
 * a golden SQL string is a handful of lines where the longest-common-subsequence table is free.
 */
function unifiedDiff(label: string, want: readonly string[], got: readonly string[]): string {
  const out = [`--- expected ${label}`, `+++ actual ${label}`]
  for (const [op, line] of lcsDiff(want, got)) out.push(`${op}${line}`)
  return out.join('\n')
}

/** `[' ' | '-' | '+', line]` pairs, via the textbook LCS table. */
function lcsDiff(a: readonly string[], b: readonly string[]): [' ' | '-' | '+', string][] {
  const n = a.length
  const m = b.length
  // table[i][j] = length of the LCS of a[i..] and b[j..].
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = table[i]
      const next = table[i + 1]
      if (!row || !next) continue
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const out: [' ' | '-' | '+', string][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([' ', a[i] ?? ''])
      i++
      j++
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      out.push(['-', a[i] ?? ''])
      i++
    } else {
      out.push(['+', b[j] ?? ''])
      j++
    }
  }
  for (; i < n; i++) out.push(['-', a[i] ?? ''])
  for (; j < m; j++) out.push(['+', b[j] ?? ''])
  return out
}
