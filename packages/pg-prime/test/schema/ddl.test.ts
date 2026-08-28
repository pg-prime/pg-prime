/**
 * The DDL-affecting modifiers and extras added by design/11 §3 K2a.
 *
 * Two things are asserted for every one of them:
 *
 *  1. the **runtime metadata** lands on `ColumnDdl` / `TableExtra` exactly as the kit's emitter
 *     will read it, and
 *  2. the **type** did not move — `Col<M>`'s five meta slots and all three row shapes are byte-for
 *     byte what they were before the modifier was called. That is design/11's hard rule ("no change
 *     to `Col<M>`'s meta parameter"), and `expectTypeOf(...).toEqualTypeOf` is what proves it per
 *     call rather than only in aggregate through `bench:types`.
 */
import { describe, expect, it } from 'vitest'
import { expectTypeOf } from 'expect-type'
import {
  check,
  comment,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgSchema,
  pgTable,
  primaryKey,
  renamedFrom,
  text,
  timestamptz,
  unique,
  uniqueIndex,
  type AnyRef,
  type Col,
  type RefLike,
  type Insertable,
  type Selectable,
  type TableExtra,
  type Updateable,
} from '../../src/schema/index.js'
import { sql } from '../../src/sql/index.js'
import { SchemaError } from '../../src/sql/errors.js'

/** The one table every case below points at. Declared first so the thunks have something to find. */
const orgs = pgTable('orgs', (t) => ({
  id: t.uuid().primaryKey(),
  slug: t.text().unique(),
}))

const extrasOf = (t: {
  readonly $: { readonly extras: readonly TableExtra[] }
}): readonly TableExtra[] => t.$.extras

describe('.references() — a thunk, resolved lazily (design/11 §1.7)', () => {
  it('stores the thunk, the actions and the deferral flags', () => {
    const memberships = pgTable('memberships', (t) => ({
      id: t.uuid().primaryKey(),
      orgId: t.uuid().references(() => orgs.cols.id, {
        name: 'memberships_org_fk',
        onDelete: 'cascade',
        onUpdate: 'no action',
        initiallyDeferred: true,
      }),
    }))
    const ref = memberships.$.column('orgId')?.ddl.references
    expect(ref).toBeDefined()
    expect(ref?.name).toBe('memberships_org_fk')
    expect(ref?.onDelete).toBe('cascade')
    expect(ref?.onUpdate).toBe('no action')
    // INITIALLY DEFERRED implies DEFERRABLE in PostgreSQL's own grammar, so it is implied here too.
    expect(ref?.deferrable).toBe(true)
    expect(ref?.initiallyDeferred).toBe(true)
    const target = ref?.target() ?? []
    expect(target).toHaveLength(1)
    expect(target[0]?.$.dbName).toBe('id')
    expect(target[0]?.$.table).toBe('orgs')
  })

  it('is lazy enough for a forward reference — `later` is declared BELOW its referrer', () => {
    const earlier = pgTable('earlier', (t) => ({
      id: t.uuid().primaryKey(),
      laterId: t.uuid().references(() => later.cols.id),
    }))
    const later = pgTable('later', (t) => ({ id: t.uuid().primaryKey() }))
    expect(earlier.$.column('laterId')?.ddl.references?.target()[0]?.$.table).toBe('later')
  })

  /**
   * `.references(() => nodes.cols.id)` *inside* `nodes` is a TS7022 circularity — the thunk's body
   * needs `nodes`'s type, which is what is being inferred — so the self-FK spelling is the
   * `foreignKey` extra, whose callback parameter is this table's own refs and therefore closes the
   * loop without naming the const. This test pins that the supported spelling works.
   */
  it('a self-referencing FK is declared through the extras callback, not through the const', () => {
    const nodes = pgTable(
      'nodes',
      (t) => ({ id: t.uuid().primaryKey(), parentId: t.uuid().nullable() }),
      (t) => [
        foreignKey({
          name: 'nodes_parent_fk',
          columns: [t.parentId],
          references: () => [t.id],
          onDelete: 'set null',
        }),
      ],
    )
    const fk = nodes.$.extras[0]
    if (fk?.node !== 'foreignKey') throw new Error('unreachable')
    expect(fk.columns).toEqual(['parent_id'])
    expect(fk.references().map((r) => `${r.$.table}.${r.$.dbName}`)).toEqual(['nodes.id'])
  })

  /**
   * The DX case design/11 §1.7 exists for. The thunk defers the *value*; the annotation defers the
   * *type*, and without it TypeScript walks `orgs → users → orgs` and reports TS7022. This test is
   * a compile-time assertion first (it lives in `test/schema/tsconfig.json`, which `pnpm typecheck`
   * runs) and a runtime one second.
   */
  it('declares a mutually-referencing pair when the thunk return type is annotated', () => {
    const left = pgTable(
      'left_t',
      (t) => ({ id: t.uuid().primaryKey(), rightId: t.uuid().nullable() }),
      (t) => [
        foreignKey({
          columns: [t.rightId],
          references: (): readonly RefLike[] => [right.cols.id],
        }),
      ],
    )
    const right = pgTable('right_t', (t) => ({
      id: t.uuid().primaryKey(),
      leftId: t
        .uuid()
        .nullable()
        .references((): RefLike => left.cols.id, { onDelete: 'cascade' }),
    }))
    const fk = left.$.extras[0]
    if (fk?.node !== 'foreignKey') throw new Error('unreachable')
    expect(fk.references().map((r) => r.$.table)).toEqual(['right_t'])
    expect(right.$.column('leftId')?.ddl.references?.target()[0]?.$.table).toBe('left_t')
  })

  it('carries the target table SCHEMA, so a cross-schema FK is unambiguous', () => {
    const audit = pgSchema('audit')
    const events = audit.table('events', (t) => ({ id: t.uuid().primaryKey() }))
    const links = pgTable('links', (t) => ({
      id: t.uuid().primaryKey(),
      eventId: t.uuid().references(() => events.cols.id),
    }))
    const target = links.$.column('eventId')?.ddl.references?.target()[0]
    expect(target?.$.schema).toBe('audit')
    expect(orgs.$.columns[0]?.schema).toBeUndefined()
  })

  it('refuses a non-thunk and an unknown referential action, at declaration time', () => {
    expect(() =>
      pgTable('bad', (t) => ({
        a: t.uuid().references(orgs.cols.id as unknown as () => AnyRef),
      })),
    ).toThrow(/takes a THUNK/)
    expect(() =>
      pgTable('bad2', (t) => ({
        a: t.uuid().references(() => orgs.cols.id, { onDelete: 'explode' as 'cascade' }),
      })),
    ).toThrow(SchemaError)
  })
})

