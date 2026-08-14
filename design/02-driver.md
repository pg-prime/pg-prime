# 02 — Driver Layer & Codec Boundary (DESIGN / DECIDED)

**Project:** `pg-orm-ts` · **Owner:** design agent 02 · **Date:** 2026-08-14
**Status:** Decided. These are implementable interfaces, not options.
**Inputs:** [`research/pg-drivers.md`](../research/pg-drivers.md), [`research/SUMMARY.md`](../research/SUMMARY.md) §3–4.
**Baseline:** PostgreSQL ≥ 15 · ESM-only · Node ≥ 22 · **zero runtime deps, zero peer deps** · near-raw `pg` performance.

**Verification method.** Every behavioural claim below was checked by executing code against `pg@8.23.0` +
`pg-protocol@1.16.0` + `pg-pool@3.14.0` + `pg-cursor@2.22.0` + `pg-copy-streams@7.0.0` +
`@neondatabase/serverless@1.1.0` + `@electric-sql/pglite@0.5.5` (all installed fresh 2026-08-14) against a
**live PostgreSQL 18.4** server, plus source reading of the installed packages. Where a probe contradicted
the research doc, the probe wins and the deviation is flagged **⚠️ DEVIATION**.

---

## 0. Decisions at a glance

| # | Decision | One-line reason |
|---|---|---|
| D1 | Adapter seam = **4 driver + 2 required connection methods**, plus 6 optional capability methods | Kysely's proven minimum, plus the PG-specific things Kysely structurally cannot carry |
| D2 | **Structural typing** (`PgLikePool`), never `import type … from 'pg'` | zero deps **and** zero peer deps; Neon + Hyperdrive duck-type in for free |
| D3 | **Array row mode always**, `fields[]` metadata always returned | duplicate JOIN column names; no per-row object alloc; OID-driven decode |
| D4 | **Extended protocol always** (`queryMode: 'extended'`), even for 0-param queries | pg silently falls back to *simple* protocol otherwise → multi-statement injection surface |
| D5 | Exec mode is a seam parameter: `'unnamed' \| 'named' \| 'simple'`; default `'unnamed'` | pooler-safe by default (research §5.7); runtime layer (agent 07) owns the policy |
| D6 | **Text result format only in v1.** Binary is off, and the seam keeps the door open | ⚠️ **DEVIATION** — `pg`'s binary result path is byte-corrupting. Proven in §4.4 |
| D7 | Codecs live in ORM core; every adapter's parsers are **neutralised** to identity | Drizzle + Prisma converged here; `pg`, PGlite and postgres.js each get `DATE` wrong differently |
| D8 | `int8` → **`bigint`** · `numeric` → **`string`** · `date` → **`'YYYY-MM-DD'` string** · `timestamp` → **string** · `timestamptz` → **`Date`** | §4.5 |
| D9 | Parameters are **pre-encoded by our codecs** to `string \| Uint8Array \| null`; `bytea` goes out binary | makes `pg`'s `prepareValue` a pure identity — no hidden second encoder |
| D10 | Parameter type OIDs **are** sent, via a verified hybrid `types` value | avoids `42P18 could not determine data type of parameter $1` without polluting SQL with casts |
| D11 | `describe()` (Parse+Describe('S')+Sync, no Execute) is a **first-class seam method** | ⚠️ **DEVIATION** — research said `pg` exposes this; it does not. We implement it via pg's Submittable protocol (§5.2) |
| D12 | Errors cross the seam as **plain data** (`PgServerErrorData`), never as classes | agent 07 owns the error class design; adapters must not need to import it |

---

## 1. Layering

```
┌──────────────────────────────────────────────────────────────────────┐
│  query builder / schema / migrations                                 │  ← agents 03–06
├──────────────────────────────────────────────────────────────────────┤
│  runtime: pool policy, exec-mode policy, transactions, retry, errors │  ← agent 07 (OWNS)
├──────────────────────────────────────────────────────────────────────┤
│  CODEC REGISTRY   encode(TIn)->wire · decode(wire)->TOut             │  ← THIS DOC §4
├──────────────────────────────────────────────────────────────────────┤
│  DRIVER SEAM      PgDriver / PgConnection  (this doc §2)             │  ← THIS DOC §2
├──────────────────────────────────────────────────────────────────────┤
│  adapters: pg (v1, bundled) │ neon │ pglite │ proxy │ community      │  ← THIS DOC §5–6
└──────────────────────────────────────────────────────────────────────┘
```

Two rules that make the whole thing work:

1. **Nothing below the codec registry ever interprets a value.** Adapters return raw wire text
   (`string`) or raw bytes (`Uint8Array`) and `null`. They never produce a `Date`, a `number`, or a parsed array.
2. **Transactions are not driver methods.** `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` / isolation levels are
   identical SQL on every PostgreSQL adapter, so they are emitted *above* the seam by agent 07. This is what
   trims Kysely's seven driver methods to four.

---

## 2. The adapter seam

All of the following is authored to compile under `erasableSyntaxOnly: true` + `verbatimModuleSyntax`
(no `enum`, no `namespace`, no parameter properties) so the sources run unbuilt on Node/Bun/Deno.

### 2.1 Driver — 4 methods

```ts
/** A driver owns a pool of physical connections. One per configured database URL. */
export interface PgDriver {
  /** Idempotent. Resolve config, validate capabilities, warm the pool. Never opens a connection eagerly. */
  init(): Promise<void>

  /**
   * Check out a physical connection. The returned object is owned by the caller until `release`.
   * `signal` aborts the *acquisition* (pool queue wait), not any query on it.
   */
  acquire(options?: PgAcquireOptions): Promise<PgConnection>

  /**
   * Return a connection to the pool. `dispose: true` destroys it instead of reusing it — the runtime
   * layer sets this after a protocol-level failure, an unfinished COPY, or an aborted transaction it
   * could not roll back.
   */
  release(connection: PgConnection, options?: { dispose?: boolean }): Promise<void>

  /** Drain and close everything. Idempotent. Safe to call while queries are in flight (they reject). */
  destroy(): Promise<void>

  /** Static description of what this adapter can do. Read after `init()`. */
  readonly capabilities: PgCapabilities
}

export interface PgAcquireOptions {
  readonly signal?: AbortSignal
  /**
   * Routing hint, not a guarantee. `'direct'` asks for a connection that bypasses any transaction
   * pooler — required for LISTEN, session advisory locks, WITH HOLD cursors, replication and
   * migrations (research §5.7 #8). Adapters without a second URL ignore it.
   */
  readonly route?: 'default' | 'direct'
}
```

### 2.2 Connection — 2 required, 6 optional

```ts
export interface PgConnection {
  /** REQUIRED. Extended-protocol execution. The single hot path. */
  execute(query: PgQuery): Promise<PgResult>

  /**
   * REQUIRED. Server-side cursor. Yields fixed-size chunks; `fields` is repeated on every chunk so a
   * consumer that only sees one chunk can still decode. Closing the iterator (break/return/throw)
   * MUST close the portal.
   */
  stream(query: PgQuery, chunkSize: number): AsyncIterable<PgResultChunk>

  // ── optional capabilities; presence must match `PgDriver.capabilities` ─────────────────────────

  /** Parse + Describe('S') + Sync, with NO Execute. Powers typed raw SQL, codegen and migration checks. */
  describe?(sql: string, options?: { readonly signal?: AbortSignal }): Promise<PgDescribeResult>

  /** Protocol-level `Close('S', name)`. NEVER SQL `DEALLOCATE` (breaks PgBouncer — research §5.2). */
  closeStatement?(name: string): Promise<void>

  /** COPY … FROM STDIN. Resolves with the row count from the CommandComplete tag. */
  copyIn?(sql: string, source: AsyncIterable<Uint8Array>, options?: PgCopyOptions): Promise<PgCopyResult>

  /** COPY … TO STDOUT. Yields raw CopyData payloads; the caller owns framing (text/csv/binary). */
  copyOut?(sql: string, options?: PgCopyOptions): AsyncIterable<Uint8Array>

  /**
   * Best-effort cancellation of whatever is currently executing on this connection.
   * Resolves once the cancel request has been *sent*; the in-flight query rejects separately
   * with SQLSTATE 57014. Safe to call when nothing is running (no-op).
   */
  cancel?(): Promise<void>

  /** Subscribe to async backend messages. Returns an unsubscribe function. */
  on?(event: 'notice', listener: (n: PgNoticeData) => void): () => void
  on?(event: 'notification', listener: (n: PgNotification) => void): () => void
  on?(event: 'error', listener: (e: PgDriverErrorData) => void): () => void

  // ── introspectable state ───────────────────────────────────────────────────────────────────────

  /** Server backend PID, if the adapter knows it. Needed for `pg_cancel_backend` and diagnostics. */
  readonly backendPid: number | undefined

  /** ParameterStatus values captured at startup + any that changed. See §4.7 — we assert on these. */
  readonly serverParameters: Readonly<Record<string, string>>

  /** 'I' idle · 'T' in transaction · 'E' failed transaction · undefined if the adapter can't tell. */
  readonly transactionStatus: 'I' | 'T' | 'E' | undefined

  /** False after a protocol error. The runtime layer must `release(conn, { dispose: true })`. */
  readonly usable: boolean
}
```

### 2.3 The query shape

