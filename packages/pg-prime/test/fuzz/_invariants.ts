/**
 * The SQL-shape invariants the compiler fuzzer and the builder fuzzer both assert (design/09 WS7).
 *
 * Extracted from `compiler-fuzz.test.ts`, which had the only copy. Two fuzzers with two tokenizers
 * is two things to get wrong, and the tokenizer is load-bearing: invariant (c) is only as good as
 * the thing that decides what a statement separator is. Its own unit test moved with it
 * (`compiler-fuzz.test.ts` still runs it, because that is where a reviewer looks for it).
 */

/**
 * Count `;` that are NOT inside a single-quoted string or a double-quoted identifier.
 *
 * Invariant (c): a compiled statement is exactly one statement. A bind value that escaped quoting
 * and happened to contain `;` is the shape this catches — and it is the shape that turns a query
 * into a script.
 */
export function statementCount(text: string): number {
  let inStr = false
  let inIdent = false
  let n = 1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === "'") inStr = text[i + 1] === "'" ? (i++, true) : false
      else if (ch === '\\') i++
    } else if (inIdent) {
      if (ch === '"') inIdent = text[i + 1] === '"' ? (i++, true) : false
    } else if (ch === "'") inStr = true
    else if (ch === '"') inIdent = true
    else if (ch === ';') n++
  }
  return n
}

/**
 * Invariant (a): the `$n` in the SQL are `$1..$len`, each exactly once, in left-to-right order.
 *
 * Returns the numbers found, so the caller can compare with `toEqual` and get a readable diff
 * rather than a boolean. A gap means a bind was allocated and never emitted; a repeat means one
 * `$n` is doing two jobs; the wrong order means numbering is not a single pass.
 */
export function placeholderNumbers(sql: string): number[] {
  return [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))
}

/** `[1, 2, …, n]` — what {@link placeholderNumbers} must equal. */
export function denseRange(n: number): number[] {
  return Array.from({ length: n }, (_unused, i) => i + 1)
}
