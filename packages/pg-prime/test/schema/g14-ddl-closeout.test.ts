/**
 * design/14 G — the DDL close-out: design/01 §3 rows 49, 50, 51 and 54.
 *
 * Three properties per feature, and they are three because a DSL addition can fail in three
 * independent ways:
 *
 *  1. the **runtime metadata** lands on `ColumnDdl` / `TableExtra` exactly as the kit's
 *     emitter reads it (the emitter's own exact-text assertions live in the kit);
 *  2. the **declaration-time refusals** fire where the type level cannot see the problem —
 *     a reversed call order, a JavaScript caller, an operator that is not an operator;
 *  3. the **type** moved only where it was meant to: `.generatedAlwaysAs()` sets `ro: true`
 *     and therefore ERASES the key from `Insert<>`/`Update<>`, and every other addition
 *     returns `Col<M>` unchanged. `expectTypeOf` pins each one, and `bench:types` pins the
 *     aggregate.
 */
import { describe, expect, it } from 'vitest'
import { expectTypeOf } from 'expect-type'
import {
  boolean,
  exclude,
  index,
  integer,
  numeric,
  pgDomain,
  pgEnum,
  pgTable,
  raw,
  text,
  uniqueIndex,
  type Insert,
  type OrmTypeError,
  type Row,
  type Update,
} from '../../src/schema/index.js'
import { sql } from '../../src/sql/index.js'
import { SchemaError } from '../../src/sql/errors.js'

const t = pgTable('bookings', {
  id: integer(),
  room: integer(),
  during: raw('tstzrange'),
  cancelled: boolean(),
})

/* --------------------------- row 49: exclude() ---------------------------- */

describe('exclude() — design/01 row 49', () => {
  it('carries method, elements, predicate and deferrability', () => {
    expect(
      exclude('bookings_no_overlap')
        .using('gist')
        .where(sql`NOT ${t.cols.cancelled}`)
        .on([t.cols.room, '='], [t.cols.during, '&&']),
    ).toEqual({
      node: 'exclude',
      name: 'bookings_no_overlap',
      using: 'gist',
      items: [
        { element: '"room"', operator: '=' },
        { element: '"during"', operator: '&&' },
      ],
      where: 'NOT "cancelled"',
      deferrable: false,
      initiallyDeferred: false,
      requires: undefined,
    })
  })

  it('.initiallyDeferred() implies .deferrable(), as PostgreSQL grammar does', () => {
    const node = exclude('x').initiallyDeferred().on([t.cols.during, '&&'])
    expect(node).toMatchObject({ deferrable: true, initiallyDeferred: true })
    expect(exclude('x').deferrable().on([t.cols.during, '&&'])).toMatchObject({
      deferrable: true,
      initiallyDeferred: false,
    })
  })

  it('takes an expression element, parenthesised', () => {
    expect(exclude('x').on([sql`lower(${t.cols.room}::text)`, '='])).toMatchObject({
      items: [{ element: '(lower("room"::text))', operator: '=' }],
    })
  })

  it('records .requires() as a name, from a pgExtension or from a string', () => {
    expect(exclude('x').requires('btree_gist').on([t.cols.room, '='])).toMatchObject({
      requires: 'btree_gist',
    })
  })

  it('refuses an operator that is not written in the operator alphabet', () => {
    expect(() => exclude('x').on([t.cols.during, 'overlaps'])).toThrow(SchemaError)
    expect(() => exclude('x').on([t.cols.during, 'overlaps'])).toThrow(/operator alphabet/)
    // …and the pair itself has to be a pair
    expect(() => exclude('x').on([t.cols.during] as never)).toThrow(/\[column, operator\] pair/)
  })

  it('refuses an exclusion with no elements at all', () => {
    expect(() => exclude('x').on()).toThrow(/was given no elements/)
  })

  it('validates its own name, because PostgreSQL default names collide', () => {
    expect(() => exclude('x'.repeat(64))).toThrow(SchemaError)
  })
})

