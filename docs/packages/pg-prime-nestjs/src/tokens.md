# packages/pg-prime-nestjs/src/tokens.ts

## Purpose
Injection tokens and decorators per connection name, and the host registry `@Transactional`
falls back to.

## Public API
- `getDbToken(name?)` → `'pg-prime:db:<name>'`; `getHostToken(name?)` → the `TransactionHost`
  class for `'default'`, else `'pg-prime:host:<name>'` (`packages/pg-prime-nestjs/src/tokens.ts:7`).
- `InjectDb(name?)`, `InjectHost(name?)`: `Inject(token)`.
- Internal: `register(name, host)` → unregister function; `hostOf(self, name, keys)`.

## Flow
1. `register` adds the host to `live: Map<name, Set<host>>` and records its name.
2. `hostOf(self, name, keys)`: the own enumerable property of `self` that is a `TransactionHost`
   registered under `name` (an unregistered host counts as `'default'`); the property key is
   cached per class in the decorator's `keys`. Otherwise the single live host under `name`.
3. None → `CONTEXT_NOT_REGISTERED`; two or more → `CONTEXT_DUPLICATE_HOST`.

## Gotchas
- Two applications under one name coexist: services that inject their host use their own; only a
  class with no injected host, resolving through the registry, gets `CONTEXT_DUPLICATE_HOST`.
- An application never closed stays registered and makes later registry lookups ambiguous.
- A host held in an ES `#private` field is invisible to `hostOf`; inject it as a constructor
  property.

## Tests
- `packages/pg-prime-nestjs/test/unit/nestjs.test.ts` — "uses the instance's own host, else the
  registry; none or two live → loud", "a named connection resolves its own host".
