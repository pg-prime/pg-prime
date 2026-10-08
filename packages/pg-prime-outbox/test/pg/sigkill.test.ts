import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { requiresConcurrency } from '@pg-prime/testing'
import { sql } from 'pg-prime'
import { afterEach, expect, it } from 'vitest'
import { channelOf } from '../../src/context.js'
import { defineOutbox, functionSink, pgOutbox } from '../../src/index.js'
import { connectDb, dropSchema, scratchSchema, until } from '../support.js'

const fixture = (f: string): string => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url))
const test = requiresConcurrency(it)

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

/** A topic with `n` records, then the relay child, once its sink holds the first wave. */
async function setup(n: number, env: Record<string, string> = {}) {
  const schema = scratchSchema()
  const db = connectDb(process.env['PG_PRIME_TEST_URL']!)
  const outbox = pgOutbox({
    db,
    schema,
    define: { t: defineOutbox<number>('kill', { partitions: 1 }) },
  })
  let child: ChildProcess | undefined
  cleanup = async () => {
    child?.kill('SIGKILL')
    await outbox.close()
    await dropSchema(db, schema)
    await db.end()
  }
  const log = sql.ident(schema, 'log')
  await outbox.start()
  await db.sql`create table ${log} (idem text not null, epoch bigint not null)`.execute()
  await outbox.topics.t.writeMany(
    Array.from({ length: n }, (_, i) => ({ payload: i })),
    { tx: db },
  )

  const args = 'Bun' in globalThis ? [] : ['--import', fixture('ts-hooks.mjs')]
  const proc = spawn(process.execPath, [...args, fixture('relay-child.mjs')], {
    env: { ...process.env, OUTBOX_SCHEMA: schema, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  child = proc
  const exited = new Promise<number | null>((r) => proc.once('exit', r))
  const said = (line: string): Promise<void> =>
    new Promise((resolve, reject) => {
      proc.stdout.on('data', (b: Buffer) => b.toString().includes(line) && resolve())
      proc.once('exit', (code) => reject(new Error(`child exited early (${code})`)))
    })
  await said('delivering')
  return { schema, db, outbox, log, child: proc, exited, said }
}

test('relay SIGKILL: the batch is redelivered with the same idem and a higher epoch', async () => {
  const N = 10
  const { db, outbox, log, child, exited } = await setup(N)
  const first = await db.sql`select idem, epoch from ${log}`.execute()
  child.kill('SIGKILL')
  await exited

  const relay = outbox.topics.t.relay(
    functionSink(async (wave, ctx) => {
      for (const r of wave) {
        await db.sql`insert into ${log} (idem, epoch) values (${r.idem}, ${ctx.epoch})`.execute()
      }
    }),
    { leaseMs: 1_500, pollMs: 50 },
  )
  await until(async () => (await outbox.topics.t.stats()).pending === 0, 30_000)
  await relay.close()

  expect(first.length).toBe(N)
  const all = await db.sql`select idem, epoch from ${log}`.execute()
  expect(new Set(all.map((r) => r['idem'])).size).toBe(N)
  const firstEpoch = first[0]!['epoch'] as bigint
  for (const { idem } of first) {
    const again = all.filter((r) => r['idem'] === idem && (r['epoch'] as bigint) > firstEpoch)
    expect(again.length).toBe(1)
  }
}, 60_000)

test('close() with a sink that ignores abort stops listening and heartbeating', async () => {
  const { schema, db, child, exited, said } = await setup(1, { OUTBOX_CLOSE: '1' })
  await said('closed')
  const chan = `%${channelOf(schema, 'kill')}%`
  await until(async () => {
    const [r] = await db.sql`select count(*)::int as n from pg_stat_activity
      where pid <> pg_backend_pid() and query like ${chan}`.execute()
    return r!['n'] === 0
  }, 3_000)
  // With its pool ended, only a live heartbeat timer can keep the child running.
  child.stdin.end()
  expect(await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000, 'alive'))])).toBe(0)
}, 60_000)
