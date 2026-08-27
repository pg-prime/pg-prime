/**
 * `.prepare()` — the contract in `03` §1.4 (b), pinned (design/09 WS6).
 *
 * The claim is "no AST walk, no compile", and the only way to test a claim about *not* doing work
 * is to count the work: `compile` and `buildDecoder` are spied here, and `codec.encode` is
 * counted through a wrapper codec. Everything else — `$n` order, the missing/extra key errors —
 * is checked against the encoded parameters the mock driver actually received, which is a
 * different artifact from the builder that produced them.
 */

import { describe, expect, it, vi } from 'vitest'

const spies = vi.hoisted(() => ({ compiles: 0, decoders: 0 }))

vi.mock('../../src/compile/compiler.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/compile/compiler.js')>(
      '../../src/compile/compiler.js',
    )
  return {
    ...actual,
    compile: (...args: Parameters<typeof actual.compile>) => {
      spies.compiles += 1
      return actual.compile(...args)
    },
  }
})

vi.mock('../../src/compile/decode.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/compile/decode.js')>(
      '../../src/compile/decode.js',
    )
  return {
    ...actual,
    buildDecoder: (...args: Parameters<typeof actual.buildDecoder>) => {
      spies.decoders += 1
      return actual.buildDecoder(...args)
    },
  }
})

const { int8Codec, numericCodec, textCodec, varcharCodec } = await import('../../src/codec/index.js')
const type = await import('../../src/codec/types.js')
const { pgPrime } = await import('../../src/query/run.js')
const q = await import('../../src/query/types.js')
const { BuilderError } = await import('../../src/sql/errors.js')
const { mockDriver } = await import('./_mock-driver.js')
const { schema } = await import('./_schema.js')

void type

/** A codec that counts its own `encode` calls. Identical behaviour, one extra closure. */
function counting<C extends { encode(v: never): unknown }>(codec: C): C & { calls: number } {
  const out = {
    ...codec,
    calls: 0,
    encode(v: never) {
      out.calls += 1
      return codec.encode(v)
    },
  }
  return out as C & { calls: number }
}

describe('.prepare() compiles once and re-encodes per execution', () => {
  it('two executions: one compile, one decoder, two encodes per slot', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    const email = counting(varcharCodec)

    spies.compiles = 0
    spies.decoders = 0
    const byEmail = db
      .from(schema.h.users)
      .select(({ users: u }) => ({ id: u.id, email: u.email }))
      .where(({ users: u }) => q.eq(u.email, q.placeholder('email', email)))
      .prepare<{ email: string }>('users_by_email')
    const afterPrepare = spies.compiles

    driver.rows.push([['7', 'ada@x']], [['8', 'grace@x']])
    expect(await byEmail.execute({ email: 'ada@x' })).toStrictEqual([{ id: 7n, email: 'ada@x' }])
    expect(await byEmail.execute({ email: 'grace@x' })).toStrictEqual([
      { id: 8n, email: 'grace@x' },
    ])

    // `.prepare()` compiles exactly once, and executing never compiles again.
    expect(afterPrepare).toBe(1)
    expect(spies.compiles).toBe(1)
    // The decode plan is likewise built once and reused (03 §1.3).
    expect(spies.decoders).toBe(1)
    // …and the ONE thing that must happen per execution did: a fresh encode per slot.
    expect(email.calls).toBe(2)
    expect(driver.log.map((r) => r.params)).toStrictEqual([['ada@x'], ['grace@x']])
  })

  it('the artifact is frozen: `compile()` is the same object every time', () => {
    const db = pgPrime({ driver: mockDriver(), schema })
    const p = db.from(schema.h.users).select(({ users: u }) => ({ id: u.id })).prepare()
    expect(p.compile()).toBe(p.compile())
  })
})

