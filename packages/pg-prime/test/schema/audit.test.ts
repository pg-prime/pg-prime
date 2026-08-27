/**
 * The WS-L audit findings on the schema layer, one describe per finding.
 *
 * Every case here failed before the fix: the type-level ones as a *wrong type* (pinned with
 * `expectTypeOf`, and their negative controls with `@ts-expect-error` in this file, which
 * `test/schema/typecheck.test.ts` compiles on both 5.9.3 and 7.0.2 — an unused suppression is
 * itself an error, so a lost gate breaks the build), the runtime ones as a silently-accepted
 * declaration or a bare `TypeError`.
 */
import { describe, expect, it } from 'vitest'
import { expectTypeOf } from 'expect-type'
import type { PgDateString } from '../../src/codec/index.js'
import { SchemaError } from '../../src/sql/errors.js'
import {
  defineRelations,
  defineSchema,
  pgEnum,
  pgTable,
  REFS,
  text,
  timestamptz,
  uuid,
} from '../../src/schema/index.js'
import type { DateString, Insertable, Selectable } from '../../src/schema/index.js'

// ─────────────────────────────────────────────────────────────────────────────
// E1 — `.$type<T>()` must not drop the column's `| null`
// ─────────────────────────────────────────────────────────────────────────────

type Kind = 'a' | 'b'

const e1 = pgTable('e1', (t) => ({
  // `.nullable()` first — the order that used to lose the `| null`
  nullableFirst: t.text().nullable().$type<Kind>(),
  // `.$type()` first — the order that always worked
  typeFirst: t.text().$type<Kind>().nullable(),
  plain: t.text().$type<Kind>(),
}))

