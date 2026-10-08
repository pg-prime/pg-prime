import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SITE = 'https://pg-prime.github.io/pg-prime/'

describe('README', () => {
  it('links its docs to pages of the published site', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
    const docs = [...readme.matchAll(/\]\((https:\/\/[^)]+)\)/g)]
      .map((m) => m[1] as string)
      .filter((u) => !u.startsWith('https://github.com/'))
    expect(docs).toHaveLength(4)
    for (const u of docs) {
      expect(u.startsWith(SITE), u).toBe(true)
      const page = `../../../../docs/src/content/docs/${u.slice(SITE.length).replace(/\/$/, '')}.mdx`
      expect(existsSync(new URL(page, import.meta.url)), u).toBe(true)
    }
  })
})