describe('.check() — a `sql` fragment, no bind parameters', () => {
  it('records the fragment TEXT, with a column reference rendered as an identifier', () => {
    const products = pgTable('products', (t) => ({
      id: t.uuid().primaryKey(),
      price: t.integer().check(sql`price > 0`, 'products_price_positive'),
      qty: t.integer().check(sql`${sql.ident('qty')} >= ${sql.lit(0)}`),
    }))
    const price = products.$.column('price')?.ddl.checks ?? []
    expect(price).toHaveLength(1)
    expect(price[0]).toEqual({ name: 'products_price_positive', expression: 'price > 0' })
    expect(products.$.column('qty')?.ddl.checks[0]).toEqual({
      name: undefined,
      expression: '"qty" >= 0',
    })
  })

  it('accumulates: two `.check()` calls are two constraints, not one overwrite', () => {
    const col = integer()
      .check(sql`n > 0`, 'a')
      .check(sql`n < 10`, 'b')
    expect(col.$.ddl.checks.map((c) => c.name)).toEqual(['a', 'b'])
  })

  it('rejects a bind parameter with a sentence naming the reason', () => {
    const limit = 10
    expect(() => integer().check(sql`n < ${limit}`)).toThrow(/never carry a \$n/)
    expect(() => integer().check(sql`n < ${limit}`)).toThrow(SchemaError)
  })

  it('rejects an empty expression', () => {
    expect(() => integer().check(sql``)).toThrow(/empty expression/)
  })
})

describe('.unique(name?, { nullsNotDistinct })', () => {
  it('keeps the no-argument spelling working and records the new options', () => {
    const plain = text().unique()
    expect(plain.$.ddl.unique).toBe(true)
    expect(plain.$.ddl.uniqueSpec).toEqual({ name: undefined, nullsNotDistinct: false })
    const named = text().unique('u_email', { nullsNotDistinct: true })
    expect(named.$.ddl.uniqueSpec).toEqual({ name: 'u_email', nullsNotDistinct: true })
  })
})

describe('.comment() / .renamedFrom()', () => {
  it('records both, and rejects a name PostgreSQL cannot store', () => {
    const col = text().comment('the login address').renamedFrom('email_address')
    expect(col.$.ddl.comment).toBe('the login address')
    expect(col.$.ddl.renamedFrom).toBe('email_address')
    expect(() => text().renamedFrom('x'.repeat(64))).toThrow(SchemaError)
  })
})

describe('the type did not move (design/11 §3 K2a hard rule)', () => {
  it('every new modifier returns the SAME Col<M>', () => {
    const base = text()
    type Base = typeof base
    expectTypeOf(base.unique()).toEqualTypeOf<Base>()
    expectTypeOf(base.unique('n', { nullsNotDistinct: true })).toEqualTypeOf<Base>()
    expectTypeOf(base.references(() => orgs.cols.id)).toEqualTypeOf<Base>()
    expectTypeOf(base.check(sql`true`)).toEqualTypeOf<Base>()
    expectTypeOf(base.comment('x')).toEqualTypeOf<Base>()
    expectTypeOf(base.renamedFrom('old')).toEqualTypeOf<Base>()
    // …and the meta parameter itself, spelled out
    expectTypeOf(base.renamedFrom('old')).toEqualTypeOf<
      Col<{ t: string; pg: 'text'; opt: false; ro: false; pk: false }>
    >()
  })

  it('the three row shapes of a table are identical with and without the modifiers', () => {
    const plain = pgTable('t_plain', (t) => ({
      id: t.uuid().primaryKey(),
      orgId: t.uuid(),
      n: t.integer(),
    }))
    const decorated = pgTable('t_decorated', (t) => ({
      id: t.uuid().primaryKey().comment('pk'),
      orgId: t.uuid().references(() => orgs.cols.id, { onDelete: 'cascade' }),
      n: t
        .integer()
        .check(sql`n > 0`)
        .unique('u_n')
        .renamedFrom('num'),
    }))
    expectTypeOf<Selectable<typeof decorated>>().toEqualTypeOf<Selectable<typeof plain>>()
    expectTypeOf<Insertable<typeof decorated>>().toEqualTypeOf<Insertable<typeof plain>>()
    expectTypeOf<Updateable<typeof decorated>>().toEqualTypeOf<Updateable<typeof plain>>()
  })
})

