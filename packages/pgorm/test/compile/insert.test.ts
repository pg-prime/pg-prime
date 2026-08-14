/**
 * INSERT … VALUES … RETURNING goldens (03 §2.5, §2.6, Appendix A).
 *
 * `RETURNING` reuses the *same* projection machinery as `select`, which is what makes `sql`
 * fragments work there for free.
 */

import { describe, expect, it } from 'vitest'
import { compile } from '../../src/compile/compiler.js'
import { buildDecoder } from '../../src/compile/decode.js'
import type { Expr } from '../../src/compile/ast.js'
import { insert, param, projection, table } from '../../src/compile/nodes.js'
import { spikeCodecs } from '../../src/sql/codec.js'
import { UnsupportedNodeError } from '../../src/sql/errors.js'
import { sql, toNode } from '../../src/sql/fragment.js'
import { u, usersCols, usersTable } from '../sql/_helpers.js'

const into = table(usersTable)
const cols = [usersCols.email, usersCols.name, usersCols.role]

const row = (email: string, name: string, role: string): readonly Expr[] => [
  param(email, spikeCodecs.citext),
  param(name, spikeCodecs.text),
  param(role, spikeCodecs.text),
]

const vals = (c: { binds: readonly { k: string }[] }) =>
  c.binds.map((b) => (b as { encoded?: unknown }).encoded)

describe('§2.5 — single-row insert with RETURNING', () => {
  it('matches design/03 Appendix A byte for byte', () => {
    const compiled = compile(
      insert({
        into,
        columns: cols,
        source: { k: 'values', rows: [row('a@b.c', 'Ada', 'admin')] },
        returning: [projection('id', u('id')), projection('createdAt', u('createdAt'))],
      }),
    )

    expect(compiled.sql).toBe(
      [
        'insert into "public"."users" ("email", "name", "role") values ($1, $2, $3)',
        'returning "id" as "id", "created_at" as "createdAt"',
      ].join('\n'),
    )
    expect(vals(compiled)).toEqual(['a@b.c', 'Ada', 'admin'])
    expect(compiled.meta.kind).toBe('insert')
    expect(compiled.meta.writes).toEqual([{ schema: 'public', name: 'users' }])
    expect(compiled.meta.reads).toEqual([])
  })

  it('RETURNING columns are unqualified (the target table is implicit)', () => {
    const compiled = compile(
      insert({
        into,
        columns: cols,
        source: { k: 'values', rows: [row('a@b.c', 'Ada', 'admin')] },
        returning: [projection('id', u('id'))],
      }),
    )
    expect(compiled.sql).toContain('returning "id" as "id"')
    expect(compiled.sql).not.toContain('returning "users"."id"')
  })

  it('no RETURNING => a void shape, and the decoder yields nothing', () => {
    const compiled = compile(
      insert({ into, columns: cols, source: { k: 'values', rows: [row('a@b.c', 'A', 'r')] } }),
    )
    expect(compiled.shape).toEqual({ k: 'void' })
    expect(buildDecoder(compiled.shape)([['1'], ['2']])).toEqual([])
    expect(compiled.sql).not.toContain('returning')
  })
})

describe('§2.6 — multi-row VALUES', () => {
  it('emits one tuple per row and numbers parameters row-major', () => {
    const compiled = compile(
      insert({
        into,
        columns: cols,
        source: {
          k: 'values',
          rows: [row('a@x', 'A', 'admin'), row('b@x', 'B', 'user'), row('c@x', 'C', 'user')],
        },
        returning: [projection('id', u('id'))],
      }),
    )
    expect(compiled.sql).toBe(
      [
        'insert into "public"."users" ("email", "name", "role") values ' +
          '($1, $2, $3), ($4, $5, $6), ($7, $8, $9)',
        'returning "id" as "id"',
      ].join('\n'),
    )
    expect(vals(compiled)).toEqual(['a@x', 'A', 'admin', 'b@x', 'B', 'user', 'c@x', 'C', 'user'])
    expect(compiled.binds).toHaveLength(9)
  })

  it('castFirstRow pins the column types on row 1 only', () => {
    // PostgreSQL infers the remaining rows from row 1, so this costs one row's worth of
    // tokens and stops a 5 000-row batch from inferring `text` for a `numeric` column.
    const compiled = compile(
      insert({
        into,
        columns: cols,
        castFirstRow: true,
        source: { k: 'values', rows: [row('a@x', 'A', 'admin'), row('b@x', 'B', 'user')] },
      }),
    )
    expect(compiled.sql).toBe(
      'insert into "public"."users" ("email", "name", "role") values ' +
        '($1::citext, $2::text, $3::text), ($4, $5, $6)',
    )
  })

  it('default values', () => {
    expect(compile(insert({ into, columns: [], source: { k: 'defaults' } })).sql).toBe(
      'insert into "public"."users" () default values',
    )
  })
})

describe('RETURNING reuses the projection machinery', () => {
  it('accepts sql fragments, and their parameters number after the VALUES', () => {
    const compiled = compile(
      insert({
        into,
        columns: cols,
        source: { k: 'values', rows: [row('a@x', 'A', 'admin')] },
        returning: [
          projection('id', u('id')),
          projection('tag', toNode(sql`${'v'} || ${'w'}`.as(spikeCodecs.text))),
        ],
      }),
    )
    expect(compiled.sql).toBe(
      [
        'insert into "public"."users" ("email", "name", "role") values ($1, $2, $3)',
        'returning "id" as "id", $4 || $5 as "tag"',
      ].join('\n'),
    )
    expect(vals(compiled)).toEqual(['a@x', 'A', 'admin', 'v', 'w'])
    expect(compiled.shape).toEqual({
      k: 'row',
      fields: [
        { key: 'id', k: 'col', idx: 0, codec: spikeCodecs.int8 },
        { key: 'tag', k: 'col', idx: 1, codec: spikeCodecs.text },
      ],
    })
  })

  it('rejects a nested relation in RETURNING with a precise error, not invalid SQL', () => {
    expect(() =>
      compile(
        insert({
          into,
          columns: cols,
          source: { k: 'values', rows: [row('a@x', 'A', 'admin')] },
          returning: [
            {
              key: 'posts',
              expr: param(null),
              nested: {
                kind: 'many',
                alias: 'lp',
                query: { k: 'select', projection: [projection('id', u('id'))] },
              },
            },
          ],
        }),
      ),
    ).toThrow(UnsupportedNodeError)
  })
})

describe('unsupported statements fail loudly', () => {
  it('names the node kind rather than emitting something plausible', () => {
    expect(() =>
      compile({
        k: 'delete',
        from: into,
      } as never),
    ).toThrowError(/'delete' is not implemented/)
  })
})
