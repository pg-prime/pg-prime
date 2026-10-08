import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { requiresConcurrency } from '@pg-prime/testing'
import { sql } from 'pg-prime'
import { expect, it } from 'vitest'
import { defineOutbox, functionSink, pgOutbox } from '../../src/index.js'
import { connectDb, dropSchema, scratchSchema, until } from '../support.js'

const fixture = (f: string): string => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url))

requiresConcurrency(it)(
  'relay SIGKILL: the batch is redelivered with the same idem and a higher epoch',
  async () => {
    const schema = scratchSchema()
    const db = connectDb(process.env['PG_PRIME_TEST_URL']!)
    const outbox = pgOutbox({
      db,
      schema,
      define: { t: defineOutbox<number>('kill', { partitions: 1 }) },
    })
    const log = sql.ident(schema, 'log')
    try {
      await outbox.start()
      await db.sql`create table ${log} (idem text not null, epoch bigint not null)`.execute()
      const N = 10
      await outbox.topics.t.writeMany(
        Array.from({ length: N }, (_, i) => ({ payload: i })),
        { tx: db },
      )

      const args = 'Bun' in globalThis ? [] : ['--import', fixture('ts-hooks.mjs')]
      const child = spawn(process.execPath, [...args, fixture('relay-child.mjs')], {
        env: { ...process.env, OUTBOX_SCHEMA: schema },
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      const exited = new Promise((r) => child.once('exit', r))
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (b: Buffer) => b.toString().includes('delivering') && resolve())
        child.once('exit', (code) => reject(new Error(`child exited early (${code})`)))
      })
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
    } finally {
      await outbox.close()
      await dropSchema(db, schema)
      await db.end()
    }
  },
  60_000,
)
