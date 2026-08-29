/**
 * Tier 0 — the COPY statement `copyFrom(table, rows)` builds, and the payload it encodes
 * (design/07 §6.6; design/13 §5, E's F1).
 *
 * The behaviour needs a real server and lives in `test/pg/session-copy.test.ts`; PGlite's socket
 * bridge exits the WASM backend on a COPY message, so there is no tier 1 for this feature at all.
 * What *is* checkable without a database is the thing that was wrong: the column list. It is a
 * pure function of the schema, so it belongs in the 5-second run.
 */

import { describe, expect, it } from 'vitest'
import { Registry } from '../../src/codec/index.js'
import { metaOf } from '../../src/query/meta.js'
import { copyColumns, copyFromSql, encodeCopyRows } from '../../src/session/copy.js'
import { UsageError } from '../../src/errors/index.js'
import { pgTable } from '../../src/schema/index.js'

const ledger = pgTable('ledger', (t) => ({
  id: t.bigint().primaryKey().generatedAlways(),
  label: t.text(),
  amount: t.numeric(),
  createdAt: t.timestamptz().defaultSql('now()'),
}))

const meta = (): ReturnType<typeof metaOf> => metaOf(ledger, new Registry())

/** What the `timestamptz` codec puts on the wire — a space, not the `T` of `toISOString()`. */
const wire = (d: Date): string => d.toISOString().replace('T', ' ')

async function payload(
  rows: Record<string, unknown>[],
  columns: readonly string[] | undefined,
): Promise<string> {
  const cols = copyColumns(meta(), columns)
  let out = ''
  for await (const chunk of encodeCopyRows(rows, cols, 'text', 65_536)) {
    out += new TextDecoder().decode(chunk)
  }
  return out
}

describe('copyFrom default columns = the insertable set (07 §6.6)', () => {
  it('omits GENERATED ALWAYS from the statement', () => {
    const m = meta()
    expect(copyFromSql(m, copyColumns(m, undefined), 'text')).toBe(
      'copy "public"."ledger" ("label", "amount", "created_at") from stdin with (format text)',
    )
  })

  it('is exactly the set an insert may name — the two read the same metadata', () => {
    const m = meta()
    expect(copyColumns(m, undefined).map((c) => c.key)).toEqual(m.insertableKeys)
  })

  it('an explicit list is honoured verbatim, generated column and all', () => {
    const m = meta()
    const cols = copyColumns(m, ['id', 'label'])
    expect(copyFromSql(m, cols, 'text')).toBe(
      'copy "public"."ledger" ("id", "label") from stdin with (format text)',
    )
    expect(cols.map((c) => c.key)).toEqual(['id', 'label'])
  })

  it('names an unknown column, and lists the ones it knows', () => {
    expect(() => copyColumns(meta(), ['nope'])).toThrow(UsageError)
    expect(() => copyColumns(meta(), ['nope'])).toThrow(/"nope".*Known columns: id, label/s)
  })

  it('refuses a table whose every column is GENERATED ALWAYS rather than emitting `()`', () => {
    const all = pgTable('all_generated', (t) => ({
      id: t.bigint().primaryKey().generatedAlways(),
    }))
    expect(() => copyColumns(metaOf(all, new Registry()), undefined)).toThrow(/no columns to write/)
  })
})

describe('the encoded payload follows the column list, not the row keys', () => {
  it('reads each value under the key carried ON its column', async () => {
    const at = new Date('2026-08-30T09:00:00.000Z')
    // `id` is in the row and must NOT appear: the default list decides, not the row.
    expect(await payload([{ id: 7, label: 'a', amount: '1.50', createdAt: at }], undefined)).toBe(
      `a\t1.50\t${wire(at)}\n`,
    )
  })

  it('the db name is the fallback, so a row keyed by column name still encodes', async () => {
    const at = new Date('2026-08-30T09:00:00.000Z')
    expect(await payload([{ label: 'a', amount: '1.50', created_at: at }], undefined)).toBe(
      `a\t1.50\t${wire(at)}\n`,
    )
  })

  it('a key the row does not have is `\\N`, which is why the list may not carry a generated column', async () => {
    expect(await payload([{ label: 'a', amount: '1.50' }], undefined)).toBe('a\t1.50\t\\N\n')
  })
})
