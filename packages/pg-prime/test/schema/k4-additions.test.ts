/**
 * The DSL additions of design/12 K4: index options, the two `renamedFrom` spellings, the
 * three standalone declarations, `t.raw`, and the three new table nodes.
 *
 * Deliberately **runtime-only**. Every one of these is a value that lands in `TableExtra`
 * or in a frozen declaration object, and not one of them is reachable from `ColMeta` — so
 * the property that matters is "the metadata the kit's emitter reads is exactly this", and
 * the type-level property (`Col<M>` unmoved) is already `ddl.test.ts`'s job and
 * `bench:types`'s. Kept short: tier 0 is at its 5 s ceiling.
 */
import { describe, expect, it } from 'vitest'
import {
  clusterOn,
  index,
  integer,
  partitionBy,
  partitionOf,
  pgDomain,
  pgEnum,
  pgExtension,
  pgSchema,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from '../../src/schema/index.js'
import { sql } from '../../src/sql/index.js'
import { SchemaError } from '../../src/sql/errors.js'

const t = pgTable('docs', {
  id: integer(),
  body: text(),
  tag: text(),
})

describe('index options (design/05 §2.4, built by design/12 K4)', () => {
  it('keeps the plain-column form producing the same items', () => {
    expect(index('i').on(t.cols.id, t.cols.tag)).toEqual({
      node: 'index',
      name: 'i',
      unique: false,
      columns: ['id', 'tag'],
      items: [
        { column: 'id', desc: false, nulls: undefined, opclass: undefined },
        { column: 'tag', desc: false, nulls: undefined, opclass: undefined },
      ],
      using: undefined,
      where: undefined,
      include: [],
      nullsNotDistinct: false,
    })
  })

  it('takes using / where / include / nullsNotDistinct, as options or as methods', () => {
    const viaOptions = uniqueIndex('u', {
      using: 'gin',
      where: sql`${t.cols.tag} IS NOT NULL`,
      include: [t.cols.body],
      nullsNotDistinct: true,
    }).on(t.cols.tag)
    const viaMethods = uniqueIndex('u')
      .using('gin')
      .where(sql`${t.cols.tag} IS NOT NULL`)
      .include(t.cols.body)
      .nullsNotDistinct()
      .on(t.cols.tag)
    expect(viaOptions).toEqual(viaMethods)
    expect(viaOptions).toMatchObject({
      unique: true,
      using: 'gin',
      where: '"tag" IS NOT NULL',
      include: ['body'],
      nullsNotDistinct: true,
    })
  })

  it('takes per-column desc / nulls / opclass as item objects', () => {
    const node = index('i').on(t.cols.id, {
      column: t.cols.tag,
      desc: true,
      nulls: 'last',
      opclass: 'text_pattern_ops',
    })
    expect(node).toMatchObject({
      columns: ['id', 'tag'],
      items: [
        { column: 'id', desc: false, nulls: undefined, opclass: undefined },
        { column: 'tag', desc: true, nulls: 'last', opclass: 'text_pattern_ops' },
      ],
    })
  })

  it('refuses a nulls value PostgreSQL does not have, at declaration time', () => {
    expect(() => index('i').on({ column: t.cols.id, nulls: 'middle' as 'first' })).toThrow(
      SchemaError,
    )
    expect(() => index('i').on()).toThrow(SchemaError)
  })
})

describe('the annotation spellings design/05 §5.1 lists and K2a did not build', () => {
  it('pgEnum carries renamedFrom', () => {
    expect(pgEnum('member_role', ['owner', 'member'], { renamedFrom: 'org_role' })).toEqual({
      kind: 'enum',
      name: 'member_role',
      values: ['owner', 'member'],
      schema: undefined,
      renamedFrom: 'org_role',
    })
    expect(pgEnum('m', ['a']).renamedFrom).toBeUndefined()
  })

  it('pgSchema carries renamedFrom', () => {
    const audit = pgSchema('audit', { renamedFrom: 'auditing' })
    expect([audit.kind, audit.name, audit.renamedFrom]).toEqual(['schema', 'audit', 'auditing'])
  })
})

describe('the standalone declarations (design/05 §3.3 / §3.5 / §3.10)', () => {
  it('pgDomain, pgSequence and pgExtension are frozen metadata with a kind discriminant', () => {
    const email = pgDomain('email', 'text', {
      notNull: true,
      checks: [{ name: 'email_shape', expression: "VALUE ~ '@'" }],
    })
    expect(email).toMatchObject({ kind: 'domain', name: 'email', baseType: 'text', notNull: true })
    expect(email.checks).toEqual([{ name: 'email_shape', expression: "VALUE ~ '@'" }])
    expect(Object.isFrozen(email)).toBe(true)

    const seq = pgSequence('docs_id_seq', {
      dataType: 'integer',
      ownedBy: { table: 'docs', column: 'id' },
    })
    expect(seq).toMatchObject({ kind: 'sequence', name: 'docs_id_seq', cycle: false })
    expect(seq.ownedBy).toEqual({ table: 'docs', column: 'id' })

    expect(pgExtension('uuid-ossp', { schema: 'public' })).toEqual({
      kind: 'extension',
      name: 'uuid-ossp',
      schema: 'public',
    })
  })

  it('rejects an unusable identifier where PostgreSQL would', () => {
    expect(() => pgDomain('x', '')).toThrow(SchemaError)
    expect(() => pgSequence('s', { ownedBy: { table: '', column: 'a' } })).toThrow(SchemaError)
  })
})

describe('the table nodes an adopted database needs', () => {
  it('primaryKey takes a name, and the positional form is unchanged', () => {
    expect(primaryKey(t.cols.id)).toEqual({ node: 'primaryKey', name: undefined, columns: ['id'] })
    expect(primaryKey({ name: 'PK_Docs', columns: [t.cols.id, t.cols.tag] })).toEqual({
      node: 'primaryKey',
      name: 'PK_Docs',
      columns: ['id', 'tag'],
    })
  })

  it('clusterOn, partitionBy and partitionOf are plain nodes', () => {
    expect(clusterOn('docs_pkey')).toEqual({ node: 'clusterOn', index: 'docs_pkey' })
    expect(partitionBy('range', 'created_at')).toEqual({
      node: 'partitionBy',
      strategy: 'range',
      key: 'created_at',
    })
    expect(partitionOf('payment', 'FOR VALUES FROM (1) TO (10)', { schema: 'archive' })).toEqual({
      node: 'partitionOf',
      parent: 'payment',
      parentSchema: 'archive',
      bound: 'FOR VALUES FROM (1) TO (10)',
    })
    expect(() => partitionBy('weekly' as 'range', 'x')).toThrow(SchemaError)
    expect(() => partitionOf('payment', '')).toThrow(SchemaError)
  })
})

describe('t.raw — design/05 §5.3 at column grain', () => {
  it('carries the type name verbatim and stays a normal column', () => {
    const table = pgTable('legacy', (c) => ({
      code: c.raw('character varying(40)'),
      doc: c.raw('xml', 'the_doc').nullable(),
    }))
    const [code, doc] = table.$.columns
    expect([code?.dbName, code?.column.ddl.pgType, code?.column.ddl.notNull]).toEqual([
      'code',
      'character varying(40)',
      true,
    ])
    expect([doc?.dbName, doc?.column.ddl.pgType, doc?.column.ddl.notNull]).toEqual([
      'the_doc',
      'xml',
      false,
    ])
  })

  it('refuses an empty type name rather than emitting a column with none', () => {
    expect(() => pgTable('x', (c) => ({ a: c.raw('') }))).toThrow(SchemaError)
  })
})
