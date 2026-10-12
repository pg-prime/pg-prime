import { PgPrimeError } from 'pg-prime'

/** A heartbeat or finish matched no row: the run was expired, cancelled away or removed. */
export class CronLeaseLostError extends PgPrimeError {
  constructor(runId: bigint) {
    super('CRON_LEASE_LOST', `cron: run ${runId} lost its lease`)
  }
}

/** An invalid pattern, time zone or bound; `field` names the culprit. */
export class ScheduleError extends PgPrimeError {
  readonly field: string
  constructor(field: string, message: string, options?: { cause?: unknown }) {
    super('CRON_SCHEDULE', `cron: ${message}`, options)
    this.field = field
  }
}

/** The `pgprime_cron` schema is missing, behind, or needs a newer client. */
export class SchemaVersionError extends PgPrimeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('CRON_SCHEMA_VERSION', `cron: ${message}`, options)
  }
}
