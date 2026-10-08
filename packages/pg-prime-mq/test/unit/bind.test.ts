import { describe, expect, it } from 'vitest'
import { defineQueue } from '../../src/index.js'
import type { Core } from '../../src/mq.js'
import { bind } from '../../src/queue/bind.js'

describe('bind', () => {
  it('a closed binding leaves the instance registry', async () => {
    let closed = 0
    const reader = { active: true, close: async () => void closed++ }
    const core = {
      running: new Set(),
      events: () => ({ subscription: () => ({ run: () => reader }) }),
    } as unknown as Core
    const b = bind(core, {} as never, defineQueue('q'), {} as never)
    expect([core.running.size, b.active]).toStrictEqual([1, true])
    await b.close()
    expect([core.running.size, closed]).toStrictEqual([0, 1])
  })
})
