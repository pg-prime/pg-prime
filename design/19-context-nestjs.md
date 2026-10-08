# 19 — `@pg-prime/context` + `@pg-prime/nestjs`: ambient transactions and a Nest module. Design & Implementation Plan

2026-10-09. Branch `feat/mq`. **Status: PLAN rev 3 (final)** — revmux `cnp-01`/`cnp-02` fixes (§11), owner decisions (§10).

Two general-purpose add-ons for apps that want the active transaction ambient instead of threaded
through every call:

- **`@pg-prime/context`** (`packages/pg-prime-context`): a framework-agnostic `TransactionHost` on
  `AsyncLocalStorage`. `host.db` is the active `Tx` or the root `Db`; `host.transaction()` nests
  with a configurable propagation; scoped settings (e.g. `app.tenant_id`, `app.user_id`,
  `app.org_id`, `app.role`) apply to every transaction started in the scope, so RLS and auditing
  work without passing anything.
- **`@pg-prime/nestjs`** (`packages/pg-prime-nestjs`): `PgPrimeModule.forRoot/forRootAsync`, tokens,
  `@Transactional()`, a request-context interceptor with per-route `@RequestTransaction()`, add-on
  lifecycle wiring, rollback-per-test.
- Typed setting keys come from core `setting(name, codec)`, pinned and owned by design/20 (§2.1).

Read with: design/07 §1.3–§1.6, §3, §8 row 10; design/08 §1.1; design/15 §0 + A1 RESULT; design/20
§3; `packages/pg-prime/src/session/guard.ts`; `docs/packages/pg-prime/src/session/{handles,guard,runner}.md`.

---

## 0. Reconciling with design/07 ("no ambient context")

design/07 §1.6 and §8 row 10 reject ambient context in **core**. That stays true:

| design/07 rule | Here |
|---|---|
| Core has no ambient context and no ALS cost on its hot path (§1.6) | Core gains only `setting()` (design/20 R1), a pure value with no ALS. Ambient state lives in an add-on the app opts into |
| `node:async_hooks` stays out of bundles that open no transaction | Still true for `pg-prime`. Context imports it statically and targets server runtimes (§5) |
| Spring propagation modes are "cosplay" (§3.8): handle types already express them | Ambient code loses the handle types, so three modes return: `join`, `savepoint`, `new`. `MANDATORY` is `host.tx()` and `SUPPORTS` is `host.db`. `NOT_SUPPORTED`/`NEVER` stay dropped |
| The dev guard throws on a root statement inside a tx; `outsideTransaction()` opts out (§1.5 L3) | Unchanged. Inside an ambient tx, `host.db` **is** the tx, so the guard never fires on it. A captured root `Db` still trips it. A deliberate root call is `host.outside()` (§3.5) |

design/07 §1.6 gets an **AMENDED (design/19)** note (integrator, §9).

---

## 1. Goals / non-goals

**Goals**
- `host.db` / `host.current()` → active `Tx`, else root; `host.tx()` → active `Tx` or throws.
- `host.transaction(fn, opts)`: host-level default propagation, per-call override; core semantics
  for retry, `rollbackWith`, savepoints and hooks (§3.2).
- **Fast:** with no scope `host.db` is one `getStore()` + two checks; settings ride core's
  post-`BEGIN` `set_config` batch (no extra round trip); no per-statement wrapper; the Nest
  interceptor is a pass-through when request context is not configured.
- Settings never leak across scopes, pooled connections or transaction poolers.
- Nest: configured `Db`, host, `@Transactional()`, request settings, per-route request txs, ordered
  shutdown, production-equal rollback-per-test. Node ≥ 22.12, Bun 1.4.2. Generic: no
  consumer-specific names or defaults; every example key is illustrative.

**Non-goals:** core changes beyond §8.1; automatic ambient pickup in
events/outbox/mq/cron (§3.6); implicit per-statement transactions (§3.3); TC39 decorators (§4.5);
a Nest exception filter or `create-pg-prime` template (§10 D6, D7); `Scope.REQUEST` providers.

---

## 2. API

### 2.1 Core: typed setting keys (`pg-prime`, pinned by design/20, owned by design/20 R1)

design/19 consumes this API and defines none of it. Root export, file `src/session/setting.ts`:

```ts
export interface SettingKey<T, P extends string> {
  readonly name: string
  readonly codec: AnyCodec
  /** `{ [name]: text }`: what `tx.setLocal({…})`, `session.set({…})` and `localSettings` already take. */
  set(value: T): Readonly<Record<string, string>>
  /** `nullif(current_setting('<name>', true), '')::<sqlName>`: NULL when unset or empty. */
  current(): TypedFragment<T | null, P>
}
export function setting(name: string): SettingKey<string, 'text'>
export function setting<C extends AnyCodec>(name: string, codec: C): SettingKey<CodecOut<C>, CodecPg<C>>
```

No new overload anywhere (`set()` returns the record existing APIs and scope settings accept);
names pass `assertGucName` (`session/transaction.ts`); byte-encoding codecs are refused; no
`required()` — strict mode throws client-side (§3.3) and SQL fails closed on NULL.

```ts
export const tenantId = setting('app.tenant_id', uuidCodec)   // one key feeds runtime and policies
export const userId = setting('app.user_id', uuidCodec)
host.run({ settings: { ...tenantId.set(t), ...userId.set(u) } }, handler)        // runtime
pgPolicy('tenant_isolation', { on: projects, using: (p) => eq(p.tenantId, tenantId.current()) })  // design/20
```

### 2.2 `@pg-prime/context`

```ts
import type { AnySchema, Db, NoHandleEscape, Queryable, Tx, TxOptions } from 'pg-prime'

export type Setting = string | number | boolean
export type Settings = Readonly<Record<string, Setting>>
export type Propagation = 'join' | 'savepoint' | 'new'
export type HostTxOptions = TxOptions & { propagation?: Propagation }

/** Structural, so `@types/node` stays out of the emitted `.d.ts`. */
export interface AsyncStorage<T> { getStore(): T | undefined; run<R>(store: T, fn: () => R): R }

export interface TransactionHostOptions {
  propagation?: Propagation           // default 'join'; per-call `opts.propagation` overrides
  strict?: boolean                    // default true (§3.3)
  storage?: AsyncStorage<unknown>     // default: new AsyncLocalStorage()
}

export class TransactionHost<Sc extends AnySchema = AnySchema> {
  constructor(root: Db<Sc>, opts?: TransactionHostOptions)
  readonly root: Db<Sc>
  get db(): Queryable<Sc>                  // active tx, else root
  current(): Queryable<Sc>
  tx(): Tx<Sc>                             // CONTEXT_NO_TRANSACTION outside one
  get inTransaction(): boolean
  get attempt(): number                    // tx().attempt, 0 outside
  get settings(): Settings
  outside(): Queryable<Sc>                 // root.outsideTransaction()

  transaction<T>(fn: (db: Tx<Sc>) => Promise<T>, opts?: HostTxOptions): Promise<NoHandleEscape<T>>
  /** Adopt an explicit `Tx`: sends the scope's settings to it, then runs `fn` with it ambient. */
  within<T>(tx: Tx<Sc>, fn: () => Promise<T>): Promise<T>
  /** A settings scope. Inherits the parent scope's settings; refused inside an ALS transaction. */
  run<T>(scope: { settings?: Settings }, fn: () => T): T
  setLocal(name: string, value: Setting): Promise<void>
  setLocal(settings: Settings): Promise<void>
}

export class ContextError extends UsageError {}   // codes: §3.8

// @pg-prime/context/testing
export interface RollbackScope<Sc extends AnySchema = AnySchema> { readonly tx: Tx<Sc>; rollback(): Promise<void> }
export function rollbackScope<Sc extends AnySchema>(host: TransactionHost<Sc>): Promise<RollbackScope<Sc>>
```

