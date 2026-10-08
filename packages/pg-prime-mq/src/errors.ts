import { PgPrimeError, UsageError } from 'pg-prime'

const init = (cause: unknown) => (cause === undefined ? undefined : { cause })

/** Throw from a handler to fail the message at once, without retries. */
export class NonRetryableError extends PgPrimeError {
  constructor(message: string, cause?: unknown) {
    super('MQ_NON_RETRYABLE', message, init(cause))
  }
}

/** A token-guarded write found the message no longer held by this consumer. */
export class LeaseLostError extends PgPrimeError {
  constructor(message: string) {
    super('MQ_LEASE_LOST', message)
  }
}

/** The reason a handler's signal aborts when its message is cancelled. */
export class CancelledError extends PgPrimeError {
  constructor(message: string) {
    super('MQ_CANCELLED', message)
  }
}

/** `result()` of a message that ended `failed` or `cancelled`. */
export class MessageFailedError extends PgPrimeError {
  readonly state: 'failed' | 'cancelled'
  constructor(message: string, state: 'failed' | 'cancelled') {
    super('MQ_FAILED', message)
    this.state = state
  }
}

/** A payload, result or progress value failed its schema, its codec, the size limit or the NUL check. */
export class PayloadError extends PgPrimeError {
  readonly path: readonly PropertyKey[]
  constructor(message: string, path: readonly PropertyKey[] = []) {
    super('MQ_PAYLOAD', message)
    this.path = path
  }
}

/** The mq schema is missing, behind, or newer than this client understands. */
export class SchemaVersionError extends PgPrimeError {
  constructor(message: string, cause?: unknown) {
    super('MQ_SCHEMA_VERSION', message, init(cause))
  }
}

/** A `{ tx }` call before `start()` resolved. */
export class NotStartedError extends UsageError {
  constructor(what: string) {
    super(
      `@pg-prime/mq: ${what} was called with { tx } before mq.start() (or queue.start()) ` +
        `resolved. Await it once at boot: migrating from inside your transaction would need a ` +
        `second connection while yours is held.`,
      { code: 'MQ_NOT_STARTED' },
    )
  }
}
