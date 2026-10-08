import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { requiresRealPostgres } from '@pg-prime/testing'
import { expect, it } from 'vitest'

const test = requiresRealPostgres(it, 'the direct-bun app connects to PG_PRIME_TEST_URL')

test('a Nest app run by bun: request settings reach @Transactional, SIGTERM ends the db', async () => {
  const child = spawn('bun', [resolve(import.meta.dirname, '../bun/app.ts')], {
    cwd: resolve(import.meta.dirname, '../..'),
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let out = ''
  const exited = new Promise<number | null>((r) => child.on('exit', r))
  const url = await new Promise<string>((ok, fail) => {
    child.stdout.on('data', (b: Buffer) => {
      out += b
      const m = /listening (\S+)/.exec(out)
      if (m) ok(m[1]!)
    })
    void exited.then(() => fail(new Error(`bun exited before listening:\n${out}`)))
  })
  const res = await fetch(url, { headers: { 'x-tenant': 't7' } })
  expect(await res.json()).toEqual({ tenant: 't7', tx: true })
  child.kill('SIGTERM')
  await exited
  expect(out).toContain('db ended')
})
