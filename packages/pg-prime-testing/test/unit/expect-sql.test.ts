/**
 * Tier 0 for `expectSql` — that it passes on an indented golden, that it fails on a real
 * difference, and that what it throws is readable.
 */

import { compileOnly, eq } from 'pg-prime'
import { describe, expect, it } from 'vitest'
import { expectSql, normaliseSql } from '../../src/expect-sql.js'
import { schema } from './_schema.js'

const q = compileOnly(schema)

const byEmail = (email: string) =>
  q
    .from(q.h.users)
    .select(({ users: u }) => ({ id: u.id, email: u.email }))
    .where(({ users: u }) => eq(u.email, email))

describe('expectSql', () => {
  it('matches a golden that is indented to fit the code around it', () => {
    const compiled = expectSql(byEmail('ada@example.com'), {
      text: `
        select "users"."id" as "id", "users"."email" as "email"
        from "public"."users" as "users"
        where "users"."email" = $1
      `,
      values: ['ada@example.com'],
    })
    expect(compiled.binds).toHaveLength(1)
  })

  it('needs no database — `compileOnly` cannot run a query and this never asks it to', async () => {
    // The negative half of the claim: the same executor rejects `.execute()`.
    await expect(
      q
        .from(q.h.users)
        .select(({ users: u }) => ({ id: u.id }))
        .execute(),
    ).rejects.toThrow(/compileOnly/)
  })

  it('reports a text difference as a unified diff naming both lines', () => {
    let message = ''
    try {
      expectSql(byEmail('ada@example.com'), {
        text: `select "users"."id" as "id"
               from "public"."users" as "users"
               where "users"."email" = $1`,
      })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('--- expected sql')
    expect(message).toContain('+++ actual sql')
    expect(message).toContain('-select "users"."id" as "id"')
    expect(message).toContain('+select "users"."id" as "id", "users"."email" as "email"')
    // The lines that DID match are context, not noise duplicated on both sides.
    expect(message).toContain(' from "public"."users" as "users"')
  })

  it('reports a bind difference separately, with the values shown', () => {
    let message = ''
    try {
      expectSql(byEmail('ada@example.com'), {
        text: `select "users"."id" as "id", "users"."email" as "email"
               from "public"."users" as "users"
               where "users"."email" = $1`,
        values: ['grace@example.com'],
      })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('--- expected values')
    expect(message).toContain('-"grace@example.com"')
    expect(message).toContain('+"ada@example.com"')
  })

  it('compares binds as the wire values a codec produced, not as the inputs', () => {
    // `id` is a bigint column: `1n` goes on the wire as the text `'1'`, and that is what the
    // assertion sees. Asserting the input would be asserting the test's own literal.
    expectSql(
      q
        .from(q.h.users)
        .select(({ users: u }) => ({ id: u.id }))
        .where(({ users: u }) => eq(u.id, 1n)),
      {
        text: `select "users"."id" as "id"
               from "public"."users" as "users"
               where "users"."id" = $1`,
        values: ['1'],
      },
    )
  })

  it('asserts only the text when `values` is omitted', () => {
    expectSql(byEmail('anything@example.com'), {
      text: `select "users"."id" as "id", "users"."email" as "email"
             from "public"."users" as "users"
             where "users"."email" = $1`,
    })
  })

  it('normaliseSql trims, drops blank lines and collapses runs of spaces', () => {
    expect(normaliseSql('  select   1 \n\n   from t  \n')).toBe('select 1\nfrom t')
  })
})
