# 07 — Runtime Execution Layer

**Owner:** design agent 07 · **Date:** 2026-08-14 · **Status:** decisions, not options
**Scope:** how a request gets from user code to a PostgreSQL backend and back — handles, execution modes, transactions, errors, pooler compatibility, cancellation, streaming, observability.
**Out of scope (owned elsewhere):** the driver seam itself (agent 02 — I *consume* `PgDriver`/`PgConnection`/`PgResult`), schema/DDL (01/03), query-builder syntax and typing (04), codecs (05?), migration engine (06). Where I need a surface from another agent I name it and depend on the shape, not the implementation.

**Inherited constraints (non-negotiable):** `pg` as the sole v1 adapter behind agent 02's structural seam · zero runtime dependencies, zero *required* peer dependencies · near-raw-driver performance · **no Unit of Work, no identity map, no ambient context** — a `db` object and explicit transactions.

**Verified findings this design is built on** (from `research/pg-drivers.md`, trusted over memory):

- `pg` executes an *unnamed* parameterised query as `Parse`+`Bind`+`Describe('P')`+`Execute`+`Sync` corked into **one write, one round trip**, inferring parameter types client-side (§5.5). postgres.js's `prepare:false` costs 2 RTT forever (§2.4). Our pooler-safe default is therefore also our *fast* default — there is no tradeoff to make.
- An unnamed statement is pooler-safe **iff no `Sync` separates `Parse` from `Bind`/`Execute`** (§5.4), because `ReadyForQuery` is exactly where a transaction pooler may reassign the server connection.
- PgBouncer ≥ **1.24.0 defaults `max_prepared_statements=200`** — protocol-level named statements now work in transaction mode by default (§5.2). Supavisor still does not (§5.3).
- Transaction pooling **never** supports `SET`/`RESET`, `LISTEN`, session advisory locks, `WITH HOLD` cursors, SQL `PREPARE`/`DEALLOCATE`, `LOAD` (§5.1). `NOTIFY` **is** supported — the matrix is asymmetric.
- `pgx`'s five explicit `QueryExecMode`s are the best prior art in any ecosystem; **no driver or ORM anywhere auto-detects pooling mode** (§5.6). Prisma's client-side pooler workaround *became the bug* (issue #21799).
- Drizzle: `db.transaction(fn, { isolationLevel, accessMode, deferrable })`, savepoint nesting — but **no type-level prevention of the outer-`db`-inside-`tx` footgun** (its single most common bug) and **no retry on `40001`** despite offering `serializable` (`research/drizzle.md` §2.3).
- MikroORM: keep `transactional()`, savepoints, isolation levels; **drop the seven Spring propagation modes** (`research/mikroorm.md` §7 — *"Enterprise-Java cosplay"*).
- Prisma: no savepoints, no `SET LOCAL`, no advisory-lock helpers, no retry — and its **5 s default transaction timeout is a documented recurring production surprise** (`research/prisma.md` §3.3). Its RLS story is blocked on the absence of a supported `SET LOCAL` (#5128, 78 comments).

---

## 0. The five-minute version

```ts
import { createDb } from 'pg-prime'
import * as schema from './schema.js'

export const db = createDb({
  schema,
  connection: process.env.DATABASE_URL!,       // pooled
  directConnection: process.env.DIRECT_URL,    // optional; migrations, LISTEN, session locks
  poolerMode: 'pgbouncer-transaction',
})

// autocommit
const rows = await db.select(users).where(...)

// explicit transaction — note the parameter is named `db`, shadowing the module-level one
const order = await db.transaction(async (db) => {
  await db.setLocal('app.tenant_id', tenantId)          // parameterised, RLS-safe
  const o = await db.insert(orders).values(...).returning()
  await db.insert(orderLines).values(...)
  return o
}, { isolation: 'serializable' })                       // retry on 40001 is ON by default here
```

Every decision below exists to make that snippet correct on a direct connection, behind PgBouncer, behind Supavisor, and on Neon — with the same code.

---

## 1. Client and handle model

### 1.1 `createDb()` — the config surface

`createDb` is **synchronous and lazy**: it opens no sockets. First query connects. This keeps module-eval side-effect-free (important for serverless cold starts and for test files that import the schema but never query).

```ts
export function createDb<S extends Schema>(config: DbConfig<S>): Db<S>

export interface DbConfig<S extends Schema> {
  /** The schema object. Powers typing, codec resolution for user types, and constraint→table error mapping (§4.4). */
  schema: S

  // ── Connection: exactly one of these three ────────────────────────────────
  /** Connection string or discrete params. We build the pool via the bundled `pg` adapter. */
  connection?: string | ConnectionParams
  /** Bring your own pool. Structurally typed — `pg.Pool`, `@neondatabase/serverless` Pool, Hyperdrive all satisfy it with zero adapter code (agent 02). */
  pool?: PgLikePool
  /** Full seam override: your own driver implementation. */
  driver?: PgDriver

  /**
   * Second, non-pooled URL. Required when `poolerMode` is a transaction mode and you use
   * any of: migrations, `db.listen()`, session advisory locks, `WITH HOLD` cursors.
   * Routed **by feature, not by call site** — the user never picks a connection manually.
   */
  directConnection?: string | ConnectionParams

  // ── Execution policy ──────────────────────────────────────────────────────
  poolerMode?: PoolerMode                 // default 'none'   — §5
  execMode?: ExecMode                     // default 'unnamedExtended' — §2
  prepared?: PreparedStatementOptions     // LRU config, only used when execMode==='prepared'
  planCache?: PlanCacheOptions | false    // decode-plan cache; default on
  pipeline?: boolean                      // default false — pg destroys the connection on error in pipeline mode
  rowMode?: 'array'                       // internal only; not user-configurable in v1

  // ── Pool ──────────────────────────────────────────────────────────────────
  poolOptions?: PoolOptions               // §1.2 — named to avoid colliding with `pool` above

  // ── Session GUCs applied at connection setup (poolerMode 'none' | 'session' only) ──
  session?: SessionDefaults               // §3.6

  // ── Types ─────────────────────────────────────────────────────────────────
  /** Overrides on top of the ORM-owned OID→codec table. We NEVER call pg's global setTypeParser. */
  codecs?: CodecOverrides

  // ── Transactions ──────────────────────────────────────────────────────────
  transaction?: TransactionDefaults       // §3

  // ── Observability & errors ────────────────────────────────────────────────
  hooks?: QueryHooks                      // §7.1
  log?: LogOptions                        // §7.3
  errors?: ErrorOptions                   // §4.3 — redaction policy
  devGuard?: boolean                      // default: NODE_ENV !== 'production'; §1.5

  /** Abort → graceful pool drain. Lets `createDb` participate in a process lifecycle signal. */
  signal?: AbortSignal
}
```

Presets ship as plain functions returning a partial config, so they compose and are inspectable:

```ts
export const presets = {
  serverless: (): Partial<DbConfig<never>> => ({
    poolOptions: { max: 1, idleTimeoutMillis: 1_000, allowExitOnIdle: true, connectionTimeoutMillis: 5_000 },
    pipeline: false,
  }),
  neonPooled:  () => ({ poolerMode: 'pgbouncer-transaction' as const, ...presets.serverless() }),
  supabaseTransaction: () => ({ poolerMode: 'transaction' as const }),   // Supavisor: no named statements
  rdsProxy:    () => ({ poolerMode: 'pgbouncer-transaction' as const }),
}
```

### 1.2 Pool sizing defaults, with rationale

We do **not** ship our own pool in v1 (`research/pg-drivers.md` §5.7 #7) — we delegate to the adapter's, but we own the *policy* and override several of `pg-pool`'s defaults because two of them are actively hostile in production.

```ts
export interface PoolOptions {
  max?: number                     // default 10
  min?: number                     // default 0
  idleTimeoutMillis?: number       // default 10_000
  connectionTimeoutMillis?: number // default 10_000   ← WE CHANGE pg's default of 0
  maxLifetimeSeconds?: number      // default 1_800    ← WE CHANGE pg's default of 0 (off)
  maxUses?: number                 // default Infinity
  allowExitOnIdle?: boolean        // default false
}
```

| Setting | Ours | `pg-pool` default | Rationale |
|---|---|---|---|
| `max` | **10** | 10 | Keep the ecosystem default — surprising a user who reads `pg` docs is worse than a marginally better number. Node is single-threaded: past ~10 in-flight queries a single process is almost always bottlenecked on the event loop or on PG's own CPU, not on connection count. The number that actually matters is **`instances × max`**, which we document loudly (below). |
| `min` | **0** | 0 | Warm pools sound nice and cost real connections in every idle replica. `min` is the right knob for a single long-lived monolith; it is the wrong default for the N-instance world. |
| `connectionTimeoutMillis` | **10 000** | **0 = wait forever** | `pg`'s default turns pool exhaustion into an *unbounded hang* with no error and no metric. That is the single worst default in the stack. Ours converts it into a `PoolTimeoutError` (§4) with pool stats attached — an alertable event instead of a mystery. |
| `maxLifetimeSeconds` | **1 800** | **0 = off** | Connections that live forever survive DNS changes, failovers, and rolling pooler restarts by *not noticing them*. A 30-minute ceiling makes the fleet self-heal after a failover with no operator action, at a cost of ~2 reconnects/hour/connection. |
| `idleTimeoutMillis` | 10 000 | 10 000 | Fine as-is. |
| **reset query** | **none, ever** | none | `DISCARD ALL` clears PgBouncer's per-client prepared-statement tracking *and* pins RDS Proxy connections (§5.7 #4). We never emit it, in any mode. |

**The multiplication warning, shipped as a doc *and* a startup check.** The way people actually exhaust `max_connections` is:

```
app instances × poolOptions.max   ≤   pooler default_pool_size
pooler default_pool_size × pools  ≤   max_connections − superuser_reserved_connections − replication slots
```

`db.diagnose()` (§5.4) reads `max_connections`, `superuser_reserved_connections` and `current_setting('max_connections')` vs `count(*) from pg_stat_activity`, and prints this arithmetic with the observed numbers. In dev, a single `warn` fires at startup if `max > 20` or if `max × 4 > max_connections`.

### 1.3 The three handles

Three concrete handle types, one shared query interface. This is deliberately *more* than Drizzle/Prisma ship (they have two) because "I need the same backend for several statements but I don't want a transaction" is a real, currently-unserved need (advisory locks, temp tables, `SET`, multi-statement diagnostics).

```ts
/** Anything you can run a query against. Helper functions should take THIS. */
export interface Queryable<S extends Schema> {
  readonly schema: S

  // Query-builder entry points (agent 04 owns their return types)
  select: SelectFn<S>;  insert: InsertFn<S>;  update: UpdateFn<S>;  delete: DeleteFn<S>
  /** Tagged template. Parameterised; `sql.unsafe` is the only injection escape hatch. */
  sql: SqlTag<S>

  /** Execute an already-compiled query (§2.5). */
  run<T>(q: CompiledQuery<T> | Query<T>, opts?: ExecOptions): Promise<Rows<T>>

  /** EXPLAIN any query (§7.5). */
  explain<T>(q: Query<T>, opts?: ExplainOptions): Promise<ExplainResult>

  /** Server-side cursor as an async iterable (§6.3). */
  stream<T>(q: Query<T>, opts?: StreamOptions): AsyncIterable<T>
  streamBatches<T>(q: Query<T>, opts?: StreamOptions): AsyncIterable<T[]>
}

/** The root handle. Pool-backed; every statement may land on a different backend. */
export interface Db<S extends Schema> extends Queryable<S> {
  readonly kind: 'db'

  transaction<T>(fn: (tx: Tx<S>) => Promise<T>, opts?: TxOptions): Promise<NoHandleEscape<T>>
  transaction<T>(opts: TxOptions, fn: (tx: Tx<S>) => Promise<T>): Promise<NoHandleEscape<T>>

  /** Pin one pool connection without opening a transaction. §1.4 */
  session<T>(fn: (s: Session<S>) => Promise<T>): Promise<NoHandleEscape<T>>

  listen(channel: string, handler: NotificationHandler): Promise<Subscription>   // §6.5
  notify(channel: string, payload?: string): Promise<void>                       // pg_notify($1,$2)

  copyFrom: CopyFromApi<S>                                                       // §6.6
  copyTo:   CopyToApi<S>

  diagnosePooler(): Promise<PoolerDiagnosis>                                     // §5.4
  diagnose(): Promise<DbDiagnosis>
  observe(hooks: QueryHooks): () => void                                         // §7.1
  stats(): PoolStats

  connect(): Promise<void>          // optional eager warm-up
  end(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

/** Inside a transaction. Same query surface; different capabilities. */
export interface Tx<S extends Schema> extends Queryable<S> {
  readonly kind: 'tx'
  /** 1 for the first attempt; increments on serialization retry (§3.4). */
  readonly attempt: number
  readonly depth: number            // 0 = outermost; >0 = savepoint
  readonly isolation: IsolationLevel
  readonly accessMode: AccessMode

  /** Nested → SAVEPOINT. Isolation/access-mode options are absent by construction (§3.3). */
  transaction<T>(fn: (tx: Tx<S>) => Promise<T>, opts?: SavepointOptions): Promise<NoHandleEscape<T>>
  savepoint<T>(fn: (tx: Tx<S>) => Promise<T>, opts?: SavepointOptions): Promise<NoHandleEscape<T>>

  /** Transaction-local GUCs via parameterised set_config(...,true). §3.5 */
  setLocal(name: string, value: string | number | boolean): Promise<void>
  setLocal(settings: Record<string, string | number | boolean>): Promise<void>

  /** Transaction-scoped advisory locks — the only kind safe behind a pooler. */
  advisoryLock(key: bigint | string, opts?: { try?: boolean; shared?: boolean }): Promise<boolean>

  /** Abort. Throws TransactionRollback, which `db.transaction` rethrows. */
  rollback(): never
  /** Abort but resolve the transaction with `value` — fully typed, no `| undefined`. §3.7 */
  rollbackWith<V>(value: V): V

  /** Live server-side transaction state (`pg` 8.21+ `getTransactionStatus()`), for assertions and diagnostics. */
  readonly status: 'idle' | 'active' | 'failed'
}

/** A pinned connection with no open transaction. */
export interface Session<S extends Schema> extends Queryable<S> {
  readonly kind: 'session'
  transaction<T>(fn: (tx: Tx<S>) => Promise<T>, opts?: TxOptions): Promise<NoHandleEscape<T>>
  /** Session-level GUCs. Throws ConfigError under a transaction-pooler mode. */
  set(name: string, value: string | number | boolean): Promise<void>
  /** Session-level advisory lock. Throws under a transaction-pooler mode; use tx.advisoryLock. */
  advisoryLock(key: bigint | string, opts?: { try?: boolean; shared?: boolean }): Promise<AdvisoryLock>
  readonly backendPid: number
}
```

`Db`, `Tx`, `Session` are mutually **non-assignable**: none is a subtype of the others. Only `Queryable` is shared. That is load-bearing (§1.5).

### 1.4 Why `Session` exists

Under `poolerMode: 'none' | 'session'`, a lot of legitimate work needs *the same backend* without wanting transaction semantics: a session advisory lock held across several transactions, a `CREATE TEMP TABLE` staging area, `SET search_path` for a legacy code path, `pg_backend_pid()`-based diagnostics, or a long `COPY` followed by an index build. Prisma has no equivalent and it is a recurring complaint; Drizzle has none. It costs us one type and ~40 lines, and it gives the pooler matrix a natural home: `Session` is precisely the handle that a transaction pooler cannot support, so `poolerMode` gates *one type* rather than being sprinkled through the codebase.

### 1.5 Preventing the outer-`db`-inside-`tx` footgun

Drizzle's #1 bug: `db.transaction(async (tx) => { await db.insert(...) })` silently runs outside the transaction, on a different connection, and can deadlock against its own transaction.

**Be honest about what TypeScript can and cannot do here.** TS has no effect system, no linear types, and no way to invalidate a binding captured from an enclosing scope. *No* type-level construct can make `db` unusable inside a closure. Anyone claiming otherwise is describing a lint rule. So we ship **four layers**, and are precise about which is which:

**Layer 1 — API shape makes shadowing the default (design, 90 % of real cases).**
Our documentation, examples, snippets, and the parameter name in every overload call the transaction handle `db`, not `tx`:

```ts
await db.transaction(async (db) => { await db.insert(orders).values(...) })
//                          ^^ shadows the module-level / outer `db`
```

Drizzle named it `tx`, which *guarantees* the dangerous binding stays in scope. Naming it `db` makes the correct thing the path of least resistance and makes the mistake require deliberate effort. This is the cheapest, highest-yield fix available and it is purely a naming decision.

**Layer 2 — the enforceable half, at the type level (real, and Drizzle lacks it).**
TS *can* prevent the converse errors, and we use it:

```ts
// (a) "this function must run in a transaction" is statically enforced,
//     because Db is not assignable to Tx.
async function debit(tx: Tx<S>, id: Uuid, amount: bigint) { ... }
debit(db, ...)          // ✗ Type 'Db<S>' is not assignable to 'Tx<S>'. kind: 'db' vs 'tx'.

// (b) helpers that genuinely work either way opt in explicitly.
async function findUser(q: Queryable<S>, id: Uuid) { ... }   // ✓ takes db, tx or session

// (c) a handle cannot escape its scope through the return value.
type NoHandleEscape<T> =
  T extends { readonly kind: 'tx' | 'session' }
    ? ['Error: a Tx/Session handle escaped its callback. It is closed and unusable.', never]
    : T
```

`(a)` alone kills a large class of real bugs and is free. `(c)` is a shallow check (one conditional, no recursion) so it costs nothing in instantiation budget — deliberately not a deep walk, per risk #1 in `SUMMARY.md`.

**Layer 3 — runtime guard via opt-in AsyncLocalStorage (catches the residual 10 %).**
This is where ALS earns its place — and *only* here.

```ts
// enabled by default when NODE_ENV !== 'production'
createDb({ devGuard: true })

await db.transaction(async (tx) => {
  await db.select(users)     // ✗ throws HandleMisuseError at runtime, with both call sites
})
```

Implementation: `node:async_hooks`' `AsyncLocalStorage` (a core module — no dependency) holds a stack of open transaction ids for the current async context. Before executing on the **root** `Db` handle, if the store is non-empty we throw `HandleMisuseError` naming the enclosing transaction, its open statement, and (with call-site capture on, §7.4) both stack frames. False positives are possible and legitimate — deliberately running an out-of-band query during a transaction (an audit log that must survive a rollback) — so there is an explicit opt-out per call: `db.select(...).outsideTransaction()`.

**Layer 4 — `@pg-orm-ts/eslint-plugin` (separate optional package).**
`no-outer-handle-in-transaction`: inside a `transaction`/`session` callback, flag any identifier reference that resolves to a binding declared *outside* the callback and whose type is `Db`/`Session`. Scope analysis is exactly what a linter does well and what a type system cannot do at all. This is the only *static* mechanism that catches capture; it is deliberately not in core (core stays zero-dep).

### 1.6 AsyncLocalStorage: the v1 decision

**Ship ALS in v1, opt-in, for exactly one purpose: the dev-mode misuse guard. Do not ship ambient context resolution — no `getDb()`, no `RequestContext`, no `@Transactional`.**

Rationale:
- `SUMMARY.md` §4 and `mikroorm.md` §1.3 are unambiguous: ambient EM + ALS is the single largest source of MikroORM's conceptual overhead, needs `@CreateRequestContext`/`@EnsureRequestContext` epicycles for every non-HTTP entrypoint, and the docs themselves warn that a global handle without a context "leads to weird bugs".
- The overhead argument cuts both ways and I will not overstate it: `AsyncLocalStorage` in modern Node is much cheaper than it was, but it is not free, and it is *unbounded* in pathological cases (deep promise chains). Keeping it off the production hot path by default means we never have to defend a number.
- We leave a documented, unsupported-for-building-on hook — `experimental_asyncContext()` — so framework integrators (Next.js middleware, NestJS request scoping) can build ambient wrappers *in userland* if they want them. We will not build APIs on top of it and will not treat its behaviour as semver-stable.

---

## 2. Query execution modes

### 2.1 The modes

pgx-style, but PG-only and cut down to what actually differs on the wire for a `pg`-backed client.

```ts
export type ExecMode =
  /** DEFAULT. Unnamed extended protocol. Parse+Bind+Describe('P')+Execute+Sync in ONE write,
   *  ONE round trip, parameter types inferred client-side. Zero server session state.
   *  Safe on every pooler in §5, including Supavisor and pgpool-II, and on RDS Proxy without pinning. */
  | 'unnamedExtended'

  /** Same wire shape, plus a process-wide cache of the statement *description*
   *  (param OIDs + result field OIDs/typmods/nullability). Does NOT save a round trip on `pg`
   *  (see §2.2) — it saves decode-plan construction and unlocks binary result formats. */
  | 'cachedDescribe'

  /** Named server-side prepared statements, per-physical-connection LRU, self-healing (§2.4).
   *  Opt-in. Saves a server-side parse+plan, not a round trip. */
  | 'prepared'

  /** Simple query protocol. No bind parameters at all — the query must be fully literal.
   *  Only for proxies that cannot speak the extended protocol, and for our own multi-statement
   *  DDL batches in the migrator. Never reachable from the query builder with user values. */
  | 'simple'
```

Mapping to pgx, for readers who know it:

| pgx mode | ours | note |
|---|---|---|
| `CacheStatement` (pgx default) | `prepared` | **We do not default to this.** Pooler-hostile, and on `pg` the win is a parse, not an RTT. |
| `CacheDescribe` | `cachedDescribe` | Same idea; different payoff on `pg` (§2.2). |
| `DescribeExec` | — | **Not offered.** pgx needs it because Go's path `Sync`s between Parse and Bind; `pg` describes the *portal* instead and never needs `ParameterDescription`. This mode is the one pgx itself warns is pooler-unsafe. |
| `Exec` | `unnamedExtended` | pgx's client-side-inferred-types mode. This is `pg`'s native behaviour, so it and `DescribeExec` collapse into one mode for us. |
| `SimpleProtocol` | `simple` | Same. |

### 2.2 Why the default is `unnamedExtended`, and what `cachedDescribe` actually buys

The default follows §5.7 #1 directly: one round trip, zero session state, correct on *every* pooler. Because `pg` corks the whole extended-protocol exchange into one write, **the pooler-safe mode is also the fastest mode** — there is no performance sacrifice to justify, which is why we can make it the default without an escape hatch being commonly needed.

`cachedDescribe` deserves a correction to the naive reading of §5.7 #2. On pgx, caching the description saves a round trip because pgx's alternative `Sync`s. On `pg` it does **not** save a round trip — `Describe('P')` rides in the same buffer. What it saves is:

1. **Decode-plan construction per result.** Given `(sql, paramOidSignature) → fieldOids/typmods`, we can precompute the column-by-column decode plan once (which codec, which typmod, which nullability) instead of rebuilding it from `RowDescription` on every execution. On a small-result hot query this is a measurable slice of ORM overhead.
2. **Binary result formats.** `Bind` must declare the result format codes *before* the server sends `RowDescription`. You cannot request binary for `int8`/`timestamptz`/`float8` unless you already know the result OIDs — i.e. unless you cached the description. `research/pg-drivers.md` §7.5 wants binary on for the hot numeric/temporal subset; **`cachedDescribe` is the precondition for that**, and that is its real justification.

**v1 decision:** ship `cachedDescribe` as opt-in with the description cache implemented and correct, but keep binary result formats behind a further flag until agent 05's codec table has verified binary decoders for the subset. Default stays `unnamedExtended`. Promote `cachedDescribe` to default in v1.1 once binary decode is proven — it is a pure win with no pooler implications, since the wire shape is identical.

Invalidation for both caches is identical and is the same set as the prepared-statement cache: `0A000` (`cached plan must not change result type`), `42P18` (`indeterminate_datatype`), `42804` (`datatype_mismatch`). Plus a proactive flush when our own migrator runs in-process (§5.5).

### 2.3 Per-db and per-query override

```ts
// per-db
createDb({ execMode: 'prepared' })

// per-query, on any builder
await db.select(users).where(...).withExecMode('prepared')
await db.sql`select 1`.withExecMode('simple')

// per-call on a compiled query
await db.run(compiled, { execMode: 'prepared' })
```

Precedence: **per-query > per-db > pooler-profile floor**. The pooler profile can only *restrict*, never expand: under `poolerMode: 'transaction'` (Supavisor), `withExecMode('prepared')` throws `ConfigError` at call time, and `execMode: 'prepared'` in `createDb` throws at construction time with a message naming the profile and pointing at the compatibility doc. Restriction is loud and immediate — we never silently downgrade a mode the user explicitly asked for, because a silent downgrade is how Prisma #21799 happened.

### 2.4 Prepared-statement cache design (`execMode: 'prepared'`)

```ts
export interface PreparedStatementOptions {
  /** Max named statements per *physical connection*. Default 100 — deliberately under
   *  PgBouncer's per-server-connection default of 200, since PgBouncer shares one server
   *  connection across clients and its own LRU is the real ceiling. */
  maxPerConnection?: number
  /** Consecutive self-heal events before this pool permanently downgrades to
   *  'unnamedExtended' and logs at error level. Default 3. */
  downgradeAfterFailures?: number
  /** Statement name prefix. Default 'pg-prime'. Names are `${prefix}_${fnv1a(sql)}_${seq}`. */
  prefix?: string
}
```

**Keying.** The cache key is `hash(sql text) + ':' + paramOidSignature`. Both components are required: the same SQL text with different inferred parameter types is a genuinely different statement, and keying on text alone is how you get `42804 datatype_mismatch` on the second call. The key is scoped **per physical connection**, never process-wide, because a named statement lives on a backend, not in our process. Cache state travels with the connection object and is discarded when the connection is destroyed.

**Naming.** `pgprime_<hash>_<seq>`. Deterministic per SQL text so logs and `pg_prepared_statements` are readable; the `seq` disambiguates hash collisions and re-prepares after eviction.

**Eviction.** LRU at `maxPerConnection`. Evicting sends the **protocol `Close` message** (`'C'`,`'S'`,name) — **never SQL `DEALLOCATE <name>`**. This is not a stylistic preference: SQL `DEALLOCATE` with a client-chosen name is exactly what breaks PHP/PDO against PgBouncer (§5.2), because the name PgBouncer gave the server is `PGBOUNCER_{id}`, not ours. Protocol `Close` is rewritten in flight by the pooler; SQL `DEALLOCATE` is forwarded verbatim and fails. If agent 02's seam cannot express a protocol `Close` on `pg`, the fallback is **evict-by-forgetting** (drop the map entry, let the server-side statement leak until the connection recycles at `maxLifetimeSeconds`) — still strictly better than emitting `DEALLOCATE`. Never `DEALLOCATE ALL` / `DISCARD ALL`.

**Auto-re-prepare policy (self-healing).** `pg` has no statement cache and no retry (§5.5) — recovery is entirely ours. postgres.js's routine-based retry (§2.4) is the model, improved with a circuit breaker:

```ts
const SELF_HEAL: Record<string, 'reprepare' | 'invalidate-and-reprepare'> = {
  '26000': 'reprepare',                 // invalid_sql_statement_name — pooler lost our statement
  '42P05': 'reprepare',                 // duplicate_prepared_statement — our map is stale
  '0A000': 'invalidate-and-reprepare',  // cached plan must not change result type (post-DDL)
  '42P18': 'invalidate-and-reprepare',  // indeterminate_datatype
  '42804': 'invalidate-and-reprepare',  // datatype_mismatch
}
```

Policy, precisely:

1. Retry **at most once** per statement execution, and **only if no rows have been delivered to the caller yet** — never mid-stream.
2. Retry only when the connection is **not** in a failed transaction (`25P02`). Inside a transaction a `0A000` has already aborted it; the correct action is to surface the error and let §3.4's retry policy decide, not to re-issue a statement into an aborted transaction.
3. On `0A000`, also flush the **description/decode-plan cache** process-wide for that SQL key — the result *type* changed, so every cached plan for it is wrong, on every connection.
4. Count self-heals per pool. After `downgradeAfterFailures` (default 3) consecutive events, **permanently downgrade the pool to `unnamedExtended`** and log at `error` with the SQLSTATE, the statement, and a pointer to the pooler doc. Rationale: repeated self-healing means our model of the environment is wrong (a pooler that clears tracking, an app doing DDL in a loop). Degrading to the always-correct mode and shouting is better than an invisible retry tax. A downgrade is a one-way door for the process lifetime; it is reported by `db.diagnose()`.
5. `0A000` after a *known* local migration run is handled proactively, not reactively — see §5.5.

**Interplay with `.prepare()` from the query builder.** Drizzle conflates two very different things under one name. We separate them:

| Call | What it does | Pooler impact | When |
|---|---|---|---|
| `q.compile()` → `CompiledQuery<T>` | **Client-side only.** Freezes SQL text, parameter plan and decode plan. Nothing touches the server. | None — always safe. | The recommended optimisation for hot paths. Removes builder + compile cost from every execution. |
| `q.prepare()` → `PreparedQuery<T>` | `compile()` **plus** pins `execMode: 'prepared'` for this query. | Requires a profile that allows named statements. | Only when you have measured that server-side parse/plan time matters. |

```ts
const byEmail = db.select(users).where(eq(users.email, ph('email'))).compile()
await db.run(byEmail, { params: { email: 'a@b.c' } })     // safe everywhere, no server state

const hot = db.select(users).where(eq(users.id, ph('id'))).prepare()
await hot.execute({ id })                                  // named statement + LRU + self-heal
```

`prepare()` throws `ConfigError` at *construction* time if the configured `poolerMode` forbids named statements. `compile()` never throws.

> **AS BUILT (design/09 WS6, §3.6).** Four corrections, three of them measured.
>
> **1. `prepare()` does NOT pin named mode.** The table above says `q.prepare()` "pins
> `execMode: 'prepared'` for this query"; `03` §1.4 says the opposite in one sentence —
> *`.prepare()` caches our work; `{ statement: 'named' }` caches Postgres's* — and `03`/`09` win.
> `.prepare()` is client-side only and is safe on every pooler; the server-side statement is a
> separate opt-in, `pgPrime({ statement: 'named' })` per db or `.prepare(name, { statement:
> 'named' })` per query. Conflating them is Drizzle's mistake and this table had half-adopted it.
> There is no `poolerMode` yet, so nothing throws at construction; the pooler profile is the
> session layer's, which has no workstream in `09`.
>
> **2. The cache key is `conn.serverParameters`, not the `PgConnection`.** This section says the
> key is scoped "per physical connection", and the `PgConnection` object is not that: the `pg`
> adapter builds a fresh `PgConnectionImpl` on every `acquire()`. Measured on PG 17.11 — five
> pooled executions of one prepared query minted **five** names and left five statements on the
> backend, i.e. the feature saved nothing and leaked. `serverParameters` is the object the adapter
> caches per underlying client, so it is one per physical connection for exactly that connection's
> lifetime. Pinned by `test/pg/executor.test.ts`.
>
> **3. Policy 2 is "only when the session is IDLE", not "not in a *failed* transaction".** The
> latter cannot be implemented over `pg`: the error callback fires **before** the `ReadyForQuery`
> that carries the new status, so a guard reading `transactionStatus === 'E'` still sees `'T'` and
> lets the retry through — which then gets `25P02`. Measured: the tier-2 case flipped between
> surfacing `26000` and surfacing `25P02` run to run. Requiring `'I'` is race-free and wants the
> same thing: inside a block the failing statement has already aborted it, so every retry there is
> a `25P02` waiting to happen.
>
> **4. `DEALLOCATE ALL` through a prepared-statement-tracking PgBouncer is FATAL `08P01`**, not
> `26000`, and no self-heal can recover it because the *session* is gone rather than the
> statement. Measured against PgBouncer 1.25.2, `pool_mode=transaction`,
> `max_prepared_statements=200`. That is the strongest possible argument for this section's ban on
> emitting it, which the implementation obeys: eviction is the protocol `Close`, and
> `test/pg/executor.test.ts` proves the evicted name really leaves `pg_prepared_statements`.
>
> Shipped from this section: the LRU at `maxPerConnection` (default 100), the protocol-`Close`
> eviction with evict-by-forgetting as the fallback when an adapter has no `closeStatement`, the
> `pgprime_<fnv1a(sql)>_<seq>` naming with its 63-byte check, the five-SQLSTATE self-heal table,
> the once-per-execution bound, the process-wide description-cache flush on `0A000`/`42P18`/`42804`
> (which fires for **unnamed** statements too — the result type changed, not the statement), and
> the `downgradeAfterFailures` circuit breaker as a one-way door with an `error`-level log.
> Not shipped: `execMode` as a four-member type (the builder reaches two of them, and `simple` is
> the migrator's), `cachedDescribe` as a mode (see `03` §1.4c AS BUILT), and §5.5's proactive flush
> after a local migration run.

### 2.5 Row mode and result shape

Internally always `rowMode: 'array'` — three independent implementations (Prisma, Drizzle, and `pg-drivers.md` §7.5) converged on it for the same two reasons: no per-row object allocation, and correct handling of duplicate column names from JOINs (`users.id` and `posts.id` both key `id` in object mode and silently clobber). Users never see array rows; the projection layer (agent 04) maps positionally using the field metadata that agent 02's `PgResult.fields` guarantees.

---

## 3. Transactions

### 3.1 API

```ts
export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable'
export type AccessMode = 'read write' | 'read only'

interface TxOptionsBase {
  retry?: RetryPolicy | boolean
  /** SET LOCAL statement_timeout for the whole transaction. */
  timeoutMs?: number
  /** SET LOCAL lock_timeout. */
  lockTimeoutMs?: number
  /** Transaction-local GUCs applied immediately after BEGIN, in one round trip. §3.5 */
  localSettings?: Record<string, string | number | boolean>
  signal?: AbortSignal
  /** Free-form label; appears in hooks, spans, slow-query logs and retry warnings. */
  label?: string
}

/** `DEFERRABLE` is only meaningful with SERIALIZABLE + READ ONLY. Enforced by the type,
 *  not by a runtime check — PG accepts and silently ignores it otherwise, which is worse. */
export type TxOptions =
  | (TxOptionsBase & { isolation?: 'read committed' | 'repeatable read'
                     ; accessMode?: AccessMode; deferrable?: never })
  | (TxOptionsBase & { isolation: 'serializable'
                     ; accessMode?: 'read write'; deferrable?: never })
  | (TxOptionsBase & { isolation: 'serializable'
                     ; accessMode: 'read only';  deferrable?: boolean })
```

`read uncommitted` is **not offered**. PostgreSQL accepts the keyword and silently gives you `read committed`. Exposing an option that does nothing is a lie we can afford not to tell, and being PG-only is exactly the licence to not tell it.

**Emission.** One statement, one round trip, no separate `SET TRANSACTION`:

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE
```

`COMMIT` / `ROLLBACK` likewise. Nothing else is emitted unless the user asked for it — in particular we never probe, never `SELECT 1`, and never emit a reset query.

**Connection lifecycle.** `transaction()` acquires one pool connection for the whole callback and releases it in a `finally`. If the callback throws, we `ROLLBACK`; if `ROLLBACK` itself fails (connection already dead), we **destroy** the connection rather than returning a possibly-in-transaction connection to the pool. `pg` 8.21's `getTransactionStatus()` is asserted before release: a connection returning to the pool in state `T` or `E` is a bug, and we destroy it and log at `error`.

### 3.2 Concurrency footgun, made loud

`Promise.all` inside a transaction is *serial*, because there is one connection (Prisma's documented surprise, `prisma.md` §3.3). We cannot make it parallel — that is the protocol. We can make it visible: in dev-guard mode, if two statements are issued on the same `Tx` while one is in flight, we log a `warn` once per transaction: *"N statements were issued concurrently on one transaction handle; they execute serially. Use separate transactions, or `db.session()` + explicit ordering, if you need parallelism."* No error — the code is correct, just not doing what it looks like.

### 3.3 Savepoint nesting

`tx.transaction(fn)` and its alias `tx.savepoint(fn)` emit:

```sql
SAVEPOINT "pgprime_sp_1"        -- depth-derived, deterministic, always identifier-quoted
RELEASE SAVEPOINT "pgprime_sp_1"          -- on success
ROLLBACK TO SAVEPOINT "pgprime_sp_1"      -- on throw, then rethrow
```

Names are depth-derived rather than random because nesting is lexical, the names appear in logs and `EXPLAIN` output, and determinism makes tests readable. They are always identifier-quoted regardless.

**Options are absent by construction.** `SavepointOptions` has no `isolation`, `accessMode` or `deferrable` — PostgreSQL cannot change those mid-transaction, and Drizzle/MikroORM both accept them on nested calls where they are silently ignored. Making them non-existent in the type is free and strictly better than a runtime error.

```ts
export interface SavepointOptions {
  timeoutMs?: number; lockTimeoutMs?: number
  localSettings?: Record<string, string | number | boolean>
  label?: string
  // no isolation, no accessMode, no deferrable, no retry — see below
}
```

**`retry` is also absent on savepoints.** A `40001` aborts the *whole* transaction, not just the savepoint; retrying at savepoint level is meaningless and dangerous. Retry lives only on the outermost `transaction()`.

**The actual value of savepoints — say it in the docs.** After any statement error PG puts the transaction in the aborted state and every subsequent statement fails with `25P02 in_failed_sql_transaction`. A savepoint is the *only* way to attempt something that may fail (a speculative insert, a constraint probe) and continue:

```ts
await db.transaction(async (db) => {
  await db.insert(audit).values(...)
  try {
    await db.savepoint(async (db) => { await db.insert(users).values(maybeDuplicate) })
  } catch (e) {
    if (e instanceof UniqueViolationError) { /* outer tx still usable */ }
    else throw e
  }
  await db.insert(events).values(...)   // works — savepoint rollback un-aborted the tx
})
```

Without the savepoint, that last insert fails with `25P02`. We surface `InFailedTransactionError` with a hint saying exactly this, naming the earlier error that poisoned the transaction (we retain it on the `Tx`).

### 3.4 Automatic retry — the decision

**Decision: retry is ON by default for `40001 serialization_failure`, and only when the transaction was opened at `repeatable read` or `serializable`. Retry is OFF by default for `40P01 deadlock_detected` at every level. `read committed` transactions are not retried at all by default.**

Reasoning:

- Offering `isolation: 'serializable'` without retry is, in `drizzle.md`'s words, *"handing users a loaded gun"* — PostgreSQL's own documentation states that applications using SERIALIZABLE **must** be prepared to retry. Every ORM surveyed offers the isolation level and none ships the retry. This is a cheap, real differentiator (`drizzle.md` §7: *"PORT as differentiator"*).
- `40001` is impossible at `read committed`, so defaulting retry on there would be pure ceremony. Scoping the default to the levels where the error is *expected* means the default never fires for code that didn't opt into an isolation level.
- `40P01` is almost always a **lock-ordering bug in the application**. Silent retry converts a loud, fixable, reproducible bug into an intermittent latency spike and a mystery. We do not retry it by default; we throw `DeadlockDetectedError` carrying PG's `detail` (which names both processes and both relations) and a hint pointing at lock ordering. Opt in with `retry: { on: ['40001', '40P01'] }` when you genuinely have an unavoidable deadlock (multi-row upserts in unordered batches).

```ts
export interface RetryPolicy {
  /** Default: ['40001'] at repeatable read / serializable; [] at read committed. */
  on?: readonly SqlState[]
  maxAttempts?: number        // default 5 (i.e. up to 4 retries)
  baseDelayMs?: number        // default 25
  maxDelayMs?: number         // default 1_000
  /** 'full' (default) = sleep(random(0, min(maxDelay, base * 2**(attempt-1)))). */
  jitter?: 'full' | 'equal' | 'none'
  /** Last word: return false to stop retrying. Sees the typed error and the attempt number. */
  shouldRetry?(err: PgPrimeError, attempt: number): boolean
  onRetry?(info: { err: PgPrimeError; attempt: number; delayMs: number; label?: string }): void
}
```

Full jitter (rather than plain exponential) because serialization failures are *inherently correlated* — the conflicting transactions failed at the same instant and would otherwise retry in lockstep, reproducing the conflict. Worst-case added latency at the defaults is under ~1.4 s across four retries.

**Hard exclusions — never retried, regardless of `on`:**

1. **`IndeterminateCommitError`.** If the connection dies after we write `COMMIT` but before we read the response, **the transaction may have committed**. Retrying is a correctness bug, not a latency tradeoff — it is how you double-charge a credit card. This gets its own error class (§4.2), is never retried, and its message says exactly this. To my knowledge no TS ORM distinguishes this case; every one of them classifies it as a generic connection error. This is the single most important correctness decision in this section.
2. **Aborted `signal`.** If the caller's `AbortSignal` fired, retrying contradicts the caller.
3. **Anything after a streamed result has been partially delivered** to the caller (§6.3) — the consumer has already seen rows.
4. **Non-`PgPrimeError` throws from the callback** unless `shouldRetry` explicitly says otherwise. A `TypeError` in user code is not a transient database condition.

**Idempotency warning — structural, not just documentary.** Retry re-runs the *callback*, so every non-database side effect in it runs again: the Stripe charge, the S3 upload, the email, the counter increment on a Redis key. Mitigations we actually ship:

- `tx.attempt` is on the handle, so guarding is a one-liner: `if (tx.attempt === 1) await sendEmail()`. Better still, the doc pattern is *return* the side effects and perform them after the transaction resolves.
- The first retry logs at `warn` with the label, SQLSTATE and attempt count, so retries are visible in production rather than silent.
- `onRetry` is a first-class hook, wired into `QueryHooks` (§7.1) and into the span as an event.
- The doc section is titled "Your transaction callback must be idempotent" and appears immediately under the retry API, not in an appendix.

### 3.5 `SET LOCAL` — and how we make it injection-safe

`SET LOCAL` cannot take bind parameters. `set_config(name, value, is_local => true)` is the transaction-local equivalent **and it is an ordinary function call, so it can**. That single fact is the whole implementation:

```ts
// tx.setLocal('app.tenant_id', tenantId)
SELECT set_config($1, $2, true)

// tx.setLocal({ 'app.tenant_id': t, 'app.user_id': u, statement_timeout: '5s' })
SELECT set_config($1,$2,true), set_config($3,$4,true), set_config($5,$6,true)   -- one round trip
```

No identifier quoting, no escaping, no injection surface — which matters enormously because the values here are tenant ids and user ids, i.e. exactly the security boundary. This directly closes Prisma's #5128 (78 comments, no supported way to `SET LOCAL` for a request) and makes **RLS a first-class, one-line pattern**:

```ts
await db.transaction(async (db) => {
  const rows = await db.select(documents)      // RLS policies see app.tenant_id
  ...
}, { localSettings: { 'app.tenant_id': tenantId }, label: 'tenant-read' })
```

`localSettings` in `TxOptions` is applied in the statement immediately after `BEGIN` (one extra round trip; zero extra round trips with `pipeline: true`). This is deliberately not folded into the `BEGIN` via string concatenation — that would reintroduce the injection surface for the sake of one RTT.

Non-GUC-name inputs are validated against `^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$` before being sent, purely as a defence-in-depth typo catcher — `set_config` itself will reject garbage safely.

`Session.set()` is the session-scoped sibling (`set_config($1,$2,false)`) and throws `ConfigError` under transaction-pooler profiles.

### 3.6 Timeout policy: `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`

```ts
export interface SessionDefaults {
  applicationName?: string                       // default 'pg-orm-ts'
  statementTimeout?: Duration | null             // default '30s'
  lockTimeout?: Duration | null                  // default null
  idleInTransactionSessionTimeout?: Duration | null  // default '60s'
  searchPath?: readonly string[]                 // default: server's
  timeZone?: string                              // default 'UTC' — see below
}
```

| GUC | Default | Rationale |
|---|---|---|
| `application_name` | `'pg-orm-ts'` (override per-app) | Free, and it is the difference between a readable and an unreadable `pg_stat_activity` during an incident. Nobody ships this by default; everybody wishes they had it at 3 a.m. |
| `statement_timeout` | **`30s`** | Unbounded is how an app hangs forever holding a connection. 30 s is generous enough that no normal OLTP query trips it, tight enough to bound the blast radius. Explicitly *not* Prisma's 5 s, which `prisma.md` records as *"a recurring production surprise"*. Set to `null` to disable. Overridable per statement and per transaction. Streaming (§6.3) and COPY (§6.6) default to `null` for their duration. |
| `lock_timeout` | **`null` (unset)** for app queries | A default here breaks legitimate queuing behaviour, and PG's own default is unset. The **migrator** is the opposite case and sets `lock_timeout` aggressively (agent 06's call; the runtime provides the mechanism). |
| `idle_in_transaction_session_timeout` | **`60s`** | The classic leak: an `await` inside a transaction callback hangs on an HTTP call, and the transaction holds locks and blocks `VACUUM` indefinitely. Because `db.transaction` always commits or rolls back in a `finally`, our own code cannot leak — but user code awaiting the network inside a callback can. 60 s bounds it. Note it terminates the *session*, which is aggressive; it is opt-out-able and the doc says so. |
| `TimeZone` | **`UTC`** | Our codecs (agent 05) decode `timestamptz` to an absolute instant and never rely on the session zone, but `DateStyle`/`TimeZone` change the *text* representation we parse for several types. Pinning to UTC removes an entire class of environment-dependent bug. `DateStyle` is likewise pinned to `ISO, MDY`. |

**Mechanism, and its pooler dependency — this is the subtle part.**

- `poolerMode: 'none' | 'session'` → applied **once at connection setup**, via the `options` startup parameter (`options=-c statement_timeout=30s -c ...`), which `pg` passes through to the startup packet. Zero per-query cost. If the startup-parameter path proves unreliable for any setting at implementation time, the fallback is a single `SET` in `pg-pool`'s `onConnect` hook (8.20+) — also once per connection.
- `poolerMode: 'pgbouncer-transaction' | 'transaction'` → **we cannot do this.** `SET` at connect time lands on a *server* connection that PgBouncer will hand to another client, and transaction mode does not run `server_reset_query` by default, so the setting **leaks across tenants**. We therefore:
  1. do not emit session-level `SET` at all under these profiles;
  2. log a one-time `info` at startup naming the settings we could not apply;
  3. document the correct operational fix — `ALTER ROLE app_user SET statement_timeout = '30s'` (server-side, pooler-proof, survives everything);
  4. report the *observed* effective values from `db.diagnose()` so users can verify.

  This is a genuine capability gap, not a workaround we can paper over, and pretending otherwise is exactly the Prisma #21799 failure mode.

**Per-query and per-transaction timeouts** are always `SET LOCAL` (i.e. `set_config(..., true)`), which works in every mode because it is transaction-scoped. See §6.2 for the autocommit case, where there is no transaction to be local to.

### 3.7 Rollback ergonomics

Two exits, both fully typed:

```ts
// (a) abort as an error — the usual case
await db.transaction(async (db) => { if (bad) db.rollback() })  // throws TransactionRollback

// (b) abort but return a value — no `| undefined` polluting the call site
const result = await db.transaction(async (db) => {
  const ok = await tryReserve(db)
  if (!ok) return db.rollbackWith({ status: 'conflict' } as const)
  return { status: 'reserved', id } as const
})
// result: { status: 'conflict' } | { status: 'reserved'; id: Uuid }
```

`rollbackWith(v)` marks the transaction doomed, returns `v` with its exact type, and the runner issues `ROLLBACK` instead of `COMMIT` and resolves with the callback's return value. Any further statement on a doomed handle throws `TransactionAbandonedError`.

We reject Drizzle's design (`tx.rollback()` throws, and the promise silently resolves) because it makes the rollback path and the success path indistinguishable at the type level — the caller cannot tell whether their work happened.

### 3.8 Explicitly rejected

- **Flush modes** (`AUTO`/`COMMIT`/`ALWAYS`) — no Unit of Work, nothing to flush. There is no write buffer; statements execute when awaited.
- **Spring-style propagation modes** (`REQUIRED`, `REQUIRES_NEW`, `MANDATORY`, `SUPPORTS`, `NOT_SUPPORTED`, `NEVER`, `NESTED`) — `mikroorm.md` §7: *"Enterprise-Java cosplay"*. Our three handle types already express the whole useful space statically: a function that requires a transaction takes `Tx` (= `MANDATORY`, checked by the compiler); one that doesn't care takes `Queryable` (= `SUPPORTS`); `db.transaction` inside a `Tx` is a savepoint (= `NESTED`); a genuinely independent transaction is `rootDb.transaction(...)` (= `REQUIRES_NEW`) and is the *only* legitimate use of the outer handle inside a callback, which is why §1.5's guard has an explicit opt-out. `NOT_SUPPORTED` and `NEVER` earn nothing.
- **Sequential array transactions** (`$transaction([q1, q2])`) — strictly less capable than the callback (cannot pass a generated id between steps, per `prisma.md` §3.3) and a second API to document, test and type.
- **A transaction *runtime* timeout** (Prisma's `timeout: 5000`). We time out *statements* and idle-in-transaction, not wall-clock transaction duration. A legitimate backfill inside a transaction that is actively executing statements should not be killed for taking 90 seconds; Prisma's `P2028` on exactly that case is the documented anti-pattern. Users who want a wall-clock bound pass a `signal` from `AbortSignal.timeout(ms)`.

---

## 4. Error taxonomy

### 4.1 Design rules

1. **One base class, `PgPrimeError`.** `instanceof PgPrimeError` reliably answers "did this come from the database layer".
2. **Branch on SQLSTATE *class*, leaf on SQLSTATE.** Users can catch broadly (`IntegrityConstraintError`) or narrowly (`UniqueViolationError`) without a lookup table.
3. **Unmodelled SQLSTATEs never lose information.** They land on the nearest class ancestor, or `UnknownQueryError`, always carrying the raw `code`. Adding a leaf class later is not a breaking change.
4. **Every error carries structured fields, not just a message.** Nobody should ever parse our message text; if they need to, we have failed.
5. **Errors are safe to log by default.** Redaction defaults are conservative (§4.3) — an error object should be shippable to Sentry without a review.
6. **`cause` is always set** (ES2022) to the underlying driver error, so nothing is lost.

### 4.2 The hierarchy

```
PgPrimeError                                  abstract; { message, code?, cause?, callSite? }
├── QueryError                              the server rejected a statement (has a SQLSTATE)
│   ├── IntegrityConstraintError            class 23
│   │   ├── NotNullViolationError           23502
│   │   ├── ForeignKeyViolationError        23503
│   │   ├── UniqueViolationError            23505
│   │   ├── CheckViolationError             23514
│   │   ├── ExclusionViolationError         23P01
│   │   └── RestrictViolationError          23001
│   ├── TransactionError
│   │   ├── SerializationFailureError       40001   ← retried by default at RR/SER (§3.4)
│   │   ├── DeadlockDetectedError           40P01   ← NOT retried by default
│   │   ├── InFailedTransactionError        25P02   ← carries the poisoning error (§3.3)
│   │   ├── IdleInTransactionTimeoutError   25P03
│   │   └── ReadOnlySqlTransactionError     25006
│   ├── DataError                           class 22
│   │   ├── NumericValueOutOfRangeError     22003
│   │   ├── InvalidTextRepresentationError  22P02
│   │   ├── StringDataRightTruncationError  22001
│   │   ├── DivisionByZeroError             22012
│   │   └── InvalidDatetimeFormatError      22007
│   ├── AccessError
│   │   ├── InsufficientPrivilegeError      42501   ← the RLS "0 rows" vs "denied" boundary
│   │   └── InvalidPasswordError            28P01, 28000  (also reachable pre-connect → see ConnectionError)
│   ├── SchemaError                         class 42 (other)
│   │   ├── UndefinedTableError             42P01
│   │   ├── UndefinedColumnError            42703
│   │   ├── UndefinedFunctionError          42883
│   │   ├── DuplicateTableError             42P07
│   │   └── SyntaxError                     42601
│   ├── PreparedStatementError
│   │   ├── InvalidStatementNameError       26000   ← self-heal (§2.4)
│   │   └── DuplicateStatementError         42P05   ← self-heal
│   ├── CachedPlanChangedError              0A000   ← self-heal + cache flush; also the PgBouncer-after-DDL case
│   ├── LockNotAvailableError               55P03   (NOWAIT / lock_timeout)
│   ├── QueryCanceledError                  57014   ← statement_timeout OR our CancelRequest landed
│   ├── InsufficientResourcesError          class 53
│   │   ├── TooManyConnectionsError         53300
│   │   ├── OutOfMemoryError                53200
│   │   └── DiskFullError                   53100
│   ├── OperatorInterventionError           class 57 (other) — 57P01 admin_shutdown, 57P03 cannot_connect_now
│   └── UnknownQueryError                   any SQLSTATE we do not model
├── ConnectionError                         we could not get bytes to/from a backend
│   ├── ConnectionRefusedError              ECONNREFUSED / ENOTFOUND / EHOSTUNREACH
│   ├── ConnectionTimeoutError              TCP or TLS handshake timed out
│   ├── TlsError                            cert/SNI/protocol failures
│   ├── AuthenticationError                 SCRAM/MD5 failure, 28P01 during startup
│   ├── ConnectionTerminatedError           ECONNRESET / 08006 / 57P01 mid-query
│   └── PoolTimeoutError                    client-side: connectionTimeoutMillis elapsed; carries PoolStats
├── IndeterminateCommitError                COMMIT written, no acknowledgement. NEVER auto-retried. §3.4
├── TimeoutError
│   ├── QueryTimeoutError                   our client-side timer fired (§6.2)
│   └── TransactionTimeoutError             a `signal` from AbortSignal.timeout fired
├── AbortError                              caller's AbortSignal fired
├── UsageError                              programmer error — our fault or yours, not the database's
│   ├── HandleMisuseError                   outer db used inside a tx (§1.5, devGuard)
│   ├── TransactionClosedError              handle used after its callback returned
│   ├── TransactionAbandonedError           handle used after rollbackWith()
│   ├── DbClosedError                       query after db.end()
│   ├── TooManyParametersError              > 65534 bind parameters (§6.6)
│   └── UnsupportedInPoolerModeError        LISTEN / session lock / prepared under a tx pooler
└── ConfigError                             invalid createDb config; thrown eagerly at construction
```

**Top-level branches, for the summary: `QueryError` · `ConnectionError` · `TimeoutError`/`AbortError` · `UsageError` · `ConfigError`, plus the deliberately-standalone `IndeterminateCommitError`.**

`IndeterminateCommitError` is standalone rather than a `ConnectionError` subclass **on purpose**: if it inherited from `ConnectionError`, every existing `catch (e) { if (e instanceof ConnectionError) retry() }` in the wild would silently do the wrong thing. Making it a sibling forces a deliberate decision.

### 4.3 Fields and the redaction policy

```ts
export abstract class PgPrimeError extends Error {
  readonly code?: string                       // SQLSTATE, when the server gave one
  readonly cause?: unknown                     // always the underlying driver error
  /** Captured at query start, so you get the real call site instead of a useless async stack. §7.4 */
  readonly callSite?: string
  readonly context: { label?: string; attempt?: number; durationMs?: number; handle: 'db'|'tx'|'session' }
  /** Stable programmatic discriminator, independent of class identity across bundlers/dual-package. */
  readonly name: string
}

export class QueryError extends PgPrimeError {
  readonly code: string                        // '23505'
  readonly sqlStateClass: string               // '23'
  readonly severity: 'ERROR' | 'FATAL' | 'PANIC'

  // PG ErrorResponse fields, verbatim and unredacted (none of these contain user values)
  readonly schemaName?: string
  readonly tableName?: string
  readonly columnName?: string
  readonly dataTypeName?: string
  readonly constraintName?: string
  readonly hint?: string
  readonly position?: number
  readonly internalPosition?: number
  readonly where?: string
  readonly routine?: string                    // e.g. 'FetchPreparedStatement' — drives self-heal
  readonly file?: string
  readonly line?: string

  // ── redaction-governed ──
  /** SQL text. Included by default (§ below). */
  readonly sql?: string
  /** Bind parameter values. `undefined` unless errors.includeParams. */
  readonly params?: readonly unknown[]
  readonly paramCount: number
  /** Parameter OIDs — always present, always safe. */
  readonly paramTypes?: readonly number[]
  /** PG's DETAIL. Redacted by default — it leaks user values (§ below). */
  readonly detail?: string
  readonly detailRedacted: boolean
}

export interface ErrorOptions {   // the `errors` key of DbConfig
  includeSql?: boolean          // default true
  maxSqlLength?: number         // default 4096, then elided with a marker
  includeParams?: boolean       // default false
  includeDetail?: boolean       // default false
  captureCallSite?: boolean     // default: NODE_ENV !== 'production'
}
```

**Three redaction decisions, each with a reason:**

1. **`sql` is included by default.** Our SQL is `$n`-parameterised by construction — the builder never inlines a user value. Without the text, an error report is close to useless. The one leak vector is a user-authored `sql.unsafe` fragment that interpolates a literal, which is that fragment's owner's responsibility and is documented at `sql.unsafe`'s definition. Truncated at 4 KB to bound log volume.

2. **`params` are redacted by default.** Parameters are *precisely* the PII, the tokens, the password hashes. Errors flow into logs and into third-party error trackers. Instead we always expose `paramCount` and `paramTypes`, which are enough to debug an arity or type mismatch, and `includeParams: true` is a one-line dev opt-in.

3. **PG's `DETAIL` is redacted by default — and this is the one everybody gets wrong.** A unique violation's detail reads:

   ```
   Key (email)=(alice@example.com) already exists.
   ```

   Every ORM I surveyed passes this straight through into `error.message`, which means a duplicate-signup error puts a user's email address into the log line. We **parse** it first, extract the structured `{ columns, values }`, keep `columns` (safe, and genuinely useful — PG does not otherwise tell you *which* columns of a composite unique key collided), and drop `values` unless `includeParams` is on. `detailRedacted: true` records that we did so. Same treatment for FK violations (`Key (user_id)=(42) is not present in table "users"` — the value there is usually an id, but "usually" is not a security policy).

### 4.4 Constraint names → schema objects

Because `createDb({ schema })` receives the schema, we can turn PG's opaque constraint name into something that points at the user's code. A `Map<constraintName, ConstraintRef>` is built **lazily, on first constraint error** (not at startup — startup cost matters for serverless) by walking the schema's tables, indexes and constraints.

```ts
export interface ConstraintRef {
  kind: 'unique' | 'primaryKey' | 'foreignKey' | 'check' | 'exclusion' | 'notNull'
  table: TableRef                       // the schema object, not a string
  columns: readonly ColumnRef[]
  /** For FKs. */
  referencedTable?: TableRef
  referencedColumns?: readonly ColumnRef[]
  /** Where it was declared, if the schema builder records it (agent 01). */
  declaredAt?: string
}

export class UniqueViolationError extends IntegrityConstraintError {
  readonly constraintName: string
  /** Resolved from the schema when known. undefined for constraints created by raw SQL migrations. */
  readonly constraint?: ConstraintRef
  readonly table?: TableRef
  readonly columns?: readonly ColumnRef[]
}
```

The message improves from:

> `duplicate key value violates unique constraint "users_email_key"`

to:

> `unique constraint violated: users(email) [users_email_key]`
> `  at src/routes/signup.ts:41:18`
> `  insert into "users" ("email","name","created_at") values ($1,$2,$3) returning "id"`
> `  hint: catch UniqueViolationError, or use .onConflict(users.email).doNothing()`

And, more importantly, matching becomes type-safe and refactor-proof:

```ts
import { isUniqueViolation, isForeignKeyViolation } from 'pg-prime'

try { await db.insert(users).values(v) }
catch (e) {
  if (isUniqueViolation(e, users.email))   return { error: 'email_taken' }
  if (isUniqueViolation(e, users.username)) return { error: 'username_taken' }
  throw e
}

// Signatures — the column/table args are typed against the schema, so a rename is a compile error.
function isUniqueViolation(e: unknown, ...cols: ColumnRef[]): e is UniqueViolationError
function isUniqueViolation(e: unknown, constraint: ConstraintRef): e is UniqueViolationError
function isForeignKeyViolation(e: unknown, fk?: ConstraintRef): e is ForeignKeyViolationError
```

String-matching on `err.constraint === 'users_email_key'` is the status quo everywhere, and it silently breaks the moment somebody renames a column and regenerates the constraint name. This is a small feature with an outsized quality-of-life payoff, and it is available **only** to an ORM that owns the schema.

**Graceful degradation is mandatory.** Constraints created by hand-written SQL migrations (or by an extension) will not be in the map. In that case `constraint`/`table`/`columns` are `undefined`, the message falls back to PG's own, and we append a hint: *"constraint 'x' is not declared in your schema — it may have been created by raw SQL."* We never guess.

### 4.5 Mapping table (excerpt), shipped as data

The SQLSTATE→class mapping lives in one exported record so it is inspectable, testable, and extensible:

```ts
export const SQLSTATE_MAP: Readonly<Record<string, PgPrimeErrorCtor>> = { '23505': UniqueViolationError, ... }
export const SQLSTATE_CLASS_FALLBACK: Readonly<Record<string, PgPrimeErrorCtor>> = {
  '23': IntegrityConstraintError, '22': DataError, '40': TransactionError,
  '42': SchemaError, '53': InsufficientResourcesError, '08': ConnectionError, ...
}
```

Lookup order: exact SQLSTATE → class prefix → `UnknownQueryError`. That is what makes rule #3 in §4.1 true.

---

## 5. Pooler compatibility

### 5.1 `poolerMode` in one line

> **`poolerMode` is a declared environment profile, not a detected one: it selects a table of capability toggles that can only ever *restrict* what the runtime will emit, so a wrong value costs performance or produces a loud error — never silent incorrectness.**

```ts
export type PoolerMode =
  | 'none'                    // direct to Postgres (default)
  | 'session'                 // session-mode pooler: PgBouncer session, Supabase :5432, pgpool-II
  | 'pgbouncer-transaction'   // transaction pooler WITH protocol-level prepared statements:
                              //   PgBouncer ≥1.24, Neon -pooler, Hyperdrive, RDS Proxy, PgDog, pgcat
  | 'transaction'             // transaction pooler WITHOUT them: Supavisor :6543, PgBouncer with
                              //   max_prepared_statements=0. The conservative floor.
```

Profiles are data, not branches:

```ts
export interface PoolerProfile {
  namedPreparedStatements: 'ok' | 'shared-lru' | 'unsupported'
  sessionGucsAtConnect:    'ok' | 'unsafe'         // 'unsafe' = leaks across clients
  listen:                  'ok' | 'unsupported'
  sessionAdvisoryLocks:    'ok' | 'unsupported'
  withHoldCursors:         'ok' | 'unsupported'
  sessionHandle:           'ok' | 'unsupported'    // db.session()
  cancelRequest:           'ok' | 'best-effort'
  resetQuery:              'never'                 // in every profile, always
}

export const POOLER_PROFILES: Readonly<Record<PoolerMode, PoolerProfile>> = { ... }
```

### 5.2 The matrix — shipped as `docs/pooler-compatibility.md` *and* as the table above

The doc is generated from `POOLER_PROFILES` so the prose and the behaviour cannot drift. Content:

| Capability | `none` | `session` | `pgbouncer-transaction` | `transaction` |
|---|---|---|---|---|
| Default `execMode` | `unnamedExtended` | `unnamedExtended` | `unnamedExtended` | `unnamedExtended` |
| `execMode: 'prepared'` | ✅ | ✅ | ⚠️ allowed, warned: PgBouncer's per-server LRU is *shared across clients*, and DDL that changes result types requires `RECONNECT` on the admin console | ❌ `ConfigError` at construction |
| `SET` / session GUCs at connect | ✅ via startup `options` | ✅ | ❌ leaks to other clients; we skip and tell you to `ALTER ROLE` | ❌ same |
| `SET LOCAL` / `set_config(...,true)` | ✅ | ✅ | ✅ | ✅ |
| `db.session()` | ✅ | ✅ | ❌ `UnsupportedInPoolerModeError` | ❌ |
| `db.listen()` | ✅ | ✅ | ❌ → auto-routes to `directConnection`; `ConfigError` if absent | ❌ same |
| `db.notify()` | ✅ | ✅ | ✅ **(the matrix is asymmetric — NOTIFY works, LISTEN doesn't)** | ✅ |
| Session advisory locks | ✅ | ✅ | ❌ | ❌ |
| `pg_advisory_xact_lock` | ✅ | ✅ | ✅ | ✅ |
| `WITH HOLD` cursors | ✅ | ✅ | ❌ | ❌ |
| `WITHOUT HOLD` cursors (our `.stream()`) | ✅ | ✅ | ✅ (in-transaction) | ✅ |
| `CancelRequest` (abort mid-query) | ✅ | ⚠️ best-effort | ⚠️ best-effort | ⚠️ best-effort |
| COPY FROM/TO STDIN | ✅ | ✅ | ✅ (transaction-scoped) | ✅ |
| Migrations | ✅ | ✅ | ❌ requires `directConnection` | ❌ requires `directConnection` |
| `DISCARD ALL` reset query | never | never | never | never |
| SQL `PREPARE`/`EXECUTE`/`DEALLOCATE` | never emitted | never | never | never |

Plus, in prose: RDS Proxy's pinning list (`SET`, SQL `PREPARE`/`DISCARD`/`DEALLOCATE`/`EXECUTE`, temp objects, **declaring cursors**, `LISTEN`, `LOAD`, `nextval`/`setval`, session advisory locks — `_xact_` variants explicitly exempt — and any statement over 16 KB), and the note that a `DISCARD ALL` reset query pins on release. The 16 KB statement limit is worth calling out for our `insertMany` chunking (§6.6).

### 5.3 What each mode toggles, concretely

- **`execMode`**: only ever restricted, never expanded. `'transaction'` forbids `'prepared'` outright.
- **`LISTEN` gating**: `db.listen()` under a transaction profile does *not* fail obscurely — it looks for `directConnection`, uses it if present (this is what "route by feature, not by call site" means, §5.7 #8), and throws `ConfigError` naming the missing config if absent.
- **Advisory locks in migrations**: the migration lock is `pg_advisory_xact_lock` in **every** mode, not just pooled ones — session locks pin RDS Proxy and break under transaction pooling, and there is no upside to the session variant.
- **Migration behaviour warnings**: the migrator refuses to run over a transaction-pooled connection unless `--allow-pooled` is passed, because `CREATE INDEX CONCURRENTLY` cannot run in a transaction, `SET lock_timeout` cannot be applied, and the advisory lock semantics are wrong. If `directConnection` is set, it is used silently and correctly.
- **Post-migration cache invalidation** (§5.5): profile-dependent.

### 5.4 `db.diagnosePooler()` — the behavioural probe, clearly labelled heuristic

```ts
export interface PoolerDiagnosis {
  verdict: 'direct' | 'likely-session-pooled' | 'likely-transaction-pooled' | 'inconclusive'
  confidence: 'low' | 'medium'                     // never 'high' — this is a heuristic, by construction
  recommendedPoolerMode: PoolerMode
  configuredPoolerMode: PoolerMode
  agrees: boolean
  signals: readonly DiagnosticSignal[]
  warnings: readonly string[]
}

export interface DiagnosticSignal {
  name: 'backend-pid-across-statements' | 'backend-pid-within-transaction'
      | 'named-statement-survives' | 'application-name-sticky'
      | 'hostname-heuristic' | 'server-version'
  result: 'supports-direct' | 'supports-transaction-pooling' | 'supports-session-pooling' | 'inconclusive'
  detail: string
}

db.diagnosePooler(): Promise<PoolerDiagnosis>
```

**Probes**, all read-only and side-effect-free except where noted:

1. **`select pg_backend_pid()` twice, as two separate autocommit statements on the same pool client.** Different pids ⇒ strong evidence of transaction pooling. (Not proof: a reconnect between them produces the same signal, hence `confidence: 'medium'` at best.)
2. **The same two calls inside one transaction.** They must be equal. If they are not, something is badly broken and we say so loudly rather than guessing.
3. **`named-statement-survives` — the decisive probe for the question we actually care about.** Prepare a trivial named statement, then execute it by name in a *separate* protocol exchange. Success ⇒ named statements are usable (direct, session, or PgBouncer ≥1.24). `26000` ⇒ they are not. Cleans up with a protocol `Close`. This is the only probe that distinguishes `pgbouncer-transaction` from `transaction`.
4. **`application-name-sticky`**: set a unique `application_name` on one statement, read it back on the next. Not sticky ⇒ transaction pooling. **This probe writes session state and is therefore opt-in** (`diagnosePooler({ probeSessionState: true })`), since under a pooler it leaks a value onto a shared server connection. Uses a harmless namespaced value and is off by default.
5. **Hostname/port heuristics** (zero cost, run always): Neon's `-pooler` suffix, `*.pooler.supabase.com`, Supabase `:6543` vs `:5432`, `*.proxy-*.rds.amazonaws.com`, Hyperdrive's local binding.
6. **`select version()`, `show server_version_num`**: some poolers self-report; also confirms we are talking to a real PG.

**`diagnosePooler()` never changes configuration.** It returns a report. Rationale is §5.6/§5.7 #10 stated bluntly: *the ecosystem's answer to pooler detection is to make the safe thing the default so detection is unnecessary*, and Prisma #21799 is the case study in what happens when a client-side pooler workaround outlives the pooler bug it worked around. A false negative on our heuristic costs performance; a false positive that silently switched modes would cost correctness. We only ever *report*.

Where it is used:
- `pg-orm doctor` CLI — prints the full report and the suggested config diff.
- Dev-mode startup, **once, asynchronously, non-blocking**: if `agrees === false`, log one `warn` naming the mismatch and the command to investigate. Never in production, never blocking the first query.
- `db.diagnose()` bundles it with pool stats, effective GUC values, `max_connections` arithmetic (§1.2), server version, and any exec-mode downgrade that has occurred.

We explicitly do **not** use PgBouncer's `SHOW POOLS` admin console: it needs admin credentials and only speaks the simple query protocol, making it a CLI diagnostic at best and not a runtime signal.

### 5.5 The migration ⇄ running-app interaction

This is the failure mode `pg-drivers.md` §5.2 flags as *"directly relevant to us: our own migration tool can trigger this in a user's running app"*, and it deserves an explicit policy because we own both sides.

After a migration that changes a result type (adding a column to a `select *`, altering a column type), running apps holding cached plans get `0A000 cached plan must not change result type`.

1. **Same process** (migrator run in-process, e.g. a test harness or a boot-time migrate): the migrator emits a `schemaChanged` event; the runtime flushes the description cache and every per-connection prepared-statement map, and marks pool connections for recycling. Zero user-visible errors.
2. **Different process** (the normal deploy): unavoidable. We self-heal per §2.4 — `0A000` invalidates and re-prepares once, transparently. The user sees nothing.
3. **Behind PgBouncer with `max_prepared_statements > 0`**: PgBouncer's *own* per-server cache also holds the stale plan, and our re-prepare may hit it again. Our self-heal retries once; if it recurs, the circuit breaker downgrades the pool to `unnamedExtended` (which cannot have this problem) and logs the fix: **`RECONNECT` on the PgBouncer admin console**. The migrator additionally prints this as a post-migration note when it detects a pooled deploy.
4. `execMode: 'unnamedExtended'` — the default — is **immune to all of the above**, which is a further argument for it being the default.

---

## 6. Cancellation, timeouts, streaming, LISTEN, COPY

### 6.1 AbortSignal, end to end

`signal` is accepted at every level and composes downward:

```ts
createDb({ signal })                                  // abort → graceful pool drain, then destroy
db.transaction(fn, { signal })                        // aborts the whole transaction
db.select(users).where(...).signal(ac.signal)         // aborts one statement
db.run(compiled, { signal })
db.stream(q, { signal })                              // stops iteration, closes the cursor
db.copyFrom(...,{ signal })
db.listen(ch, h, { signal })                          // unsubscribes
```

Semantics are defined by *when* the abort lands:

| Abort lands | Behaviour |
|---|---|
| Before the statement is written | Never sent. Reject with `AbortError`. Connection returns to the pool clean. |
| While in flight | Issue a `CancelRequest` on a **separate** connection (see below), then reject with `AbortError` **without waiting** for the cancel to take effect. |
| After the response arrived | No-op; the result is returned. Aborting is not a rollback. |
| Inside a transaction | The statement is cancelled, the transaction is rolled back, `AbortError` propagates out of `db.transaction`. Never retried (§3.4). |

**`CancelRequest` needs a control connection.** The protocol requires opening a *second* socket carrying the `BackendKeyData`. Kysely solved this with a `controlClient` factory in its dialect config; we do the same, derived automatically from the connection config so users never configure it:

```ts
createDb({ connection, control: { max: 2 } })   // optional; defaults derived from `connection`
```

**After a cancel we destroy the connection rather than reusing it.** The cancelled query's `ErrorResponse`/`ReadyForQuery` is still in flight and there is a genuine race between draining it and the next query's `Bind`. Cancellation is rare; a wasted connection is cheap; a cross-talked result set is a catastrophe. This is documented: *"aborting an in-flight query costs one pooled connection."*

**Behind a pooler, `CancelRequest` is best-effort** — the `BackendKeyData` we hold belongs to the pooler, and under transaction pooling the mapping can be stale by the time our cancel arrives. This is the core reason for §6.2's decision.

### 6.2 Per-query timeout: the implementation decision

**Decision: server-side `statement_timeout` is the primary mechanism. Client-side `CancelRequest` is the fallback, and is explicitly documented as best-effort.**

Why: `statement_timeout` is enforced by the backend that is actually running the query. It is race-free, pooler-independent, needs no control connection, and cannot leave an orphaned query burning CPU after the client gave up — which is exactly what a failed `CancelRequest` does.

The awkward case is a timeout on an **autocommit** statement, where there is no transaction for `SET LOCAL` to be local to. Three options, and what we do with each:

| Option | Cost | Verdict |
|---|---|---|
| Session-level `statement_timeout` set once at connect | **0 per query** | ✅ **The default path** for `poolerMode: 'none' \| 'session'` (§3.6). Covers the 95 % case where one global ceiling is all anyone wants. |
| Implicitly wrap the statement in `BEGIN; SET LOCAL …; …; COMMIT` | +2 RTT | ❌ Not the default — tripling the round trips of every timed query to enforce a timeout is a bad trade. Available as `{ timeoutMs, strategy: 'transaction' }` for users who need a hard server-side guarantee per statement. |
| Client-side timer → `CancelRequest` → `AbortError` | ~0 until it fires; costs a connection when it does | ✅ **The fallback** for a per-statement `.timeout(ms)` outside a transaction, and the only option under a transaction pooler where we cannot set session GUCs. |

Inside a transaction (including anything under `db.transaction`), `.timeout(ms)` and `TxOptions.timeoutMs` always use `SET LOCAL statement_timeout` — correct in every profile, +1 RTT, or +0 with `pipeline: true`.

A statement killed by `statement_timeout` surfaces as `QueryCanceledError` (`57014`) with `context.reason: 'statement_timeout'`; one killed by our client-side timer surfaces as `QueryTimeoutError`. Distinguishing them matters: the first means the server gave up, the second means we did and the server may still be working.

### 6.3 Streaming / cursors

```ts
export interface StreamOptions {
  batchSize?: number                 // rows per FETCH; default 1000
  signal?: AbortSignal
  statementTimeoutMs?: number | null // default null — long streams should not trip the 30s default
}

for await (const row of db.stream(db.select(events).where(...), { batchSize: 5_000 })) { ... }
for await (const batch of db.streamBatches(q, { batchSize: 5_000 })) { ... }
```

Design points:

- **A stream is transaction-scoped.** At the root, `db.stream()` opens an implicit transaction for the cursor's lifetime and closes it when iteration ends (normally, by `break`, by `throw`, or by abort). Inside an existing `Tx` it joins that transaction. This makes cursors `WITHOUT HOLD`, which is the *only* cursor form that works under transaction pooling (§5.1) and the only one that does not pin RDS Proxy.
- **`return()` on the iterator is honoured.** `break` out of a `for await` closes the cursor, ends the transaction and releases the connection — no leak. This is the bug in most hand-rolled cursor wrappers.
- **A partially-consumed stream disables transaction retry** (§3.4 exclusion 3): rows have already reached the caller.
- **Back-pressure is the consumer's `await`.** We fetch the next batch only when the current one is exhausted. No unbounded buffering, no `highWaterMark` knob.
- Node streams interop stays in userland — `Readable.from(db.stream(q))` is one line and needs nothing from us.

⚠️ **Open implementation risk.** Two ways to implement the batches, and I could not settle it without a live server (none available in this environment):

  - **(a) `pg-cursor` as an optional peer dependency** (`pg-cursor@2.22.0`, by brianc, released 2026-08-08, alongside `pg` itself). Uses the protocol-correct path — `Execute` with a row limit, `PortalSuspended` — so bind parameters work without question. Consistent with "zero runtime deps, optional peers" (Drizzle ships 28 optional peers). **This is the recommended primary path.** Required only if you call `.stream()`; a clear `ConfigError` tells you to install it if you do and haven't.
  - **(b) SQL `DECLARE … CURSOR` + `FETCH FORWARD n`.** Fully dependency-free, but `DECLARE` is a *utility* statement and I could not verify, from the sources available here, whether PostgreSQL reliably accepts bind parameters in `DECLARE … CURSOR FOR <query>` over the extended protocol. psycopg2's named cursors interpolate client-side, which is weak evidence against. **Must be settled with a live PG 14–18 matrix before committing.** If it works, it becomes the zero-dep default and (a) becomes an optimisation.

  Either way the **public API above does not change** — this is an adapter-level choice behind agent 02's `PgConnection.stream()`.

> **AS BUILT (design/09 WS6, §3.6).** The open risk is closed in favour of **(b)**, and it was
> closed by measurement rather than by preference: `DECLARE … CURSOR` *does* accept bind parameters
> over the extended protocol on PG 17.11 (`test/driver/cursor.test.ts`, WS4), so `.stream()` needs
> neither `pg-cursor` nor an optional peer dependency. The FETCH **count** may not be a bind
> (`42601`) and is inlined as a validated integer the ORM supplies, never the user.
>
> `stream(opts?: { batchSize?, signal? })` is on `Query`, `SetQuery`, a prepared select and
> ``db.sql`…` ``. The transaction is the **runner's**, not the cursor's: at the root it acquires
> one connection, opens `BEGIN`, and ends the transaction *and releases the connection* on every
> exit — completion (`commit`), `break` (which calls the iterator's `return()`, so `rollback`),
> `throw`, and abort. Inside `db.transaction()` it joins and touches neither. Both shapes are
> asserted on the mock's statement log with `acquired === released`
> (`test/query/stream.test.ts`), because a cursor wrapper that returns the right rows and leaks a
> connection looks perfect from the consumer's side.
>
> Deviations: `statementTimeoutMs` is not implemented (per-query timeout is the session layer's,
> and `07` §6.2 has no workstream yet), and **`streamBatches` is not shipped** — it did not fall
> out for free, because the decoder is positional over a chunk and a batch API would have to
> decide whether a batch is a FETCH or a fixed count. `Readable.from(db.stream(q))` is unaffected.

### 6.4 A note on `Promise`-and-`AsyncIterable` results

Prisma Next makes a query result *both* awaitable and async-iterable (`prisma.md` §3.4). It is elegant and it is a trap: `await q` and `for await (const x of q)` differ enormously in memory profile and in whether a transaction is held, and making them the same expression hides that. We keep `.stream()` explicit. One extra token buys an unambiguous cost model.

### 6.5 LISTEN / NOTIFY

```ts
export interface Subscription {
  readonly channel: string
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
  on(event: 'reconnect', h: (info: { attempt: number; downMs: number }) => void): () => void
  /** Fires after a reconnect. Notifications during the gap are LOST — reconcile here. */
  on(event: 'gap', h: (info: { downMs: number }) => void): () => void
  on(event: 'error', h: (e: PgPrimeError) => void): () => void
}

db.listen(channel: string, handler: (payload: string, ctx: { channel: string; processId: number }) => void,
          opts?: { signal?: AbortSignal }): Promise<Subscription>

db.notify(channel: string, payload?: string): Promise<void>
```

- **Connection ownership: a dedicated `Client` outside the pool, never a pool client.** A connection holding `LISTEN` is pinned for its lifetime; taking it from the pool silently shrinks `max` and eventually starves the app. One connection is shared by all channels on a given `Db` (multiplexing `LISTEN a`, `LISTEN b` on one backend), reference-counted, opened on the first subscription and closed when the last one goes away.
- **Auto-reconnect with full-jitter backoff, and re-`LISTEN` on every channel after reconnect.**
- **The `'gap'` event is the correctness feature.** `LISTEN`/`NOTIFY` is at-most-once: notifications published while you were disconnected are gone forever. Every implementation I have seen reconnects silently, which quietly loses events. We emit `'gap'` with the outage duration so the application can reconcile (re-poll the table, re-read a watermark). The doc says, in bold, that a `LISTEN`-based cache invalidation without gap handling is incorrect.
- **`notify` uses `pg_notify($1, $2)`, never `NOTIFY chan, 'literal'`** — the SQL form needs identifier quoting for the channel and literal escaping for the payload, i.e. two injection surfaces, for zero benefit. `pg_notify` is parameterised and works inside a transaction (delivering on commit, which is usually what you want).
- **Pooler gating**: under a transaction profile, `db.listen()` uses `directConnection` if configured, otherwise throws `UnsupportedInPoolerModeError` with the exact config key to add. `db.notify()` works in every mode (the asymmetry from §5.1).
- Payload limit is 8000 bytes; we check client-side and throw `UsageError` rather than letting PG produce a confusing failure. The doc says what everyone eventually learns: send an id, not a document.

### 6.6 COPY and bulk loading

Two tiers, because most people reaching for `COPY` do not need it.

**Tier 1 — `insertMany`, dependency-free, covers ~95 % of cases.** Multi-row `INSERT … VALUES (…),(…),…` chunked automatically to stay under **65 534 bind parameters** (a hard PG limit) and, when a pooler profile flags it, under RDS Proxy's **16 KB statement size** pinning threshold. Exceeding the parameter limit throws `TooManyParametersError` (a `UsageError`) with the computed chunk size, rather than the confusing server-side error. Chunks run inside one transaction by default.

**Tier 2 — real `COPY`, for the 5 %.**

```ts
await db.copyFrom(users, asyncIterableOfRows, { format: 'text' })          // typed rows → COPY … FROM STDIN
await db.copyFrom.raw(sql`copy "users" ("id","name") from stdin with (format csv)`, byteStream)
for await (const chunk of db.copyTo(sql`copy (select …) to stdout with (format csv)`)) { … }
```

`COPY` requires `pg-copy-streams` (**optional peer**; `7.0.0`, 2025-05-27, maintained by `jeromew` rather than brianc — a maintenance risk worth stating in the docs). Not installed and you call it ⇒ a `ConfigError` naming the package and pointing at `insertMany` as the alternative. Documented crossover from measurement, expected around 5–10 k rows; we will publish the measured number rather than a guess.

`COPY` is transaction-scoped and therefore works under transaction pooling. `statementTimeout` defaults to `null` for the duration.

---

## 7. Observability

### 7.1 Structured query hooks

```ts
export interface QueryHooks {
  onQueryStart?(e: QueryStartEvent): void
  onQueryEnd?(e: QueryEndEvent): void
  onQueryError?(e: QueryErrorEvent): void
  onTransactionStart?(e: TxStartEvent): void
  onTransactionEnd?(e: TxEndEvent): void         // outcome: 'commit' | 'rollback' | 'error'
  onRetry?(e: RetryEvent): void
  onPool?(e: PoolEvent): void                    // acquire, release, create, destroy, timeout
  onNotice?(e: NoticeEvent): void                // PG NoticeResponse — RAISE NOTICE from your functions
  onInternal?(e: InternalEvent): void            // downgrades, cache flushes, self-heals, hook failures
}

export interface QueryStartEvent {
  readonly queryId: string          // ULID-ish, correlates start/end/error and spans
  readonly sql: string
  readonly paramCount: number
  readonly execMode: ExecMode
  readonly handle: 'db' | 'tx' | 'session'
  readonly txId?: string
  readonly depth: number
  readonly attempt: number
  readonly label?: string
  readonly startedAt: number        // performance.now()
  /** Best-effort operation classification for spans, from the compiled query, not a regex on SQL. */
  readonly operation?: 'select' | 'insert' | 'update' | 'delete' | 'ddl' | 'other'
  readonly tables?: readonly string[]
}

export interface QueryEndEvent extends QueryStartEvent {
  readonly durationMs: number
  readonly rowCount: number
  readonly command: string          // 'SELECT' | 'INSERT' | …
  /** Split so you can see driver time vs our decode time — the number that tells you whether
   *  the ORM or the database is slow. Nobody else reports this. */
  readonly serverMs: number
  readonly decodeMs: number
  readonly waitedForConnectionMs: number
}

export interface QueryErrorEvent extends QueryStartEvent {
  readonly durationMs: number
  readonly error: PgPrimeError
}
```

Rules:

- **Hooks are synchronous.** An `async` hook on the hot path is an unbounded-latency footgun and an ordering hazard. Users who need async work push onto their own queue.
- **A throwing hook can never break a query.** Every invocation is wrapped; a failure is reported once through `onInternal` and then that specific hook is disabled for the process with a loud log. Observability must not be able to take down the application.
- **Two registration styles**: static in `createDb({ hooks })`, and dynamic `const off = db.observe(hooks)` which composes (multiple observers, each called; unsubscribe by calling the returned function). No `EventEmitter` — typed hook objects give better inference and avoid stringly-typed event names.
- `paramCount`, not `params` — same redaction policy as §4.3. `params` appear in events only when `errors.includeParams` is on.
- `waitedForConnectionMs` is separated from `serverMs` deliberately: "slow query" and "pool exhausted" look identical in every ORM's logs today and have completely different fixes.

### 7.2 OpenTelemetry-compatible, without depending on OpenTelemetry

Core exports the attribute mapping as data and a pure function; core imports nothing.

```ts
/** Pinned to OTel semantic conventions for database client spans, v1.34 (stable).
 *  Exported as a mutable-by-config record so a semconv bump is one edit, not a refactor. */
export const SEMCONV = {
  dbSystemName: 'db.system.name',
  dbNamespace: 'db.namespace',
  dbQueryText: 'db.query.text',
  dbQuerySummary: 'db.query.summary',
  dbOperationName: 'db.operation.name',
  dbCollectionName: 'db.collection.name',
  dbResponseStatusCode: 'db.response.status_code',
  dbResponseReturnedRows: 'db.response.returned_rows',
  dbOperationBatchSize: 'db.operation.batch.size',
  serverAddress: 'server.address',
  serverPort: 'server.port',
  errorType: 'error.type',
} as const

export type SpanAttributes = Readonly<Record<string, string | number | boolean>>

/** Pure. No imports. Adapt it to whatever tracer you use. */
export function spanAttributes(e: QueryStartEvent | QueryEndEvent | QueryErrorEvent): SpanAttributes

/** The name OTel wants: "<operation> <collection>", e.g. "SELECT users". */
export function spanName(e: QueryStartEvent): string
```

Produces, for a failing insert:

```
db.system.name           = 'postgresql'
db.namespace             = 'app_production'
db.operation.name        = 'INSERT'
db.collection.name       = 'users'
db.query.text            = 'insert into "users" ("email") values ($1) returning "id"'
db.query.summary         = 'INSERT users'
db.response.status_code  = '23505'          ← SQLSTATE, which is exactly what semconv asks for
db.response.returned_rows= 0
server.address           = 'db.internal'
server.port              = 5432
error.type               = 'UniqueViolationError'
```

Plus non-semconv attributes under a `pg_orm.*` prefix (`pg_orm.exec_mode`, `pg_orm.attempt`, `pg_orm.tx_depth`, `pg_orm.pooler_mode`, `pg_orm.decode_ms`, `pg_orm.wait_ms`) — namespaced so they can never collide with a future semconv key.

A separate optional package `@pg-orm-ts/otel` wires `db.observe()` to `@opentelemetry/api` (start/end spans, record exceptions, propagate the active context). Core stays at zero dependencies, and the person who does not use OTel pays nothing — not even a `.d.ts`.

`db.query.text` honours `errors.includeSql`; parameters are never attached to a span.

### 7.3 Slow-query log

```ts
export interface LogOptions {
  level?: 'silent' | 'error' | 'warn' | 'info' | 'debug'   // default 'warn'
  slowQueryMs?: number | null                              // default null (off); 500 is a good start
  /** Log EVERY query. Dev only; refuses to enable when NODE_ENV === 'production' unless forced. */
  logAllQueries?: boolean
  sink?: (record: LogRecord) => void                       // default: a small console formatter
  format?: 'pretty' | 'json'                               // default: pretty on a TTY, json otherwise
}
```

A slow-query record carries `durationMs`, `serverMs`, `decodeMs`, `waitedForConnectionMs`, `rowCount`, truncated SQL, `paramCount`, `label`, `queryId`, and the captured call site (§7.4). Deliberately no built-in aggregation or sampling: that is the metrics pipeline's job, and `onQueryEnd` is the seam for it.

### 7.4 Call-site capture — why async stacks are not enough

The stack trace attached to a rejected database promise points at our internals and tells you nothing about *which line of your code* issued the query. We therefore capture the call site at query *start* (`Error.captureStackTrace` into a lightweight holder, with our own frames elided) and attach it to errors and slow-query records.

It is not free — a few microseconds per query — so:

```ts
errors: { captureCallSite: process.env.NODE_ENV !== 'production' }   // the default
```

On in production if you want it; off by default. This is the single highest-value debugging feature in the whole runtime layer and it is one config line.

### 7.5 `.explain()` on any query

```ts
export interface ExplainOptions {
  analyze?: boolean          // default false. TRUE EXECUTES THE QUERY.
  verbose?: boolean
  costs?: boolean            // default true
  buffers?: boolean          // default true when analyze
  wal?: boolean
  timing?: boolean           // default true when analyze
  settings?: boolean         // default true — surfaces non-default planner GUCs
  summary?: boolean
  format?: 'text' | 'json'   // default 'json'
  /** Safety rail for mutating statements under analyze. Default true. §below */
  rollback?: boolean
}

await db.explain(db.select(users).where(...))
await db.explain(db.update(users).set(...), { analyze: true })          // wrapped + rolled back
await db.explain(db.update(users).set(...), { analyze: true, rollback: false })  // deliberate

export interface ExplainResult {
  readonly plan: ExplainNode                 // typed tree when format === 'json'
  readonly text: string                      // always available; ExplainResult.toString() === text
  readonly planningTimeMs?: number
  readonly executionTimeMs?: number
  readonly executed: boolean
  readonly rolledBack: boolean
}
```

**The safety rail is the differentiating bit.** `EXPLAIN ANALYZE UPDATE …` *performs the update*. This has ruined real production data and no ORM guards it. We do:

- `analyze: true` on a mutating statement (`insert`/`update`/`delete`/DDL) **wraps in a transaction and rolls back** by default. `rolledBack: true` says so.
- Opting out requires the explicit `rollback: false`, which reads as a deliberate act at the call site.
- The type system reinforces it: `rollback: false` on a mutating builder is only accepted in the overload that also demands the acknowledgement, so it cannot be reached by a stray object spread.

`format: 'json'` gives a typed `ExplainNode` (node type, relation name, estimated vs actual rows, loops, buffers, children) rather than a string, which makes plan assertions viable in tests — `expect(plan).not.toContainNode('Seq Scan', { relation: 'events' })`.

> **AS BUILT (design/09 WS6, §3.6).** `explain(opts?)` is on every builder and on a prepared
> query, and sends the query's **own binds** — the extended protocol accepts a parameterised
> `EXPLAIN`, and a plan for an inlined literal is a plan for a different query. (`EXPLAIN
> (GENERIC_PLAN)` is the other question, and is what `test/live/_harness.ts`'s `planProbe` asks.)
>
> Two deviations:
>
> - **`plan` is `ExplainNode | undefined`**, present iff `format` is `'json'` (the default). A
>   typed tree cannot be recovered from PostgreSQL's *text* rendering without writing a parser for
>   it, and running a second `EXPLAIN` to get both would execute a mutating statement twice under
>   `analyze`. `text` is always there, and `String(result)` is it, as promised.
> - **`buffers` / `timing` / `wal` are emitted only with `analyze`.** `EXPLAIN (BUFFERS)` without
>   it is an error before PG 16, and asking for it is almost always a slip rather than a request.
>
> The safety rail ships and is the differentiating bit it was advertised as. "Mutating" is
> `meta.writes.length > 0` as well as the statement kind, so a **SELECT carrying a writable CTE**
> is wrapped too — the case a `kind`-only test would miss. Inside an existing transaction the
> wrapper is a `SAVEPOINT` / `ROLLBACK TO` / `RELEASE`, never a nested `BEGIN`: rolling the
> caller's whole transaction back because they asked for a plan would be the cure being worse than
> the disease. `test/live-query/executor.test.ts` proves the rollback with the row itself, read
> back through a second path, and proves `rollback: false` really writes.
>
> The type-level reinforcement this section describes — "`rollback: false` on a mutating builder is
> only accepted in the overload that also demands the acknowledgement" — is **not** built: it
> needs an overload per builder keyed on the statement kind, and the runtime rail plus the explicit
> spelling carry the weight. Recorded as a deferral in `09` §3.6.

**v1.1, flagged now so it is designed for:** `explain().hints()` — a small rule set flagging `Seq Scan` on a large relation, estimate-vs-actual row mismatches over 10×, nested loops with high loop counts, and external (disk) sorts. Deliberately out of v1 scope; the typed plan tree is the enabling structure.

---

## 8. Alternatives considered and rejected

| # | Rejected | Why |
|---|---|---|
| 1 | **Named prepared statements as the default exec mode** (pgx's `CacheStatement`) | Pooler-hostile in the general case, and on `pg` the win is a server-side parse, *not* a round trip, because `pg` already corks Parse+Bind+Execute+Sync into one write. The pooler-safe default is also the fast default; there is no tradeoff to trade. Npgsql — the only mainstream driver with true auto-prepare — ships it **off**. |
| 2 | **pgx's `DescribeExec` as a mode** | It is the one mode pgx itself warns is pooler-unsafe (it `Sync`s between Parse and Bind). `pg` describes the *portal* instead and never needs `ParameterDescription`, so the mode has no reason to exist for us. |
| 3 | **Auto-detecting pooler mode and switching exec mode** | No driver or ORM anywhere does this (§5.6). A false positive is a correctness bug; a false negative is a perf bug. Prisma #21799 is the case study of a client-side pooler workaround outliving its cause and *becoming* the bug. We detect only to *report* (§5.4). |
| 4 | **`postgres.js`-style always-on automatic statement caching** | Elegant, and it is the reason `postgres.js` needs a self-healing retry at all. Making the caching opt-in removes the failure class entirely for the 90 % who never turn it on. |
| 5 | **Pipelining on by default** | `pg`'s pipeline mode **destroys the connection** on error to unblock queued queries (§1.4), i.e. one bad query kills unrelated in-flight ones. Opt-in per db. |
| 6 | **Client-side `CancelRequest` as the primary timeout mechanism** | Racy, needs a control connection, best-effort behind every pooler, and — worst — a failed cancel leaves the server burning CPU on a query nobody will read. `statement_timeout` is enforced by the backend actually running the query. Cancel stays as the fallback for autocommit `.timeout()`. |
| 7 | **A wall-clock transaction timeout** (Prisma's `timeout: 5000`) | Documented as *"a recurring production surprise"*; kills legitimate long backfills that are actively making progress. We bound *statements* and *idle-in-transaction* instead, and offer `signal: AbortSignal.timeout(ms)` for those who want the wall clock. |
| 8 | **Retrying `40P01` deadlocks by default** | A deadlock is nearly always a lock-ordering bug. Retrying it converts a reproducible bug into an intermittent latency spike. Opt-in. |
| 9 | **Retrying after a failed `COMMIT`** | The transaction may have committed. Retrying is how you double-charge a card. Gets its own non-`ConnectionError` class so existing retry-on-connection-error code cannot swallow it. |
| 10 | **Ambient `AsyncLocalStorage` context / `getDb()` / `RequestContext` / `@Transactional`** | The single largest source of MikroORM's conceptual overhead; needs a decorator per non-HTTP entrypoint; the docs themselves warn about "weird bugs". ALS ships **only** as the dev-mode misuse guard (§1.6). |
| 11 | **Spring-style transaction propagation modes** | Our three handle types express the useful subset *statically* (§3.8). The rest is ceremony. |
| 12 | **Flush modes / write buffering / Unit of Work** | Team-level decision, inherited. Nothing to flush. |
| 13 | **`tx.rollback()` that silently resolves the promise** (Drizzle) | Makes the rollback path indistinguishable from success at the type level. `rollbackWith(value)` gives the same ergonomics with an honest type. |
| 14 | **Emitting SQL `PREPARE`/`EXECUTE`/`DEALLOCATE`** | Universally unsupported or pinning behind poolers; only PgDog handles it, behind an off-by-default flag. SQL `DEALLOCATE <client-name>` is precisely what broke PHP/PDO against PgBouncer. Protocol `Close` only. |
| 15 | **`DISCARD ALL` / `DEALLOCATE ALL` as a connection reset query** | Clears PgBouncer's per-client tracking *and* pins RDS Proxy connections on release. Never emitted, in any mode. |
| 16 | **`read uncommitted` isolation** | PostgreSQL silently maps it to `read committed`. Being PG-only is the licence to not ship a no-op option. |
| 17 | **Sequential array transactions** (`$transaction([q1, q2])`) | Strictly less capable than the callback (cannot thread a generated id between steps) and a second API to type, document and test. |
| 18 | **Query results that are simultaneously `Promise` and `AsyncIterable`** (Prisma Next) | Elegant, but it hides an enormous difference in memory profile and connection-holding between `await q` and `for await (…of q)`. `.stream()` stays explicit. |
| 19 | **Bundling `pg-cursor` / `pg-copy-streams` as hard dependencies** | Violates zero-deps for features most users never call. Optional peers with a clear `ConfigError` when missing (Drizzle ships 28 optional peers; the pattern is proven). |
| 20 | **Shipping our own connection pool in v1** | `pg-pool` is 517 LOC, accepts an injected `Client`, and is adequate. We own the *policy* (§1.2) and can replace the implementation later behind the same config. |
| 21 | **`EventEmitter`-based observability** | Stringly-typed events, worse inference, and `once`/`off` bookkeeping. Typed hook objects plus `db.observe()` compose better and cost nothing. |
| 22 | **Depending on `@opentelemetry/api`** | It is a real dependency with its own version treadmill, and most users do not trace. We export attribute names and a pure mapping function; `@pg-orm-ts/otel` is a separate optional package. |
| 23 | **A built-in query cache with a Redis integration** (Drizzle 0.44+) | Scope creep in a library selling zero dependencies. `onQueryStart`/`onQueryEnd` plus `compile()` are the seam for anyone who wants one. |
| 24 | **Async observability hooks** | Unbounded latency injected into the hot path, plus ordering hazards. Sync only; push to your own queue. |
| 25 | **Blocking the first query on a pooler probe** | Startup latency for a heuristic. The probe is opt-in, async, dev-only, and advisory. |

---

## 9. Open questions — status

1. ~~**`DECLARE … CURSOR` with bind parameters over the extended protocol**~~ — **RESOLVED**
   (spike, PG 17.11): yes. `.stream()` is zero-dep and `pg-cursor` is struck entirely. Boundaries
   pinned by `test/driver/cursor.test.ts`: cursors are transaction-scoped (`25P01` outside),
   `FETCH FORWARD $1` is `42601` so the count is inlined as a validated integer, and the simple
   protocol cannot carry `$1` at all (`42P02`).
2. **Driver surface requests to 02** — **delivered**: protocol `Close` for named statements,
   `stream()`, a cancel path with a control-connection provider, `PgResult.fields` with
   `dataTypeID`/`dataTypeModifier`/`tableID`/`columnID`, and `transactionStatus`. The `DEALLOCATE`
   fallback was not needed.
3. **`cachedDescribe` + binary results** — binary is **out of v1**: `pg-protocol` UTF-8-decodes
   every DataRow field, which corrupts binary payloads (measured live). Text decode only; the seam
   stays wired. `unnamedExtended` remains the default.
4. **`compile()` vs `prepare()` naming** — **open.** Lands with the fluent builder, which does not
   exist yet. The distinction (client-side freeze vs server-side named statement) must not be
   blurred the way Drizzle blurs it.
5. **Migration/running-app interaction** — design holds; **unimplemented.** Note one correction
   from 06: the migration lock is a **session** advisory lock plus a heartbeat lease, not
   `pg_advisory_xact_lock`, because a `txmode none` file has no enclosing transaction to scope it
   (00-overview R6). `pg_advisory_xact_lock` remains right for the *runtime* side described here.
6. **`statementTimeout: '30s'` as a default** — **open**, and still the most opinionated call in
   this document. Unchanged mitigations: `null` disables, `.timeout()` overrides per statement,
   streaming and COPY exempt themselves, and it is stated in the startup log line. No executor
   exists yet, so this has never been exercised.
7. **Should `cachedDescribe` be the v1 default?** — **open.** Deferred until there is an executor
   to measure it with. The wire shape is identical to `unnamedExtended`, so there is no pooler
   risk; the only question is cache-invalidation correctness.