```ts
export interface PgQuery {
  /** SQL with `$1`-style placeholders. Never interpolated values. */
  readonly text: string

  /**
   * Parameters, ALREADY ENCODED by the codec registry.
   *  - `string`      → sent in text format
   *  - `Uint8Array`  → sent in BINARY format (this is how `bytea` avoids `\x` hex doubling)
   *  - `null`        → SQL NULL
   * Adapters MUST NOT apply any further conversion. If an adapter's driver would (pg's
   * `prepareValue` converts Date/Array/object), passing only these three shapes makes it a no-op.
   */
  readonly params: readonly PgParam[]

  /**
   * Parameter type OIDs, one per param, sent in the `Parse` message. Length must equal
   * `params.length` or be 0. Supplying these is how we avoid `42P18` on bare `$n` without
   * emitting `::type` casts into the SQL text.
   */
  readonly paramTypes?: readonly number[]

  /**
   * How to get this onto the wire. The RUNTIME layer chooses; the seam only obeys.
   *  - 'unnamed' (default) — extended protocol, unnamed statement, Parse+Bind+Describe(P)+Execute+Sync
   *                          in ONE write → 1 RTT, zero server session state, safe on every pooler.
   *  - 'named'             — extended protocol with `statementName`. Server-side plan cache.
   *                          Caller owns the LRU and the `closeStatement` cleanup.
   *  - 'simple'            — simple query protocol. `params` MUST be empty. For DDL scripts,
   *                          `SET`, multi-statement migration bodies, and dumb proxies.
   */
  readonly mode?: PgExecMode

  /** Required iff `mode === 'named'`. ≤ 63 bytes (PG identifier limit). */
  readonly statementName?: string

  /**
   * Result column format. `'text'` is the only value an adapter is REQUIRED to support and the only
   * one v1 emits (see §4.4). `'binary'` is all-or-nothing per query because that is all the
   * protocol's Bind message expresses in every driver we surveyed.
   */
  readonly resultFormat?: 'text' | 'binary'

  /**
   * Cap on rows fetched via the portal in one Execute. `undefined` = all rows.
   * (This is `stream`'s primitive; exposed here for `LIMIT`-less safety valves.)
   */
  readonly maxRows?: number

  /** Aborts the query. Adapters that can MUST issue a real CancelRequest, not just drop the promise. */
  readonly signal?: AbortSignal

  /** Milliseconds. Adapter-enforced client-side deadline. Distinct from server `statement_timeout`. */
  readonly timeoutMs?: number
}

export type PgParam = string | Uint8Array | null

export type PgExecMode = 'unnamed' | 'named' | 'simple'
```

### 2.4 Results and metadata

```ts
export interface PgResult {
  /**
   * ALWAYS array-of-arrays, positionally aligned with `fields`. Values are RAW:
   *   text format   → `string`
   *   binary format → `Uint8Array`
   *   SQL NULL      → `null`
   * Decoding is the codec registry's job, above this seam.
   */
  readonly rows: readonly (readonly PgRawValue[])[]

  /**
   * REQUIRED whenever the statement produced a RowDescription. This is the field Kysely's
   * dialect-neutral `QueryResult` structurally cannot have, and it is what buys us OID-driven
   * decoding, typmod-aware types and nullability derivation.
   */
  readonly fields: readonly PgField[]

  /** From CommandComplete: rows returned/affected. `null` when the tag carries no count. */
  readonly rowCount: number | null

  /** From CommandComplete: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE' | 'COPY' | … */
  readonly command: string

  /** NoticeResponses collected during this statement. Migrations surface `RAISE NOTICE` from these. */
  readonly notices: readonly PgNoticeData[]
}

/** `stream()` chunk. `fields` is repeated on every chunk. `done` marks the final chunk. */
export interface PgResultChunk {
  readonly rows: readonly (readonly PgRawValue[])[]
  readonly fields: readonly PgField[]
  readonly done: boolean
}

export type PgRawValue = string | Uint8Array | null

export interface PgField {
  readonly name: string
  /** OID → codec registry lookup. */
  readonly dataTypeID: number
  /** typmod. `varchar(30)` → 34 (= n + 4); `numeric(10,2)` → 655366 (= ((p<<16)|s) + 4); -1 = none. */
  readonly dataTypeModifier: number
  /** Source table OID, or 0 for computed columns. Join to `pg_attribute` for `attnotnull`. */
  readonly tableID: number
  /** Source column attnum, or 0. Together with `tableID` this disambiguates duplicate JOIN names. */
  readonly columnID: number
  /** Wire size: fixed-width types give a positive byte count, variable-width give -1. */
  readonly dataTypeSize: number
  readonly format: 'text' | 'binary'
}

export interface PgDescribeResult {
  /** Server-inferred parameter OIDs, in `$1..$n` order. */
  readonly paramTypes: readonly number[]
  /** Empty array when the statement returns no rows (protocol `NoData`). */
  readonly fields: readonly PgField[]
}
```

All four `PgField` metadata values were confirmed live: `varchar(30)` → `dataTypeModifier: 34`,
`numeric(10,2)` → `655366`, and a real table column returned `tableID: 16401, columnID: 2`.

### 2.5 COPY, LISTEN/NOTIFY, notices

```ts
export interface PgCopyOptions {
  readonly signal?: AbortSignal
  /** Bytes buffered before backpressure is applied to the source. Default 64 KiB. */
  readonly highWaterMark?: number
}

export interface PgCopyResult {
  readonly rowCount: number
  readonly notices: readonly PgNoticeData[]
}

export interface PgNotification {
  readonly channel: string
  readonly payload: string
  /** PID of the notifying backend. Compare with `connection.backendPid` to ignore self-notifies. */
  readonly processId: number
}
```

`LISTEN`/`NOTIFY` deliberately has **no dedicated seam method**. `LISTEN ch` and `SELECT pg_notify(…)` are
ordinary SQL; the only thing the seam must provide is the *delivery channel*, which is
`connection.on('notification', …)`. The runtime layer is responsible for (a) pinning a `route: 'direct'`
connection for the lifetime of the subscription, (b) re-issuing `LISTEN` after reconnect, and (c) refusing
to `LISTEN` at all when `capabilities.listenNotify` is false. PgBouncer transaction mode forbids `LISTEN`
but permits `NOTIFY` (research §5.1) — that asymmetry is encoded in `PgCapabilities`.

### 2.6 Capabilities

Modelled on Prisma's `ConnectionInfo`, which the research recommends stealing, widened for the things a
PG-only ORM actually branches on.

```ts
export interface PgCapabilities {
  /** Human-readable adapter id for error messages and telemetry. e.g. 'pg', 'neon-ws', 'pglite'. */
  readonly adapter: string

  /** Which exec modes `execute()` honours. 'unnamed' is mandatory for every adapter. */
  readonly execModes: readonly PgExecMode[]

  /** False ⇒ the ORM must never emit `resultFormat: 'binary'`. False for every v1 adapter (§4.4). */
  readonly binaryResults: boolean

  /** False ⇒ the ORM must emit `::type` casts instead of relying on `PgQuery.paramTypes`. */
  readonly paramTypeOids: boolean

  /** False ⇒ typed-raw-SQL and `migrate verify` degrade to executing against a shadow schema. */
  readonly describe: boolean

  /** False ⇒ `fields[].dataTypeModifier / tableID / columnID` are 0/-1. PGlite is false here. */
  readonly richFieldMetadata: boolean

  readonly cursors: boolean
  readonly copyIn: boolean
  readonly copyOut: boolean
  readonly listenNotify: boolean

  /** How `cancel()` is implemented, or `false` if it cannot be. */
  readonly cancel: 'protocol' | 'pg_cancel_backend' | false

  /** False ⇒ interactive transactions are impossible (HTTP one-shot adapters). Blocks `db.transaction()`. */
  readonly multipleStatementsPerSession: boolean

  /** PGlite: 1. Drives whether the concurrency test suite runs against this adapter. */
  readonly maxConnections: number | undefined

  /** Prisma's `maxBindValues`. PG's own wire limit is 65535; poolers/edge backends may be lower. */
  readonly maxParams: number

  /** Populated after `init()` from ParameterStatus. `undefined` before first connect. */
  readonly serverVersionNum: number | undefined
}
```

### 2.7 The escape hatch

One function, modelled on `drizzle-orm/pg-proxy`. The cheapest possible way for a user to put an HTTP
proxy, a queue, or a test double behind the ORM without us maintaining an adapter.

```ts
export type PgRemoteCallback = (
  sql: string,
  params: readonly PgParam[],
  meta: { readonly mode: PgExecMode; readonly paramTypes: readonly number[] },
) => Promise<{ rows: readonly (readonly PgRawValue[])[]; fields: readonly PgField[]; rowCount?: number | null; command?: string }>

export function proxyDriver(fn: PgRemoteCallback, capabilities?: Partial<PgCapabilities>): PgDriver
```

---

## 3. Structural typing — how we import `pg` without importing `pg`

`kysely@0.29.5` has zero deps *and* zero peer deps because it re-declares the subset of `pg` it touches.
We adopt this and extend it to the extra surfaces we use (Submittable, Connection, Cursor).

