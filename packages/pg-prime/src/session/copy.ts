/**
 * COPY (design/07 §6.6, and decision 9 of design/12 §1).
 *
 * ## Two tiers, because most people reaching for COPY do not need it
 *
 * Tier 1 is `insertMany` — multi-row `INSERT … VALUES`, chunked under PostgreSQL's 65 534 bind
 * parameters — and it covers about 95 % of cases with zero ceremony. Tier 2 is this file. The
 * measured crossover is in the `07` §6.6 AS BUILT note; below it `insertMany` wins on simplicity
 * and above it COPY wins on throughput, and publishing the number beats publishing a guess.
 *
 * ## No optional peer dependency
 *
 * `07` §6.6 planned on `pg-copy-streams`. It is not needed: the API that package uses is `pg`'s own
 * connection-level COPY messages (`copyInResponse` / `copyData` / `copyDone` on the way in,
 * `sendCopyFromChunk` / `endCopyFrom` on the way out), and the driver seam has had `copyIn` /
 * `copyOut` slots since `02` §2.2. Implementing them in the pg adapter keeps the promise of zero
 * dependencies *and* zero optional peers, and the public API is identical either way — which is
 * what makes the fallback in design/12 §6 cheap if a `pg` minor ever breaks it.
 *
 * ## Encoding
 *
 * Rows go out in COPY **text** format, encoded through the very codecs the insert path uses, so a
 * `numeric` is the precision-exact string and a `timestamptz` is the ISO instant — not
 * `String(value)`. Five characters are escaped and `null` is `\N`; that is the entire format.
 */

import type { AnyCodec } from '../codec/index.js'
import type { ColumnMeta } from '../compile/ast.js'
import type { PgConnection } from '../driver/types.js'
import { ConfigError, UsageError } from '../errors/index.js'
import type { TableCodecMeta } from '../query/meta.js'

/** `07` §6.6's `format`. Binary COPY is not offered: our codecs are text (`02` §4.4). */
export type CopyFormat = 'text' | 'csv'

/**
 * The five escapes COPY text format defines, and nothing else.
 *
 * A per-character loop rather than four chained `replace`s: four passes over every value of every
 * row of a 100 000-row COPY is measurable, and this is the hot loop of the feature.
 */
export function escapeCopyText(s: string): string {
  let out = ''
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    let esc: string | undefined
    if (c === 92) esc = '\\\\'
    else if (c === 9) esc = '\\t'
    else if (c === 10) esc = '\\n'
    else if (c === 13) esc = '\\r'
    else continue
    out += s.slice(start, i) + esc
    start = i + 1
  }
  return start === 0 ? s : out + s.slice(start)
}

/** RFC-4180-ish, which is what PostgreSQL's CSV reader expects. `null` is the empty *unquoted* field. */
export function escapeCopyCsv(s: string): string {
  if (!/[",\n\r]/.test(s)) return s
  return `"${s.replace(/"/g, '""')}"`
}

/** The columns a typed `copyFrom` writes, and the codec for each. */
export interface CopyColumn {
  readonly name: string
  readonly codec: AnyCodec
}

/**
 * Resolve `{ columns }` against the table, or default to every declared column in declaration
 * order — the same order `insert into t (...)` uses, so the two paths cannot disagree.
 */
export function copyColumns(meta: TableCodecMeta, requested: readonly string[] | undefined): readonly CopyColumn[] {
  const all: readonly ColumnMeta[] = meta.columns
  if (requested === undefined) return all.map((c) => ({ name: c.name, codec: c.codec }))
  const byKey = meta.byKey
  const out: CopyColumn[] = []
  for (const key of requested) {
    const hit = byKey[key] ?? all.find((c) => c.name === key)
    if (hit === undefined) {
      throw new UsageError(
        `pg-prime: copyFrom({ columns }) names "${key}", which is not a column of ` +
          `"${meta.table.name}". Known columns: ${meta.keys.join(', ')}.`,
      )
    }
    out.push({ name: hit.name, codec: hit.codec })
  }
  return out
}

/** `copy "schema"."table" ("a","b") from stdin with (format text)` — the statement, built once. */
export function copyFromSql(meta: TableCodecMeta, columns: readonly CopyColumn[], format: CopyFormat): string {
  const cols = columns.map((c) => `"${c.name.replace(/"/g, '""')}"`).join(', ')
  return `copy ${meta.table.qualified} (${cols}) from stdin with (format ${format})`
}

/**
 * Rows → COPY payload chunks.
 *
 * Batched into ~64 KiB chunks rather than one `Uint8Array` per row: a `CopyData` message per row
 * would put 100 000 protocol messages on the wire for a 100 000-row load, which is most of the
 * reason a naive COPY implementation is no faster than `insertMany`.
 */
export async function* encodeCopyRows(
  rows: AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>,
  columns: readonly CopyColumn[],
  format: CopyFormat,
  keys: readonly string[],
  highWaterMark: number,
): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder()
  const escape = format === 'csv' ? escapeCopyCsv : escapeCopyText
  const nullText = format === 'csv' ? '' : '\\N'
  const sep = format === 'csv' ? ',' : '\t'
  let buffer = ''
  for await (const row of rows as AsyncIterable<Record<string, unknown>>) {
    const cells: string[] = []
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i] as CopyColumn
      const key = keys[i] as string
      const value = Object.hasOwn(row, key) ? row[key] : row[col.name]
      if (value === null || value === undefined) {
        cells.push(nullText)
        continue
      }
      const encoded = col.codec.encode(value as never)
      if (typeof encoded !== 'string') {
        throw new ConfigError(
          `pg-prime: column "${col.name}" encodes to binary (${col.codec.name}), which COPY text ` +
            `format cannot carry. Use copyFrom.raw(sql\`copy … with (format binary)\`, bytes) or ` +
            `insertMany for this table.`,
        )
      }
      cells.push(escape(encoded))
    }
    buffer += cells.join(sep)
    buffer += '\n'
    if (buffer.length >= highWaterMark) {
      yield encoder.encode(buffer)
      buffer = ''
    }
  }
  if (buffer.length > 0) yield encoder.encode(buffer)
}

/** The seam check, with the sentence that says what to do instead. */
export function assertCopyIn(conn: PgConnection, adapter: string): asserts conn is PgConnection & {
  copyIn: NonNullable<PgConnection['copyIn']>
} {
  if (conn.copyIn === undefined) {
    throw new ConfigError(
      `pg-prime: the '${adapter}' adapter does not implement COPY FROM STDIN ` +
        `(capabilities.copyIn is false). Use insertMany, which is dependency-free and covers ~95 % ` +
        `of bulk loads (07 §6.6).`,
    )
  }
}

export function assertCopyOut(conn: PgConnection, adapter: string): asserts conn is PgConnection & {
  copyOut: NonNullable<PgConnection['copyOut']>
} {
  if (conn.copyOut === undefined) {
    throw new ConfigError(
      `pg-prime: the '${adapter}' adapter does not implement COPY TO STDOUT ` +
        `(capabilities.copyOut is false).`,
    )
  }
}

/** Split a COPY TO byte stream into lines, for the convenience iterator over rows of text. */
export async function* copyLines(chunks: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder()
  let carry = ''
  for await (const chunk of chunks) {
    carry += decoder.decode(chunk, { stream: true })
    let nl = carry.indexOf('\n')
    while (nl >= 0) {
      yield carry.slice(0, nl)
      carry = carry.slice(nl + 1)
      nl = carry.indexOf('\n')
    }
  }
  carry += decoder.decode()
  if (carry.length > 0) yield carry
}
