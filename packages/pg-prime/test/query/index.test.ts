/**
 * The package entry point (`src/index.ts`) — what `import { … } from 'pg-prime'` gets.
 *
 * A barrel is API, so it is tested like API: the list below is hand-written, not read back out of
 * the module (an echo would pass no matter what the barrel contained). Two directions matter and
 * both are asserted:
 *
 *  - **present** — every name design/03 §2 and design/05 spell in an example is reachable, and one
 *    query is built end to end *through the barrel only*, so a missing re-export is a test failure
 *    rather than a discovery at publish time;
 *  - **absent** — the test-only surface stays out. `OPS` / `CONFIRMABLE` are the operator manifest
 *    (the list the goldens and the OID differential are generated from) and the AST constructors
 *    are the layer below the builder; `export * from './query/types.js'` would have shipped both.
 */

import { describe, expect, it } from 'vitest'
import * as pgPrime from '../../src/index.js'

/** Hand-written, in the order design/03 introduces them. */
const EXPECTED_VALUES = [
  // schema DSL (05)
  'pgTable',
  'pgEnum',
  'defineSchema',
  'defineRelations',
  'primaryKey',
  'uniqueIndex',
  'index',
  'comment',
  'kit',
  'text',
  'bigint',
  'timestamptz',
  'jsonb',
  'REFS',
  'NAME',
  'META',
  'OUT',
  // sql tag + errors (03 §3)
  'sql',
  'isFragment',
  'quoteIdentPart',
  'BuilderError',
  'NullOperandError',
  'NoCodecError',
  'PgPrimeError',
  'SchemaError',
  // codecs (02 §4)
  'Registry',
  'defaultRegistry',
  'builtinCodecs',
  'int8Codec',
  'textCodec',
  'jsonbCodec',
  'PgEncodeError',
  // driver (02)
  'pgDriver',
  'PgDriverError',
  // query (03 §2)
  'pgPrime',
  'compileOnly',
  'nest',
  'nestNullable',
  'over',
  'fn',
  'and',
  'or',
  'not',
  'exists',
  'notExists',
  'asc',
  'desc',
  'eq',
  'neq',
  'gt',
  'inList',
  'inQuery',
  'between',
  'like',
  'jsonGet',
  'hasKey',
  'arrayContains',
  'rangeOverlaps',
  'containsNet',
  'matches',
  'cast',
  'coalesce',
  'val',
] as const

/** Internals that must NOT be on the public surface. */
const EXPECTED_ABSENT = [
  'OPS',
  'CONFIRMABLE',
  'compile',
  'compileExpr',
  'planSelect',
  'planReturning',
  'buildDecoder',
  'mkNode',
  'isAstNode',
  'projection',
  'setop',
  'scopeFor',
  'metaOf',
  'refsOf',
  'makeSelect',
  'makeInsert',
  'registerBuilder',
  'RANGE_ELEMENT_NAMES',
  'typeSource',
  'assertSessionGucs',
] as const

describe('the pg-prime barrel', () => {
  it('exports everything design/03 §2 and design/05 name', () => {
    const missing = EXPECTED_VALUES.filter((k) => !(k in pgPrime))
    expect(missing).toStrictEqual([])
  })

  it('exports nothing internal', () => {
    const leaked = EXPECTED_ABSENT.filter((k) => k in pgPrime)
    expect(leaked).toStrictEqual([])
  })

  it('builds and compiles a query through the barrel alone', () => {
    const users = pgPrime.pgTable('users', (t) => ({
      id: t.bigint().primaryKey().generatedAlways(),
      email: t.text(),
      deletedAt: t.timestamptz().nullable(),
    }))
    const schema = pgPrime.defineSchema({ users })
    const db = pgPrime.compileOnly(schema)
    const built = db
      .from(schema.h.users)
      .select(({ users: u }) => ({ id: u.id, email: u.email }))
      .where(({ users: u }) =>
        pgPrime.and(pgPrime.isNull(u.deletedAt), pgPrime.like(u.email, '%@acme')),
      )
      .orderBy(({ users: u }) => pgPrime.desc(u.id))
      .limit(10)
    expect(built.compile().sql).toBe(
      [
        'select "users"."id" as "id", "users"."email" as "email"',
        'from "public"."users" as "users"',
        'where ("users"."deleted_at" is null and "users"."email" like $1)',
        'order by "users"."id" desc',
        'limit $2',
      ].join('\n'),
    )
  })
})