The declarations below are **verified against the real `pg@8.23.0` runtime and `@types/pg@8.21.0`**, and
against `@neondatabase/serverless@1.1.0`'s inlined `.d.ts` (which is a near-exact copy of the `pg` surface —
`Pool_2.connect(): Promise<PoolClient_2>`, `PoolClient_2 extends ClientBase_2 { release(err?): void }`,
`ClientBase_2.query<T extends Submittable>(q: T): T`).

```ts
// ── src/driver/pg-like.ts ──────────────────────────────────────────────────────────────────────
// We deliberately do NOT `import type { Pool } from 'pg'`. That would force @types/pg on every
// consumer AND would break duck-typed drop-ins: @neondatabase/serverless@1.1.0 inlined its own
// declarations and switched Buffer -> Uint8Array, so *nominal* identity with @types/pg is already
// gone. Structural typing is the only approach that stays robust to that.

/** Subset of `pg.Pool` / Neon's `Pool` / Hyperdrive-fed `pg.Pool` that we need. */
export interface PgLikePool {
  connect(): Promise<PgLikePoolClient>
  end(): Promise<void>
  /** pg-pool exposes the resolved config here; we read host/port/user/database to build a
   *  cancel connection. Verified present on both pg and Neon (`Pool_2.options`). */
  readonly options?: Record<string, unknown>
  readonly totalCount?: number
  readonly idleCount?: number
  readonly waitingCount?: number
}

export interface PgLikePoolClient extends PgLikeClient {
  release(err?: Error | boolean): void
}

export interface PgLikeClient {
  /** Config-object overload — the only one we call. */
  query(config: PgLikeQueryConfig): Promise<PgLikeResult>
  /** Submittable overload. This is pg's real extension seam (§5.2) and Neon re-exports it verbatim. */
  query<T extends PgLikeSubmittable>(submittable: T): T
  on(event: 'notice' | 'notification' | 'error' | 'end', listener: (arg: never) => void): unknown
  /** Present on pg >= 8.21. Optional so a minimal duck-type still satisfies us. */
  getTransactionStatus?(): 'I' | 'T' | 'E'
  readonly processID?: number
  /** Private-ish, but stable since pg 6 and required for describe/copy/close (§5.2). */
  readonly connection?: PgLikeConnection
}

export interface PgLikeQueryConfig {
  text: string
  values?: readonly unknown[]
  name?: string
  rowMode?: 'array'
  /** pg >= 8.12. Forces the extended protocol even with zero parameters. See D4. */
  queryMode?: 'extended'
  binary?: boolean
  /** Per-portal row cap. */
  rows?: number
  query_timeout?: number
  /**
   * OVERLOADED IN pg — see §5.1. Read as an array it supplies Parse parameter OIDs; read as an
   * object it supplies the result-parser table. We pass a value that satisfies both.
   */
  types?: PgLikeTypeSource
}

/** Array of param OIDs that ALSO carries `getTypeParser`. Verified to satisfy both consumers. */
export interface PgLikeTypeSource extends ReadonlyArray<number> {
  getTypeParser(oid: number, format?: 'text' | 'binary'): (raw: string) => unknown
}

export interface PgLikeResult {
  rows: unknown[]
  fields: readonly PgLikeField[]
  rowCount: number | null
  command: string
}

export interface PgLikeField {
  name: string
  tableID: number
  columnID: number
  dataTypeID: number
  dataTypeSize: number
  dataTypeModifier: number
  format: 'text' | 'binary'
}

/** pg dispatches backend messages to whatever object has a `submit` method. */
export interface PgLikeSubmittable {
  submit(connection: PgLikeConnection): Error | null
  handleRowDescription(msg: { fields: readonly PgLikeField[] }): void
  handleDataRow(msg: { fields: readonly (string | null)[] }): void
  handleCommandComplete(msg: { text?: string; command?: string }, connection: PgLikeConnection): void
  handleEmptyQuery(connection: PgLikeConnection): void
  handlePortalSuspended(connection: PgLikeConnection): void
  handleCopyInResponse(connection: PgLikeConnection): void
  handleCopyData(msg: { chunk: Uint8Array }, connection: PgLikeConnection): void
  handleError(err: unknown, connection: PgLikeConnection): void
  handleReadyForQuery(connection: PgLikeConnection): void
  callback?: (err: unknown, result?: unknown) => void
  name?: string
  text?: string
}

/** The low-level protocol writer. Present on pg, Neon (with an extra `more` arg) and pg-cloudflare. */
export interface PgLikeConnection {
  parse(q: { name: string; text: string; types?: readonly number[] }, more?: boolean): void
  bind(c: { portal?: string; statement?: string; values?: readonly unknown[]; binary?: boolean; valueMapper?: unknown }, more?: boolean): void
  describe(m: { type: 'S' | 'P'; name?: string }, more?: boolean): void
  execute(c: { portal?: string; rows?: number }, more?: boolean): void
  close(m: { type: 'S' | 'P'; name?: string }, more?: boolean): void
  sync(): void
  flush(): void
  sendCopyData(chunk: Uint8Array): void
  sendCopyDone(): void
  sendCopyFail(msg: string): void
  on(event: string, listener: (msg: never) => void): unknown
  removeListener(event: string, listener: (msg: never) => void): unknown
  readonly parsedStatements: Record<string, string>
  readonly stream: { cork?(): void; uncork?(): void; destroy(): void }
}
```

Public constructor surface:

```ts
export interface PgDriverConfig {
  /** Anything that duck-types as a pg Pool: pg.Pool, Neon's Pool, a Hyperdrive-fed pg.Pool. */
  pool: PgLikePool
  /** Optional second pool that bypasses a transaction pooler. Used for `route: 'direct'`. */
  directPool?: PgLikePool
  /**
   * Only needed to enable protocol-level `cancel()`, which requires opening a *second* socket.
   * If omitted we fall back to `pg_cancel_backend(pid)` over a pooled connection, and if
   * `directPool` is also absent, `capabilities.cancel` is `false`.
   */
  createCancelClient?: () => PgLikeClient
}

export function pgDriver(config: PgDriverConfig): PgDriver
```

**Consequence:** `pg-orm-ts`'s `package.json` has `"dependencies": {}`, `"peerDependencies": {}`, and
`@types/pg` only in `devDependencies` (for our own adapter tests). TLS, SCRAM-SHA-256(-PLUS) channel
binding, `sslnegotiation=direct`, `.pgpass`, `PGSERVICEFILE`, unix sockets, `keepAlive`, `application_name`
and every other connection concern are configured **on the user's own `Pool`** and pass through us
untouched. We never parse a connection string and never own a credential. This is a deliberate
non-goal — it is also the single biggest reason we avoid inheriting `pg`'s CVE surface.

---

## 4. The codec boundary

### 4.1 Why the ORM owns decoding — re-verified, not assumed

Three drivers, one `DATE`, three different wrong answers (all measured today, machine in UTC−5):

| Driver | `SELECT '2026-08-14'::date` decodes to | Verdict |
|---|---|---|
| `pg@8.23.0` (via `pg-types@2.2.0`) | `Date` = `2026-08-13T19:00:00.000Z` | **the day shifted backwards** |
| `@electric-sql/pglite@0.5.5` | `Date` = `2026-08-14T00:00:00.000Z` | different answer, same class of lie |
| `postgres@3.4.9` | `new Date(x)` — engine-dependent | third answer |

And naive `timestamp`: `pg` → `2026-08-14T07:00:00.000Z`, PGlite → `2026-08-14T07:00:00.000Z` (both reinterpret
a zoneless value as local time). And `int8`: `pg` → `string`, PGlite → `bigint`, `postgres.js` → `string`.

SUMMARY §5 promises *"`numeric`/`timestamptz` decode identically everywhere, `DATE` never shifts a day."*
That promise is only keepable by neutralising every adapter's parsers. Confirmed feasible on all three:

* **pg** — pass `types` per query or per pool. Verified: a per-query `{ getTypeParser: () => v => v }` on a
  pool constructed *without* any `types` option returned raw strings for `int8`, `date`, `timestamptz` and
  `numeric`. This matters a lot: it means **we do not need to control how the user constructs their Pool.**
* **PGlite** — `query(sql, params, { parsers })`. ⚠️ Must be a **plain object with explicit numeric OID
  keys**; a `Proxy` with a `has`/`get` trap is silently ignored (PGlite spreads the object). Verified.
* **postgres.js** (future community adapter) — mutate `client.options.parsers[oid]`, as Drizzle does.

### 4.2 `Codec<TIn, TOut>`

