/**
 * PostgreSQL array-literal grammar — real parsing and real writing.
 *
 * Everything here is measured against PG 17.11. The cases every hand-rolled parser gets wrong:
 *
 *  - the delimiter is NOT always `,` — `box` and `_box` use `;`, taken from `pg_type.typdelim`.
 *    A parser that hard-codes a comma is silently wrong for geometry columns.
 *  - unquoted `NULL` (case-insensitive) is SQL NULL; quoted `"NULL"` is the four-character STRING.
 *    A writer must therefore quote the string `'NULL'` and must not quote a real null.
 *  - `\"` and `\\` are the only escapes inside a quoted element.
 *  - a non-default lower bound emits a dimension prefix: `[0:1]={a,b}`.
 *  - arrays nest: `{{1,2},{3,4}}`.
 *  - unquoted elements have surrounding whitespace trimmed; quoted ones do not.
 */

/** Parsed shape: arbitrarily nested, leaves are `string | null`. */
export type PgArrayLiteral = readonly (string | null | PgArrayLiteral)[]

export function parseArrayLiteral(raw: string, delimiter = ','): PgArrayLiteral {
  let i = 0

  // Optional dimension prefix: `[1:3]=` or `[0:1][0:1]=`
  if (raw[0] === '[') {
    const eq = raw.indexOf('=')
    if (eq === -1) throw new SyntaxError(`malformed array dimension prefix: ${raw}`)
    i = eq + 1
  }

  const parseList = (): PgArrayLiteral => {
    if (raw[i] !== '{') throw new SyntaxError(`expected "{" at ${i} in ${raw}`)
    i++
    const out: (string | null | PgArrayLiteral)[] = []
    if (raw[i] === '}') {
      i++
      return out
    }
    for (;;) {
      if (raw[i] === '{') {
        out.push(parseList())
      } else if (raw[i] === '"') {
        i++
        let s = ''
        for (;;) {
          const c = raw[i]
          if (c === undefined) throw new SyntaxError(`unterminated quoted element in ${raw}`)
          if (c === '\\') {
            const n = raw[i + 1]
            if (n === undefined) throw new SyntaxError(`dangling escape in ${raw}`)
            s += n
            i += 2
            continue
          }
          if (c === '"') {
            i++
            break
          }
          s += c
          i++
        }
        out.push(s)
      } else {
        const start = i
        while (i < raw.length && raw[i] !== delimiter && raw[i] !== '}') i++
        const tok = raw.slice(start, i).trim()
        out.push(tok.toUpperCase() === 'NULL' ? null : tok)
      }
      const c = raw[i]
      if (c === delimiter) {
        i++
        continue
      }
      if (c === '}') {
        i++
        return out
      }
      throw new SyntaxError(`expected "${delimiter}" or "}" at ${i} in ${raw}`)
    }
  }

  const result = parseList()
  if (i !== raw.length) throw new SyntaxError(`trailing garbage after array literal: ${raw}`)
  return result
}

const NEEDS_QUOTE_ALWAYS = /[{}"\\\s]/

function needsQuoting(s: string, delimiter: string): boolean {
  return (
    s === '' || s.toUpperCase() === 'NULL' || s.includes(delimiter) || NEEDS_QUOTE_ALWAYS.test(s)
  )
}

/**
 * Write an array literal. Elements are already-encoded text (or `null` for SQL NULL).
 *
 * `isLeaf` decides whether a JS array is a NESTED array or a single element that merely happens
 * to be an array. Only the ELEMENT CODEC knows: `jsonb[]` carrying `[[1, 2]]` is a one-element
 * array whose element is the JSON document `[1,2]` (`{"[1,2]"}`), not the 2-D array `{{1,2}}`
 * that `Array.isArray` alone would produce. Default: every array nests, which is right for every
 * scalar element type.
 *
 * `undefined` is NOT silently a NULL: it is handed to `encodeLeaf`, so a codec that must reject
 * it (`arrayCodec`, `unknownCodec`) can, while the default leaf encoder keeps the old behaviour
 * for callers that only ever pass strings.
 */
export function writeArrayLiteral(
  values: readonly (string | null | readonly unknown[])[],
  delimiter = ',',
  encodeLeaf: (v: unknown) => string | null = (v) => (v === null || v === undefined ? null : String(v)),
  isLeaf: (v: readonly unknown[]) => boolean = () => false,
): string {
  const part = (v: unknown): string => {
    if (v === null) return 'NULL'
    if (Array.isArray(v) && !isLeaf(v)) return `{${Array.from(v, part).join(delimiter)}}`
    const s = encodeLeaf(v)
    if (s === null) return 'NULL'
    return needsQuoting(s, delimiter) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s
  }
  // `Array.from`, not `.map`: `.map` SKIPS holes, so a sparse `[1, , 3]` joined to '{1,,3}' —
  // a literal PostgreSQL rejects. `Array.from` visits a hole as `undefined`, which `encodeLeaf`
  // then gets to reject with a real error naming the codec.
  return `{${Array.from(values, part).join(delimiter)}}`
}
