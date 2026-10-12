import { PgPrimeError, UsageError } from 'pg-prime'

/** A relay's partition lease was taken over; the abort reason of the sink's `signal`. */
export class OutboxLeaseLostError extends PgPrimeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('OUTBOX_LEASE_LOST', message, options)
  }
}

/** Thrown (or reported in `failed`) by a sink: the record parks at once instead of retrying. */
export class NonRetryableSinkError extends PgPrimeError {
  constructor(message = 'non-retryable sink error', options?: { cause?: unknown }) {
    super('OUTBOX_NON_RETRYABLE', message, options)
  }
}

/** The schema is behind this client (with `autoMigrate: false`) or ahead of it. */
export class SchemaVersionError extends PgPrimeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('OUTBOX_SCHEMA_VERSION', message, options)
  }
}

/** A write before its topic's `start()` resolved. */
export class NotStartedError extends UsageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { ...options, code: 'OUTBOX_NOT_STARTED' })
  }
}

/** A payload its topic's `schema` rejected. */
export class PayloadError extends PgPrimeError {
  readonly issues: readonly { readonly message: string }[]
  constructor(message: string, issues: readonly { readonly message: string }[]) {
    super('OUTBOX_PAYLOAD', message)
    this.issues = issues
  }
}
