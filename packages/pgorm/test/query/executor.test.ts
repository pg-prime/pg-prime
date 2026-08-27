/**
 * `pgOrm()`'s two invisible decisions: **which registry** a db decodes against, and **how often**
 * a decode plan is built (design/09 WS4/WS6 seam).
 *
 * Both are invisible in the sense that no SQL changes, which is why each needs an oracle that is
 * not the builder: a codec registered on the process-wide default (whose presence or absence is
 * the whole question), and a counting wrapper around `buildDecoder` (whose call count is the
 * whole question). The decoded values are asserted against hand-written expectations either way,
 * so a memo that returned a stale decoder would fail on the value and not only on the count.
 */

import { describe, expect, it, vi } from 'vitest'

const built = vi.hoisted(() => ({ n: 0 }))

vi.mock('../../src/compile/decode.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/compile/decode.js')>(
    '../../src/compile/decode.js',
  )
  return {
    ...actual,
    buildDecoder: (...args: Parameters<typeof actual.buildDecoder>) => {
      built.n += 1
      return actual.buildDecoder(...args)
    },
  }
})

const { defaultRegistry, textCodec } = await import('../../src/codec/index.js')
const { pgOrm } = await import('../../src/query/run.js')
const { defineSchema, pgEnum, pgTable } = await import('../../src/schema/index.js')
const { mockDriver } = await import('./_mock-driver.js')
const { schema } = await import('./_schema.js')

/** The OID the query will decode this column with — `undefined` until a registry has resolved it. */
function oidOfFirstColumn(shape: import('../../src/compile/contract.js').ResultShape): number | undefined {
  if (shape.k !== 'row') throw new Error('expected a row shape')
  const field = shape.fields[0]
  if (field === undefined || field.k !== 'col') throw new Error('expected a column field')
  return field.codec.oid
}

describe('pgOrm() does not decode against the process-wide registry', () => {
  it('an enum resolved on defaultRegistry() is invisible to a db that was given none', () => {
    // The oracle is a *user type's OID*, which is exactly what `02` §4.6 says is per database.
    // `resolveDynamic` writes it into whichever registry it was handed; a db that shares the
    // process-wide one therefore decodes its rows against whatever database resolved first.
    const mood = pgEnum('audit_mood', ['sad', 'ok'])
    const moody = pgTable('moody', (t) => ({ v: t.enum(mood) }))
    const moodSchema = defineSchema({ moody })
    defaultRegistry().register({
      ...textCodec,
      name: 'audit_mood',
      sqlName: '"public"."audit_mood"',
      oid: 90001,
      typeClass: 'enum',
    })

    const shape = (db: ReturnType<typeof pgOrm<typeof moodSchema>>) =>
      db
        .from(moodSchema.h.moody)
        .select(({ moody: m }) => ({ v: m.v }))
        .compile().shape

    // A fresh registry has never met this database, so the codec is still the *pending* one.
    expect(oidOfFirstColumn(shape(pgOrm({ driver: mockDriver(), schema: moodSchema })))).toBeUndefined()
    // Handing the shared one over explicitly still works — this is isolation, not a regression.
    expect(
      oidOfFirstColumn(
        shape(pgOrm({ driver: mockDriver(), schema: moodSchema, registry: defaultRegistry() })),
      ),
    ).toBe(90001)
  })
})

describe('the decode plan is built once per compiled statement', () => {
  it('two executions of one builder build one decoder, and decode the same values', async () => {
    const driver = mockDriver()
    const db = pgOrm({ driver, schema })
    const query = db.from(schema.h.users).select(({ users: u }) => ({ id: u.id, email: u.email }))

    driver.rows.push([['7', 'ada@x']], [['8', 'grace@x']])
    built.n = 0
    expect(await query.execute()).toStrictEqual([{ id: 7n, email: 'ada@x' }])
    const afterFirst = built.n
    expect(await query.execute()).toStrictEqual([{ id: 8n, email: 'grace@x' }])

    expect(afterFirst).toBe(1)
    expect(built.n).toBe(1)
  })

  it('a different statement gets its own decoder', async () => {
    const driver = mockDriver()
    const db = pgOrm({ driver, schema })
    driver.rows.push([['7', 'ada@x']], [['t']])
    built.n = 0
    await db.from(schema.h.users).select(({ users: u }) => ({ id: u.id, email: u.email })).execute()
    expect(
      await db.from(schema.h.posts).select(({ posts: p }) => ({ published: p.published })).execute(),
    ).toStrictEqual([{ published: true }])
    expect(built.n).toBe(2)
  })
})
