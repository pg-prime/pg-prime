import { afterEach, expect, it, vi } from 'vitest'
import { createHooks } from '../../src/hooks.js'
import { defineQueue } from '../../src/index.js'
import type { Core } from '../../src/mq.js'
import { startWorker } from '../../src/queue/worker.js'
import { tables } from '../../src/sql/tables.js'

afterEach(() => vi.useRealTimers())

it('close({ graceMs }) leaves no timer behind', async () => {
  vi.useFakeTimers()
  const db = { listen: async () => ({ close: async () => {}, on: () => {} }) }
  const core = {
    db,
    t: tables('s'),
    hooks: createHooks({ onInternal: () => {} }),
    running: new Set(),
    ready: () => Promise.reject(new Error('offline')),
  } as unknown as Core
  const w = startWorker(core, defineQueue('q'), async () => {}, { pollMs: 50 })
  await w.close({ graceMs: 1000 })
  expect([vi.getTimerCount(), core.running.size]).toStrictEqual([0, 0])
})
