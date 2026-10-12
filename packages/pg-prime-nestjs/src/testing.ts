import { rollbackScope } from '@pg-prime/context/testing'
import type { RollbackScope } from '@pg-prime/context/testing'
import type { TransactionHost } from '@pg-prime/context'
import { getHostToken } from './tokens.js'

export type { RollbackScope } from '@pg-prime/context/testing'

/** `rollbackScope` on the app's host: every request and transaction until `rollback()` is discarded. */
export function rollbackScopeFor(
  app: { get(token: any): any },
  name?: string,
): Promise<RollbackScope> {
  return rollbackScope(app.get(getHostToken(name)) as TransactionHost)
}
