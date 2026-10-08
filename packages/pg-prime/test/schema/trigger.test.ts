import { describe, expect, it } from 'vitest'
import { pgTable, raw, rls, updatedAtTrigger } from '../../src/schema/index.js'
import { SchemaError } from '../../src/sql/errors.js'

describe('rls and updatedAtTrigger extras', () => {
  it('produce plain extra nodes', () => {
    const docs = pgTable(
      'docs',
      (t) => ({ id: t.uuid(), updatedAt: t.timestamptz(), seen: raw('timestamp') }),
      (t) => [rls.force(), updatedAtTrigger(t.updatedAt), updatedAtTrigger(t.seen as never)],
    )
    expect(docs.$.extras).toEqual([
      { node: 'rls', force: true },
      { node: 'updatedAtTrigger', column: 'updated_at' },
      { node: 'updatedAtTrigger', column: 'seen' },
    ])
    expect(rls.enable()).toEqual({ node: 'rls', force: false })
  })

  it('refuses a non-timestamp column, a non-column and a trigger name over 63 bytes', () => {
    const long = 'x'.repeat(55)
    expect(() =>
      pgTable(
        'a',
        (t) => ({ id: t.uuid() }),
        (t) => [updatedAtTrigger(t.id as never)],
      ),
    ).toThrow(/timestamptz or timestamp column; got uuid/)
    expect(() => updatedAtTrigger({} as never)).toThrow(SchemaError)
    expect(() =>
      pgTable(
        'b',
        (t) => ({ at: t.timestamptz(long) }),
        (t) => [updatedAtTrigger(t.at)],
      ),
    ).toThrow(SchemaError)
  })
})