describe('placeholders and `$n`', () => {
  /** Three holes in an order the projection does NOT share, so a slot/bind mix-up is visible. */
  const build = (db: ReturnType<typeof pgPrime<typeof schema>>) =>
    db
      .from(schema.h.posts)
      .select(({ posts: p }) => ({ id: p.id }))
      .where(({ posts: p }) =>
        q.and(
          q.gt(p.amount, q.placeholder('min', numericCodec)),
          q.eq(p.authorId, q.placeholder('author', int8Codec)),
          q.eq(p.title, q.placeholder('title', textCodec)),
        ),
      )
      .prepare<{ min: string; author: bigint; title: string }>()

  it('bind order follows `$n`, not the object literal the caller wrote', async () => {
    const driver = mockDriver()
    const p = build(pgPrime({ driver, schema }))
    // Deliberately spelled out of order. `$1` is `min`, `$2` is `author`, `$3` is `title`, and
    // the ORACLE is the SQL text itself, which names the columns those holes sit next to.
    await p.execute({ title: 'hi', author: 9n, min: '10.50' })
    expect(p.sql).toContain('"posts"."amount" > $1')
    expect(p.sql).toContain('"posts"."author_id" = $2')
    expect(p.sql).toContain('"posts"."title" = $3')
    expect(driver.log[0]?.params).toStrictEqual(['10.50', '9', 'hi'])
    // The declared parameter OIDs come from the placeholder's own codec, in the same order.
    expect(driver.log[0]?.paramTypes).toStrictEqual([1700, 20, 25])
    expect(p.meta.placeholders).toStrictEqual(['min', 'author', 'title'])
  })

  it('a MISSING key throws a BuilderError naming the placeholder, before anything is sent', async () => {
    const driver = mockDriver()
    const p = build(pgPrime({ driver, schema }))
    await expect(
      p.execute({ min: '1', author: 1n } as never as { min: string; author: bigint; title: string }),
    ).rejects.toThrow(/placeholder "title"/)
    expect(driver.log).toStrictEqual([])
  })

  it('an EXTRA key throws naming it, because a typo that is ignored filters on nothing', async () => {
    const driver = mockDriver()
    const p = build(pgPrime({ driver, schema }))
    await expect(
      p.execute({ min: '1', author: 1n, title: 'x', tittle: 'x' } as never),
    ).rejects.toThrow(/"tittle"/)
    expect(driver.log).toStrictEqual([])
  })

  it('the error is a BuilderError, so a caller can branch on `code`', async () => {
    const p = build(pgPrime({ driver: mockDriver(), schema }))
    await p.execute({ min: '1', author: 1n, title: 'x' }).catch(() => {})
    const err = await p.execute({} as never).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BuilderError)
    expect((err as InstanceType<typeof BuilderError>).code).toBe('BUILDER')
  })

  it('placeholder() refuses an empty name rather than emitting an unfillable hole', () => {
    expect(() => q.placeholder('', textCodec)).toThrow(BuilderError)
  })
})

describe('the rest of the prepared surface', () => {
  it('toSQL() shows the holes unfilled, and filled when given values', () => {
    const p = pgPrime({ driver: mockDriver(), schema })
      .from(schema.h.users)
      .select(({ users: u }) => ({ id: u.id }))
      .where(({ users: u }) => q.eq(u.email, q.placeholder('email', varcharCodec)))
      .prepare<{ email: string }>()
    expect(p.toSQL().params).toStrictEqual([{ placeholder: 'email' }])
    expect(p.toSQL({ email: 'a@b.c' }).params).toStrictEqual(['a@b.c'])
  })

  it('executeTakeFirst() takes the parameters too', async () => {
    const driver = mockDriver()
    const p = pgPrime({ driver, schema })
      .from(schema.h.users)
      .select(({ users: u }) => ({ id: u.id }))
      .where(({ users: u }) => q.eq(u.email, q.placeholder('email', varcharCodec)))
      .prepare<{ email: string }>()
    driver.rows.push([['7'], ['8']])
    expect(await p.executeTakeFirst({ email: 'a@b.c' })).toStrictEqual({ id: 7n })
  })

  it('a chunked insert refuses to prepare, and says how many statements it is', () => {
    const db = pgPrime({ driver: mockDriver(), schema })
    const rows = Array.from({ length: 12_000 }, (_, i) => ({ body: `b${i}` }))
    expect(() =>
      db
        .insertInto(schema.h.comments)
        .valuesMany(rows, { strategy: 'values', chunkSize: 5_000 })
        .prepare(),
    ).toThrow(/describes ONE statement and this insert compiles to 3/)
  })

  it('the JS-side name is kept and is NOT the server-side one (03 §1.4b, 07 §2.4)', () => {
    const p = pgPrime({ driver: mockDriver(), schema })
      .from(schema.h.users)
      .select(({ users: u }) => ({ id: u.id }))
      .prepare('users_all')
    expect(p.name).toBe('users_all')
    // Nothing named `users_all` ever reaches the wire: the server-side name is derived from the
    // SQL hash so it is stable per statement and unique per connection (see named.test.ts).
    expect(p.sql).not.toContain('users_all')
  })
})
