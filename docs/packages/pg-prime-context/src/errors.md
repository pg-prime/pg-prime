# packages/pg-prime-context/src/errors.ts

## Purpose
`ContextError`, the one error class of the host (and of `@pg-prime/nestjs`), discriminated by `code`.

## Public API
- `ContextErrorCode` (`packages/pg-prime-context/src/errors.ts:3`): `CONTEXT_NO_TRANSACTION`,
  `CONTEXT_UNSCOPED_QUERY`, `CONTEXT_NO_SCOPE`, `CONTEXT_NESTED_SCOPE`, `CONTEXT_OPTIONS`,
  `CONTEXT_CONCURRENT_SAVEPOINT`, and nestjs's `CONTEXT_NOT_REGISTERED`, `CONTEXT_DUPLICATE_HOST`.
- `new ContextError(code, message)` (`:14`); the message is prefixed `@pg-prime/context: `.

## Flow
1. Thrown synchronously from readers (`db`, `tx()`, `run`) and as rejections from async methods.

## Gotchas
- It extends `UsageError`, so core's retry loop never re-runs a transaction over it.

## Tests
- `packages/pg-prime-context/test/unit/host.test.ts` — every code except the nestjs ones.
