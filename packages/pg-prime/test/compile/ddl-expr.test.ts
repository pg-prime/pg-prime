import { describe, expect, it } from 'vitest'
import {
  boolCodec,
  byteaCodec,
  int4Codec,
  jsonbCodec,
  textCodec,
  timestamptzCodec,
  uuidCodec,
} from '../../src/codec/index.js'
import { compileDdlExpr } from '../../src/compile/compiler.js'
import {
  agg,
  and,
  bin,
  cast,
  col,
  countStar,
  fn,
  is,
  not,
  or,
  over,
  param,
  placeholder,
} from '../../src/compile/nodes.js'
import { SchemaError } from '../../src/sql/errors.js'
import { sql } from '../../src/sql/index.js'
import { toNode } from '../../src/sql/fragment.js'

const orgId = col('documents', 'org_id', uuidCodec)
const archived = col('documents', 'archived', boolCodec)
const ddl = (e: Parameters<typeof compileDdlExpr>[0]): string => compileDdlExpr(e, 'test')

describe('compileDdlExpr', () => {
  it('renders eq/and/or/not/is/cast with qualified columns and inlined, cast binds', () => {
    const u = '6f1c2a3b-0000-4000-8000-000000000001'
    expect(ddl(bin('=', orgId, param(u, uuidCodec)))).toBe(`"documents"."org_id" = '${u}'::uuid`)
    expect(
      ddl(
        and(
          or(bin('=', archived, param(false, boolCodec)), is(orgId, 'null')),
          not(is(archived, 'true')),
          bin('<', cast(orgId, 'text', textCodec), param("o'brien", textCodec)),
        ),
      ),
    ).toBe(
      `(("documents"."archived" = 'f'::boolean or "documents"."org_id" is null) and ` +
        `not ("documents"."archived" is true) and "documents"."org_id"::text < 'o''brien'::text)`,
    )
  })

  it('renders backslashes, NULL, jsonb and timestamptz binds with their codec', () => {
    expect(ddl(bin('=', orgId, param('a\\b', textCodec)))).toBe(
      `"documents"."org_id" = E'a\\\\b'::text`,
    )
    expect(ddl(bin('=', orgId, param(null, int4Codec)))).toBe(
      `"documents"."org_id" = NULL::integer`,
    )
    expect(ddl(fn('f', [param({ a: 1 }, jsonbCodec)], boolCodec))).toBe(`f('{"a":1}'::jsonb)`)
    expect(ddl(fn('f', [param(new Date(0), timestamptzCodec)], boolCodec))).toBe(
      `f('1970-01-01 00:00:00.000Z'::timestamptz)`,
    )
  })

  it('leaves an untyped bind as a bare literal', () => {
    expect(ddl(toNode(sql`${archived} = ${'t'} and ${null} is null`))).toBe(
      `"documents"."archived" = 't' and NULL is null`,
    )
  })

  it('qualifies a schema ref interpolated into raw SQL by its relation name', () => {
    const plainRef = { $: { table: 'memberships', dbName: 'org_id' } }
    expect(
      ddl(toNode(sql`exists (select 1 from memberships m where ${plainRef} = ${orgId})`)),
    ).toBe(
      `exists (select 1 from memberships m where "memberships"."org_id" = "documents"."org_id")`,
    )
  })

  it.each([
    ['a placeholder', bin('=', orgId, placeholder('org', uuidCodec)), /placeholder/],
    ['an aggregate', bin('>', countStar(), param(1, int4Codec)), /an aggregate/],
    ['a window call', over(agg('rank', [], int4Codec), {}), /a window call/],
    ['a binary bind', bin('=', orgId, param(new Uint8Array([1]), byteaCodec)), /a binary bind/],
  ])('refuses %s', (_, e, message) => {
    expect(() => ddl(e)).toThrow(SchemaError)
    expect(() => ddl(e)).toThrow(message)
  })
})