Framework-free use:

```ts
export const host = new TransactionHost(pgPrime({ connection: process.env.DATABASE_URL!, schema }))
server.use((req, next) => host.run({ settings: tenantId.set(req.auth.tenantId) }, next))
export const createProject = (input: NewProject) =>
  host.transaction(async () => {
    const [p] = await host.db.insertInto(projects).values(input).returning((t) => t.projects.$all).execute()
    await audit('project.created', p!.id)      // same transaction, nothing passed
    return p!
  })
```

- **`db` is `Queryable<Sc>`:** `Tx | Db` has incompatible `transaction` overloads and nesting goes
  through `host.transaction`; `host.tx()` serves helpers declaring `tx: Tx<S>` (design/07 §1.5 L2).
- **Prepared statements** built on the root run on the root (the guard catches it in dev); use
  `host.db.run(prepared, { params })` — `run` takes any `Compilable` (§10 D8).

---

## 3. Semantics

### 3.1 State

- **ALS store** per scope: `{ tx?: Tx, base?: Tx, settings: Record<string, Setting> }`. `base` is set
  only under a pin (§3.7). `run`, `transaction` and `within` use `storage.run(newStore, …)`, never
  `enterWith`.
- **`busy`:** a host `WeakMap<Tx, boolean>` marking an in-flight host savepoint. It is per `Tx`
  because savepoint names are depth-derived per connection. A nested savepoint runs on the child
  `Tx`, so its parent's flag never blocks it.
- **Hot path** (`db`/`current()`), one `getStore()` and two checks with no scope:

  ```ts
  const s = storage.getStore()
  if (s?.tx) return s.tx
  if (strict && s && hasKeys(s.settings)) throw unscoped()
  return s?.base ?? pin?.tx ?? root
  ```

### 3.2 Propagation

The default is the host's `propagation` (`'join'` unless configured); `opts.propagation` overrides
it per call. Default reason: on composable service methods `@Transactional()` usually means "needs
a transaction", and a join is free where a savepoint costs two round trips.

| Mode | No active tx | Active ALS tx |
|---|---|---|
| any | `root.transaction(fn', { ...opts, localSettings: { ...scope.settings, ...opts.localSettings } })`; under a pin, a savepoint on the base (§3.7) | see below |
| `join` | — | `fn(tx)` with the **real** outer `Tx`; no wrapper and no new store. A join cannot change the transaction: `isolation`/`accessMode`/`deferrable` must equal the outer's, and `timeoutMs`/`lockTimeoutMs`/`localSettings` → `CONTEXT_OPTIONS` (use `savepoint` or `new`). `retry`, `signal` and `label` are ignored |
| `savepoint` | — | `tx.savepoint(fn', { timeoutMs, lockTimeoutMs, localSettings, label })`; `busy(tx)` → `CONTEXT_CONCURRENT_SAVEPOINT`; `TxOptions`-only keys → `CONTEXT_OPTIONS` |
| `new` | — | `root.transaction(fn', …)` on a **second** connection with the scope's settings. Needs `pool.max ≥ 2` per concurrent caller; with `max: 1` it waits `connectionTimeoutMillis`, then throws. Under a pin it is a savepoint (§3.7) |

- `fn'` is `(tx) => storage.run({ settings: scope.settings, tx }, () => fn(tx))`; explicit
  `localSettings` win over scope settings.
- **`rollbackWith` inside a join ends the outer transaction.** Documented, not wrapped: the joined
  code holds the outer `Tx`, so core's sentinel unwinds to the outermost call, which resolves with
  that value. For a local rollback, use `propagation: 'savepoint'`.

### 3.3 Settings

**Settings apply only inside transactions.** Outside one they need a session `SET` (leaks across
tenants behind a transaction pooler, design/07 §3.6) or an implicit per-statement transaction (a
core hook and three extra statements per query).

- **At `BEGIN`:** every host-started root tx sends the scope's settings in core's post-`BEGIN` batch
  — no extra round trip, repeated on every retry attempt.
- **`within(tx, fn)`** is async: with scope settings it sends them in one `tx.setLocal` before `fn`.
- **`host.setLocal`:** in a tx, one batch; in a scope, also recorded for later txs; in neither,
  `CONTEXT_NO_SCOPE`.
- **Strict** (default on): `db`/`current()` in a scope with settings but no ALS tx throws
  `CONTEXT_UNSCOPED_QUERY` — under RLS that read would silently see no rows (or, for `BYPASSRLS`,
  every tenant). `root`/`outside()` stay explicit escapes. A pin does **not** satisfy strict (§3.7).
- **No leak:** `SET LOCAL` ends with the tx; tier 2 proves it directly and through PgBouncer.

### 3.4 Retry