```ts
/**
 * A codec is the ONLY place a PostgreSQL type meets a TypeScript type.
 *
 *  TIn  — what a user may pass as a parameter / insert value  (accepts a superset, e.g. bigint | number | string)
 *  TOut — what a SELECT of this column yields                 (exactly one type, no unions unless the DB has one)
 */
export interface Codec<TIn, TOut> {
  /** Stable identifier, used in error messages, config overrides and the schema DSL. e.g. 'int8', 'numeric:number'. */
  readonly name: string

  /**
   * The OID this codec claims. `undefined` for codecs bound to a user-defined type whose OID is
   * resolved at connect time (§4.6) — the registry fills it in.
   */
  readonly oid: number | undefined

  /**
   * OID sent in `Parse` for a parameter carrying this codec. Usually === `oid`. Differs when we
   * deliberately widen (we send `text`/`unknown` (705) for domains so PG applies the domain's own cast).
   */
  readonly paramOid: number | undefined

  /**
   * Encode a JS value to the wire.
   *  - return `string`      → text format
   *  - return `Uint8Array`  → binary format (currently only `bytea`)
   *  - return `null`        → SQL NULL
   * MUST NOT throw for values inside the declared TIn; MUST throw `PgEncodeError` outside it.
   */
  encode(value: TIn): PgParam

  /** Decode raw wire text. `null` never reaches here — the registry short-circuits it. */
  decodeText(raw: string, ctx: CodecContext): TOut

  /** Decode raw wire bytes. Optional; unimplemented for every built-in except `bytea` in v1 (§4.4). */
  decodeBinary?(raw: Uint8Array, ctx: CodecContext): TOut

  /**
   * How this value is rendered by the ORM's explicit `serialize()` (SUMMARY §4: no implicit toJSON).
   * Needed because `bigint` and `Uint8Array` are not JSON-representable.
   */
  toJson?(value: TOut): unknown

  /** For the schema DSL: the SQL type name to emit in DDL. */
  readonly sqlName: string
}

export interface CodecContext {
  /** typmod from `PgField.dataTypeModifier`. `numeric(10,2)` codecs read scale from here. */
  readonly typmod: number
  /** The live registry, so container codecs (array/range/composite) can recurse. */
  readonly registry: CodecRegistry
  /** Session ParameterStatus. Codecs assert on DateStyle / IntervalStyle rather than guessing (§4.7). */
  readonly serverParameters: Readonly<Record<string, string>>
}
```

`PgParam` here is exactly the seam's `PgParam` — the codec output type *is* the driver input type. That is
the whole point of the boundary: there is no third representation in between.

### 4.3 The registry

```ts
export interface CodecRegistry {
  /** Hot path. Called once per column per RowDescription, never per row. */
  forOid(oid: number): Codec<unknown, unknown> | undefined

  /** Schema-DSL path: `registry.byName('numeric:number')`. */
  byName(name: string): Codec<unknown, unknown> | undefined

  /**
   * Build a decoder plan for one RowDescription. Returns a positional array of
   * `(raw: PgRawValue) => unknown`, with nulls short-circuited and typmod already bound.
   * This is what makes decoding ~1 monomorphic call per cell.
   */
  planFor(fields: readonly PgField[]): readonly ((raw: PgRawValue) => unknown)[]

  /** Register or override. Throws on an OID collision unless `{ override: true }`. */
  register(codec: Codec<never, unknown>, options?: { override?: boolean }): void

  /**
   * Resolve user-defined types by qualified name -> OID against the live catalogue, then derive
   * array / range / multirange / domain / composite codecs automatically. Idempotent; run once per
   * physical database on first connect and cached by `(database, catalogue fingerprint)`.
   */
  resolveDynamic(connection: PgConnection, requests: readonly DynamicTypeRequest[]): Promise<void>

  /** True once every requested dynamic type has an OID. Queries are blocked until then. */
  readonly resolved: boolean
}

export interface DynamicTypeRequest {
  /** Schema-qualified: `{ schema: 'public', name: 'mood' }`. `schema` omitted ⇒ resolved via search_path. */
  readonly schema?: string
  readonly name: string
  /** What the schema DSL declared it as; a mismatch against `pg_type.typtype` is a hard error. */
  readonly kind: 'enum' | 'composite' | 'domain' | 'range' | 'multirange' | 'base'
  /** For enums: the TS union the user declared. Mismatch against `pg_enum` is a hard error at connect. */
  readonly enumLabels?: readonly string[]
  /** For composites: field name -> codec name. */
  readonly fields?: Readonly<Record<string, string>>
}
```

**The single query that powers `resolveDynamic`** (verified live on PG 18.4; PG 15+ compatible):

```sql
SELECT t.oid, t.typname, n.nspname, t.typtype, t.typcategory,
       t.typarray, t.typelem, t.typbasetype, t.typrelid, t.typdelim,
       r.rngsubtype, r.rngmultitypid
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
LEFT JOIN pg_range r ON r.rngtypid = t.oid
WHERE (n.nspname, t.typname) = ANY($1::text[][])
```

Derivation rules, all verified against a live catalogue:

| `typtype` | Derived codec | Source columns |
|---|---|---|
| `e` enum | `enumCodec(labels)` — decode is identity + membership check | `pg_enum.enumlabel ORDER BY enumsortorder` |
| `c` composite | `compositeCodec(fieldCodecs)` — PG record literal grammar | `pg_attribute` where `attnum > 0 AND NOT attisdropped` |
| `d` domain | delegates to `typbasetype`'s codec; `paramOid` widened to `unknown` (705) | `t.typbasetype` |
| `r` range | `rangeCodec(subtypeCodec)` | `pg_range.rngsubtype` |
| `m` multirange | `multirangeCodec(rangeCodec)` | `pg_range.rngmultitypid` |
| any | **array** codec auto-derived from `t.typarray`, using `t.typdelim` | `typarray`, `typdelim` |

⚠️ **`typdelim` is not always `,`** — verified: `box` and `_box` use `;`. The array text parser must take the
delimiter from the catalogue, not hard-code a comma. Every hand-rolled PG array parser that assumes `,`
is wrong for geometry columns.

### 4.4 Binary vs text — DECIDED: **text only in v1**

⚠️ **DEVIATION from research §7.5**, which specified *"binary result format: on for the hot numeric/temporal
subset."* That is not implementable on `pg` and would silently corrupt data.

**The proof.** `pg-protocol@1.16.0`'s wire parser UTF-8-decodes every `DataRow` field unconditionally:

```js
// pg-protocol/dist/parser.js
const parseDataRowMessage = (reader) => { … fields[i] = len === -1 ? null : reader.string(len) … }
// buffer-reader.js
string(length) { return this.buffer.toString('utf-8', this.offset, this.offset + length) }
// parser.js constructor
if (opts?.mode === 'binary') { throw new Error('Binary mode not supported yet') }
```

`pg/lib/result.js` then tries to undo this for binary columns with `Buffer.from(rawValue)` — re-encoding a
string that has already lost bytes. Live measurement against PostgreSQL 18.4 with
`{ binary: true, queryMode: 'extended' }` (field formats *did* come back as `'binary'`, so the server
really did send binary):

| Expression | Correct binary bytes | What `pg` delivered | |
|---|---|---|---|
| `128::int4` | `00 00 00 80` | `00 00 00 ef bf bd` (6 bytes) | ❌ |
| `1.5::float8` | `3f f8 00 00 00 00 00 00` | `3f ef bf bd 00 00 00 00 00 00` (10 bytes) | ❌ |
| `'550e…'::uuid` | 16 bytes | 19 bytes, three U+FFFD | ❌ |
| `9007199254740993::int8` | `00 20 00 00 00 00 00 01` | identical | ✅ **by luck** — every byte is valid UTF-8 |
| `'abc'::text` | `61 62 63` | identical | ✅ |

Any binary payload containing a byte ≥ 0x80 that is not part of a valid UTF-8 sequence is replaced with
`EF BF BD`. That is *most* numeric and temporal values. `binary: true` in `pg` is a data-corruption bug for
exactly the types the research wanted to use it for.

Two further, independent nails:

* **`pg` cannot express per-column binary anyway.** `pg-protocol`'s `bind()` writes a single result format
  code for all columns: `writer.addInt16(1); writer.addInt16(binary ? 1 : 0)`. Binary is all-or-nothing per
  query in every driver surveyed.
* **`binary: true` is silently ignored for parameterless queries.** `Query.requiresPreparation()` returns
  false when there are no values, so `pg` falls back to the *simple* query protocol which is text-only.
  Live-confirmed: field formats came back `'text'`. This is the same trap as D4.

**Therefore:**