describe('E1 — $type after nullable()', () => {
  it('re-attaches the column`s own `| null`, in either order', () => {
    expectTypeOf<Selectable<typeof e1>['nullableFirst']>().toEqualTypeOf<Kind | null>()
    expectTypeOf<Selectable<typeof e1>['typeFirst']>().toEqualTypeOf<Kind | null>()
    expectTypeOf<Selectable<typeof e1>['plain']>().toEqualTypeOf<Kind>()
  })

  it('leaves the DDL nullable, which is what made the old type a lie', () => {
    expect(e1.$.column('nullableFirst')!.ddl.notNull).toBe(false)
    expect(e1.$.column('typeFirst')!.ddl.notNull).toBe(false)
    expect(e1.$.column('plain')!.ddl.notNull).toBe(true)
  })

  it('so `null` is accepted on insert for a nullable narrowed column', () => {
    const ok: Insertable<typeof e1> = { nullableFirst: null, typeFirst: null, plain: 'a' }
    expect(ok.nullableFirst).toBeNull()
  })

  it('$type is still narrow-only, and null is not a narrowing', () => {
    // @ts-expect-error — `number` is not a subtype of `text`
    const widened = text().$type<number>()
    // @ts-expect-error — `null` alone is not a narrowing of a NOT NULL text column
    const nulled = text().$type<null>()
    expect([widened, nulled].length).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E3 — `.array()` wraps the element, never the column's nullability
// ─────────────────────────────────────────────────────────────────────────────

const e3 = pgTable('e3', (t) => ({
  nullableFirst: t.text().nullable().array(),
  arrayFirst: t.text().array().nullable(),
  plain: t.text().array(),
}))

describe('E3 — array() after nullable()', () => {
  it('is a nullable `text[]`, not an array of nullable text', () => {
    expectTypeOf<Selectable<typeof e3>['nullableFirst']>().toEqualTypeOf<string[] | null>()
    expectTypeOf<Selectable<typeof e3>['arrayFirst']>().toEqualTypeOf<string[] | null>()
    expectTypeOf<Selectable<typeof e3>['plain']>().toEqualTypeOf<string[]>()
  })

  it('matches the DDL, which has exactly one NOT NULL to spend', () => {
    expect(e3.$.column('nullableFirst')!.ddl.pgType).toBe('text[]')
    expect(e3.$.column('nullableFirst')!.ddl.notNull).toBe(false)
  })

  it('a `jsonb` column is still `unknown[]`, not `{}[]`', () => {
    const j = pgTable('e3j', (t) => ({ v: t.jsonb().array() }))
    expectTypeOf<Selectable<typeof j>['v']>().toEqualTypeOf<unknown[]>()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E5 — one date brand
// ─────────────────────────────────────────────────────────────────────────────

describe('E5 — DateString is the codec layer`s brand', () => {
  it('the schema brand and the codec brand are the same type', () => {
    expectTypeOf<DateString>().toEqualTypeOf<PgDateString>()
  })

  it('a codec-typed date value is assignable to a `date()` column, and a bare string is not', () => {
    const dated = pgTable('e5', (t) => ({ d: t.date() }))
    const fromCodec = '2026-01-01' as PgDateString
    const ins: Insertable<typeof dated> = { d: fromCodec }
    expect(ins.d).toBe('2026-01-01')
    // negative control: the brand still keeps a plain string out
    expectTypeOf<string>().not.toExtend<DateString>()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E6 — a relation's `from`/`to` must be comparable types
// ─────────────────────────────────────────────────────────────────────────────

describe('E6 — relation column type compatibility', () => {
  const users = pgTable('users', (t) => ({ id: t.uuid().primaryKey(), name: t.text() }))
  const posts = pgTable('posts', (t) => ({
    id: t.uuid().primaryKey(),
    authorId: t.uuid(),
    createdAt: t.timestamptz(),
  }))
  const tables = { users, posts }

  it('rejects uuid → timestamptz, naming both columns and both types', () => {
    const rels = defineRelations(tables, (r) => ({
      users: { posts: r.many.posts({ from: users[REFS].id, to: posts[REFS].createdAt }) },
    }))
    expect(() => defineSchema(tables, rels)).toThrow(SchemaError)
    expect(() => defineSchema(tables, rels)).toThrow(
      /users\.id \(uuid\) with `to` posts\.createdAt \(timestamptz\)/,
    )
  })

  it('accepts the correct correlation', () => {
    const rels = defineRelations(tables, (r) => ({
      users: { posts: r.many.posts({ from: users[REFS].id, to: posts[REFS].authorId }) },
    }))
    expect(() => defineSchema(tables, rels)).not.toThrow()
  })

  it('lets the numeric family cross, so `int4 → int8` is not a false rejection', () => {
    const a = pgTable('a6', (t) => ({ id: t.integer().primaryKey() }))
    const b = pgTable('b6', (t) => ({ id: t.bigint().primaryKey(), aId: t.bigint() }))
    const t2 = { a, b }
    const rels = defineRelations(t2, (r) => ({
      a: { bs: r.many.b({ from: a[REFS].id, to: b[REFS].aId }) },
    }))
    expect(() => defineSchema(t2, rels)).not.toThrow()
  })

  it('correlates `text[]` with `text` elementwise', () => {
    const tags = pgTable('tags6', (t) => ({ id: t.text().primaryKey() }))
    const docs = pgTable('docs6', (t) => ({ id: t.text().primaryKey(), tagIds: t.text().array() }))
    const t2 = { tags, docs }
    const rels = defineRelations(t2, (r) => ({
      docs: { tags: r.many.tags({ from: docs[REFS].tagIds, to: tags[REFS].id }) },
    }))
    expect(() => defineSchema(t2, rels)).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E7 — the resolution memo is keyed on (tables, rels), not on rels alone
// ─────────────────────────────────────────────────────────────────────────────

describe('E7 — resolution memo key', () => {
  it('re-validates when the same relation record is used with a different table set', () => {
    const users = pgTable('users', (t) => ({ id: t.uuid().primaryKey() }))
    const posts = pgTable('posts', (t) => ({ id: t.uuid().primaryKey(), authorId: t.uuid() }))
    const withPosts = { users, posts }
    const rels = defineRelations(withPosts, (r) => ({
      users: { posts: r.many.posts({ from: users[REFS].id, to: posts[REFS].authorId }) },
    }))

    expect(() => defineSchema(withPosts, rels)).not.toThrow()
    // Same `rels` object, a registry that has no `posts`. The old single-level memo handed back
    // the first resolution and skipped validation entirely.
    expect(() => defineSchema({ users }, rels)).toThrow(
      /points at "posts", which is not a table in this schema/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E8 — two TS keys may not map to one DB column
// ─────────────────────────────────────────────────────────────────────────────

describe('E8 — duplicate DB column names', () => {
  it('rejects two explicit names that collide', () => {
    expect(() => pgTable('dup', { a: text('x'), b: text('x') })).toThrow(SchemaError)
    expect(() => pgTable('dup', { a: text('x'), b: text('x') })).toThrow(
      /maps both "a" and "b" to the DB column "x"/,
    )
  })

  it('rejects a collision produced by the casing strategy, and names the strategy', () => {
    expect(() => pgTable('dup', { displayName: text(), display_name: text() })).toThrow(
      /casing strategy: snakeCase/,
    )
  })

  it('accepts distinct names', () => {
    const t = pgTable('okdup', { a: text('x'), b: text('y') })
    expect(t.$.columns.map((c) => c.dbName)).toEqual(['x', 'y'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E9 — identifier validity is checked where the name is declared
// ─────────────────────────────────────────────────────────────────────────────

const LONG = 'x'.repeat(64)

describe('E9 — identifier validity at declaration time', () => {
  it('names the table', () => {
    expect(() => pgTable(LONG, { id: text() })).toThrow(
      new RegExp(`pgTable\\("${LONG}"\\) table name is not a usable PostgreSQL identifier: too-long`),
    )
  })

  it('names the column and its resolved DB name', () => {
    expect(() => pgTable('t9', { id: text(LONG) })).toThrow(
      new RegExp(`pgTable\\("t9"\\)\\.id column name "${LONG}"`),
    )
  })

  it('rejects an empty and a NUL-bearing column name', () => {
    expect(() => pgTable('t9', { id: text('') })).toThrow(/empty/)
    expect(() => pgTable('t9', { id: text('a b') })).toThrow(/nul-byte/)
  })

  it('names the schema', () => {
    expect(() => pgTable('t9', { id: text() }, undefined, { schema: LONG })).toThrow(
      /pgTable\("t9"\) schema name/,
    )
  })

  it('names the enum type and the offending label', () => {
    expect(() => pgEnum(LONG, ['a'])).toThrow(/pgEnum\(".*"\) type name/)
    expect(() => pgEnum('e9', ['a', LONG])).toThrow(/pgEnum\("e9"\) label/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E11 — `__proto__` is reserved
// ─────────────────────────────────────────────────────────────────────────────

describe('E11 — __proto__ keys', () => {
  it('rejects a column record whose prototype was reassigned by a `__proto__:` key', () => {
    // A `__proto__:` key in an object literal never becomes an own property, so the column would
    // simply vanish. The prototype it leaves behind is the only detectable trace.
    const record = { __proto__: { marker: true }, id: text() } as unknown as Record<string, never>
    expect(() => pgTable('proto', record)).toThrow(/non-standard prototype/)
  })

  it('rejects an own `__proto__` column key', () => {
    const record = { ['__proto__']: text(), id: text() } as unknown as Record<string, never>
    expect(() => pgTable('proto', record)).toThrow(/"__proto__" is reserved/)
  })

  it('keeps the refs record null-prototype, so no column can shadow Object.prototype', () => {
    const t = pgTable('protoOk', { id: text() })
    expect(Object.getPrototypeOf(t[REFS])).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E12 — contradictory chains
// ─────────────────────────────────────────────────────────────────────────────

describe('E12 — contradictory column chains', () => {
  it('rejects .nullable() after .primaryKey() at the type level and at runtime', () => {
    // @ts-expect-error — `nullable` is an OrmTypeError sentinel once `pk` is true
    expect(() => uuid().primaryKey().nullable()).toThrow(SchemaError)
  })

  it('rejects the reverse order at runtime, which no cheap type gate can see', () => {
    expect(() => uuid().nullable().primaryKey()).toThrow(/\.primaryKey\(\) after \.nullable\(\)/)
  })

  it('rejects a default after .generatedAlways(), both directions', () => {
    // @ts-expect-error — `default` is an OrmTypeError sentinel once `ro` is true
    expect(() => text().generatedAlways().default('x')).toThrow(SchemaError)
    // @ts-expect-error — same for the DDL-expression and the client-side spellings
    expect(() => text().generatedAlways().defaultSql('now()')).toThrow(SchemaError)
    // @ts-expect-error
    expect(() => text().generatedAlways().$default(() => 'x')).toThrow(SchemaError)
    expect(() => text().default('x').generatedAlways()).toThrow(
      /\.generatedAlways\(\) after a default/,
    )
  })

  it('rejects .nullable() after .generatedAlways(), both directions', () => {
    // @ts-expect-error — `nullable` is an OrmTypeError sentinel once `ro` is true
    expect(() => text().generatedAlways().nullable()).toThrow(SchemaError)
    expect(() => text().nullable().generatedAlways()).toThrow(
      /\.generatedAlways\(\) after \.nullable\(\)/,
    )
  })

  it('still allows the legal chains the schema files actually use', () => {
    expect(() => uuid().primaryKey().defaultSql('gen_random_uuid()')).not.toThrow()
    expect(() => timestamptz().nullable().default(new Date(0))).not.toThrow()
    expect(() => uuid().primaryKey().generatedAlways()).not.toThrow()
    expect(() => uuid().generatedAlways().primaryKey()).not.toThrow()
  })

  it('rejects a duplicate enum label', () => {
    expect(() => pgEnum('e12', ['a', 'a'])).toThrow(/declares the label "a" twice/)
    expect(() => pgEnum('e12ok', ['a', 'b'])).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E17 — runtime objects
// ─────────────────────────────────────────────────────────────────────────────

describe('E17 — runtime object hygiene', () => {
  it('rejects a non-column value with a sentence naming the key', () => {
    const record = { id: 'text' } as unknown as Record<string, never>
    expect(() => pgTable('r17', record)).toThrow(/pgTable\("r17"\)\.id is not a column/)
  })

  it('freezes the table, its refs and its runtime column list', () => {
    const t = pgTable('f17', { id: text() })
    expect(Object.isFrozen(t)).toBe(true)
    expect(Object.isFrozen(t[REFS])).toBe(true)
    expect(Object.isFrozen(t.$.columns)).toBe(true)
    expect(Object.isFrozen(t.$.extras)).toBe(true)
  })

  it('freezes the schema registry and its handles', () => {
    const t = pgTable('f17b', { id: text() })
    const s = defineSchema({ t })
    expect(Object.isFrozen(s)).toBe(true)
    expect(Object.isFrozen(s.h)).toBe(true)
    expect(Object.isFrozen(s.h.t)).toBe(true)
  })
})
