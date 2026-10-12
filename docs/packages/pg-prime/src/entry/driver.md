# packages/pg-prime/src/entry/driver.ts

## Purpose
Source of the published `pg-prime/driver` subpath (`packages/pg-prime/package.json:44` maps it to
`dist/entry/driver.js`). Re-exports exactly the driver slice of the root barrel from the internal
`src/driver/index.ts`, so the subpath never exposes the `@internal` adapter helpers or the
implementation-only `PgLike*` types. No module imports it; consumers import `pg-prime/driver`.

## Public API
- Values: `PgDriverError`, `isServerErrorShape`, `normaliseError`, `pgDriver`, `toServerErrorData`.
- Seam types: `PgAcquireOptions`, `PgCapabilities`, `PgConnection`, `PgCopyOptions`, `PgCopyResult`,
  `PgDescribeResult`, `PgDriver`, `PgDriverErrorData`, `PgErrorKind`, `PgExecMode`, `PgField`, …
- … `PgNoticeData`, `PgNotification`, `PgParam`, `PgQuery`, `PgRawValue`, `PgResult`,
  `PgResultChunk`, `PgServerErrorData`.
- pg-like types: `PgDriverConfig`, `PgLikeClient`, `PgLikeDedicatedClient`, `PgLikePool`,
  `PgLikeQueryConfig`, `PgLikeResult`.

## Flow
1. Re-exports five values from `src/driver/index.ts` (`packages/pg-prime/src/entry/driver.ts:18`).
2. Re-exports the type list (`packages/pg-prime/src/entry/driver.ts:26`); no runtime code.

## Gotchas
- The export list must stay a subset of the root entry `src/index.ts`; `tools/api-snapshot.mjs`
  enforces it (`tools/api-snapshot.mjs:24`).
- Pointing the export map at `src/driver/index.ts` instead would publish `typeSource` and
  `assertSessionGucs` (`packages/pg-prime/src/entry/driver.ts:6`).
- Adding a driver export means editing both this file and `src/index.ts`, then regenerating the
  golden with `pnpm api-snapshot`.
- Not exported here: `PgRemoteCallback`, `PgLikeCancelClient`, `PgLikeConnection`, `PgLikeField`,
  `PgLikePoolClient`, `PgLikeSubmittable`, `PgLikeTypeSource`.

## Tests
- No vitest spec imports this file. The surface is checked by `tools/api-snapshot.mjs --check`
  (`pnpm api-snapshot:check` from the repo root, after a build; part of `pnpm package:check`).
- `packages/pg-prime/test/query/index.test.ts` covers the root barrel these names must also appear in.
- Not covered: runtime import of `pg-prime/driver` outside the snapshot and pack smoke checks.
