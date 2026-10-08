/**
 * `.ifVersion()` and `executeRowCount()`, tier 0. The mock driver reports `rowCount: 0` for every
 * statement, so every versioned run here is a conflict; the matching case is `test/live-query/`.
 */

import { describe, expect, it } from 'vitest'
import { int4Codec } from '../../src/codec/index.js'
import { PgPrimeError, VersionConflictError } from '../../src/errors/index.js'
import { compileOnly, pgPrime } from '../../src/query/run.js'
import * as q from '../../src/query/types.js'
import { defineSchema, pgTable } from '../../src/schema/index.js'
import { NullOperandError } from '../../src/sql/errors.js'
import { mockDriver } from './_mock-driver.js'

const blocks = pgTable('blocks', (t) => ({
  id: t.bigint().primaryKey(),
  text: t.text(),
  rev: t.integer(),
}))
const schema = defineSchema({ blocks })
const b = schema.h.blocks
const cdb = compileOnly(schema)

const versionedUpdate = (db: typeof cdb) =>
  db
    .update(b)
    .set(({ blocks: x }) => ({ text: 'x', rev: q.add(x.rev, 1) }))
    .where(({ blocks: x }) => q.eq(x.id, 1n))
    .ifVersion(({ blocks: x }) => x.rev, 7)

const versionedDelete = (db: typeof cdb) =>
  db
    .deleteFrom(b)
    .where(({ blocks: x }) => q.eq(x.id, 1n))
    .ifVersion(({ blocks: x }) => x.rev, 7)

const params = (c: { binds: readonly unknown[] }) =>
  c.binds.map((x) => (x as { encoded?: unknown }).encoded)

describe('SQL', () => {
  it('update: the check is ANDed after the where, bound with the column codec', () => {
    const c = versionedUpdate(cdb).compile()
    expect(c.sql).toBe(
      [
        'update "public"."blocks" as "blocks"',
        'set "text" = $1, "rev" = "blocks"."rev" + $2',
        'where ("blocks"."id" = $3 and "blocks"."rev" = $4)',
      ].join('\n'),
    )
    expect(params(c)).toStrictEqual(['x', '1', '1', '7'])
    expect(c.binds[3]).toMatchObject({ oid: 23 })
    expect(c.meta.versionCheck).toStrictEqual({ table: 'blocks', expected: 7 })
  })

  it('delete', () => {
    const c = versionedDelete(cdb).compile()
    expect(c.sql).toBe(
      'delete from "public"."blocks" as "blocks"\nwhere ("blocks"."id" = $1 and "blocks"."rev" = $2)',
    )
    expect(c.meta.versionCheck).toStrictEqual({ table: 'blocks', expected: 7 })
  })

  it('an unversioned statement carries no versionCheck', () => {
    const c = cdb
      .deleteFrom(b)
      .where(({ blocks: x }) => q.eq(x.id, 1n))
      .compile()
    expect('versionCheck' in c.meta).toBe(false)
    expect('versionCheck' in cdb.deleteFrom(b).allRows().toAst()).toBe(false)
  })
})