/* --------------------- row 51: .generatedAlwaysAs() ----------------------- */

const invoices = pgTable('invoices', (c) => ({
  id: c.integer().primaryKey(),
  price: c.numeric(),
  quantity: c.integer(),
  // the late-bound `(cols) => fragment` form: `price` and `quantity` do not exist as
  // references at the point this line runs
  total: c.numeric().generatedAlwaysAs((cols) => sql`${cols.price} * ${cols.quantity}`),
  // the plain-fragment form, and a generated column MAY be nullable
  label: c
    .text()
    .nullable()
    .generatedAlwaysAs(sql`upper(id::text)`),
}))

describe('.generatedAlwaysAs() — design/01 row 51', () => {
  it('resolves the callback form against the table’s own DB names, at pgTable() time', () => {
    expect(invoices.$.column('total')?.ddl.generatedAs).toBe('"price" * "quantity"')
    expect(invoices.$.column('total')?.ddl.generatedAsFrom).toBeUndefined()
  })

  it('stores the fragment form verbatim', () => {
    expect(invoices.$.column('label')?.ddl.generatedAs).toBe('upper(id::text)')
    expect(invoices.$.column('label')?.ddl.notNull).toBe(false)
  })

  it('honours an explicit DB name in the callback record', () => {
    const rows = pgTable('rows', (c) => ({
      firstName: c.text(),
      shout: c.text().generatedAlwaysAs((cols) => sql`upper(${cols.firstName})`),
    }))
    expect(rows.$.column('shout')?.ddl.generatedAs).toBe('upper("first_name")')
  })

  it('ERASES the key from Insert<> and Update<>, and keeps it in Row<>', () => {
    expectTypeOf<keyof Row<typeof invoices>>().toEqualTypeOf<
      'id' | 'price' | 'quantity' | 'total' | 'label'
    >()
    expectTypeOf<keyof Insert<typeof invoices>>().toEqualTypeOf<'id' | 'price' | 'quantity'>()
    expectTypeOf<keyof Update<typeof invoices>>().toEqualTypeOf<'id' | 'price' | 'quantity'>()
    // the read type is unchanged: a generated `numeric` still decodes to `string`
    expectTypeOf<Row<typeof invoices>['total']>().toEqualTypeOf<string>()
    expectTypeOf<Row<typeof invoices>['label']>().toEqualTypeOf<string | null>()
  })

  it('refuses VIRTUAL at runtime, naming PostgreSQL 18 and the reason', () => {
    // The type level refuses `{ stored: false }` outright — `GeneratedAlwaysAsOptions.stored`
    // is `true | OrmTypeError<…>` — so this is the JavaScript caller's path.
    expect(() =>
      (numeric().generatedAlwaysAs as (e: unknown, o: unknown) => unknown)(sql`1`, {
        stored: false,
      }),
    ).toThrow(/VIRTUAL is PostgreSQL 18\+/)
    expect(() => numeric().generatedAlwaysAs(sql`1`, { stored: true })).not.toThrow()
  })

  it('refuses the combinations PostgreSQL cannot express, at declaration time', () => {
    expect(() =>
      integer()
        .generatedAlways()
        .generatedAlwaysAs(sql`1`),
    ).toThrow(/identity column or a generated one, never both/)
    expect(() =>
      integer()
        .generatedAlwaysAs(sql`1`)
        .generatedAlways(),
    ).toThrow(/identity column or a generated one, never both/)
    expect(() =>
      integer()
        .default(1)
        .generatedAlwaysAs(sql`1`),
    ).toThrow(/the database always supplies the value/)
    expect(() => text().generatedAlwaysAs(sql``)).toThrow(/empty expression/)
  })

  it('closes .default() and .nullable() at the TYPE level, exactly as identity does', () => {
    const generated = integer().generatedAlwaysAs(sql`1`)
    // `ro: true` is what does it, so the two sentinels are the ones `.generatedAlways()`
    // already resolves to — one gate, two spellings.
    expectTypeOf(generated.defaultSql).toEqualTypeOf<
      OrmTypeError<'a default after .generatedAlways(): the database always supplies the value'>
    >()
    expectTypeOf(generated.nullable).toEqualTypeOf<
      OrmTypeError<'.nullable() after .generatedAlways()/.generatedAlwaysAs(): an identity column is never null, and a generated expression column takes .nullable() BEFORE it'>
    >()
    // …and the runtime says the same thing to a JavaScript caller, which is the only one
    // that can get here.
    const escaped = generated as unknown as { defaultSql(expr: string): unknown }
    expect(() => escaped.defaultSql('1')).toThrow(/the database always supplies the value/)
  })
})

