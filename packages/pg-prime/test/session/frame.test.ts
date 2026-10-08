import { describe, expect, it } from 'vitest'
import { defaultRegistry } from '../../src/codec/index.js'
import { HandleMisuseError, UsageError } from '../../src/errors/index.js'
import { inTransactionFrame } from '../../src/index.js'
import { pgPrime } from '../../src/query/run.js'
import { resetGuardForTests } from '../../src/session/guard.js'
import { mockDriver } from '../query/_mock-driver.js'
import { schema } from '../query/_schema.js'

describe('inTransactionFrame', () => {
  it('trips the guard on a captured root db inside the frame, not outside it', async () => {
    resetGuardForTests()
    const db = pgPrime({ driver: mockDriver(), schema, registry: defaultRegistry() })
    let pinned: Parameters<typeof inTransactionFrame>[0] | undefined
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const open = db.transaction(async (tx) => {
      pinned = tx
      await held
    })
    await new Promise((r) => setTimeout(r, 0))

    await expect(db.sql`select 1`.execute()).resolves.toBeDefined()
    const inside = await inTransactionFrame(pinned!, () => db.sql`select 1`.execute()).catch(
      (e: unknown) => e,
    )
    expect(inside).toBeInstanceOf(HandleMisuseError)
    // The tx handle itself is fine inside the frame.
    await expect(
      inTransactionFrame(pinned!, () => pinned!.sql`select 1`.execute()),
    ).resolves.toBeDefined()

    release()
    await open
  })

  it('refuses something that is not a Tx handle', () => {
    expect(() => inTransactionFrame({} as never, () => 1)).toThrow(UsageError)
  })
})
