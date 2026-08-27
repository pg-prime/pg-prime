/**
 * Planner guards (`src/compile/hoist.ts`): the three ways the AST→AST pre-pass could produce a
 * *valid-looking* statement that answers a different question.
 *
 *  - **`one()` cardinality.** A `LEFT JOIN LATERAL` returning n rows multiplies the parent row n
 *    times. The `one` flavour is a cardinality claim, and the limit is what enforces it.
 *  - **DISTINCT ON.** Its expressions must be a syntactic prefix of ORDER BY, so a clause that is
 *    rewritten must be rewritten *everywhere* or PostgreSQL raises 42P10.
 *  - **Alias length.** A dotted `nest()` alias is cosmetic, but it is still an identifier, and
 *    PostgreSQL truncates identifiers at 63 bytes — so the compiler used to reject a perfectly
 *    valid query with a message about `sql.ident`, which the caller never called.
 */

import { describe, expect, it } from 'vitest'
import { int4Codec, int8Codec, textCodec } from '../../src/codec/index.js'
import { compile } from '../../src/compile/compiler.js'
import { planSelect } from '../../src/compile/hoist.js'
import {
  countStar,
  desc,
  eq,
  group,
  nested,
  param,
  projection,
  scalarSubquery,
  select,
} from '../../src/compile/nodes.js'
import { UnsupportedNodeError } from '../../src/sql/errors.js'
import { p, postsFrom, u, usersFrom } from '../sql/_helpers.js'

/** `users → author` shaped as a `one` relation, with whatever inner clauses a test wants. */
const authorRel = (extra: Partial<Parameters<typeof select>[0]> = {}) =>
  nested('author', {
    kind: 'one',
    alias: 'au',
    required: false,
    query: select({
      projection: [projection('id', p('id')), projection('title', p('title'))],
      from: postsFrom,
      where: eq(p('authorId'), u('id')),
      ...extra,
    }),
  })

const withProjection = (...items: ReturnType<typeof projection>[]) =>
  select({ projection: [projection('id', u('id')), ...items], from: usersFrom })

describe('a one() relation is limited to one row, always', () => {
  it('emits `limit 1` and one lateral', () => {
    const sql = compile(withProjection(authorRel())).sql
    expect(sql).toContain('left join lateral (')
    expect(sql).toContain('  limit 1\n) as "au" on true')
    expect(sql.match(/limit/g)).toHaveLength(1)
  })

  it('a caller-supplied limit is refused by name, not silently honoured', () => {
    // With `limit: inner.limit ?? 1` the lateral returned 2 rows and the LEFT JOIN duplicated
    // every parent row — the same user came back twice, with no error anywhere.
    let thrown: unknown
    try {
      compile(withProjection(authorRel({ limit: param(2, int4Codec) })))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(UnsupportedNodeError)
    expect((thrown as Error).message).toContain('author')
    expect((thrown as Error).message).toContain('one()')
  })

  it('…and so is an offset, which skips the only row it was allowed to return', () => {
    expect(() =>
      compile(withProjection(authorRel({ offset: param(1, int4Codec) }))),
    ).toThrow(UnsupportedNodeError)
  })

  it('NEGATIVE CONTROL — a many() relation keeps the caller’s limit', () => {
    const sql = compile(
      withProjection(
        nested('posts', {
          kind: 'many',
          alias: 'ps',
          query: select({
            projection: [projection('id', p('id'))],
            from: postsFrom,
            where: eq(p('authorId'), u('id')),
            limit: param(7, int4Codec),
          }),
        }),
      ),
    ).sql
    expect(sql).toContain('limit $1')
  })
})

describe('DISTINCT ON is rewritten with every other clause', () => {
  /** `(select count(*) from posts where posts.author_id = users.id)`, marked for hoisting. */
  const postCount = () =>
    scalarSubquery(
      select({
        projection: [projection('v', countStar())],
        from: postsFrom,
        where: eq(p('authorId'), u('id')),
      }),
      int8Codec,
      true,
    )

  it('the DISTINCT ON expression and the ORDER BY expression are the same reference', () => {
    const sql = compile(
      select({
        projection: [projection('id', u('id'))],
        from: usersFrom,
        distinct: { on: [postCount()] },
        orderBy: [desc(postCount())],
      }),
    ).sql
    // Left un-rewritten, the DISTINCT ON kept the correlated subquery while the ORDER BY became
    // `"_r0"."v"` — 42P10: SELECT DISTINCT ON expressions must match initial ORDER BY.
    expect(sql).toContain('select distinct on ("_r0"."v") "users"."id" as "id"')
    expect(sql).toContain('order by "_r0"."v" desc')
    expect(sql.match(/left join lateral/g)).toHaveLength(1)
    expect(sql).not.toContain('distinct on ((')
  })

  it('NEGATIVE CONTROL — a plain DISTINCT ON is untouched, node identity included', () => {
    const node = select({
      projection: [projection('id', u('id'))],
      from: usersFrom,
      distinct: { on: [u('role')] },
      orderBy: [desc(u('role'))],
    })
    expect(planSelect(node).node).toBe(node)
    expect(compile(node).sql).toContain('select distinct on ("users"."role") "users"."id" as "id"')
  })
})

describe('a dotted nest() alias that would exceed 63 bytes falls back to a short one', () => {
  const long = (n: number, tag: string) => `${tag}${'x'.repeat(n - tag.length)}`

  it('keeps the dotted alias while it fits — that is what makes EXPLAIN legible', () => {
    const sql = compile(
      select({
        projection: [
          group('author', {
            items: [projection('name', u('name'))],
            nullable: false,
          }),
        ],
        from: usersFrom,
      }),
    ).sql
    expect(sql).toBe('select "users"."name" as "author.name"\nfrom "public"."users" as "users"')
  })

  it('generates one when it does not, instead of failing a valid query', () => {
    // 40 + 1 + 40 = 81 bytes of perfectly ordinary column names. Before: the compile threw
    // `identifier part 0 rejected (too-long)` from inside `quoteIdentPart`.
    const outer = long(40, 'author')
    const innerKey = long(40, 'displayName')
    const c = compile(
      select({
        projection: [
          group(outer, {
            items: [projection(innerKey, u('name'))],
            nullable: false,
          }),
        ],
        from: usersFrom,
      }),
    )
    expect(c.sql).toBe('select "users"."name" as "_g0"\nfrom "public"."users" as "users"')
    // The decode plan is positional, so the fallback alias costs nothing: the KEYS are the
    // caller's, only the SQL alias changed.
    expect(c.shape).toEqual({
      k: 'row',
      fields: [
        {
          key: outer,
          k: 'group',
          nullable: false,
          sentinel: undefined,
          witnesses: undefined,
          fields: [{ key: innerKey, k: 'col', idx: 0, codec: textCodec }],
        },
      ],
    })
  })

  it('a multi-byte name is measured in UTF-8 bytes, as PostgreSQL measures it', () => {
    // 30 emoji × 4 bytes = 120 bytes in 60 UTF-16 code units: a length check on `.length` would
    // have let this through and then failed in `quoteIdentPart`.
    const emoji = '🙂'.repeat(30)
    const c = compile(
      select({
        projection: [
          group('g', { items: [projection(emoji, u('name'))], nullable: false }),
        ],
        from: usersFrom,
      }),
    )
    expect(c.sql).toContain(' as "_g0"')
  })
})