| Direction | Format | Rationale |
|---|---|---|
| **Results** | **text, always** | the only format `pg` transports without corruption; the only format `postgres.js` supports at all; keeps results byte-identical across adapters (SUMMARY §5 promise #4) |
| **Parameters — `bytea`** | **binary** (`Uint8Array`) | verified working: `pg`'s serializer sets format code 1 per-parameter for any `ArrayBuffer.isView` value. Avoids the 2× size of `\x` hex. Live: `$1::bytea` with `new Uint8Array([0,255,128])` → `length = 3` ✅ |
| **Parameters — everything else** | **text** (`string`) | one format, one code path, and it makes `pg`'s `prepareValue` a pure identity |

Text is not a meaningful perf loss here. The binary win is concentrated in `float8`/`int4` array-heavy
workloads; for the ORM's actual hot path — a few dozen scalar columns per row — the cost is one
`parseInt`/`parseFloat`/`new Date` per cell either way, and text `numeric` is *cheaper* than binary
`numeric` (base-10000 digit groups) while being exactly lossless.

**We keep the seam.** `PgQuery.resultFormat`, `Codec.decodeBinary` and `PgCapabilities.binaryResults` all
exist and are wired. The day we ship an own-wire adapter, or `pg-protocol` grows a real binary mode, the
switch is a capability flip with zero public API change.

### 4.5 Built-in decoding policy

All raw text below is **measured** from PostgreSQL 18.4 with identity parsers installed.

#### The three decisions the mandate asks for

**`int8` (OID 20) → `bigint`.**
`int8` is the type of every `bigserial` primary key and of `count(*)`. `number` silently loses precision above
2^53 — verified: `9007199254740993` is a real, storable `int8` that `number` cannot hold. `string` is safe but
turns every id comparison into a string compare and makes arithmetic a user problem. `bigint` is a native JS
primitive, exact for the full `[-9223372036854775808, 9223372036854775807]` range (both endpoints verified to
round-trip as text), universally available on Node ≥ 22, and is already PGlite's default — so choosing it
*reduces* cross-adapter divergence. Its one cost, `JSON.stringify` throwing, is already handled: SUMMARY §4
commits us to an explicit `serialize()` rather than implicit `toJSON`, and `Codec.toJson` exists precisely for
this. Overrides ship in the box: `int8:number` (range-checked, throws above 2^53) and `int8:string`.
`count()` in the query builder binds `int8:number` explicitly, because a count exceeding 2^53 is not a real
scenario and `bigint` there is pure friction.

**`numeric` / `decimal` (OID 1700) → `string`.**
There is no lossless JS primitive for arbitrary-precision decimal, and we have **zero runtime dependencies**,
so we cannot ship a `Decimal`. `number` is wrong twice over: it loses precision beyond 17 significant digits
*and* it loses scale, which is semantically meaningful (`numeric(10,2)` renders `1.10`, not `1.1` — measured).
Text also carries the values no JS number type can: `'NaN'`, `'Infinity'`, `'-Infinity'` (PG 14+, all measured).
So the default is the exact PG text, unmodified. Users bring their own decimal library through one
registration: `registry.register(decimalCodec(Decimal))`. Ships in the box: `numeric:number` (documented as
lossy) and `numeric:bigint` (scale 0 only, throws otherwise).
**`money` (OID 790) → `string`, and the schema DSL warns on it** — its text form is `$12.34`, formatted by
`lc_monetary`, so it is not portably parseable. Use `numeric`.

**`date` (OID 1082) → `string`, `'YYYY-MM-DD'`. Never a `Date`. This is the headline correctness guarantee.**
A `DATE` has no time and no time zone. Every mapping to `Date` must invent both, and every driver invents
differently (§4.1). Measured with `pg`'s default parser in a UTC−5 process, `'2026-08-14'` becomes
`2026-08-13T19:00:00.000Z` — **the calendar day changes**, which is a silent, timezone-dependent, ships-to-prod
data bug. `'YYYY-MM-DD'` is lossless, sorts lexicographically, round-trips as a parameter byte-for-byte, is
JSON-safe, and is what Prisma's `@prisma/adapter-pg` independently chose. The type is a branded
`PgDateString` so it cannot be confused with an arbitrary string. Values outside the ISO shape are preserved
verbatim rather than rejected — all measured: `'infinity'`, `'-infinity'`, `'0001-01-01 BC'`,
`'294276-12-31'`. When `Temporal` is available at runtime we ship `date:temporal` →
`Temporal.PlainDate` as an **opt-in** codec, feature-detected; it does not become the default while any
supported Node version lacks it.

#### Full built-in table

OIDs below were dumped from `pg_catalog.pg_type` on PostgreSQL 18.3 (not from memory). The shipped map is
**generated** by this same query in a build step and asserted in CI against a PG 15/16/17/18 matrix, because
some OIDs are version-dependent (the multirange array OIDs in particular).

| OID | array OID | Type | Raw text measured | → TS default | Rationale / trap |
|---|---|---|---|---|---|
| 16 | 1000 | `bool` | `t` / `f` | `boolean` | single-char compare, not `Boolean(x)` |
| 17 | 1001 | `bytea` | `\x00ff80` | `Uint8Array` | decode hex; **encode binary** (§4.4). Not `Buffer` — Neon dropped it |
| 18 | 1002 | `char` | | `string` | |
| 19 | 1003 | `name` | | `string` | |
| **20** | 1016 | **`int8`** | `9007199254740993` | **`bigint`** | see above |
| 21 | 1005 | `int2` | `1` | `number` | always safe |
| 23 | 1007 | `int4` | `128` | `number` | always safe |
| 25 | 1009 | `text` | | `string` | identity — zero-cost |
| 26 | 1028 | `oid` | `1259` | `number` | unsigned 32-bit, safe |
| 114 | 199 | `json` | `{"a": 1,   "b":2}` | `unknown` | **exact source text preserved by PG** — `JSON.parse` |
| 142 | 143 | `xml` | `<a/>` | `string` | no parsing, ever |
| 600–718 | | `point`,`lseg`,`path`,`box`,`polygon`,`line`,`circle` | `(1,2)` | structured objects | ⚠️ `box` has `typdelim = ';'` |
| 650 / 869 | 651 / 1041 | `cidr` / `inet` | `10.1.0.0/16` | `string` | round-trips exactly; parsing adds nothing |
| 700 | 1021 | `float4` | | `number` | |
| 701 | 1022 | `float8` | `0.30000000000000004`, `NaN`, `Infinity` | `number` | text is the **exact** shortest round-trip repr; must special-case NaN/±Infinity |
| 774 / 829 | 775 / 1040 | `macaddr8` / `macaddr` | `08:00:2b:01:02:03` | `string` | |
| **790** | 791 | `money` | `$12.34` | `string` + DSL warning | `lc_monetary`-dependent |
| 1042 | 1014 | `bpchar` | `"ab   "` | `string` | **PG space-pads** — measured; do not trim |
| 1043 | 1015 | `varchar` | | `string` | typmod carries `n` |
| **1082** | 1182 | **`date`** | `2026-08-14` | **`PgDateString`** | see above |
| 1083 | 1183 | `time` | `04:05:06.789` | `string` | µs precision `Date` cannot hold |
| **1114** | 1115 | **`timestamp`** | `2026-08-14 12:00:00.123456` | **`PgTimestampString`** | zoneless; any `Date` invents a zone. µs preserved. Verbatim wire text |
| **1184** | 1185 | **`timestamptz`** | `2026-08-14 06:30:00.123456+00` | **`Date`** | the one temporal type where `Date` is semantically right. See caveats ↓ |
| 1186 | 1187 | `interval` | `1 year 2 mons 3 days 04:05:06.789` | `{ years, months, days, hours, minutes, seconds }` | requires `IntervalStyle = postgres` (§4.7). Negative components measured |
| 1266 | 1270 | `timetz` | `04:05:06+05:30` | `string` | the offset is meaningless without a date; never coerce |
| 1560/1562 | 1561/1563 | `bit`/`varbit` | `101` | `string` | |
| **1700** | 1231 | **`numeric`** | `1.10`, `NaN`, `Infinity` | **`string`** | see above |
| 2249 | 2287 | `record` | `("a,b""c",5)` | `unknown[]` | anonymous records: no field names available |
| 2950 | 2951 | `uuid` | `550e8400-…` (lowercased by PG) | `string` | measured: PG normalises case |
| 3220 | 3221 | `pg_lsn` | | `string` | |
| 3614/3615 | 3643/3645 | `tsvector`/`tsquery` | `'fox':3 'quick':2` | `string` | |
| **3802** | 3807 | `jsonb` | `{"a": 1}` | `unknown` | ⚠️ **PG reformats jsonb** (key order, whitespace) — measured. Never compare text |
| 4072 | 4073 | `jsonpath` | | `string` | |
| 3904/3906/3908/3910/3912/3926 | +1 each | ranges | `[1,5)`, `empty`, `(,6)` | `PgRange<T>` | ⚠️ `pg-types@2.2.0` leaves these as raw strings — one of the gaps we close |
| 4451/4532/4533/4534/4535/4536 | 6150–6157 | multiranges | `{[1,5),[10,20)}` | `PgRange<T>[]` | PG 14+. Array OIDs are version-dependent → generate them |
| — | — | user enum / domain / composite | | union / base / object | §4.6 — **this is the moat** |

**`timestamptz` caveats, decided:**

1. **Microsecond truncation.** PG stores µs; `Date` holds ms. The default codec truncates. Ships alongside:
   `timestamptz:string` (exact, verbatim wire text) for anyone who needs µs. Documented, not hidden.
2. **`infinity` / `-infinity`.** These are legal `timestamptz` values and have no `Date` representation.
   The default codec **throws** `PgDecodeError` naming the column and pointing at `timestamptz:string`.
   Rejected alternatives: mapping to `new Date(±8.64e15)` (a silent lie), and widening the type to
   `Date | 'infinity' | '-infinity'` (union noise on every timestamp column in the schema). An error on a
   rare, deliberate value beats a wrong answer discovered three months later.
3. **The offset in the text is `TimeZone`-dependent** — measured: the same instant rendered `+00` on a UTC
   server and `+05` on a PGlite instance. The decoder parses whatever offset is present and produces an
   absolute instant, so the *value* is TimeZone-independent. Do not assume `+00`.

#### Encoding policy

```ts
// The complete set of shapes an adapter ever sees. Nothing else crosses the seam.
type PgParam = string | Uint8Array | null
```

* `bigint` → `String(v)`; `number` → range-checked then `String(v)` (rejects `NaN`/`Infinity` for integer types).
* `boolean` → `'t'` / `'f'`.
* `Date` → **we never call `pg`'s `dateToString`.** Our `timestamptz` encoder emits
  `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC, unambiguous). `pg`'s own version emits a *local-offset* string with
  hand-rolled BC handling; keeping it out of the path removes a whole class of environment-dependent bugs.
* arrays → our own array-literal writer, using the element codec and the catalogue `typdelim`, with correct
  `NULL` / quote / backslash escaping. Measured target grammar: `{a,"b,c",NULL,"{}","NULL"}` — note that the
  *string* `'NULL'` must be quoted while a real null must not be.
* `bytea` → `Uint8Array`, passed straight through as a binary parameter.
* Everything else → the codec's `encode`. **No `JSON.stringify` fallback and no `toPostgres()` duck-typing**:
  an unregistered type is a compile-time error in the schema DSL and a `PgEncodeError` at runtime. `pg`'s
  implicit `JSON.stringify(obj)` fallback is exactly the kind of silent coercion we exist to remove.

### 4.6 User-defined types — the part no general driver can do

Prisma collapses every OID `>= 16384` to `ColumnTypeEnum.Text` because it must span four databases.
Being PG-only, we resolve them. Verified live:

```
oid    typname     nsp     typtype typcat typarray typelem typbase typrelid rngsub delim
16422  mood        public  e       E      16421    0       0       0        —      ,
16421  _mood       public  b       A      0        16422   0       0        —      ,
16420  addr        public  c       C      16419    0       0       16418    —      ,
16430  pos         public  d       N      16429    0       23      0        —      ,
16435  numrange2   public  r       R      16432    0       0       0        1700   ,
```

* enum `mood` → labels `['sad','ok','happy']` (from `pg_enum ORDER BY enumsortorder`) → TS union
  `'sad' | 'ok' | 'happy'`, decode = identity + membership assert.
* composite `addr` → `pg_attribute` gives `street:25`, `zip:23` → object codec over the record grammar.
  Measured wire text, including the escaping we must handle: `("a,b""c",5)`, `(,)` for all-null, and
  `{"(x,1)","(y,2)"}` for an array of composites.
* domain `pos` → `typbasetype = 23` → delegate to `int4`.
* range `numrange2` → `rngsubtype = 1700` → `rangeCodec(numeric)`.
* every one of the above gets its array codec for free from `typarray`.

**Resolution happens once per physical database on first connect** and is cached against a catalogue
fingerprint. OIDs of user types are *not* stable across databases (dev vs prod vs shadow), so they are
never baked into generated code — only names are. A label/attribute mismatch between the TS schema and
`pg_catalog` is a **hard error at connect**, not a runtime surprise: this is the `migrate verify` story
extended to types.

### 4.7 Session GUCs the codecs depend on — asserted, not assumed

Captured from `ParameterStatus` at startup. `pg` emits these on the connection but **does not store them**
(verified: no `parameterStatus` handler in `client.js`), so the adapter subscribes and populates
`PgConnection.serverParameters`. Live capture from PG 18.4:

```
DateStyle "ISO, MDY"  ·  IntervalStyle "postgres"  ·  TimeZone "UTC"  ·  integer_datetimes "on"
standard_conforming_strings "on"  ·  client_encoding "UTF8"  ·  server_version "18.4"
·  search_path "\"$user\", public"   ← PG 18 added search_path to ParameterStatus
```

On first connect we assert:

| GUC | Requirement | If violated |
|---|---|---|
| `DateStyle` | must start with `ISO` | **throw** — every date/timestamp codec assumes ISO output |
| `IntervalStyle` | `postgres` or `iso_8601` | throw on `sql_standard` / `postgres_verbose`; we implement the two grammars we can parse |
| `client_encoding` | `UTF8` | **throw** — the whole wire layer is UTF-8 |
| `standard_conforming_strings` | `on` | **throw** — our literal escaping assumes it |
| `integer_datetimes` | `on` | throw (float-datetime builds are pre-PG10 and unsupported) |
| `TimeZone` | any | no requirement — every temporal codec is offset-driven |

We do **not** `SET` these ourselves. `SET` is forbidden under transaction pooling (research §5.1) and a reset
query is forbidden outright (`DISCARD ALL` clears PgBouncer's prepared-statement tracking and pins RDS
Proxy). Users who need to change them do so via their own `Pool`'s startup `options`.

---

## 5. The `pg` adapter — implementation notes that are load-bearing

### 5.1 The `types` field is overloaded, and we exploit it

`pg` reads `query.types` twice with two different meanings:

```js
// pg/lib/query.js:212  — as an ARRAY of parameter type OIDs for the Parse message
connection.parse({ text: this.text, name: this.name, types: this.types })
// pg/lib/query.js:28   — as an OBJECT with getTypeParser, for result parsing
this._result = new Result(this._rowMode, this.types)
```

**We satisfy both with one value: an array of param OIDs carrying a `getTypeParser` own-property.**

```ts
function typeSource(paramOids: readonly number[]): PgLikeTypeSource {
  const a = paramOids.slice() as number[] & { getTypeParser?: unknown }
  a.getTypeParser = () => identity           // neutralise ALL of pg's parsers
  return a as PgLikeTypeSource
}
const identity = (v: string) => v
```

Verified live: `{ text: 'select $1 as a, $2 as b, pg_typeof($1)::text', values: ['9007199254740993','x'],
types: typeSource([20, 25]) }` → `pg_typeof($1)` = `bigint`, and every result value came back as a raw
`string`. Both consumers satisfied by one object. (Without param OIDs, a bare `$1` fails with
`42P18 could not determine data type of parameter $1` — measured. This trick is what lets us keep `::type`
casts out of the generated SQL.)

It also works with `paramOids = []`: `serialize.parse` does `types.length → undefined` and
`Writer.addInt16(undefined)` computes `undefined >>> 8 === 0`, writing zero parameter OIDs. Verified safe
with 0, 1 and 3 parameters.

**Consequence:** the adapter needs no control over how the user built their `Pool`. A pool constructed with
no `types` option at all still yields raw text, because we override per query. This is what makes
`pgDriver({ pool })` (Kysely-style, user-supplied pool) work without compromising the codec boundary.

### 5.2 The Submittable protocol is pg's real extension seam

`Client.prototype.query` branches on `typeof config.submit === 'function'` and then routes every backend
message to that object's `handleX` methods. This is how `pg-cursor` and `pg-copy-streams` work, and it is
how we implement three things `pg`'s public API does not offer:

* **`describe()`** — ⚠️ **DEVIATION.** Research §4.4 claims `pg` exposes Describe-without-Execute. It does
  not: driving `client.connection.parse/describe/sync` directly crashes the client with
  `Error: Received unexpected parseComplete message from backend` (measured), because `Client._handleParseComplete`
  requires an `activeQuery`. Implemented as a Submittable it works cleanly. Verified against PG 18.4:

  ```
  describe('select $1::int8 as big, $2::varchar(30) as t, now() as n, 1.5::numeric(10,2) as num')
    → paramTypes [20, 1043]
    → fields  big:20/typmod=-1 · t:1043/typmod=34 · n:1184/typmod=-1 · num:1700/typmod=655366
  describe('select id, nm, opt from nt where id = $1')
    → fields  id:23 tbl=16401 col=1 · nm:25 tbl=16401 col=2 · opt:25 tbl=16401 col=3
  ```
  and errors surface normally (`42P01`, `position: 15`) with the connection left fully usable.
  `ParameterDescription` is not in `Client._attachListeners`, so the Submittable subscribes to
  `connection.on('parameterDescription')` itself and unsubscribes in `handleReadyForQuery` — no conflict.
  Joining `tableID`/`columnID` to `pg_attribute.attnotnull` yields the **nullability** the protocol
  otherwise cannot give (verified: `nt` → `id:t, req:t, opt:f`).

* **`closeStatement()`** — protocol `Close('S', name)` + `Sync`, never SQL `DEALLOCATE` (the exact thing
  that broke PHP/PDO against PgBouncer). One integration detail: **`pg` does not update its own
  `connection.parsedStatements` bookkeeping on Close**, so the adapter must
  `delete connection.parsedStatements[name]` as well. Verified: after doing both, re-`Parse`ing the same
  name with *different* SQL succeeds; without it, `pg` raises
  `Prepared statements must be unique - 'ps1' was used for a different statement`.

* **`copyIn` / `copyOut`** — the same seam `pg-copy-streams` uses. Implementing it ourselves (~120 LOC)
  keeps `pg-copy-streams` out of the dependency graph, which matters because it is the one package in this
  stack **not** maintained by the `pg` authors (last publish 2025-05-27). Behaviour parity confirmed against
  the real package: `COPY … FROM STDIN (FORMAT csv)` → `rowCount: 2`; `COPY … TO STDOUT` → exact bytes.

### 5.3 Always force the extended protocol

`Query.requiresPreparation()` returns `false` when `values` is empty, so `pg` silently downgrades to the
**simple query protocol**. Measured consequences:

```
{ text: 'select 1 as a; select 2 as b' }                          → succeeds, returns an ARRAY of 2 results
{ text: 'select 1 as a; select 2 as b', queryMode: 'extended' }   → 42601 cannot insert multiple commands
                                                                    into a prepared statement
```

The simple path also makes `binary: true` a no-op and runs multi-statement strings in an implicit
transaction. **The adapter sets `queryMode: 'extended'` on every `execute()` except `mode: 'simple'`.**
This turns "someone concatenated a string into SQL" from a multi-statement RCE-shaped bug into a server-side
`42601`. That defence-in-depth is worth more than the microseconds it costs.

### 5.4 Cancellation — two paths, both verified

| Path | Mechanism | Verified result | Constraint |
|---|---|---|---|
| `'protocol'` | `new Client(cfg)` **without** `.connect()`, then `.cancel(target, target._activeQuery)` → second socket, `CancelRequest` | `57014 canceling statement due to user request` in 206 ms; connection usable afterwards | ⚠️ the canceller **must be unconnected** — calling `.connect()` first fails with `EISCONN` (measured). Requires `createCancelClient` in config, and requires the target's `_activeQuery`, which we have because we own the Submittable. Does not traverse most poolers |
| `'pg_cancel_backend'` | `SELECT pg_cancel_backend($1)` from a second pooled connection | `57014` in 205 ms; connection usable afterwards | needs `backendPid` and a spare connection; risks deadlock if the pool is exhausted → the runtime layer must use a reserved connection or the direct pool |

**Not a cancellation path:** `pg`'s `query_timeout`. Measured — it rejects with a plain
`Error: Query read timeout` and the client stays usable, **but the query keeps running on the server**. It is
a client-side give-up, not a cancel. The seam therefore exposes `timeoutMs` (client deadline) and `signal`
(real cancel) as separate, composable things, and the adapter fires a genuine cancel when `signal` aborts.
Server-side `statement_timeout` is a third, orthogonal control the user sets on their own pool.

### 5.5 Pipelining — the research over-stated the risk

⚠️ **DEVIATION (in `pg`'s favour).** Research §1.4 reads `pg@8.23.0` as destroying the connection on any
error in pipeline mode. Re-reading `client.js`, the `connection.stream.destroy()` call at line 726 sits
inside the **`query_timeout`** handler, not the general error path. Measured with `pipeline: true`:

```
Promise.all([select 1, select 2, select 3])   → [['1'],['2'],['3']]
Promise.allSettled([select 1/0, select 2])    → ['rejected:22012', 'fulfilled:ok']
subsequent query                              → succeeds; connection healthy
```

Per-query error isolation is intact. It remains **opt-in** for v1 anyway (research §7.5), because
`query_timeout` *does* destroy the connection under pipelining and because pipelining interacts badly with
interactive transactions — but the reason is narrower than recorded, and pipelining is a credible v1.1
default for read-only batches.

### 5.6 Row shape

`Result._parseRowAsArray` writes `null` directly for SQL NULL without consulting the parser (verified:
`select null::int8, null::text, 1::int8` → `[null, null, '1']`), so the codec layer never sees `null` and can
be non-nullable in its signature. Array row mode also skips `pg`'s `{ ...prebuiltEmptyResultObject }` clone
per row — the allocation Drizzle and Prisma both cite for choosing it.

---

## 6. Neon / Hyperdrive / PGlite / postgres.js

Verified against the packages installed today.

### 6.1 `@neondatabase/serverless@1.1.0` — **zero adapter code**

Its `.d.ts` (fully inlined; no `@types/pg` dependency since 1.1.0) declares exactly the shapes our
`PgLikePool` names:

```ts
declare class Pool_2 extends EventEmitter {
  options: PoolOptions
  connect(): Promise<PoolClient_2>
  end(): Promise<void>
  readonly totalCount: number; readonly idleCount: number; readonly waitingCount: number
}
declare interface PoolClient_2 extends ClientBase_2 { release(err?: Error | boolean): void }
declare class ClientBase_2 extends EventEmitter {
  query<T extends Submittable>(queryStream: T): T          // ← Submittable supported
  query<R extends any[]>(cfg: QueryArrayConfig<I>, …): Promise<QueryArrayResult<R>>   // rowMode:'array'
  setTypeParser(…); getTypeParser(…)
}
export interface CustomTypesConfig { getTypeParser: (id, format?) => any }   // ← identical to pg
export interface QueryConfig<I> { name?; text; values?; types?: CustomTypesConfig }
export declare class Connection extends EventEmitter { parse(q, more); bind(c, more); describe(m, more); … }
export declare class DatabaseError extends Error { severity; code; detail; position; … }   // pg-identical
```

`neonConfig.poolQueryViaFetch` and WebSocket transport are transport details below our seam. **Verdict:
`pgDriver({ pool: new NeonPool({ connectionString }) })` type-checks and works with no adapter code.** Two
notes: (a) `Connection`'s methods take an extra trailing `more?: boolean` — our `PgLikeConnection`
declares it optional, so calls remain valid and merely flush per message; (b) the one-shot HTTP mode
(`neon(sql)` tagged template) is a *different* object with no session — it needs the `proxyDriver` escape
hatch and `multipleStatementsPerSession: false`, which blocks interactive transactions at the type level.

### 6.2 Cloudflare Hyperdrive — **zero adapter code**

Hyperdrive is not a driver. It hands the Worker a connection string
(`env.HYPERDRIVE.connectionString`) that you feed to an ordinary `pg` `Pool`/`Client`; Cloudflare's docs
name node-postgres (≥ 8.13.0) the recommended driver with "best compatibility with Hyperdrive's caching."
So the integration is `pgDriver({ pool: new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 5 }) })`.
`pg-cloudflare@1.4.0` (already an optional dep of `pg`) supplies the socket shim. Hyperdrive supports
**named** prepared statements and explicitly notes that unnamed statements get no cross-connection caching
benefit — so this is the one deployment where the runtime layer should default to `mode: 'named'`.
Worker concurrency limits mean `max: 5`.

### 6.3 `@electric-sql/pglite@0.5.5` — **thin wrapper required** (~80 LOC)

Different shape, and PG 18.3 embedded:

```ts
query<T>(sql: string, params?: any[], options?: QueryOptions): Promise<Results<T>>
describeQuery(sql: string): Promise<DescribeQueryResult>
transaction<T>(cb: (tx: Transaction) => Promise<T>): Promise<T>
listen(channel, cb) / unlisten / onNotification
interface QueryOptions { rowMode?: 'array' | 'object'; parsers?: ParserOptions; serializers?; paramTypes?: number[]; blob?; onNotice? }
type Results<T> = { rows: Row<T>[]; fields: { name: string; dataTypeID: number }[]; affectedRows?; command?; rowCount? }
```

Wrapper responsibilities and measured constraints:

* **`fields` carries only `{ name, dataTypeID }`** — no typmod, no `tableID`/`columnID`. So
  `capabilities.richFieldMetadata = false`, and nullability/typmod-driven typing is unavailable here.
  `describeQuery` has the same gap (`{ dataTypeID, serializer/parser }` only).
* **Parser neutralisation needs an explicit plain object.** A `Proxy` with `get`/`has` traps is silently
  ignored (measured: values still came back as `Date`/`bigint`); an explicit `{ 20: id, 1082: id, … }` map
  works. So the wrapper materialises the full built-in OID list.
* **`capabilities.maxConnections = 1`** — the README's *"PGlite is single user/connection"*. It is excellent
  for the fast correctness suite and structurally useless for the pooling/concurrency/`LISTEN` suite. Plan
  for both (Testcontainers PG for the latter), exactly as research §3.3 says.
* `execModes: ['unnamed', 'simple']`; `cancel: false`; COPY via `blob`/`Results.blob` rather than streams.
* Errors are pg-shaped by duck-type (measured: `code: '42P01'`, `position: 15`, `severity: 'ERROR'`, plus
  `query`/`params`) but the class is minified to `N` — see §7.

### 6.4 `postgres.js` — community adapter, not bundled

Publish the seam and accept `@pg-orm-ts/adapter-postgresjs`. Not default: ~4 commits in 2026, bus factor 1,
no SCRAM channel binding, no binary result path, and `prepare: false` costs 2 RTT per execution forever
(research §2.2, §2.4, §2.8). Neutralisation is possible (`client.options.parsers[oid]`, as Drizzle does), so
the codec guarantee holds — capabilities would be `describe: true` (built-in `.describe()`),
`richFieldMetadata: true`, `binaryResults: false`, `paramTypeOids: false`.

### 6.5 `Bun.sql` — **not supportable**

No `setTypeParser` equivalent of any kind ([oven-sh/bun#25035](https://github.com/oven-sh/bun/issues/25035),
open since 2025-11). D7 is unimplementable there, so results would be silently inconsistent with every other
adapter. Bun users run `pg` under Bun's Node compatibility. Revisit only if Bun ships a parser hook.

---

## 7. What crosses the seam on failure

> **Coordination:** agent **07** (runtime/transactions) owns the error *class* hierarchy, retry policy and
> user-facing messages. This section defines only the **data** an adapter must produce. Adapters must be
> able to satisfy it without importing anything from the runtime layer — hence plain objects, not classes.

```ts
export type PgErrorKind =
  | 'server'      // ErrorResponse from the backend. `sqlstate` is present.
  | 'connection'  // socket/TLS/auth failure, pool exhaustion, connection closed mid-query
  | 'protocol'    // desync / unexpected message. Connection is NOT reusable.
  | 'timeout'     // client-side deadline (PgQuery.timeoutMs) elapsed
  | 'cancelled'   // AbortSignal fired, or SQLSTATE 57014 came back
  | 'adapter'     // the adapter itself misbehaved / unsupported capability requested