describe('table extras', () => {
  const t = pgTable(
    'invoices',
    (c) => ({
      orgId: c.uuid(),
      seq: c.integer(),
      total: c.integer(),
      createdAt: c.timestamptz(),
    }),
    (c) => [
      primaryKey(c.orgId, c.seq),
      unique('invoices_total_key').nullsNotDistinct().on(c.total),
      check('invoices_total_positive', sql`total >= 0`),
      foreignKey({
        name: 'invoices_org_fk',
        columns: [c.orgId],
        references: () => [orgs.cols.id],
        onDelete: 'restrict',
        deferrable: true,
      }),
      index('invoices_created_idx').on(c.createdAt),
      uniqueIndex('invoices_seq_idx').on(c.seq),
      comment('One row per invoice.'),
      renamedFrom('bills'),
    ],
  )

  it('produces one tagged node per declaration, in declaration order', () => {
    expect(extrasOf(t).map((e) => e.node)).toEqual([
      'primaryKey',
      'unique',
      'check',
      'foreignKey',
      'index',
      'index',
      'comment',
      'renamedFrom',
    ])
  })

  it('unique() carries columns and NULLS NOT DISTINCT', () => {
    expect(extrasOf(t)[1]).toEqual({
      node: 'unique',
      name: 'invoices_total_key',
      columns: ['total'],
      nullsNotDistinct: true,
    })
  })

  it('check() stores the fragment text under a mandatory name', () => {
    expect(extrasOf(t)[2]).toEqual({
      node: 'check',
      name: 'invoices_total_positive',
      expression: 'total >= 0',
    })
    expect(() => check('c', sql`n = ${1}`)).toThrow(/never carry a \$n/)
  })

  it('foreignKey() keeps the target behind a thunk', () => {
    const fk = extrasOf(t)[3]
    expect(fk?.node).toBe('foreignKey')
    if (fk?.node !== 'foreignKey') throw new Error('unreachable')
    expect(fk.columns).toEqual(['orgId'.replace('orgId', 'org_id')])
    expect(fk.onDelete).toBe('restrict')
    expect(fk.onUpdate).toBeUndefined()
    expect(fk.deferrable).toBe(true)
    expect(fk.initiallyDeferred).toBe(false)
    expect(fk.references().map((r) => r.$.dbName)).toEqual(['id'])
    expect(() => foreignKey({ columns: [], references: () => [orgs.cols.id] })).toThrow(
      /no columns/,
    )
  })

  it('renamedFrom() is the table-level spelling of the same annotation', () => {
    expect(extrasOf(t)[7]).toEqual({ node: 'renamedFrom', from: 'bills' })
  })
})

describe('pgSchema (design/05 §3.1)', () => {
  it('binds `schema` on every table and enum it makes', () => {
    const audit = pgSchema('audit', { renamedFrom: 'auditing' })
    expect(audit.name).toBe('audit')
    expect(audit.renamedFrom).toBe('auditing')
    const kind = audit.enum('event_kind', ['created', 'deleted'])
    expect(kind).toEqual({
      kind: 'enum',
      name: 'event_kind',
      values: ['created', 'deleted'],
      schema: 'audit',
    })
    const events = audit.table(
      'events',
      (t) => ({ id: t.uuid().primaryKey(), at: t.timestamptz(), kind: t.enum(kind) }),
      (t) => [index('events_at_idx').on(t.at)],
    )
    expect(events.$.schema).toBe('audit')
    expect(events.$.column('kind')?.ddl.enumSchema).toBe('audit')
    // and the row shapes are exactly a `pgTable`'s
    expectTypeOf<Selectable<typeof events>>().toEqualTypeOf<{
      id: string
      at: Date
      kind: 'created' | 'deleted'
    }>()
  })

  it('rejects a schema name PostgreSQL cannot store', () => {
    expect(() => pgSchema('x'.repeat(64))).toThrow(SchemaError)
  })
})

describe('pgEnum({ schema })', () => {
  it('defaults to `undefined` — the emitter’s default schema, never the first table that uses it', () => {
    expect(pgEnum('mood', ['ok']).schema).toBeUndefined()
    expect(pgEnum('mood', ['ok'], { schema: 'audit' }).schema).toBe('audit')
    expect(timestamptz().$.ddl.enumSchema).toBeUndefined()
  })
})