Only the outermost root tx retries (core's rule). Core calls `fn'` with a new `Tx`, so the store is
rebuilt, settings re-sent, and joined/savepoint calls re-run as part of `fn`. A nested `new` tx
committed on attempt 1 runs again on attempt 2 — a side effect like any other, documented with
`host.attempt`. `ContextError` is a `UsageError`, which core never retries.

### 3.5 Guard interplay

1. `host.transaction` → `root.transaction` (core pushes its guard frame) → `fn'` sets the ALS tx;
   `host.db` is that tx, and `Tx` statements never consult the guard.
2. A captured root `Db` (`@InjectDb()`, a module-level `db`) used inside → `HandleMisuseError` in
   dev — the intended catch. `host.outside()` = `root.outsideTransaction()` is the opt-out;
   `host.root.from(…)` without it still throws, as in core.
3. `new` = `root.transaction()`, allowed inside a frame. Pinned requests keep the guard (§3.7).
4. Raw `db.transaction(async (tx) => service.x())` without `host.within(tx, …)` leaves `host.db` at
   the root → the guard throws in dev, correctly; the guide shows `within`.

### 3.6 Add-ons' `{ tx }`

**Explicit, no automatic pickup:** `outbox.topics.orders.write(o, { tx: host.current() })`,
`mq.queue(q).send(m, { tx: host.tx() })` (must be transactional). Pickup would put ALS into
events/outbox/mq/cron or need a new option in four packages; `current()` is a `Queryable`, which is
what their `tx` takes (outside a tx it is the root, which outbox and a started events accept).

### 3.7 Rollback per test (the pin)

`rollbackScope(host)` opens a root transaction the test owns (`retry: false`, `localSettings:
{ idle_in_transaction_session_timeout: 0 }`), pins it on the host, and parks the callback.
`rollback()` releases it with `rollbackWith(undefined)` and unpins. It is a pin, not ALS, because
`beforeEach`, the test body and server-side requests run in different async contexts.

**One rule: the pin replaces the pool.** Wherever production opens a root transaction, the host
opens a **pinned savepoint** on the base: the request savepoint `R` below, or `pin.tx` for
test-body code.

- **Requests:** under a pin the interceptor runs every request in one pinned savepoint `R`. If the
  mode opens a request tx, `R` is the ALS `tx` (joins and strict behave as in production);
  otherwise `R` is only the `base` (strict still fires, `@Transactional` nests a savepoint on `R`,
  tx-less `host.db` runs on `R`). A failed request rolls back only `R`; core's savepoint runner
  catches `rollbackWith`.
- **Protocol** of a pinned savepoint (`host.transaction` without ALS tx, or `R`):
  1. run inside `inTransactionFrame(pin.tx, …)` (core, §8.1), so a captured root `Db` throws
     `HandleMisuseError` as in an unpinned dev run instead of committing for real or hanging on the
     pin's locks;
  2. on entry, capture `current_setting(k, true)` in one statement for every user-settable built-in
     in `pg_settings` (`context = 'user'`) and every key the host knows (scope settings,
     `localSettings`, `host.setLocal`, so every `SettingKey` it has seen), then apply the scope
     settings. Placeholder GUCs never appear in `pg_settings`, `SHOW ALL` or
     `pg_show_all_settings()` (PG 17, 18, PGlite; N0 spike 6), so the host's keys are the only way
     to find them;
  3. on success, **before** `RELEASE` (which keeps `SET LOCAL` values), restore every changed entry
     to its captured value in one `set_config(…, true)` statement; `''` only for keys captured as
     unset (placeholders), never for built-ins. Built-ins changed by `tx.setLocal`, `localSettings`
     or `timeoutMs` are restored too. **Caveat:** a dotted key set only by a raw `tx.setLocal` or
     `set_config`, which the host never saw, is not restored and can leak into the next request of
     the same pinned test (guide: set request keys through the scope or `host.setLocal`). A failed
     restore aborts only `R`; on error `ROLLBACK TO` restores everything itself.
- **Options:** a savepoint cannot change `isolation`/`deferrable` and serializable retry cannot occur
  on one connection, so those and `retry` are ignored under a pin (documented; §6.3 covers them
  unpinned). `accessMode: 'read only'` → `set_config('transaction_read_only', 'on', true)` inside the
  savepoint, which then ends with `ROLLBACK TO` (restores read-write; it wrote nothing).
- **One request at a time:** a second pinned savepoint on a busy base is the ordinary
  `CONTEXT_CONCURRENT_SAVEPOINT` (§3.1), its message naming the pin. Real-concurrency tests (§6.3,
  §6.4) run unpinned.
- **Caveats (guide):** test-body `host.db` outside a request runs on `pin.tx` directly, so a failing
  statement poisons the test (`25P02`) — await requests first; code needing a real `COMMIT`
  (NOTIFY, deferred constraints, a second connection) needs a scratch database; a failing tx-less
  statement inside `R` aborts the rest of that request, where production would have autocommitted it.

### 3.8 Errors

`ContextError extends UsageError`, one class with a `code` (in the style of outbox's
`NotStartedError`):

| `code` | When |
|---|---|
| `CONTEXT_NO_TRANSACTION` | `host.tx()` with no active tx |
| `CONTEXT_UNSCOPED_QUERY` | strict; `db`/`current()` read with settings and no ALS tx |
| `CONTEXT_NO_SCOPE` | `setLocal` outside both a scope and a tx |
| `CONTEXT_NESTED_SCOPE` | `run()` inside an ALS tx |
| `CONTEXT_OPTIONS` | `join` with a different isolation/access mode/deferrable, or with `timeoutMs`/`lockTimeoutMs`/`localSettings`; `savepoint` with a `TxOptions`-only key |
| `CONTEXT_CONCURRENT_SAVEPOINT` | a second in-flight host savepoint on one `Tx`, including a second request under a pin |
| `CONTEXT_NOT_REGISTERED` | (nestjs) `@Transactional` with no host on the instance and none registered under the name |
| `CONTEXT_DUPLICATE_HOST` | (nestjs) a second live app registers a host under the same name |

---

## 4. `@pg-prime/nestjs`

### 4.1 API

```ts
export type RequestTxMode = 'never' | 'whenSettings' | 'always'

export interface PgPrimeModuleOptions<Sc extends AnySchema = AnySchema> {
  db?: Db<Sc>                         // exactly one of db / config (→ pgPrime(config))
  config?: PgPrimeOptions<Sc>
  end?: boolean                       // db.end() on shutdown; default true
  propagation?: Propagation           // host default 'join'; @Transactional({ propagation }) overrides
  strict?: boolean
  request?: {
    settings?(ctx: ExecutionContext): Settings | undefined | Promise<Settings | undefined>
    transaction?: RequestTxMode | ((ctx: ExecutionContext) => boolean | Promise<boolean>)  // default 'whenSettings'
  }
}

export interface PgPrimeModuleAsyncOptions<Sc extends AnySchema = AnySchema> {
  imports?: ModuleMetadata['imports']
  inject?: (InjectionToken | OptionalFactoryDependency)[]
  useFactory(...args: any[]): PgPrimeModuleOptions<Sc> | Promise<PgPrimeModuleOptions<Sc>>
}

export class PgPrimeModule {
  static forRoot(opts: PgPrimeModuleOptions & { name?: string }): DynamicModule
  static forRootAsync(opts: PgPrimeModuleAsyncOptions & { name?: string }): DynamicModule
}

export function getDbToken(name?: string): InjectionToken
export function getHostToken(name?: string): InjectionToken   // default name → the TransactionHost class
export function InjectDb(name?: string): ParameterDecorator
export function InjectHost(name?: string): ParameterDecorator
export function Transactional(opts?: HostTxOptions & { connection?: string }): MethodDecorator
export function RequestTransaction(mode: RequestTxMode): CustomDecorator   // handler > class > global
export function provideAddOn<T extends { start?(): Promise<unknown>; close?(): Promise<unknown> }>(
  token: InjectionToken, factory: (db: Db) => T, opts?: { connection?: string; start?: boolean },
): Provider[]

export { TransactionHost, ContextError } from '@pg-prime/context'
export type { HostTxOptions, Propagation, Setting, Settings } from '@pg-prime/context'

// @pg-prime/nestjs/testing
export function rollbackScopeFor(app: { get(token: unknown): unknown }, name?: string): Promise<RollbackScope>
```

Example (all names illustrative):

```ts
@Module({
  imports: [
    PgPrimeModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({
        config: { connection: c.getOrThrow('DATABASE_URL'), schema },
        request: { settings: (ctx) => tenantSettings(ctx.switchToHttp().getRequest().auth) },
      }),
    }),
  ],
  providers: [...provideAddOn(OUTBOX, (db) => pgOutbox({ db, define: { projectEvents } }))],
})
export class AppModule {}

@Injectable()
export class ProjectsService {
  constructor(private readonly host: TransactionHost<Schema>, @Inject(OUTBOX) private readonly outbox: Outbox) {}

  @Transactional()
  async create(input: CreateProjectDto) {
    const { db } = this.host
    const [p] = await db.insertInto(db.h.projects).values(input).returning((t) => t.projects.$all).execute()
    await this.outbox.topics.projectEvents.write({ id: p!.id }, { tx: this.host.tx() })
    return p!
  }
}
```

### 4.2 Providers and lifecycle

Per `forRoot` call, keyed by `name` (default `'default'`):

| Token | Provider | Notes |
|---|---|---|
| `OPTIONS(name)` | `useValue` / async `useFactory` | internal |
| `getDbToken(name)` | `useFactory: o => o.db ?? pgPrime(o.config)` | `ConfigError` if both or neither. Lazy: no socket until the first query |
| `getHostToken(name)` | `useFactory: db => new TransactionHost(db, { propagation, strict })` + `register(name, host)` | the default name provides the `TransactionHost` class, so `constructor(host: TransactionHost)` resolves through `emitDecoratorMetadata` |
| `LIFECYCLE(name)` | factory returning `{ onApplicationShutdown }` | `end !== false` → `db.end()`; unregisters the host |
| `APP_INTERCEPTOR` | factory over options + host + `Reflector` | when `request` is unset, returns `next.handle()` untouched (zero per-request cost), except under a pin, where it still opens `R` (§3.7) |

- `global: true`; exports the db and host tokens. **Shutdown order:** `provideAddOn` handles close
  in `beforeApplicationShutdown`, the db ends in `onApplicationShutdown` (Nest runs it after every
  `before…`), so relays stop before the pool drains; apps call `app.enableShutdownHooks()`.
  `start: true` (default) calls `start()` in `onApplicationBootstrap` (design/15 §0.3).
- **No decorator syntax in our `src/`:** `Inject(tok)`/`SetMetadata(…)` are returned as values and
  providers are `useFactory` + `inject`, so the TS 7 build and emit-parity see plain TS.

### 4.3 Request context: an interceptor

**An interceptor, not middleware or a guard:** it runs after guards (the auth result exists), is
transport-agnostic (HTTP, RPC, GraphQL resolvers) and can wrap the handler in the scope and the
transaction. Middleware runs before auth and only for HTTP; a guard cannot wrap the handler.

```ts
intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
  if (!this.request) return next.handle()
  return from(this.resolve(ctx)).pipe(switchMap(({ settings, tx }) =>
    new Observable((sub) => this.host.run({ settings }, () =>
      (tx ? from(this.host.transaction(() => lastValueFrom(next.handle(), { defaultValue: undefined }),
        { retry: false, label: `${ctx.getClass().name}.${ctx.getHandler().name}` }))
          : next.handle()).subscribe(sub)))))
}
```

- **Mode:** `@RequestTransaction(mode)` on the handler, then the class
  (`reflector.getAllAndOverride`), then the global `transaction` (mode or predicate), then the
  default **`'whenSettings'`** (a tx iff the resolved settings are non-empty). Why that default:
  requests without settings pay nothing, and settings only take effect inside a transaction, so RLS
  is correct by default rather than a strict-mode error. Apps preferring per-method transactions set
  `'never'` and rely on strict mode.
- **ALS reaches the handler:** it runs at subscribe time inside `host.run`, and Nest's interceptor
  consumer binds the deferred handler with `AsyncResource.bind` (W0 verifies on Node and Bun).
- **Commit before the response:** the value reaches outer interceptors only after commit. The tx
  collapses the observable to its last value, so streaming/SSE routes use
  `@RequestTransaction('never')`.
- **`retry: false`** on the request tx: re-running a whole handler is not idempotent. A route needing
  serializable retry uses `@RequestTransaction('never')` + `@Transactional({ isolation:
  'serializable' })`; inside a request tx that decorator throws `CONTEXT_OPTIONS` (isolation
  mismatch on join) rather than silently joining.
- **GraphQL:** query/mutation resolvers get interceptors, so they are scoped. `@ResolveField`
  resolvers run from graphql-js's own promise continuations, outside the parent's `host.run`, so
  they do **not** inherit the scope (W0 spike 7 confirms). They are scoped only with
  `GraphQLModule.forRoot({ fieldResolverEnhancers: ['interceptors'] })`, each then with its own scope
  and, under `'whenSettings'`, its own tx (no shared snapshot). Guide and §6.4 cover both.
- Guards querying the DB run before the scope and use the root, correctly: they compute the
  settings.

### 4.4 `@Transactional(opts)`

```ts
export function Transactional(opts: TransactionalOptions = {}): MethodDecorator {
  return (_target, key, d: PropertyDescriptor) => {
    const fn = d.value as (...a: unknown[]) => Promise<unknown>
    d.value = function (this: object, ...args: unknown[]) {
      return hostOf(this, opts.connection).transaction(() => fn.apply(this, args),
        { label: `${this.constructor.name}.${String(key)}`, ...opts })
    }
    copyMetadata(fn, d.value)   // Nest's route metadata lives on the function
  }
}
```

- **Host lookup** (`hostOf`): without `opts.connection`, the instance's own injected
  `TransactionHost` (the single own property `instanceof TransactionHost`, key cached per class), so
  two apps in one process each use their own host; otherwise the name registry filled by the host
  provider (decorators run before DI), where a second live registration under one name throws
  `CONTEXT_DUPLICATE_HOST`. None found → `CONTEXT_NOT_REGISTERED`.
- `copyMetadata` copies `Reflect.getMetadataKeys` entries when `reflect-metadata` is loaded, so
  `@Get()` works above or below `@Transactional()`. Async methods only (the return becomes a `Promise`).

### 4.5 Decorators, Bun and TS 7

- **Legacy decorators only:** Nest's DI needs legacy parameter decorators, which TC39 lacks. Our
  `src/` uses none (§4.2). Tests do: the package `tsconfig.json` (typecheck incl. `test`) sets
  `experimentalDecorators`, `tsconfig.build.json` covers `src` only (W0 spike 1).
- **Vitest (Vite 8 → oxc):** fixtures use explicit `@Inject(token)`, independent of
  `design:paramtypes` emit (W0 spike 2). **Bun** honours `experimentalDecorators` +
  `emitDecoratorMetadata`; `test/bun/app.ts` uses metadata-only injection under `bun` directly.

### 4.6 Peers and dependencies

| Package | `dependencies` | `peerDependencies` | Reason |
|---|---|---|---|
| `@pg-prime/context` | — | `pg-prime` (the release shipping `setting()`, §8.1) | ALS is `node:async_hooks` |
| `@pg-prime/nestjs` | `@pg-prime/context: workspace:^` | `pg-prime` (same), `@nestjs/common ^11 \|\| ^12`, `@nestjs/core ^11 \|\| ^12`, `rxjs ^7.8` | `@nestjs/core` provides `APP_INTERCEPTOR`/`Reflector`; `rxjs` is used by the interceptor. **Not** `reflect-metadata`: it is only feature-detected |

- Context is a real dependency (like mq → events): one install, and the nestjs barrel re-exports its
  surface, so there is one import site and one `TransactionHost` class. Dev deps:
  `@nestjs/{common,core,testing,platform-express,graphql,apollo}`, `@apollo/server`, `graphql`,
  `rxjs`, `reflect-metadata` at Nest `^12` (CI leg on `^11`, §10 D4); e2e uses `fetch`.
- **Why `context` is separate:** useful without Nest (other frameworks, workers, cron/mq handlers),
  zero deps vs nestjs's four peers, the small-modules rule; the cost is one fixed-group entry and
  one pack-smoke project.

---

## 5. Runtimes

Node ≥ 22.12 and Bun 1.4.2 are tested and CI-gated (Bun: unit + pg via `bunx --bun vitest` and the
direct-`bun` Nest app). Deno and Workers with `nodejs_compat` have ALS and are expected to work,
untested. **Without ALS** (browser, Workers without the flag) the static `node:async_hooks` import
fails at load: the package never degrades silently, because an ambient tx falling back to the root
would run statements outside the transaction. `storage:` accepts any `AsyncStorage` (e.g. an
`AsyncContext.Variable` adapter) but such runtimes also need an alias stub for the import. Core
works without context.

---

## 6. Tests

Family layout (`test/{unit,live,pg}`, vitest projects, pg-prime aliased to source). RLS tests
connect as a **non-superuser** role (`create role rls_app login`, `force row level security`):
superusers and owners bypass RLS. Keys come from core `setting()`.

### 6.1 Context — tier 0 (`createMockPool`)

- **Propagation** per §3.2 cell, on recorded SQL: root `BEGIN` + one `set_config` batch (scope ∪
  explicit, explicit wins); `SAVEPOINT "pgprime_sp_1"`; `new` on a second connection; host default
  vs per-call override.
- **Join:** the callback and `host.tx()` both get the real outer `Tx`; isolation mismatch or any
  of `timeoutMs`/`lockTimeoutMs`/`localSettings` → `CONTEXT_OPTIONS`; `retry` ignored;
  `host.tx().rollbackWith(v)` in a joined `@Transactional` ends the outer tx, which resolves `v`
  (the documented behaviour).
- **Savepoints:** three nested levels pass; sibling savepoints in `Promise.all` on one `Tx`, or two
  scopes `within` one `Tx` → `CONTEXT_CONCURRENT_SAVEPOINT`.
- **Retry:** `40001` on the first `COMMIT` → `fn` re-runs, `current()` is the new handle, settings
  re-sent, `attempt === 2`; a `ContextError` is not retried.
- **API:** strict on/off; `tx()`/`inTransaction`/`attempt`/`settings`; `setLocal` in scope / tx /
  neither; `run` in a tx → `CONTEXT_NESTED_SCOPE`; `within` sends settings before `fn`, nothing
  when none; interleaved scopes never see each other's state.
- **Guard** (`devGuard: true`): no throw for `host.db`, `outside()`, `new`; a captured root throws.
- **Pin:** root tx → pinned savepoint and tx-less request `host.db` on `R`; two tenants in sequence
  (request 2 never sees tenant 1, a settings-less request sees none); restore covers direct
  `tx.setLocal`, `timeoutMs`, `statement_timeout` back to its captured `30s` (never `''`) and a
  placeholder created mid-request; `read only` ends with `ROLLBACK TO` and the next request writes;
  isolation ignored; a second concurrent request → `CONTEXT_CONCURRENT_SAVEPOINT`; a request error
  (incl. a 409-mapped `23505`) rolls back only `R`; `rollbackWith` caught; a captured root `Db` →
  `HandleMisuseError`; strict fires as in production.
- **Cost / graph:** with no scope `db` calls `getStore()` exactly once (spy); `storage:` override;
  module graph is `node:async_hooks` + `pg-prime` only.

### 6.2 Context — tier 1 (PGlite)

`current_setting` equals the scope value in a host tx and is `''` on the same connection after
commit; a caught savepoint failure leaves the outer tx usable; `within(tx)` makes
`tenantId.current()` visible in `fn`; `rollbackScope` isolates sequential "tests", settings included.

### 6.3 Context — tier 2 (real PG 17 and 18; PgBouncer when available)

| Test | Asserts |
|---|---|
| RLS | policy `using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`; a scoped host tx sees only its tenant; strict throws on an unscoped read |
| `within` + RLS | `db.transaction(tx => host.within(tx, read))` sees only the scope's tenant |
| No leak | 50 concurrent scopes × `host.transaction` on `max: 5`; each sees only its tenant; afterwards every pooled connection reads empty; repeated through PgBouncer transaction mode |
| Savepoints | three levels, inner failures caught, outer commits the rest |
| `40001` | two serializable host txs conflict; the loser re-runs with its settings on attempt 2 |
| `new` | commits when the outer rolls back; `max: 1` → acquire timeout, not a hang |

### 6.4 Nest e2e (`@nestjs/testing`, `platform-express`, `fetch`)

PGlite (live) and real PG (pg); Nest 12 plus a CI leg on 11.
- **Lifecycle:** `forRoot`/`forRootAsync` boot; `app.close()` → `db.end()`; `provideAddOn` order
  `start` … `close` → `end`; `end: false` keeps the db.
- **`@Transactional()`:** joins across services by default; per-call `propagation: 'savepoint'`;
  module-level default; label reaches `onTransactionStart`; route metadata preserved.
- **Interceptor:** pass-through when `request` is unset; settings from a guard-set `req.auth`;
  precedence handler > class > global predicate > default; `'whenSettings'` opens a tx exactly when
  settings exist; an error response rolls back; serializable `@Transactional` inside a request tx →
  `CONTEXT_OPTIONS`; 20 concurrent requests of different tenants (no pin, tier 2, RLS) each see only
  their rows.
- **`rollbackScopeFor(app)`:** test 1's writes absent in test 2; two tenants in one test isolated;
  a 409-mapped constraint error does not break the next request; a second app in the same process
  keeps its own host (`hostOf`), and a duplicate name → `CONTEXT_DUPLICATE_HOST`.
- **GraphQL** (`@nestjs/graphql` + Apollo, dev deps): a query resolver is scoped; a `@ResolveField`
  sees no scope by default (strict does not fire, and the guide warns about it), and is scoped
  with `fieldResolverEnhancers: ['interceptors']`.
- **Bun:** unit + pg under `bunx --bun vitest`; `test/pg/bun-app.test.ts` spawns `bun
  test/bun/app.ts` (metadata-only DI), calls it with `fetch`, SIGTERM → `db.end()` observed.

**Gates per package:** `test`, `test:live`, `test:pg`, Bun (design/15 §11), API snapshot,
tree-shake golden, pack-smoke, check-dts on TS 5.9.3, emit-parity.

---

## 7. Docs

- **Guides:** `guides/ambient-transactions.mdx` (host, propagation, typed keys, RLS, strict, retry,
  guard, `within`, prepared queries, runtimes, the pin); `guides/nestjs.mdx` (module, injection,
  `@Transactional`, request settings, `@RequestTransaction`, GraphQL, add-ons, shutdown, testing,
  migrating from a hand-written db module); pointers in `guides/{transactions,testing}.mdx`.
- **Reference** `reference/{context,nestjs}.mdx`; **module docs** (Purpose / Public API / Flow /
  Gotchas / Tests) `docs/packages/pg-prime-context/src/{index,host,storage,pin,errors,testing}.md`
  and `docs/packages/pg-prime-nestjs/src/{index,module,tokens,transactional,request,add-on,testing}.md`
  (INDEX lines in RESULTs); ~30-line READMEs. Decorator docs blocks need `experimentalDecorators` in
  the docs typecheck config (N0). `setting()` docs are design/20 R1's.

---

## 8. Core change, tooling, CI, release

### 8.1 Core change required

| Change | Where | Owner | Notes |
|---|---|---|---|
| `setting(name, codec?)` → `SettingKey<T, P>` (§2.1) and the `assertGucName` export | new `src/session/setting.ts`; `session/transaction.ts`; `src/index.ts` | **design/20 R1, exclusively.** No design/19 agent edits these files | Its tests, docs and changeset are R1's |
| `inTransactionFrame(tx, fn)`: runs `fn` with `tx`'s guard frame pushed (plain call when the guard store is absent), so pinned requests keep the dev guard (§3.7) | `session/guard.ts` + `handles.ts` accessor; `src/index.ts` | **design/20 R1** (the coordinator adds it to R1's brief; R1 already owns `src/index.ts`) | ~10 lines + one tier-0 test. If it is not shipped, C1 documents the pinned-request guard gap and marks its test `todo` |

