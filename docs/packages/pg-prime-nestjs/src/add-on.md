# packages/pg-prime-nestjs/src/add-on.ts

## Purpose
`provideAddOn`: an add-on (outbox, events, mq, cron, …) built from the module's `Db`, started at
bootstrap and closed before the pool ends.

## Public API
- `provideAddOn(token, factory, { connection?, start? })` → `Provider[]`
  (`packages/pg-prime-nestjs/src/add-on.ts:9`).

## Flow
1. `{ provide: token, useFactory: factory, inject: [getDbToken(connection)] }`.
2. A lifecycle provider under a fresh symbol: `onApplicationBootstrap` → `start()` unless
   `start: false`; `beforeApplicationShutdown` → `close()`.

## Gotchas
- `close()` runs in `beforeApplicationShutdown` and the pool ends in `onApplicationShutdown`;
  within one phase Nest 11 and 12 order providers differently, so nothing else may rely on order.
- Add-ons do not read the host: pass `{ tx: host.tx() }` or `{ tx: host.current() }` explicitly.

## Tests
- `packages/pg-prime-nestjs/test/unit/nestjs.test.ts` — "provideAddOn starts at bootstrap and
  closes before the db ends".
