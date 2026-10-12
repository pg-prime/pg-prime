# packages/pg-prime-nestjs/src/module.ts

## Purpose
`PgPrimeModule.forRoot` / `forRootAsync`: one global dynamic module per connection name that
provides the `Db`, its `TransactionHost`, the shutdown hook and the request interceptor.

## Public API
- `PgPrimeModule.forRoot(opts & { name? })`, `PgPrimeModule.forRootAsync(opts & { name? })`
  (`packages/pg-prime-nestjs/src/module.ts:36`).
- `PgPrimeModuleOptions` (`db` | `config`, `end`, `propagation`, `strict`, `request`) and
  `PgPrimeModuleAsyncOptions` (`imports`, `inject`, `useFactory`).

## Flow
1. `build(name, optionsProvider, imports)` returns `{ module: PgPrimeModule, global: true }` with
   five providers, all `useFactory`:
   - options (`useValue` or the async factory) under `optionsToken(name)`;
   - `getDbToken(name)`: `o.db ?? pgPrime(o.config)`, `ConfigError` unless exactly one is given;
   - `getHostToken(name)`: `new TransactionHost(db, o)` (`propagation`, `strict`);
   - `pg-prime:lifecycle:<name>`: registers the host by name and returns
     `{ onApplicationShutdown }`, which unregisters it and awaits `db.end()` unless `end: false`;
   - `APP_INTERCEPTOR`: `new RequestInterceptor(host, reflector, o.request)`.
2. Exports the db and host tokens.

## Gotchas
- Shutdown relies on Nest's phases only: every `beforeApplicationShutdown` (add-ons) runs before
  any `onApplicationShutdown` (the pool). Order within a phase differs between Nest 11 and 12.
- Registration happens in the lifecycle factory per application, not per `forRoot` call, so one
  module class imported by two applications registers two hosts.

## Tests
- `packages/pg-prime-nestjs/test/unit/nestjs.test.ts` — "module" block: tokens, `end`,
  `ConfigError`, `forRootAsync`, named connections, add-on order.
- `packages/pg-prime-nestjs/test/live/app.test.ts` — "lifecycle": `config` over PGlite, close ends
  the db.
- `packages/pg-prime-nestjs/test/pg/bun-app.test.ts` — SIGTERM on a `bun`-run app ends the db.