Nothing else in `packages/pg-prime/**` changes. Both new packages' `pg-prime` peer floor is the
release that ships these.

### 8.2 Tooling and release (N0, as design/15 F0)

- **Slots** `packages/pg-prime-{context,nestjs}/`: `package.json` (ESM-only, `sideEffects: false`,
  `types@<5.9` gate, `files: ["dist"]`, Node ≥ 22.12, exports `.` + `./testing`);
  `tsconfig{,.build}.json` (nestjs: `experimentalDecorators` in the typecheck config only);
  `vitest.config.ts` (unit/live/pg; nestjs also aliases `@pg-prime/context`); stub `src/index.ts`,
  `src/unsupported-typescript.d.ts`, README, `test/unit/slot.test.ts`.
- **Release:** `.changeset/config.json` `fixed` += both, first publish at the group's next version;
  RELEASING rows (placeholder publish + trusted publisher are human steps).
- **`tools/budgets.json`** (design numbers, ratcheted at first measurement):

  | Package | Unpacked | Install (pkg + deps, excl. peers) | Tree-shake delta (min+gz, peers external) |
  |---|---|---|---|
  | context | ≤ 40 KB | ≤ 60 KB | ≤ 3 KB (`context-basic`) |
  | nestjs | ≤ 60 KB | ≤ 120 KB incl. context | ≤ 8 KB incl. context (`nestjs-module`) |

  `dependencies`: context `[]`, nestjs `["@pg-prime/context"]`; `requiredPeers` per §4.6.
