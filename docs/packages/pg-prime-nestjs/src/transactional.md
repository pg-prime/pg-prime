# packages/pg-prime-nestjs/src/transactional.ts

## Purpose
`@Transactional(opts)`: runs an async method in `host.transaction(…)`.

## Public API
- `Transactional(opts?: HostTxOptions & { connection?: string }): MethodDecorator`
  (`packages/pg-prime-nestjs/src/transactional.ts:11`).

## Flow
1. Replaces `descriptor.value` with an `async` wrapper calling
   `hostOf(this, connection, keys).transaction(() => fn.apply(this, args), { label, ...opts })`,
   `label` defaulting to `Class.method`.
2. Copies the original's name and its own `reflect-metadata` entries (when
   `Reflect.getOwnMetadataKeys` exists) to the wrapper, so route decorators work on either side.

## Gotchas
- The wrapper is `async`, so a host lookup failure or a refused option is a rejection, never a
  synchronous throw.
- Propagation defaults to the host's (module `propagation`, default `'join'`); a join refuses
  `timeoutMs`/`lockTimeoutMs`/`localSettings` and a different isolation or access mode.
- Inside a request transaction, `rollbackWith` in a joined method ends the request transaction.

## Tests
- `packages/pg-prime-nestjs/test/unit/nestjs.test.ts` — "@Transactional" block: join, savepoint,
  label, module default, route metadata, host resolution.
- `packages/pg-prime-nestjs/test/live/app.test.ts` — joins the request transaction; serializable
  inside one → `CONTEXT_OPTIONS`; on a route handler.