describe('refused at build time', () => {
  it('does not satisfy the no-WHERE guard', () => {
    expect(() =>
      cdb
        .update(b)
        .set(() => ({ text: 'x' }))
        .ifVersion(({ blocks: x }) => x.rev, 1)
        .toAst(),
    ).toThrowError(/has no \.where\(\)/)
    expect(() =>
      cdb
        .deleteFrom(b)
        .ifVersion(({ blocks: x }) => x.rev, 1)
        .toAst(),
    ).toThrowError(/has no \.where\(\)/)
  })

  it('with fromValues, in either order', () => {
    const vals = [{ id: 1 }]
    const codecs = { id: int4Codec }
    expect(() =>
      cdb
        .update(b)
        .fromValues(vals, codecs)
        .ifVersion(({ blocks: x }) => x.rev, 1),
    ).toThrowError(/cannot be combined with fromValues/)
    expect(() =>
      cdb
        .update(b)
        .ifVersion(({ blocks: x }) => x.rev, 1)
        .fromValues(vals, codecs),
    ).toThrowError(/cannot be combined with fromValues/)
  })

  it('a null expected is a NullOperandError; a second ifVersion is refused', () => {
    expect(() => cdb.deleteFrom(b).ifVersion(({ blocks: x }) => x.rev, null as never)).toThrow(
      NullOperandError,
    )
    expect(() =>
      cdb
        .deleteFrom(b)
        .ifVersion(({ blocks: x }) => x.rev, 1)
        .ifVersion(({ blocks: x }) => x.rev, 2),
    ).toThrowError(/already set/)
  })

  it('as a CTE body, as a builder or as its .toAst() node', () => {
    expect(() => cdb.with('d', () => versionedDelete(cdb))).toThrowError(/cannot be a CTE body/)
    expect(() => cdb.with('d', () => versionedUpdate(cdb).toAst() as never)).toThrowError(
      /cannot be a CTE body/,
    )
  })
})

describe('runtime', () => {
  const conflict = async (p: Promise<unknown>) => {
    const e = await p.then(
      () => undefined,
      (x: unknown) => x,
    )
    expect(e).toBeInstanceOf(VersionConflictError)
    return e as VersionConflictError
  }

  it('0 rows → VersionConflictError from every terminal; executeRowCount without a check is 0', async () => {
    const db = pgPrime({ driver: mockDriver(), schema })
    for (const p of [
      versionedUpdate(db).execute(),
      versionedUpdate(db).executeTakeFirst(),
      versionedUpdate(db).executeRowCount(),
      versionedDelete(db).execute(),
      db.run(versionedDelete(db)),
      db.run(versionedDelete(db).compile()),
      versionedDelete(db).prepare().execute({}),
    ])
      await conflict(p)
    expect(
      await db
        .deleteFrom(b)
        .where(({ blocks: x }) => q.eq(x.id, 1n))
        .executeRowCount(),
    ).toBe(0)
  })

  it('error shape: code, table, context; expected only under includeParams', async () => {
    const e = await conflict(versionedUpdate(pgPrime({ driver: mockDriver(), schema })).execute())
    expect(e).toBeInstanceOf(PgPrimeError)
    expect(e.code).toBe('VERSION_CONFLICT')
    expect(e.table).toBe('blocks')
    expect(e.context).toStrictEqual({ handle: 'db' })
    expect('expected' in e).toBe(false)

    const db = pgPrime({ driver: mockDriver(), schema, errors: { includeParams: true } })
    const tx = await conflict(db.transaction((t) => versionedUpdate(t as never).execute()))
    expect(tx.expected).toBe(7)
    expect(tx.context).toMatchObject({ handle: 'tx', depth: 0, attempt: 1 })
  })

  it('stream, streamBatches and explain-analyze-without-rollback refuse it', async () => {
    const db = pgPrime({ driver: mockDriver(), schema })
    const drain = async (it: AsyncIterable<unknown>) => {
      for await (const _ of it);
    }
    await expect(drain(db.stream(versionedDelete(db)))).rejects.toThrow(/stream\(\) would skip/)
    await expect(drain(db.streamBatches(versionedDelete(db)))).rejects.toThrow(
      /streamBatches\(\) would skip/,
    )
    await expect(drain(versionedDelete(db).prepare().stream({}))).rejects.toThrow(/would skip/)
    const noRail = { analyze: true, rollback: false }
    await expect(versionedUpdate(db).explain(noRail)).rejects.toThrow(/explain/)
    await expect(db.explain(versionedUpdate(db), noRail)).rejects.toThrow(/explain/)
    await expect(versionedUpdate(db).prepare().explain({}, noRail)).rejects.toThrow(/explain/)
  })
})
