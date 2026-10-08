# packages/pg-prime-nestjs/src/request.ts

## Purpose
The global request interceptor and `@RequestTransaction(mode)`: per request, a settings scope and,
by mode, a request transaction.

## Public API
- `RequestTransaction(mode)`: `SetMetadata('pg-prime:request-transaction', mode)`
  (`packages/pg-prime-nestjs/src/request.ts:24`).
- `RequestOptions { settings?(ctx), transaction? }`, `RequestTxMode`.
- Internal: `RequestInterceptor` (provided by the module as `APP_INTERCEPTOR`).

## Flow
1. `intercept`: no `request` options and no pin → `next.handle()` untouched.
2. `resolve(ctx)`: `settings(ctx) ?? {}`; mode = handler/class metadata
   (`reflector.getAllAndOverride`) ?? `request.transaction` ?? `'whenSettings'`; a predicate is
   awaited; `'whenSettings'` means "settings non-empty".
3. No transaction and no pin: `host.run({ settings }, () => next.handle().subscribe(sub))`, so the
   handler's observable streams inside the scope.
4. Otherwise `host.request({ settings, transaction: tx && { retry: false, label } },
   () => lastValueFrom(next.handle()))`: under a pin this is one savepoint per request.

## Gotchas
- The request transaction collapses the observable to its last value and commits before the
  response: streaming/SSE routes need `'never'`.
- `@RequestTransaction` is ignored while `request` is unset (the pass-through skips the lookup).
- GraphQL `@ResolveField` resolvers run outside the parent's scope unless
  `fieldResolverEnhancers: ['interceptors']`, which gives each field its own scope and transaction.
- Guards run before the interceptor, on the root.

## Tests
- `packages/pg-prime-nestjs/test/unit/nestjs.test.ts` — "request interceptor": pass-through,
  `'whenSettings'`, precedence, RPC, label.
- `packages/pg-prime-nestjs/test/live/app.test.ts` — HTTP e2e: modes, rollback on error, strict,
  20 concurrent requests.
- `packages/pg-prime-nestjs/test/live/graphql.test.ts` — query vs field resolvers.
- `packages/pg-prime-nestjs/test/pg/rls.test.ts` — RLS with 20 concurrent tenants.