- **`tools/treeshake-check.mjs`:** externalize every peer of the fixture's package, not only
  `pg-prime`; fixtures `fixtures/treeshake/{context-basic,nestjs-module}/` with placeholder goldens.
- **`tools/pack-smoke.mjs`:** per-package peer list; nestjs's project also installs
  `@nestjs/{common,core}`, `rxjs`, `reflect-metadata`, boots `createApplicationContext` over a mock
  pool and closes it.
- **`tools/check-dts.mjs`:** nestjs consumer installs `@nestjs/common`; context's `.d.ts` must not
  reference `@types/node`.
- **Lists:** empty API goldens `tools/api-snapshot/pg-prime-{context,nestjs}.json`; docs
  coverage/signatures/typecheck; `knip.json` (sherif: Nest dev deps only in nestjs); `ci.yml` (bun
  filters, tier-2 loop, direct-`bun` app step, Nest 11 leg); `docs/package.json`; stub pages;
  `pnpm-lock.yaml`. **Not `docs/astro.config.mjs`** (design/20 R4 owns it): N0 puts the sidebar
  entries in its RESULT and the integrator applies them.
- **W0 spikes** (results in N0's RESULT, each with a fallback): (1) TS 7.0.2 typechecks legacy
  decorators in `test/` → call-form fixtures; (2) Vite 8/oxc transforms them (and emits
  `design:paramtypes`?) → esbuild pre-transform; (3) Nest calls lifecycle hooks on factory-provided
  instances → `useClass` + call-form `Inject`; (4) ALS survives `next.handle()` on Node and Bun;
  (5) an undecorated `DynamicModule` class works → `Module({})(PgPrimeModule)`; (6) placeholder GUCs
  appear in `pg_settings` with `context = 'user'` on PG 17/18 and PGlite → the capture also
  unions the scope's own keys; (7) `@ResolveField` resolvers do not inherit the parent's ALS store →
  if they do, the guide says so and the field-enhancer note becomes optional.

---

## 9. Workstreams and agent briefs

```
design/20 R1 (adds setting()) ─┐
mq A5 merged ──────────────────┴─▶ N0 tooling + slots + spikes ─▶ C1 context ─▶ N1 nestjs ─▶ Integrator
                                                                                  └─▶ X1 optional example
```

N0 shares files with the mq agent (budgets, changesets, `ci.yml`, `knip.json`, docs config,
lockfile, RELEASING), so it starts after A5 merges. C1 depends on design/20 R1 (`setting()`); if R1
slips, C1 waits — it does not add `setting()` itself. RLS tests use raw
`create policy` and do not depend on the rest of design/20.

### Rules for every agent (as design/15 §11)

- **Never edit:** `packages/pg-prime/**`, other package directories, `design/{07,15,16,17,18,20}*.md`
  and other plan files, `docs/INDEX.md`, `docs/astro.config.mjs` (design/20 R4 owns it); and,
  **except N0**, `tools/*.mjs`, `tools/budgets.json`, `.changeset/config.json`, `.github/**`,
  `knip.json`, `pnpm-lock.yaml`, `package.json` dependency fields, `docs/package.json`,
  `RELEASING.md`. Your own API and tree-shake goldens are yours to commit. INDEX lines, sidebar
  entries and sizes go in your RESULT; need a dep or tool change → stop and report.
- **Regenerators** rewrite every golden: commit only yours, `git checkout --` the rest.
- **Database:** your own PG 17 (:5417) and PG 18 (:5418) databases via `~/.agents/bin/pg-dev`;
  `PG_PRIME_TEST_URL`, plus `PG_PRIME_TEST_PGBOUNCER_URL` when available (else record "not run").
- **Code style:** simple, clean, short; comments only for a non-obvious reason, workaround or trap,
  one short line; no history, ticket ids or ALL-CAPS headings; shorter wherever clarity allows.
- **Generic:** no consumer-specific names or defaults in code, tests or docs.
- **Done:** your tiers + the full chain (design/15 §11) green; `#### <agent> — RESULT` appended.

| Agent | When | Owns | Done |
|---|---|---|---|
| **N0** tooling, slots, spikes | after A5 | all of §8.2, both slots, empty goldens, tree-shake fixtures, docs stubs | seven W0 spikes recorded with fallbacks; `pnpm build && pnpm package:check && pnpm docs:check` green with empty slots; full chain |
| **C1** context | after N0 and design/20 R1 (`setting`, `inTransactionFrame`) merged | `packages/pg-prime-context/**` (not dep fields), its module docs, `guides/ambient-transactions.mdx`, `reference/context.mdx`, its goldens, RESULT. Inputs §2, §3, §5, §6.1–§6.3 | tiers incl. §6.3 on PG 17/18 and Bun; `src/` ≤ ~350 lines; full chain |
| **N1** nestjs | after C1 merged | `packages/pg-prime-nestjs/**` (not dep fields), its module docs, `guides/nestjs.mdx`, `reference/nestjs.mdx`, pointers in `guides/{transactions,testing}.mdx`, its goldens, RESULT. Never touches context (report instead). Inputs §4, §6.4, W0 | §6.4 on Node, Bun, Nest 11; full chain |
| **X1** optional example | after N1, outside this repo | `../bun-nestjs/**`: `PgPrimeModule.forRoot`, one `@Transactional()` method, prepared queries via `host.db.run(q, { params })`, `../packages-local/pack.sh` += both. An illustration, not a design input | `bun run typecheck`, `bun run smoke` |
| **Integrator** | between rounds | merge (design/20 R1) → N0 → C1 → N1; INDEX lines; N0's sidebar entries into `docs/astro.config.mjs`; ratchet budgets; design/07 §1.6 AMENDED note | full chain on the merged tree; push; watch CI |

---

## 10. Decisions on the former open questions

| # | Question | Decision | Reason |
|---|---|---|---|
| D1 | Default propagation | **Configurable**: host/module `propagation`, default `'join'`, per-call override | Owner's decision; `join` is free and matches "needs a tx" |
| D2 | Per-request transaction | Mode or predicate globally, `@RequestTransaction` per class/handler; default **`'whenSettings'`** | Zero cost without settings, correct RLS with them (§4.3) |
| D3 | Ambient pickup in add-ons | **No**: explicit `{ tx: host.current() }` | Keeps the add-ons ALS-free and unchanged; one argument is cheap |
| D4 | Nest 11 | Peer `^11 \|\| ^12`; one CI leg on 11 | 11 is widely deployed; one leg is cheap |
| D5 | `@Transactional` host resolution | The instance's injected host first, then the name registry, which refuses duplicates | Correct with several apps in one process; loud, never last-wins |
| D6 | Exception filter | **Docs recipe** | HTTP status mapping is application policy |
| D7 | `create-pg-prime` Nest template | **Not now** | No framework templates exist; separate scaffolder decision |
| D8 | `prepared.on(handle)` in core | **No** | `host.db.run(prepared, { params })` already works |
| D9 | Typed setting keys | Core `setting(name, codec)` as pinned by design/20, owned by its R1 | Policies must not require context; one key feeds both |

---

## 11. Review fixes

**cnp-01:** all eight fixed in rev 2; rev 3 replaces its joined-handle guard and pin cache.

| cnp-02 finding | Fix (rev 3) |
|---|---|
| astra-bugs-1: handles derived from the joined handle restore `rollbackWith` | Wrapper removed: a join is the real `Tx`, and `rollbackWith` ending the outer tx is documented (§3.2) |
| opus-bugs-1: the ALS store keeps the real `Tx`, bypassing the guard and `timeoutMs` | Same single rule: there is no guarded handle to diverge from. Join `timeoutMs`/`lockTimeoutMs`/`localSettings` → `CONTEXT_OPTIONS` (§3.2) |
| astra-bugs-4: pin reset `''` breaks built-ins and misses direct `tx.setLocal` | Capture user GUCs from `pg_settings` on entry and restore the captured values before `RELEASE`. `''` only for placeholders created during the request (§3.7) |
| opus-bugs-3: tx-less `host.db` under the pin bypasses savepoint and queue | Every request runs in a pinned savepoint `R` (the store's `base`); tx-less statements use `R`; concurrency is refused; test-body use is a documented caveat (§3.1, §3.7) |
| opus-adv-2: pinned requests lose the dev guard | Core `inTransactionFrame(pin.tx, …)` (design/20 R1, §8.1) wraps each pinned savepoint |
| opus-adv-7: `@ResolveField` gets no scope | Documented `fieldResolverEnhancers` requirement and tx-per-field consequence; W0 spike 7 and a §6.4 test (§4.3) |
| opus-adv-8: `astro.config.mjs` collision with design/20 R4 | R4 owns the file; N0 hands its sidebar entries to the integrator (§8.2, §9) |
| opus-adv-6: last-wins registry can pick another app's host | `hostOf`: the instance's own host first; the registry refuses duplicates (§4.4, D5) |
| opus-adv-5: isolation/access mode under the pin unspecified | Isolation, deferrable and retry are ignored under a pin; `read only` becomes `transaction_read_only` and the savepoint ends with `ROLLBACK TO` (§3.7) |

---

#### N0 — RESULT (2026-10-09)

Branch `worktree-agent-ad06b018e2a1b986d`, from `c39698a`. Commits: `42e0055` slots, `38998cb`
tooling, `f6cbab5` CI, `d3a0d0e` docs stubs, `db8879b` nestjs dev-dep fixes.

**Set up.**
- Slots `packages/pg-prime-{context,nestjs}`: exports `.` and `./testing` (`src/index.ts`,
  `src/testing.ts`, both `export {}`), generated types@<5.9 stub, README, slot test, pack-smoke
  body, unit/live/pg vitest projects (nestjs also aliases `@pg-prime/context{,/testing}`).
  context's build tsconfig keeps `types: ["node"]` for `node:async_hooks`; nestjs sets
  `experimentalDecorators` + `emitDecoratorMetadata` in `tsconfig.json` and turns both off in
  `tsconfig.build.json`.
- Deps: peer `pg-prime >=0.2.0` on both; nestjs → `@pg-prime/context: workspace:^`, peers
  `@nestjs/{common,core} ^11.0.0 || ^12.0.0`, `rxjs ^7.8.0`; dev deps Nest 12.1.2 (common, core,
  testing, platform-express), `@nestjs/{graphql,apollo}` 14.0.3, `@apollo/server` 5.5.1,
  `@as-integrations/express5` (Apollo on Express 5 does not boot without it), `graphql` 16,
  `rxjs`, `reflect-metadata`, and `typescript ^7.0.2` (else `@nestjs/graphql`'s optional
  `typescript` peer resolves to the workspace's 5.9.3 and links its `tsc` into the package's
  `.bin`; pnpm now reports that optional peer as unmet, which is harmless).
- Tools: `budgets.json` (§8.2 numbers, deps, required peers, `context-basic` 3 KB / `nestjs-module`
  8 KB deltas); `treeshake-check` externalizes every required peer of the imported packages for
  the delta and never stages third-party peers (existing goldens unchanged); `api-snapshot`
  lets `./testing` export names the root does not and renders the stub from the union of all
  entries; `pack-smoke` installs `REGISTRY_PEERS` (Nest, rxjs, reflect-metadata) for nestjs;
  `check-dts` lib-checks a package with a third-party required peer with Node's types and counts
  a `reference types` directive as `@types/<name>`; `docs-typecheck` enables
  `experimentalDecorators`; knip workspaces; changesets `fixed` += both plus one minor changeset
  each; RELEASING rows; docs depends on both plus `@nestjs/{common,core,testing}`, `rxjs`,
  `reflect-metadata` (not GraphQL: its `typescript` peer would re-resolve Starlight's).
- CI: bun job unit filter += both, tier-2 loop += context, a nestjs tier-2 step whose jq check
  fails if `bun-app.test.ts` exists and any of its cases is not `passed`; a `nest11` job that
  `pnpm add`s Nest 11 + `@nestjs/{graphql,apollo}@^13`, asserts 11 resolved, runs `typecheck` and
  `test:live` (simulated locally: green).

**W0 spikes** (Node 24.14, Bun 1.4.2, Nest 12.1.2 and 11.2.7 unless noted).

| # | Result | Fallback |
|---|---|---|
| 1 | **Pass.** TS 7.0.2 typechecks class, method and parameter (`@Inject`) legacy decorators in `test/` with `emitDecoratorMetadata`; TS 5.9.3 and `oxlint --type-aware` clean too | Call-form fixtures: not needed |
| 2 | **Pass.** Vitest 4.1.10 / Vite 8.2.1 (oxc) transforms them **and emits `design:paramtypes`** (it follows the tsconfig): metadata-only DI resolves under Node and `bunx --bun vitest` | esbuild pre-transform: not needed |
| 3 | **Pass.** All four hooks run on `useFactory` (and `useValue`) instances; every `beforeApplicationShutdown` precedes every `onApplicationShutdown`. Order **within** a phase differs: Nest 12 reverses registration order on shutdown, Nest 11 keeps it, so only the phase split may be relied on (as designed) | `useClass` + call-form `Inject`: not needed |
| 4 | **Pass.** A factory-provided `APP_INTERCEPTOR` running `next.handle().subscribe` inside `als.run` reaches async handlers behind an async guard, Observable handlers and a nested tx store; 20 concurrent requests isolated; Node, `bunx --bun vitest`, direct `bun` (metadata-only DI), Nest 11 | — |
| 5 | **Pass.** An undecorated `class PgPrimeModule { static forRoot(): DynamicModule }` (global, exports) imports and injects on Nest 12 and 11 | `Module({})(PgPrimeModule)`: not needed |
| 6 | **Fail — design change.** Placeholder (dotted) GUCs are **never** in `pg_settings`, `SHOW ALL` or `pg_show_all_settings()` on PG 17.11, 18.6 or PGlite 18.3, even after `set_config`; only `current_setting(k, true)` sees them. Built-ins (`statement_timeout`, `lock_timeout`) are listed with `context = 'user'`. Also verified: `set_config('transaction_read_only', 'on', true)` inside a savepoint refuses writes and `ROLLBACK TO` restores read-write, on all three | **Verified** on PG 17 and PGlite: capture `current_setting(k, true)` for the host's known keys plus `pg_settings` for the built-ins in one statement; restore all in one `set_config(…, true)` before `RELEASE` (`NULL` → `''`); `statement_timeout` returns to its captured 30 s |
| 7 | **Confirmed.** By default `@ResolveField` resolvers (sync and async) see no store while the query resolver sees its scope; with `fieldResolverEnhancers: ['interceptors']` each field runs in its own interceptor scope. Node and Bun, `@nestjs/graphql` 14 and 13 | Design unchanged |

**Spike 6 changes §3.7 (for C1; §3.7 step 2 and §6.1 "Pin" are to be read this way):** the
capture keys are the scope's settings ∪ explicit `localSettings` ∪ `host.setLocal` keys ∪ every
dotted key the host has applied under this pin, read with `current_setting(k, true)`, plus
`pg_settings` for `context = 'user'` built-ins. A dotted key set only through a raw
`tx.setLocal`/`set_config` that the host never saw cannot be found, so it can leak into the next
request of the same pinned test: a guide caveat ("set request keys through the scope or
`host.setLocal`"), and the §6.1 placeholder case uses a key the host knows. Built-ins set by a raw
`tx.setLocal` or `timeoutMs` are still restored.

**Gates.** Full chain green, tier 2 on a temporary `postgres:17` + `edoburu/pgbouncer`
(transaction mode; PgBouncer tests ran):
- unit: pg-prime 1 122, create 35, testing 23, events 33, outbox 51, cron 59, mq/context/nestjs 1;
- live: pg-prime 1 943 (+18 skipped), testing 28, events 49, outbox 68, cron 78, 3 × 1;
- pg: pg-prime 2 031 (+29 skipped), kit 461, create 42, testing 36, events 59, outbox 77, cron 94,
  3 × 1;
- package:check 33/33 size gates, no API drift, emit parity, check:dts, tree-shake 7 ok + 3
  pending (`context-basic`, `nestjs-module`, `mq-send`), pack smoke (context install 20.6 KB /
  60 KB, nestjs 41.8 KB / 120 KB incl. context; unpacked 4.3 / 4.9 KB), create smoke;
- bench:types, bench:compile; docs:check 710 blocks / 68 pages, 114 examples;
  docs:examples:pg 10; Bun unit for both slots.

**Sidebar entries (integrator → `docs/astro.config.mjs`):**
- Guides: `{ label: 'Ambient transactions', slug: 'guides/ambient-transactions' }`,
  `{ label: 'NestJS', slug: 'guides/nestjs' }`.
- Reference (after `@pg-prime/cron`): `{ label: '@pg-prime/context', slug: 'reference/context' }`,
  `{ label: '@pg-prime/nestjs', slug: 'reference/nestjs' }`.

**For C1 and N1.**
- `./testing` is `src/testing.ts`; record your golden with `pnpm build && node
  tools/api-snapshot.mjs` and the tree-shake golden with `node tools/treeshake-check.mjs --update
  --case <context-basic|nestjs-module>` (entries already written); commit only yours.
- check-dts fails on `node:*` or a `@types/node` reference in context's `dist` — keep
  `AsyncStorage` structural. nestjs is checked with Node's types (Nest's own `.d.ts` need them).
- `test/pack-smoke.ts` is yours; nestjs's already boots an empty Nest context with Nest, rxjs and
  reflect-metadata installed from the registry: extend it to `PgPrimeModule` over a mock pool.
- N1: the `nest11` CI job runs only `typecheck` and `test:live`, so Nest e2e that must hold on 11
  belongs in `test/live`; `test/bun/*.ts` is a knip entry and `bun test/bun/app.ts` from the
  package dir resolves pg-prime and context to source through `tsconfig.json` paths;
  `docs-examples` does not enable decorators, so runnable Nest blocks need `no-run`, and GraphQL
  blocks need `skip-check="…"` (docs has no GraphQL deps).
