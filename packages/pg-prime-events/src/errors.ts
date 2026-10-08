import { PgPrimeError, UsageError } from 'pg-prime'

/** A guarded write found another holder: the subscription's lease was taken over. */
export class EventsLeaseLostError extends PgPrimeError {
  constructor(message: string) {
    super('EVENTS_LEASE_LOST', message)
  }
}

/** A payload failed its schema, its codec, the size limit or the NUL check. */
export class PayloadError extends PgPrimeError {
  readonly path: readonly PropertyKey[]
  constructor(message: string, path: readonly PropertyKey[] = [], cause?: unknown) {
    super('EVENTS_PAYLOAD', message, cause === undefined ? undefined : { cause })
    this.path = path
  }
}

/** The events schema is missing, behind, or newer than this client understands. */
export class SchemaVersionError extends PgPrimeError {
  constructor(message: string, cause?: unknown) {
    super('EVENTS_SCHEMA_VERSION', message, cause === undefined ? undefined : { cause })
  }
}

/** A `{ tx }` call before `start()` resolved. */
export class NotStartedError extends UsageError {
  constructor(what: string) {
    super(
      `@pg-prime/events: ${what} was called with { tx } before events.start() resolved. Await ` +
        `events.start() once at boot: migrating from inside your transaction would need a second ` +
        `connection while yours is held.`,
      { code: 'EVENTS_NOT_STARTED' },
    )
  }
}
