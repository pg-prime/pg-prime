# packages/pg-prime/src/driver/index.ts

## Purpose
Internal barrel for the driver layer. Re-exports the seam types (`src/driver/types.ts`), the pg-like
shapes (`src/driver/pg-like.ts`), error helpers (`src/driver/errors.ts`) and the pg adapter's
exports (`src/driver/pg-adapter.ts`). Imported by `src/entry/driver.ts`, the root barrel
`src/index.ts`, `src/query/run.ts`, `src/query/executor.ts`, `src/query/raw.ts`,
`src/query/terminals.ts` and `src/query/builder-state.ts`, and by every `packages/pg-prime/test/driver` spec.

## Public API
- Seam types from `src/driver/types.ts`: `PgAcquireOptions`, `PgCapabilities`, `PgConnection`,
  `PgCopyOptions`, `PgCopyResult`, `PgDescribeResult`, `PgDriver`, `PgDriverErrorData`, `PgErrorKind`, …
- … `PgExecMode`, `PgField`, `PgNoticeData`, `PgNotification`, `PgParam`, `PgQuery`, `PgRawValue`,
  `PgRemoteCallback`, `PgResult`, `PgResultChunk`, `PgServerErrorData`.
- pg-like types from `src/driver/pg-like.ts`: `PgDriverConfig`, `PgLikeClient`, `PgLikeConnection`,
  `PgLikeDedicatedClient`, `PgLikeField`, `PgLikePool`, `PgLikePoolClient`, `PgLikeQueryConfig`, …
- … `PgLikeResult`, `PgLikeSubmittable`, `PgLikeTypeSource`, `PgLikeCancelClient`.
- From `src/driver/errors.ts`: `PgDriverError`, `isServerErrorShape`, `normaliseError`, `toServerErrorData`.
- From `src/driver/pg-adapter.ts`: `pgDriver`, and the `@internal` `typeSource`, `assertSessionGucs`.

## Flow
1. Pure re-export; no runtime code (`packages/pg-prime/src/driver/index.ts:1`).
2. `src/entry/driver.ts` and `src/index.ts` select the public subset from here.

## Gotchas
- This barrel is not the public surface: it exports `typeSource` and `assertSessionGucs` for the
  adapter's tests (`packages/pg-prime/src/driver/index.ts:41`), which
  `packages/pg-prime/test/query/index.test.ts:111` asserts are absent from `pg-prime`.
- `PgRemoteCallback`, `PgLikeConnection`, `PgLikeField`, `PgLikePoolClient`, `PgLikeSubmittable`,
  `PgLikeTypeSource` and `PgLikeCancelClient` are exported here but not from the published entries.
- The Submittable and COPY helpers are not re-exported; tests import `src/driver/submittable.js` directly.
- `NormaliseOptions` is not re-exported.

## Tests
- Every `packages/pg-prime/test/driver/*.test.ts` imports through this barrel; the fake pool in
  `packages/pg-prime/test/driver/_fake-pg.ts` imports its pg-like types from here.
- Run: `pnpm --filter pg-prime exec vitest run test/driver`.
- Not covered: nothing specific to this file.