/* ------------------------- row 50: index options -------------------------- */

describe('index options — design/01 row 50', () => {
  it('takes an expression key, bare or as an item object', () => {
    expect(index('i').on(sql`lower(${t.cols.room}::text)`)).toMatchObject({
      columns: [],
      items: [
        {
          column: undefined,
          expression: 'lower("room"::text)',
          desc: false,
          nulls: undefined,
          opclass: undefined,
        },
      ],
    })
    expect(
      index('i').on({ expression: sql`lower(${t.cols.room}::text)`, desc: true, nulls: 'last' }),
    ).toMatchObject({
      items: [{ expression: 'lower("room"::text)', desc: true, nulls: 'last' }],
    })
  })

  it('keeps `columns` the COLUMN keys only, with an expression among them', () => {
    const node = index('i').on(t.cols.room, sql`lower(${t.cols.room}::text)`)
    expect(node).toMatchObject({ columns: ['room'] })
    expect(node.node === 'index' && node.items).toHaveLength(2)
  })

  it('.with() merges, .fillfactor() is sugar for it', () => {
    expect(index('i').fillfactor(70).with({ fastupdate: false }).on(t.cols.room)).toMatchObject({
      with: { fillfactor: 70, fastupdate: false },
    })
    expect(index('i', { with: { fillfactor: 90 } }).on(t.cols.room)).toMatchObject({
      with: { fillfactor: 90 },
    })
  })

  it('.tablespace() and .concurrently(false) land on the node', () => {
    expect(index('i').tablespace('fast_ssd').concurrently(false).on(t.cols.room)).toMatchObject({
      tablespace: 'fast_ssd',
      concurrently: false,
    })
    // the default is `true`: D15's rewrite is the product, the opt-out is the exception
    expect(index('i').on(t.cols.room)).toMatchObject({ concurrently: true })
    expect(uniqueIndex('u', { concurrently: false }).on(t.cols.room)).toMatchObject({
      concurrently: false,
    })
  })

  it('refuses a storage parameter that has no SQL form, and a fillfactor out of range', () => {
    expect(() => index('i').with({ x: {} as never })).toThrow(/storage parameter is a string/)
    expect(() => index('i').with({ x: Number.NaN })).toThrow(/has no SQL form/)
    expect(() => index('i').fillfactor(5)).toThrow(/between 10 and 100/)
    expect(() => index('i').fillfactor(70.5)).toThrow(/between 10 and 100/)
    expect(() => index('i').on(sql``)).toThrow(/empty expression key/)
  })
})

/* -------------------- row 54: comments on types --------------------------- */

describe('comment on a type — design/01 row 54', () => {
  it('rides on pgEnum and pgDomain as a plain option', () => {
    expect(pgEnum('k', ['a'], { comment: 'two kinds' }).comment).toBe('two kinds')
    expect(pgEnum('k', ['a']).comment).toBeUndefined()
    expect(pgDomain('email', 'text', { comment: 'an address' }).comment).toBe('an address')
    expect(pgDomain('email', 'text').comment).toBeUndefined()
  })

  it('refuses a non-string, as the table and column spellings do', () => {
    expect(() => pgEnum('k', ['a'], { comment: 1 as never })).toThrow(SchemaError)
    expect(() => pgDomain('email', 'text', { comment: 1 as never })).toThrow(SchemaError)
  })
})
