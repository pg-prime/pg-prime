import { describe, expect, it } from 'vitest'
import { createHooks } from '../../src/hooks.js'

describe('hooks', () => {
  it('fan out to every observer until it unsubscribes', () => {
    const seen: string[] = []
    const hooks = createHooks({ onPublish: (e) => void seen.push(`a:${e.count}`) })
    const off = hooks.observe({ onPublish: (e) => void seen.push(`b:${e.count}`) })
    hooks.emit('onPublish', { topic: 't', count: 1, inTx: false })
    off()
    hooks.emit('onPublish', { topic: 't', count: 2, inTx: false })
    expect(seen).toStrictEqual(['a:1', 'b:1', 'a:2'])
  })

  it('a throwing hook becomes hook-failed; a throwing onInternal is swallowed', () => {
    const internal: string[] = []
    const hooks = createHooks({
      onPublish: () => {
        throw new Error('boom')
      },
    })
    hooks.observe({ onInternal: (e) => void internal.push(e.kind) })
    hooks.observe({
      onInternal: () => {
        throw new Error('again')
      },
    })
    expect(() => hooks.emit('onPublish', { topic: 't', count: 1, inTx: false })).not.toThrow()
    expect(internal).toStrictEqual(['hook-failed'])
  })
})
