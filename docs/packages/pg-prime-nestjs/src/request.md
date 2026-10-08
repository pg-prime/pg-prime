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
2. `resolve(ctx)`: no `request` → no settings, no transaction. Else `settings(ctx) ?? {}`; mode =
   handler/class metadata (`reflector.getAllAndOverride`) ?? `request.transaction` ??
   `'whenSettings'`; a predicate is awaited; `'whenSettings'` means "settings non-empty".
3. A transaction: `host.request({ settings, transaction: { retry: false, label } },
   () => lastValueFrom(next.handle()))`.
4. None: `host.request({ settings }, …)` subscribes the handler's observable inside the scope and
   settles when it completes, errors or is unsubscribed, so it streams. Under a pin either way is
   one savepoint per request.

## Gotchas
- The request transaction collapses the observable to its last value and commits before the
  response: streaming/SSE routes need `'never'`.
- `@RequestTransaction` is ignored while `request` is unset, pinned or not.
- Under a pin a streaming route holds the request savepoint until the stream ends or the client
  hangs up; a request in the meantime gets `CONTEXT_CONCURRENT_SAVEPOINT`.
- GraphQL `@ResolveField` resolvers run outside the parent's scope unless
  `fieldResolverEnhancers: ['interceptors']`, which gives each field its own scope and transaction.
- Guards run before the interceptor, on the root.

## Tests
- `packages/pg-prime-nestjs/test/unit/nestjs.test.ts` — "request interceptor": pass-through,
  `'whenSettings'`, precedence, RPC, label.
- `packages/pg-prime-nestjs/test/live/app.test.ts` — HTTP e2e: modes, precedence over a global
  predicate, rollback on error, strict, 20 concurrent requests, SSE streaming (pinned and not), the
  pinned pass-through.
- `packages/pg-prime-nestjs/test/live/graphql.test.ts` — query vs field resolvers.
- `packages/pg-prime-nestjs/test/pg/rls.test.ts` — RLS with 20 concurrent tenants.
