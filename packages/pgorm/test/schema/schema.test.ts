import { describe, expect, it } from 'vitest'
import { expectTypeOf } from 'expect-type'
import { pgTable, text } from '../../src/schema/index.js'
import { relations, schema, users } from './fixture.js'

describe('defineRelations', () => {
  it('records name-keyed relation nodes and produces zero DDL', () => {
    expect(relations.users.posts).toEqual({ kind: 'many', opt: false, to: 'posts', config: undefined })
    expect(relations.users.latest).toEqual({ kind: 'one', opt: true, to: 'posts', config: undefined })
    expect(relations.posts.author).toEqual({ kind: 'one', opt: false, to: 'users', config: undefined })
    // no relation ever contributes a table extra
    expect(users.$.extras.some((e) => e.node === 'index')).toBe(true)
  })

  it('keeps `to` a registry key, so a fully-cyclic graph needs no thunks', () => {
    expectTypeOf<(typeof relations)['users']['posts']['to']>().toEqualTypeOf<'posts'>()
    expectTypeOf<(typeof relations)['posts']['author']['to']>().toEqualTypeOf<'users'>()
  })
})

describe('defineSchema', () => {
  it('exposes one handle per registry key', () => {
    expect(Object.keys(schema.h)).toEqual(['users', 'posts', 'comments'])
    expect(schema.h.users.$.name).toBe('users')
    expect(schema.tables.posts.$.name).toBe('posts')
  })
})

describe('pgTable', () => {
  it('accepts the plain-record column form as well as the kit callback', () => {
    const t = pgTable('plain', { id: text(), other: text('renamed_col') })
    expect(t.$.columns.map((c) => c.dbName)).toEqual(['id', 'renamed_col'])
    expectTypeOf<(typeof t)['$']['name']>().toEqualTypeOf<string>()
  })

  it('rejects `$`-prefixed column keys', () => {
    expect(() => pgTable('bad', { $meta: text() })).toThrow(/may not start with/)
  })
})
