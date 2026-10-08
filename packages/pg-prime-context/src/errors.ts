import { UsageError } from 'pg-prime'

export type ContextErrorCode =
  | 'CONTEXT_NO_TRANSACTION'
  | 'CONTEXT_UNSCOPED_QUERY'
  | 'CONTEXT_NO_SCOPE'
  | 'CONTEXT_NESTED_SCOPE'
  | 'CONTEXT_OPTIONS'
  | 'CONTEXT_CONCURRENT_SAVEPOINT'
  | 'CONTEXT_NOT_REGISTERED'
  | 'CONTEXT_DUPLICATE_HOST'

/** A misuse of the host. A `UsageError`, so a transaction never retries it. */
export class ContextError extends UsageError {
  declare readonly code: ContextErrorCode
  constructor(code: ContextErrorCode, message: string) {
    super(`@pg-prime/context: ${message}`, { code })
  }
}
