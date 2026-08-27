export type {
  PgAcquireOptions,
  PgCapabilities,
  PgConnection,
  PgCopyOptions,
  PgCopyResult,
  PgDescribeResult,
  PgDriver,
  PgDriverErrorData,
  PgErrorKind,
  PgExecMode,
  PgField,
  PgNoticeData,
  PgNotification,
  PgParam,
  PgQuery,
  PgRawValue,
  PgRemoteCallback,
  PgResult,
  PgResultChunk,
  PgServerErrorData,
} from './types.js'

export type {
  PgDriverConfig,
  PgLikeClient,
  PgLikeConnection,
  PgLikeField,
  PgLikePool,
  PgLikePoolClient,
  PgLikeQueryConfig,
  PgLikeResult,
  PgLikeSubmittable,
  PgLikeTypeSource,
} from './pg-like.js'

export type { PgLikeCancelClient } from './pg-like.js'

export { PgDriverError, isServerErrorShape, normaliseError, toServerErrorData } from './errors.js'
/**
 * `typeSource` and `assertSessionGucs` are `@internal`: they are exported for the adapter's own
 * tests (test/driver/types-trick.test.ts pins the two-readers trick) and are not part of the
 * public surface. The Submittable helpers used to be exported here too — they are pg-protocol
 * plumbing with no meaning above the seam, so they are not.
 */
export { assertSessionGucs, pgDriver, typeSource } from './pg-adapter.js'
