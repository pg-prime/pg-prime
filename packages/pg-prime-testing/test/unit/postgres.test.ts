import { expect, it, vi } from 'vitest'

const statements: string[] = []
let failDrops = 0

vi.mock('pg-prime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('pg-prime')>()),
  pgPrime: () => ({
    sql: (strings: TemplateStringsArray) => ({
      execute: async () => {
        const text = strings.join('?').trim()
        statements.push(text)
        if (text.startsWith('drop database') && failDrops-- > 0) throw new Error('busy')
        return []
      },
    }),
    end: async () => {},
  }),
}))

const { scratchDatabase } = await import('../../src/postgres.js')

it('drop() retries after a failure and is a no-op once it succeeded', async () => {
  const scratch = await scratchDatabase('postgres://u@h/postgres')
  failDrops = 1
  await expect(scratch.drop()).rejects.toThrow('busy')
  await scratch.drop()
  await scratch.drop()
  expect(statements.filter((s) => s.startsWith('drop database'))).toHaveLength(2)
})