export interface PgDriverErrorData {
  readonly kind: PgErrorKind
  readonly message: string
  /** True ⇒ the runtime MUST `release(conn, { dispose: true })`. Always true for 'protocol'. */
  readonly connectionUnusable: boolean
  /** Present iff kind === 'server'. */
  readonly server?: PgServerErrorData
  /** The SQL we sent, for the error's `position` to point into. Redacted params never included. */
  readonly sql?: string
  readonly adapter: string
  readonly cause?: unknown
}

/** Every field of the protocol's ErrorResponse, normalised. Field letters in comments. */
export interface PgServerErrorData {
  readonly severity: string          // S / V   'ERROR' | 'FATAL' | 'PANIC' | 'WARNING' | 'NOTICE' | …
  readonly sqlstate: string          // C       5 chars, e.g. '23505'. THE routing key.
  readonly message: string           // M
  readonly detail?: string           // D
  readonly hint?: string             // H
  readonly position?: number         // P       1-based char offset into the SQL WE sent
  readonly internalPosition?: number // p
  readonly internalQuery?: string    // q
  readonly where?: string            // W
  readonly schema?: string           // s
  readonly table?: string            // t
  readonly column?: string           // c
  readonly dataType?: string         // d
  readonly constraint?: string       // n
  readonly file?: string             // F
  readonly line?: number             // L
  readonly routine?: string          // R       postgres.js keys its self-healing retry off this
}

