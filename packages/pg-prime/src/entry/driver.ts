/**
 * `pg-prime/driver` — the published entry for the driver layer.
 *
 * ## Why this file exists rather than a map straight at `src/driver/index.ts`
 *
 * `src/driver/index.ts` is an *internal* barrel and says so: it deliberately re-exports
 * `typeSource` and `assertSessionGucs`, which are `@internal` and exist for the adapter's own
 * tests (`test/driver/types-trick.test.ts`, `test/driver/execute.test.ts`), plus the `PgLike*`
 * types that are the seam's implementation detail. `test/query/index.test.ts` asserts those two
 * names are **absent** from the public surface, so pointing the export map at that barrel would
 * publish exactly what a committed test says we do not publish.
 *
 * So the subpath re-exports precisely the driver slice of the root barrel — no more, no fewer.
 * That is the invariant `tools/api-snapshot.mjs` checks: every subpath's exported names are a
 * subset of the root's, so `pg-prime/driver` can never say something `pg-prime` does not.
 */

export { PgDriverError, isServerErrorShape, normaliseError, pgDriver, toServerErrorData } from '../driver/index.js'

export type {
  PgAcquireOptions,
  PgCapabilities,
  PgConnection,
  PgCopyOptions,
  PgCopyResult,
  PgDescribeResult,
  PgDriver,
  PgDriverConfig,
  PgDriverErrorData,
  PgErrorKind,
  PgExecMode,
  PgField,
  PgLikeClient,
  PgLikePool,
  PgLikeQueryConfig,
  PgLikeResult,
  PgNoticeData,
  PgNotification,
  PgParam,
  PgQuery,
  PgRawValue,
  PgResult,
  PgResultChunk,
  PgServerErrorData,
} from '../driver/index.js'
