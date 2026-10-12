import type { AnySchema, Tx } from 'pg-prime'
import { setPin } from './host.js'
import type { TransactionHost } from './host.js'

export interface RollbackScope<Sc extends AnySchema = AnySchema> {
  readonly tx: Tx<Sc>
  rollback(): Promise<void>
}

/**
 * Opens a transaction the test owns and pins it on `host`: every transaction the host would open
 * becomes a savepoint inside it, and `rollback()` discards all of it.
 */
export async function rollbackScope<Sc extends AnySchema>(
  host: TransactionHost<Sc>,
): Promise<RollbackScope<Sc>> {
  let opened!: (tx: Tx<Sc>) => void
  let release!: () => void
  const ready = new Promise<Tx<Sc>>((r) => (opened = r))
  const parked = new Promise<void>((r) => (release = r))
  const done = host.root.transaction(
    async (tx) => {
      opened(tx)
      await parked
      return tx.rollbackWith(undefined)
    },
    { retry: false, localSettings: { idle_in_transaction_session_timeout: 0 } },
  )
  const tx = (await Promise.race([ready, done])) as Tx<Sc>
  setPin(host, tx as Tx)
  return {
    tx,
    async rollback() {
      setPin(host, undefined)
      release()
      await done
    },
  }
}