export interface PgNoticeData extends PgServerErrorData {}
```

**Adapter obligations, and the traps they must absorb** (all measured):

1. **`position`, `internalPosition` and `line` arrive as strings** from `pg` (`position: "15"`, not `15`).
   The adapter converts. Without `position` as a number the error formatter cannot render a caret under the
   offending token — the single highest-value thing an ORM does with a SQL error.
2. **Never `instanceof`.** `pg`'s error has `name === 'error'` and `constructor.name === 'DatabaseError'`;
   PGlite's is minified to `N`; Neon has its own `DatabaseError` *and* a separate `NeonDbError` for HTTP mode.
   Detection is duck-typed: `typeof e.code === 'string' && typeof e.severity === 'string'`.
3. **Absent fields are absent, not null.** `pg` omits keys entirely. Measured shapes:
   `42P01` → `{severity, code, message, position, file, line, routine}`;
   `23505` → `{severity, code, message, detail:"Key (id)=(1) already exists.", schema, table, constraint}`.
   The constraint name and detail are what turn a unique violation into a field-level validation error.
4. **Notices are not errors.** `RAISE NOTICE` (measured: `severity 'NOTICE', code '00000'`) arrives on the
   same channel and must be collected into `PgResult.notices`, never thrown. Migrations depend on this.
5. **`57014` may arrive as a normal query rejection.** Both cancel paths produce it. The adapter tags
   `kind: 'cancelled'`, not `'server'`, so agent 07's retry logic never retries a user-initiated cancel.

**SQLSTATEs the runtime layer will route on** (documented here because the adapter must not swallow them):
`40001` serialization_failure and `40P01` deadlock_detected → retryable; `57014` query_canceled;
`23505`/`23503`/`23502`/`23514` constraint violations → field-level; `26000` invalid_sql_statement_name,
`42P05` duplicate_prepared_statement, `0A000` cached-plan-must-not-change-result-type → **prepared-statement
eviction + retry, then permanent downgrade to `mode: 'unnamed'`** (research §5.7 #3); `42P18`
indeterminate_datatype → a bug in our `paramTypes` emission, never retry; `53300` too_many_connections →
pool policy.

---

## 8. Alternatives rejected

| Rejected | One-line reason |
|---|---|
| **`peerDependency` on `pg`** (research §7.2) | Structural typing gets the same result with *zero* peers; a peer dep still forces `@types/pg` on consumers and breaks Neon's now-nominally-incompatible inlined types. ⚠️ minor deviation — we go further than the research, not less far |
| **Hard `dependency` on `pg`** (the `@prisma/adapter-pg` model) | Takes version control — and therefore security patching — away from the user, and makes duplicate-`pg`-instance bugs possible |
| **`postgres.js` as the default adapter** | ~4 commits in 2026, bus factor 1, 230 open issues, no SCRAM channel binding, `prepare:false` costs 2 RTT forever. Excellent optional adapter, unacceptable sole dependency |
| **Our own wire-protocol client for v1** | 3.5–5k LOC and 4–7 months for something whose hard part (`pgx`'s `pgtype` is 3.5× its protocol codec) we must build anyway. The seam makes it a non-breaking v2 addition |
| **Binary result format in v1** | `pg`'s binary path corrupts any byte ≥ 0x80 (§4.4). Seam retained, switch stays off |
| **Transactions as driver methods** (Kysely's `beginTransaction` etc.) | PostgreSQL's transaction syntax is identical across every adapter; abstracting it buys nothing and costs 5 methods |
| **Prisma-style normalised `ColumnType` enum** | Exists only because Prisma spans four databases; its `oid >= 16384 → Text` fallback collapses every user enum, domain and composite. We resolve those OIDs instead — §4.6 |
| **Object row mode** | Duplicate column names from JOINs silently clobber, plus a per-row object allocation. Drizzle, Prisma and Kysely's PG dialect all use array mode |
| **`pg-copy-streams` / `pg-cursor` / `pg-query-stream` as deps** | All three are reimplementable on the Submittable seam we already need. `pg-copy-streams` in particular is the one package here outside the `pg` maintainer group |
| **Global `pg.types.setTypeParser`** | Process-wide mutation; would corrupt every other library in the user's app. Per-query `types` is strictly better and needs no cooperation from the user's Pool |
| **`Bun.sql` adapter** | No type-parser hook of any kind; D7 is unimplementable, so results cannot match other adapters |
| **Auto-detecting transaction poolers** | No ecosystem prior art, and Prisma #21799 is the cautionary tale of a client-side pooler workaround *becoming* the bug. Make the default safe so detection is unnecessary |

---

## 9. Open coordination points

| # | With | Question |
|---|---|---|
| 1 | **07 runtime/transactions** | Exec-mode *policy* is yours. Recommendation stands: default `'unnamed'` + a process-wide `sql → { paramTypes, fields }` description cache (pgx's `CacheDescribe`), invalidated on `0A000`/`42P18`/`42804`. `'named'` opt-in, LRU per physical connection, cleanup via `closeStatement`, permanent downgrade after N failures. Hyperdrive is the exception where `'named'` should be the default |
| 2 | **07** | `PgDriverErrorData` → your error classes. Confirm you want `position` as a number and notices as data rather than events |
| 3 | **03 schema DSL** | `Codec.sqlName` + `Codec.name` are the DSL's contract with this layer. `bigint`-by-default for `int8` and `string`-by-default for `numeric`/`date` must be reflected in `$inferSelect` |
| 4 | **05/06 migrations** | You need `mode: 'simple'` (multi-statement bodies, `CREATE INDEX CONCURRENTLY` outside a transaction), `PgResult.notices` (`RAISE NOTICE`), and `route: 'direct'`. All present |
| 5 | **codegen / typed SQL** | `describe()` + `pg_attribute.attnotnull` is the nullability source. It is `capabilities.describe`-gated, and **PGlite cannot supply typmod/tableID/columnID** — CI type-generation must run against a real PG |
| 6 | Build | The built-in OID map is *generated* from `pg_type`, not hand-written, and asserted against a PG 15/16/17/18 matrix in CI. Multirange array OIDs in particular are version-dependent |

---

## Appendix — verification log (2026-08-14)

Packages installed fresh and inspected: `pg@8.23.0`, `pg-protocol@1.16.0`, `pg-pool@3.14.0`,
`pg-types@2.2.0`, `pg-cursor@2.22.0`, `pg-query-stream@4.17.0`, `pg-copy-streams@7.0.0`,
`@types/pg@8.21.0`, `@neondatabase/serverless@1.1.0`, `@electric-sql/pglite@0.5.5` (PG 18.3 embedded).
Live server: **PostgreSQL 18.4** (throwaway `postgres:18-alpine` container, removed after probing).

Executed and confirmed: identity type-parser neutralisation (per-query and per-pool) · raw wire text for 44
type expressions incl. NaN/±Infinity/BC-years/infinity-timestamps/empty+unbounded ranges/2-D arrays/non-default
array lower bounds/quoted composites · `binary: true` byte corruption under the extended protocol ·
`binary: true` silently ignored under the simple protocol · the overloaded `types` field satisfying both param
OIDs and the parser table · `42P18` without param OIDs · `Uint8Array` parameters sent in binary format ·
`null` short-circuit in array row mode · Describe-without-Execute via Submittable (params, typmods,
tableID/columnID, error recovery) · direct-`connection` Describe crashing the client · protocol `Close('S')`
plus the `parsedStatements` bookkeeping fix · named-statement uniqueness guard · cursors with `rowMode`/`types`
· COPY in and out · both cancellation paths (`57014` in ~205 ms) and the `EISCONN` constraint on the canceller
· `query_timeout` not cancelling server-side · pipeline-mode per-query error isolation · simple-protocol
multi-statement acceptance vs `queryMode: 'extended'` rejection (`42601`) · startup `ParameterStatus` capture ·
`pg_type`/`pg_enum`/`pg_attribute`/`pg_range` derivation for enum/composite/domain/range · `box` `typdelim = ';'`
· PGlite parser-neutralisation requiring a plain object · PGlite's reduced `fields` metadata · the full
built-in OID/array-OID table dumped from `pg_catalog` on PG 18.3.
