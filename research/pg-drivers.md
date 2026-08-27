# PostgreSQL Driver Landscape for Node/TypeScript — Research & Recommendation

> **Historical snapshot — 2026-08-14. Not maintained.**
> This is a point-in-time study of software we do not control; version numbers, APIs and bug
> reports below were accurate on that date and will drift. It is kept as the provenance for the
> decisions in [`../design/`](../design/), not as a current reference. Conclusions that survived
> review are carried into [`SUMMARY.md`](./SUMMARY.md) and cited from the design docs.

**Project:** `pg-orm-ts` (PostgreSQL-only, type-safe TS ORM, minimal runtime deps, first-class migrations)
**Question:** How should the ORM talk to PostgreSQL?
**Date:** 2026-08-14
**Method:** npm registry queries (`npm view`, `api.npmjs.org`); **source inspection of locally installed** `pg@8.23.0`, `pg-protocol@1.16.0`, `pg-types@2.2.0`, `pg-pool@3.14.0`, `postgres@3.4.9`, `@neondatabase/serverless@1.1.0`, `kysely@0.29.5`, `drizzle-orm@0.45.2`, `@prisma/adapter-pg@7.9.1`; executing `pg-types` parsers on real PG text output; `git clone` + LOC counts of `jackc/pgx`; and web verification of maintenance status, releases, benchmarks and pooler docs.

Everything below is dated and sourced. **Where I quote code, it is from the installed package, not from memory.** Three claims in circulation turned out to be wrong when traced to source and are corrected here: postgres.js's `prepare: false` cost (§2.4), the state of PgBouncer's prepared-statement support (§5.2), and the belief that `pg` has no pipelining (§1.4).

---

## 0. TL;DR — Recommendation

**Ship a thin internal driver-adapter interface, with `pg` (node-postgres) as the only bundled/default adapter for v1, declared as a `peerDependency`.**

Ranking:

| Rank | Option | One-line rationale |
|---|---|---|
| **1** | **(d) Driver-adapter interface with a default (`pg`)** | A 4-method driver + 2-method connection seam (~300 LOC, modelled on Kysely's verified interface). Combined with Kysely's **structural typing** trick (declare our own `PgLikePool` rather than importing `pg`), we ship **zero dependencies *and* zero peer dependencies** — while Neon and Hyperdrive work with no adapter code at all. Also makes the query layer unit-testable with no database. |
| **2** | **(a) Depend on `pg` directly** | Safest single choice: 43.7M weekly downloads, 7 releases in 2026 alone, now has pipelining, SCRAM-SHA-256-PLUS channel binding and `sslnegotiation=direct`. Cost: 5 transitive deps, no bundled `.d.ts`, and `pg-types` pinned to a 2019 release. |
| **3** | **(b) Depend on `postgres.js`** | Genuinely zero-dep and architecturally elegant (auto-prepared-statement cache, native COPY/LISTEN, pipelining by default), but **~4 commits and 2 releases in the last 14 months, 230 open issues / 48 open PRs, single maintainer** — an unacceptable bus factor for a foundation dependency. Also: no SCRAM channel binding, no binary result format, and its pooler-safe mode costs 2 RTT per query vs `pg`'s 1. Excellent *optional* adapter. |
| **4** | **(c) Own wire-protocol client** | Technically achievable (~3.5–5k LOC for a credible v1), but a **4–7 month** distraction with a long tail of auth/TLS/edge-case bugs. Revisit at v2 as an *optional* adapter once the ORM has users. |

The decisive factor: **type-parsing control, the thing that actually matters for end-to-end ORM type safety, does NOT require owning the wire protocol.** Both `pg` and `postgres.js` expose OID-level parser overrides (§1.5, §2.5), both expose `Describe`-without-`Execute` for deriving parameter and result types from the server (§4.4), and an ORM must override the defaults anyway because *both* drivers mis-handle `DATE` and naive `TIMESTAMP` (§1.5). Writing our own wire client buys binary result formats and single-digit-percent perf — not type safety.

---

## 1. `pg` (node-postgres)

### 1.1 Facts (verified 2026-08-14)

| Property | Value |
|---|---|
| Latest version | **8.23.0**, published **2026-08-08** (`npm view pg time`) |
| Weekly downloads | **43,701,187** (week of 2026-08-03, [api.npmjs.org](https://api.npmjs.org/downloads/point/last-week/pg)) |
| GitHub | 13.2k stars, **449 open issues, 66 open PRs** ([github.com/brianc/node-postgres](https://github.com/brianc/node-postgres)) |
| Latest commit | **2026-08-12** ("fix: avoid mutating query config (#3720)") |
| Maintainers active 2025–26 | brianc, charmander, nigrosimone, sehrope, + Copilot-assisted PRs |
| `engines` | `node >= 16.0.0` |
| Unpacked size | 100 KB / 20 files; full tree on disk ≈ **420 KB** (`pg` + 5 deps + their deps) |
| Ships own TS types | **No** — requires `@types/pg` (DefinitelyTyped, `8.21.0`, updated 2026-08-07) |
| `npm audit` | 0 vulnerabilities |

### 1.2 Dependency tree (measured)

```
pg@8.23.0
├── pg-cloudflare@1.4.0          (optionalDependency — Workers socket shim)
├── pg-connection-string@2.14.0
├── pg-pool@3.14.0
├── pg-protocol@1.16.0
├── pg-types@2.2.0               ← EXACT PIN to a package published 2019-08
│   ├── pg-int8@1.0.1
│   ├── postgres-array@2.0.0
│   ├── postgres-bytea@1.0.1
│   ├── postgres-date@1.0.7
│   └── postgres-interval@1.2.0 → xtend@4.0.2
├── pgpass@1.0.5 → split2@4.2.0
└── (peerDependency, optional) pg-native >= 3.0.1
```

**13 packages** total for `pg` alone. Every one is maintained by brianc or charmander — i.e. the "5 dependencies" are really vendored sub-modules of the same project, not third-party supply-chain surface. That materially softens the "minimal deps" objection. The genuine third-party leaves are `xtend` and `split2`.

Separate packages needed for full feature coverage:
- `pg-cursor@2.22.0` (2026-08-08) / `pg-query-stream@4.17.0` (2026-08-08) — cursors & streaming
- `pg-copy-streams@7.0.0` (**2025-05-27**, maintained by `jeromew`, not brianc — 950k downloads/wk) — COPY

### 1.3 2026 release cadence — this is the headline

`pg` shipped **seven minor releases between 2026-01-14 and 2026-08-08**:

| Version | Date | Highlight (from [CHANGELOG.md](https://raw.githubusercontent.com/brianc/node-postgres/master/CHANGELOG.md)) |
|---|---|---|
| 8.17.0 | 2026-01-14 | |
| 8.18.0 | 2026-01-30 | `connect()` now returns the client instance (was void) |
| 8.19.0 | 2026-02-25 | Internal query queue deprecated (architectural cleanup) |
| 8.20.0 | 2026-03-04 | `onConnect` pool callback |
| 8.21.0 | 2026-05-18 | SASL SCRAM server error handling; `scramMaxIterations`; `client.getTransactionStatus()`; node@26 support |
| 8.22.0 | 2026-06-19 | **`sslnegotiation=direct`** (PostgreSQL 17+ direct TLS) |
| 8.23.0 | 2026-08-08 | **"Add support for query pipelineing"** [sic] |

Earlier: **8.14.0 added SCRAM-SHA-256-PLUS channel binding**.

### 1.4 Pipelining — the old objection is now dead

The single strongest historical argument for `postgres.js` was that `pg` serialised queries per connection with no pipelining ([issue #2646](https://github.com/brianc/node-postgres/issues/2646), [issue #3193](https://github.com/brianc/node-postgres/issues/3193), [WIP PR #2706](https://github.com/brianc/node-postgres/pull/2706)). **As of 8.23.0 this shipped.** Verified in the installed source:

```js
// node_modules/pg/lib/client.js:101
this.pipeline = Boolean(c.pipeline)
// :761
if (this._queryQueue.length > 0 && !this.pipeline) { ... }
// :723-725
} else if (this.pipeline) {
  // Query already sent — the pipeline is blocked until it completes.
  // Destroy the connection to unblock all remaining pipelined queries.
```

Note the error-handling semantics: in pipeline mode an error forces connection destruction to unblock queued queries. That is a legitimate design choice (protocol-correct: after an error the backend skips to the next `Sync`), but it means **pipeline mode + `pg` has coarser error isolation than `postgres.js`**, which tracks Sync boundaries per query. For an ORM, pipeline mode should be **opt-in per pool**, not the default.

### 1.5 Type parsing (the ORM-critical part)

`pg` gives OID-keyed parser overrides at **client/pool granularity** and defaults from `pg-types`:

```js
// node_modules/pg/lib/type-overrides.js
function TypeOverrides(userTypes) { this._types = userTypes || types; this.text = {}; this.binary = {} }
TypeOverrides.prototype.setTypeParser = function (oid, format, parseFn) { ... }
TypeOverrides.prototype.getTypeParser = function (oid, format) {
  return this.getOverrides(format)[oid] || this._types.getTypeParser(oid, format)
}
```

You pass `new Client({ types })` where `types` is anything with `getTypeParser(oid, format)`. **This is exactly the seam an ORM needs** — we can supply a fully custom, ORM-owned parser table without patching globals (the old `pg.types.setTypeParser` global mutation is a landmine in a library; never use it).

**But: `pg` pins `pg-types` to exactly `2.2.0` (published August 2019) while `pg-types@4.1.0` exists (2025-07-30).** I ran the 2.2.0 default parsers against real Postgres text output:

| OID | Type | Input | `pg-types@2.2.0` output | ORM verdict |
|---|---|---|---|---|
| 20 | `int8` | `9007199254740993` | `"9007199254740993"` (string) | Correct-but-lossy default; ORM should map to `bigint` |
| 1700 | `numeric` | `1.10` | `"1.10"` (string) | Correct (must stay string/Decimal) |
| 1082 | `date` | `2026-08-14` | `Date` = `2026-08-13T19:00:00.000Z` | **BUG-CLASS.** A `DATE` becomes a `Date` at *local* midnight → shifts across the date boundary. |
| 1114 | `timestamp` | `2026-08-14 12:00:00` | `Date` = `2026-08-14T07:00:00.000Z` | **BUG-CLASS.** Naive timestamp reinterpreted as local time. |
| 1184 | `timestamptz` | `2026-08-14 12:00:00+00` | `Date` = `2026-08-14T12:00:00.000Z` | Correct |
| 1186 | `interval` | `1 day` | `PostgresInterval { days: 1 }` | OK |
| 3904 | `int4range` | `[1,5)` | `"[1,5)"` (raw string) | **Unparsed** — `pg-types@4` adds `postgres-range`; `2.2.0` does not |
| 1009 | `_text` | `{a,b}` | `["a","b"]` | OK |

**Conclusion: whichever driver we pick, `pg-orm-ts` MUST ship its own OID→parser table.** The defaults of *both* mainstream drivers produce values that contradict a type-safe ORM's advertised types (`DATE` → shifted `Date`, naive `TIMESTAMP` → local-time `Date`). This is a feature we own, not a driver capability we shop for — and it substantially deflates the "write our own driver for type-parsing control" argument.

### 1.6 Parameter serialisation

`pg` sends **all parameters as text** except `Buffer` (sent as binary). From `pg-protocol/dist/serializer.js`:

```js
if (mappedVal == null)                 { writer.addInt16(0 /* STRING */); paramWriter.addInt32(-1) }
else if (mappedVal instanceof Buffer)  { writer.addInt16(1 /* BINARY */); ... }
else                                   { writer.addInt16(0 /* STRING */); paramWriter.addInt32PrefixedString(mappedVal) }
```

`lib/utils.js#prepareValue` handles `Date` (with a hand-rolled `dateToString` including BC-year handling), typed arrays, JS arrays → PG array literal, and objects via `toPostgres()` duck-typing or `JSON.stringify`. The `toPostgres` protocol is an extension point we can use. Result format can be requested binary per query (`binary: true`), backed by `pg-types` `binaryParsers.js` (257 LOC, partial coverage).

### 1.7 Feature checklist

| Capability | `pg` |
|---|---|
| Prepared statements | Yes, **opt-in** via `name` on the query config. Not automatic. Duplicate-name guard: `"Prepared statements must be unique"` (`lib/query.js:158`) |
| Pipelining | **Yes, 8.23.0+**, opt-in `pipeline: true` |
| Pooling | Built-in `pg-pool` (separate pkg, 517 LOC) — see §1.8 |
| LISTEN/NOTIFY | Yes — `client.on('notification')`; you manage the dedicated connection yourself |
| Cursors / streaming | Yes, via **separate** `pg-cursor` / `pg-query-stream` |
| COPY | Only via **third-party** `pg-copy-streams@7.0.0` (last publish 2025-05) |
| SCRAM-SHA-256 | Yes, `lib/crypto/sasl.js` (262 LOC), incl. **channel binding** (`-PLUS`, 8.14.0+) and `scramMaxIterations` |
| TLS | Yes, incl. `sslnegotiation=direct` for PG17+ (8.22.0+) |
| Binary result format | Yes, per-query `binary: true` |
| Query cancellation | Yes (`CancelRequest` on a second socket) |
| Logical replication | No |
| Native bindings | Optional `pg-native` (libpq) peer dep |

### 1.8 `pg-pool` — adequate, and pluggable

Read from `node_modules/pg-pool/index.js` (517 LOC). Options: `max` (default 10), `min` (0), `idleTimeoutMillis` (10 000), `connectionTimeoutMillis`, `maxUses` (Infinity), `maxLifetimeSeconds` (0 = off), `allowExitOnIdle`, `onConnect` hook, and `log`.

The important line for us is `:95`:

```js
this.Client = this.options.Client || Client || require('pg').Client
```

**`pg-pool` accepts an injected `Client` class.** This is the documented mechanism by which `@neondatabase/serverless` and Cloudflare-targeted builds swap the transport while keeping the pool. It is also a free seam for *us*: we can inject an instrumented `Client` subclass for tracing/metrics without forking anything, and tests can inject a fake `Client` to exercise pool behaviour with no database.

Gaps worth knowing: no `min`-warmup by default (`min: 0`), no built-in circuit breaker, and no queue-depth backpressure signal beyond `pool.waitingCount`. None of these are blockers for v1; all are things we can layer above the adapter.

---

## 2. `postgres.js` (porsager/postgres)

### 2.1 Facts (verified 2026-08-14)

| Property | Value |
|---|---|
| Latest version | **3.4.9**, published **2026-04-05** |
| Weekly downloads | **14,065,441** |
| GitHub | 8.7k stars, 355 forks, **230 open issues, 48 open PRs** ([github.com/porsager/postgres](https://github.com/porsager/postgres)) |
| Latest commit | **2026-04-05** |
| Commits in 2026 | **~4** (Jan and Apr clusters only) — [commit history](https://github.com/porsager/postgres/commits/master) |
| Dependencies | **Zero** — verified: `package.json` has no `dependencies`, `peerDependencies`, or `optionalDependencies` |
| `engines` | `node >= 12` |
| Unpacked size | 300 KB / 37 files (ships `src/` ESM + `cjs/` + `cf/` Workers build + `types/`) |
| Ships own TS types | Yes (`types/index.d.ts`) — hand-written, community-contributed |
| `npm audit` | 0 vulnerabilities |

### 2.2 Release history — the bus-factor problem

| Version | Published |
|---|---|
| 3.4.4 | 2024-03-21 |
| 3.4.5 | 2024-10-25 |
| 3.4.6 | 2025-05-20 |
| 3.4.7 | 2025-05-21 |
| 3.4.8 | **2026-01-06** |
| 3.4.9 | **2026-04-05** |

**Two patch releases in the whole of 2026, zero minor releases since 3.4.0 in October 2022, no v4 branch, ~4 commits in 2026, and a backlog of 230 issues / 48 PRs.** The project is not abandoned — 3.4.8 shipped `sslnegotiation=direct` and commit-time fixes, which is real work — but it is running at roughly **one maintainer's spare-time cadence**, versus `pg`'s seven releases in the same eight months.

> **Risk flag.** For an ORM, the driver is the single deepest dependency: a driver bug is an ORM bug, and users will file it against us. A 2–4 month median response window on a security or protocol issue is not acceptable as our *only* path to the database. Bus factor ≈ 1.

No CVEs or GitHub advisories found for `postgres` (the npm package) in 2025–2026.

### 2.3 Architecture (read from source, `node_modules/postgres/src/`)

| File | LOC |
|---|---|
| `connection.js` | 1062 |
| `index.js` | 567 |
| `types.js` | 367 |
| `subscribe.js` (logical replication) | 277 |
| `query.js` | 173 |
| `bytes.js`, `large.js`, `errors.js`, `queue.js`, `result.js` | 248 |
| **Total** | **2694** |

**A complete, pipelined, zero-dep PG client in ~2,700 LOC of JS.** This is the most useful data point in this entire document for §4's effort estimate.

### 2.4 Prepared statements — automatic, with a cache and a retry

```js
// src/connection.js:232-241
q.prepare    = options.prepare && ('prepare' in q.options ? q.options.prepare : true)
q.signature  = q.prepare && types + string          // cache key = param types + SQL text
q.prepared   = q.prepare && q.signature in statements
q.statement  = q.prepared ? statements[q.signature]
                          : { string, types, name: q.prepare ? statementId + statementCount++ : '' }
```

- **`prepare: true` (default)**: first execution sends `Parse` + `Describe('S')` + `Bind` + `Execute`; subsequent executions with the same SQL+types send only `Bind` + `Execute`. Statement names are `statementId + counter`, cached per connection.
- **`prepare: false`**: `q.statement.name = ''` → an **unnamed** statement. Critically, this **still uses the extended query protocol** — full `$n` parameterisation, no string interpolation, no injection risk.

  ⚠️ **Correction to the common understanding, traced through the source.** It is widely stated (including implicitly by postgres.js's own docs) that `prepare: false` merely costs an extra server-side `Parse`. It actually costs **a full extra network round trip on every execution**. With `prepare: false` and ≥1 parameter, `q.prepared` is always `false`, so `q.describeFirst` is always truthy, and `toBuffer` takes the **`describeFirst`** branch — *not* the `unnamed()` branch:

  ```js
  return q.options.simple
    ? b().Q()...                                  // simple protocol
    : q.describeFirst
      ? Buffer.concat([describe(q), Flush])        // ← prepare:false WITH params lands HERE
      : q.prepare
        ? (q.prepared ? prepared(q) : Buffer.concat([describe(q), prepared(q)]))
        : unnamed(q)                               // ← only reached with ZERO params
  ```

  Round trip 1 is `Parse('')` + `Describe('S','')` + `Flush`; postgres.js then waits for `ParameterDescription` to learn the inferred parameter OIDs before it can serialise the values, and only then writes round trip 2 (`Bind` + `Execute` + `Sync`).

  | mode | first execution | steady state |
  |---|---|---|
  | `prepare: true` | 2 round trips | **1 round trip** |
  | `prepare: false` | 2 round trips | **2 round trips, every time** + a server-side Parse every time |

  **`pg` does not have this problem** — it infers parameter types client-side from the JS values and describes the *portal* (`Describe('P')`) rather than the statement, so it never needs `ParameterDescription` and completes an unnamed parameterised query in **one** round trip. For pooler-safe operation, `pg`'s unnamed path is therefore *strictly faster than* postgres.js's `prepare: false`. See §5.
- **Self-healing**: an error whose `routine` is `FetchPreparedStatement`, `RevalidateCachedQuery`, or `transformAssignedExpr` triggers an automatic retry (`src/connection.js:25-29, 540-542`) — i.e. it recovers from "prepared statement does not exist" behind a pooler and from cached-plan invalidation after DDL. **This is a genuinely nice piece of engineering that `pg` lacks.**

### 2.5 Type system

`src/types.js` defines a small `{ to, from, serialize, parse }` table (string/number/json/boolean/date/bytea) and the `sql.types` / `types` option lets you register custom types with the same shape. It infers parameter OIDs from JS values (`inferType`). Notable defaults:
- `number.from = [21, 23, 26, 700, 701]` — `int8` (OID 20) is **not** included, so bigints come back as strings, like `pg`.
- `date.parse = x => new Date(x)` — same `DATE`/naive-`TIMESTAMP` timezone hazards as `pg`.
- All results are **text format**; there is no binary result path (only `x.raw` for raw buffers). `pg` actually has *more* binary support here.

The type registration API is *nicer* than `pg`'s but *less granular*: it's keyed by named type with a `from: [oids]` list rather than a per-OID map, and it's tied to the tagged-template layer.

### 2.6 Feature checklist

| Capability | `postgres.js` |
|---|---|
| Prepared statements | **Automatic**, per-connection cache, keyed on SQL+types; `prepare: false` → unnamed statements |
| Pipelining | **Yes, by default** — writes are batched with `setImmediate` + 1 KB coalescing (`connection.js:250+`) |
| Pooling | Built-in, no extra package; `max`, `idle_timeout`, `max_lifetime`, multi-host failover |
| LISTEN/NOTIFY | Yes, first-class `sql.listen(ch, fn)` / `sql.notify()`; **automatically opens a dedicated `max:1` connection** and re-subscribes on reconnect (`index.js:147-199`) |
| Cursors / streaming | Yes, built-in (`sql``...``.cursor(n)`, `.forEach()`) |
| COPY | Yes, built-in as Node streams (`connection.js:861,891`) |
| Logical replication | **Yes**, `sql.subscribe()` (`subscribe.js`, 277 LOC) — unique among the options |
| Large objects | Yes (`large.js`) |
| SCRAM-SHA-256 | Yes — **but no channel binding** (see §2.8) |
| TLS | Yes, incl. `sslnegotiation=direct` (3.4.8+) |
| Binary result format | **No** |
| Max parameters | Hard error above 65534 |
| Runtimes | Node, Deno, Bun, Cloudflare Workers (`cf/` build) |

### 2.7 The performance claim — verify, then discount

The README claims "the fastest full-featured node & deno client." Actual measurements:

- **[nigrosimone/postgres-benchmarks](https://github.com/nigrosimone/postgres-benchmarks)** — `pg@8.23.0` vs `pg-native@3.9.0` vs `postgres@3.4.9`, Node 26.7, unix socket, **pipeline mode enabled for all clients**, pool of 10 / single-conn pipelined suites, LIMIT 1/100/500:
  - `pg-native` 175,289 ns median · `postgres` 181,810 ns · `pg` 187,820 ns
  - Relative: pg-native **1.052**, postgres **1.058**, pg **1.092** → **`postgres.js` is ~3% ahead of `pg`; the whole field spans ~7%.**
  - Caveat the author states himself: he had to override `pg`'s `pg-types@2.2.0` pin to 4.x for a fair comparison. ⚠️ *Author bias note: `nigrosimone` is a `pg` contributor, credited in 2026 pipelining/connection work.*
- **[node-postgres issue #3391](https://github.com/brianc/node-postgres/issues/3391)** (2025-02-21), "Performance: pg VS postgres.js VS Bun.SQL": the initial "postgres.js is much faster" result was an **artifact of prepared-statement defaults** — Bun and postgres.js auto-cache prepared statements, `pg` requires an explicit `name`. Once `pg` was given `name: 'foo'`, **`pg` measured faster than postgres.js.**
- **[pkgpulse "2026 guide"](https://www.pkgpulse.com/guides/pg-vs-postgres-js-vs-neon-serverless-postgresql-drivers-2026)** claims postgres.js is "2-3x faster than pg". ❌ **This is not supported by any benchmark I could find and is contradicted by the two above.** Treat this and similar SEO content-farm comparisons as noise.

**Verdict: the perf delta between `pg` (pipelining on, named statements) and `postgres.js` is within single-digit percent — noise next to network RTT and query planning.** Performance is *not* a valid tiebreaker between these two in 2026. It *was* in 2023.

### 2.8 Security gap found: no SCRAM channel binding

Verified by reading both implementations:

- **`pg` supports `SCRAM-SHA-256-PLUS`** and *prefers* it whenever a TLS stream is present (`lib/crypto/sasl.js:37` — `candidates.unshift('SCRAM-SHA-256-PLUS')`), computing `p=tls-server-end-point` binding data from the peer certificate hash (`:103-112`). It also enforces `scramMaxIterations` (DoS guard) and verifies the server signature.
- **`postgres.js` hardcodes the plain mechanism**: `b().p().str('SCRAM-SHA-256' + b.N)` (`src/connection.js:709`). There is no `gs2`/`cbind`/`tls-server-end-point` handling anywhere in the source. It does correctly verify the server signature (`SASL_SIGNATURE_MISMATCH`, `:745`) and supports MD5 for legacy servers.

Channel binding is the defence that makes SCRAM resistant to an active MITM holding a mis-issued or compromised certificate. For an ORM used against managed Postgres over the public internet, **`pg` is the more secure default**, and this gap is unlikely to close soon given §2.2's commit cadence.

---

## 3. Serverless / edge drivers

### 3.1 `@neondatabase/serverless`

| Property | Value |
|---|---|
| Latest version | **1.1.0** (changelog dated **2026-04-09**, npm 2026-04-17) |
| Weekly downloads | 3,228,860 |
| Dependencies | **Zero** — as of 1.1.0 the type declarations are fully inlined (previously re-exported from `@types/pg`/`@types/node`) |
| Size | 432 KB unpacked, 10 files; single bundled `index.js` of **1,372 LOC** (a **bundled fork of `pg` + `pg-pool` + `pg-protocol`** with the net socket swapped for WebSocket/`fetch`) |
| License | MIT |

Release history from the bundled `CHANGELOG.md`: 1.0.0 (2025-03-25), 1.0.1 (2025-06-06), 1.0.2 (2025-09-30), 1.1.0 (2026-04-09). **Steady, and the acquisition of Neon by Databricks did not visibly interrupt it** — 1.1.0 is a substantive packaging improvement, not a maintenance stub.

Two modes: `neon(sql)` — one-shot HTTP `fetch`, no session, no cross-call transactions, lowest cold-start; and `Pool`/`Client` — WebSocket-tunnelled TCP, API-compatible with `pg`. The **`pg` API-compatibility shim is the key architectural fact**: because Neon deliberately mimics `pg`'s `Client`/`Pool`/`Result` surface, *anything that targets `pg`'s interface gets Neon almost for free.* That is a strong argument for making our adapter interface `pg`-shaped.

One design decision worth copying: in **1.0.0 they made the HTTP tagged template callable *only* as a template**, so `sql(\`... ${id}\`)` (ordinary interpolation → injection) is now both a type error and a runtime error, with `sql.query(text, values)` and `sql.unsafe(str)` as the explicit escape hatches. If `pg-orm-ts` exposes a raw-SQL tag, it should adopt exactly this stance.

### 3.2 `pg-cloudflare`

Already an optional dependency of `pg@8.23.0` (v1.4.0, 2026-05-18). It provides a `net.Socket`-shaped wrapper over Cloudflare's `connect()` TCP API, so `pg` itself runs on Workers.

### 3.3 `@electric-sql/pglite`

v**0.5.5**, published **2026-08-13** — very actively developed, zero deps, and it embeds **PostgreSQL 18.3** (verified by string-scanning the shipped `pglite.data`). WASM-compiled Postgres, in-process, no server. Unpacked **25 MB / 308 files** (~3 MB gzipped at runtime). Extensions include pgvector and PostGIS. Kysely ships a `PGliteDialect` **in core** as of 0.29; Drizzle has `drizzle-orm/pglite`; Prisma uses it for `prisma dev` but publishes no adapter.

**The constraint that decides how we use it,** verbatim from the README: **"PGlite is single user/connection"** — Emscripten builds run strictly single-process, so Postgres's fork-per-connection model is unavailable. (Kysely encodes this as `supportsMultipleConnections: false` on its dialect adapter.)

So: excellent for fast query-correctness integration tests with zero infrastructure, and **useless for testing exactly the things §5 says are hard** — pooling, concurrent transactions, deadlocks, advisory locks under contention, cross-session `LISTEN`/`NOTIFY`. Plan for **both**: PGlite for the fast suite, Docker/Testcontainers PG for the concurrency suite. (`@electric-sql/pglite-socket` can expose it over a real socket if we ever want to point unmodified `pg` at it.)

### 3.4 Runtimes: Bun, Node, Deno — and a deprecation

**Node has no built-in PostgreSQL client** and no proposal for one; the only database module in core is SQLite (and `node:sqlite` is still **Stability 1.2 – Release Candidate** in both v24 LTS and v26, contrary to common belief). Node v26.7.0 is Current, **v24.19.0 is Active LTS**. Useful adjacent fact for our packaging: **TypeScript type stripping is now Stability 2 – Stable**, so if we author with `erasableSyntaxOnly: true` + `verbatimModuleSyntax` (no `enum`, no parameter properties, no `namespace`) our `.ts` runs unbuilt on Node, Bun and Deno.

**Deno** has no built-in PG client either; Deno's own Deploy docs tell you to `import { Pool } from "npm:pg"`. The native `deno-postgres` / JSR `@db/postgres` is at **0.19.5, last published 2025-04-24** — ~16 months stale, still pre-1.0, README self-describes as WIP. Effectively maintenance mode. `npm:pg` is the answer, which again favours a `pg`-shaped port.

**Bun's `Bun.sql`** is stable (introduced 1.2.0, unified PG+MySQL+SQLite in 1.3.0; latest 1.3.14, 2026-05-13). Note the module specifier is `import { sql, SQL } from "bun"` — **`bun:sql` is not a real module**, despite appearing colloquially in changelogs. The wire protocol is hand-implemented natively (Zig through 1.3.14; a Rust rewrite exists unreleased on `main`).

> ⚠️ **Bun.sql has no `setTypeParser` equivalent at all** — no parser hook of any kind (open issue [oven-sh/bun#25035](https://github.com/oven-sh/bun/issues/25035), unanswered since 2025-11). Its defaults are also idiosyncratic: `numeric` → string *always*, `int8` → string unless the **connection-wide** `bigint: true` is set, and binary `int4[]`/`float4[]` → `Int32Array`/`Float32Array` (so `Array.isArray(row.col) === false`).
>
> **This is disqualifying for our architecture.** §7.3 requires neutralising the driver's parsers and owning decoding; Bun.sql structurally cannot let us do that. Drizzle ships a `bun-sql` adapter and, tellingly, installs **no** parser overrides there — accepting the inconsistency. If we ever add a Bun.sql adapter we must document it as *not type-consistent with the others*, or decode from `.raw()` buffers ourselves. Bun users are better served today by `pg` or `postgres.js` under Bun's Node compat.

**Deprecated, avoid:** `@vercel/postgres` and `@vercel/postgres-kysely` are **npm-deprecated** — the registry message directs users to Neon ("existing Vercel Postgres databases should have been migrated to Neon"). On Vercel in 2026 you use `@neondatabase/serverless` directly. Also stale: `kysely-pglite` (2024-09), `@prisma/adapter-pg-worker` (6.9.0).

### 3.5 Do we need this for v1?

**No — but we need the seam.** Concretely: v1 ships one adapter (`pg`). The interface is designed so `@neondatabase/serverless` works by *literally passing it in place of `pg`* (it's API-compatible), and so PGlite/postgres.js adapters can be community-contributed. Zero v1 cost, large v2 optionality.

---

## 3b. How the incumbents stay driver-agnostic (read from installed source)

I installed and read the actual type definitions rather than relying on docs. This is the most directly reusable prior art we have.

### 3b.1 Kysely — the minimal interface (`kysely@0.29.5`)

Two interfaces do all the work. From `dist/driver/database-connection.d.ts`:

```ts
export interface DatabaseConnection {
  executeQuery<R>(compiledQuery: CompiledQuery, options?: AbortableOperationOptions): Promise<QueryResult<R>>
  streamQuery<R>(compiledQuery: CompiledQuery, chunkSize: number, options?: AbortableOperationOptions): AsyncIterableIterator<QueryResult<R>>
  cancelQuery?(controlConnectionProvider: ControlConnectionProvider): Promise<void>
  killSession?(controlConnectionProvider: ControlConnectionProvider): Promise<void>
  collectSessionInfo?(): Promise<void>
}

export interface QueryResult<O> {
  readonly rows: O[]
  readonly numAffectedRows?: bigint
  readonly numChangedRows?: bigint
  readonly insertId?: bigint
}
```

and `dist/driver/driver.d.ts`:

```ts
export interface Driver {
  init(options?): Promise<void>
  acquireConnection(options?): Promise<DatabaseConnection>
  beginTransaction(connection, settings: TransactionSettings): Promise<void>
  commitTransaction(connection): Promise<void>
  rollbackTransaction(connection): Promise<void>
  releaseConnection(connection, options?): Promise<void>
  destroy(options?): Promise<void>
  savepoint?(connection, savepointName, compileQuery): Promise<void>
  rollbackToSavepoint?(connection, savepointName, compileQuery): Promise<void>
  releaseSavepoint?(connection, savepointName, compileQuery): Promise<void>
}
```

`Dialect` then bundles four factories: `createDriver()`, `createQueryCompiler()`, `createAdapter()`, `createIntrospector(db)`.

**Two required connection methods. Seven required driver methods, with savepoints optional.** This is the shape to copy. Notably Kysely ships a **PGlite dialect in core** (`dist/dialect/pglite/`), alongside postgres/mysql/mssql/sqlite — confirming PGlite is now mainstream enough to matter.

> ⚠️ **The gap we should deliberately close.** Kysely's `QueryResult` has **no field metadata** — no column type OIDs, no typmods, no source table/column. It cannot, because it spans PG/MySQL/MSSQL/SQLite. That means Kysely fundamentally *cannot* do OID-driven result parsing or `Describe`-based query typing. **We are PostgreSQL-only, so our `PgResult` must carry `fields: readonly PgField[]` with `dataTypeID`, `dataTypeModifier`, `tableID`, `columnID`.** That single decision is what lets us do end-to-end type safety that a multi-dialect ORM structurally cannot — and it costs us nothing, because `pg` already hands us exactly that struct (§4.4).

#### ⭐ Kysely's best idea: **structural typing instead of importing `pg`**

`kysely@0.29.5` (2026-08-10) has **zero dependencies *and* zero peer dependencies**. It achieves that by never importing `pg` at all — it re-declares the subset it needs, with the rationale in the docblock:

```ts
/**
 * This interface is the subset of pg driver's `Pool` class that kysely needs.
 * We don't use the type from `pg` here to not have a dependency to it.
 */
export interface PostgresPool {
  connect(): Promise<PostgresPoolClient>
  end(): Promise<void>
  options: object
  Client?: PostgresClientConstructor
}
```

You then pass the pool in: `new PostgresDialect({ pool })`.

**This is the highest-leverage single decision in the whole survey, and it improves on §7.2.** The consequence is that *anything that duck-types as a `pg` Pool works with zero extra code* — which is precisely why `@neondatabase/serverless`'s WebSocket `Pool` and Cloudflare Hyperdrive need no custom dialect in Kysely. It also means **we do not need a peer dependency on `@types/pg` either** — we can declare our own minimal structural interface and have literally zero dependencies of any kind. Adopt this.

### 3b.2 Drizzle — one adapter package per driver (`drizzle-orm@0.45.2`)

Verified from `package.json`:

- **`dependencies`: none.** Zero runtime dependencies.
- **28 `peerDependencies`, all optional.** The PG-relevant ones: `pg >=8`, `postgres >=3`, `@neondatabase/serverless >=0.10.0`, `@electric-sql/pglite >=0.2.0`, `@vercel/postgres >=0.8.0`, `@xata.io/client`, `bun-types`, `@types/pg`.
- Subpath exports per driver: `drizzle-orm/node-postgres`, `/postgres-js`, `/neon-http`, `/neon-serverless`, `/pglite`, `/vercel-postgres`, `/pg-proxy`, all over a shared `/pg-core`.

The seam is an **abstract class**, not an interface. `pg-core/session.d.ts`:

```ts
export abstract class PgSession<...> {
  abstract prepareQuery<T>(query, fields, name, isResponseInArrayMode, customResultMapper?, queryMetadata?, cacheConfig?): PgPreparedQuery<T>
  abstract transaction<T>(fn, config?: PgTransactionConfig): Promise<T>
  // concrete: execute(), all(), count()
}
export abstract class PgPreparedQuery<T> { abstract execute(placeholderValues?): Promise<T['execute']> }
```

**Two abstract methods on the session, one on the prepared query.** Thicker than Kysely (it's a class hierarchy with `entityKind` runtime tagging), but the surface a new driver must implement is comparably small.

Two implementation details worth stealing:

1. **`rowMode: 'array'`.** `node-postgres/session.js:61` passes `rowMode: "array"` to `pg`, and the postgres.js adapter uses `.values()` — the equivalent. Drizzle then maps positionally via `customResultMapper?: (rows: unknown[][]) => T['execute']`. This is how you correctly handle **duplicate column names from JOINs** (`users.id` and `posts.id` both key `id` in object mode and silently clobber) and it avoids a per-row object allocation. **We should do the same.**

1b. **⭐ Drizzle *disables* the driver's type parsers and decodes in core.** This is the decisive validation of §7.3. It installs identity ("transparent") parsers for every temporal/numeric OID so the driver hands back raw strings, then decodes via each column's `mapFromDriverValue`:

   ```js
   const noop = (val) => val;
   const typeConfig = { getTypeParser: (typeId, format) => {
     switch (typeId) {
       case types.builtins.TIMESTAMPTZ: case types.builtins.TIMESTAMP:
       case types.builtins.DATE:        case types.builtins.INTERVAL:
       case 1231: case 1115: case 1185: case 1187: case 1182: return noop;
       default: return types.getTypeParser(typeId, format);
     }
   }};
   ```

   It does the same to postgres.js by mutating `client.options.parsers[oid]` and to PGlite via its `parsers` option. **Drizzle v1.0 formalises this into per-driver codec tables** (`nodePgCodecs`, `postgresJsCodecs`, `pgliteCodecs`, …) plus a user-facing `config.codecs` override and a `PostgresType` union with entries like `'bigint:number'`, `'numeric:bigint'`, `'interval:tuple'`, plus PostGIS/`vector`/ranges/multiranges.

   Two ORMs, arrived at independently, both concluding that **the driver's type parsing must be neutralised and owned by the ORM.** That is exactly §7.3.
2. `PgTransactionConfig` = `{ isolationLevel, accessMode, deferrable }` — a good minimal transaction-settings shape, slightly richer than Kysely's (which omits `deferrable`).

### 3b.3 Prisma — driver adapters, verified from source (`@prisma/adapter-pg@7.9.1`)

Installed and read `dist/index.js`. Two findings worth recording:

1. **The query config it builds is `{ text: sql, values, rowMode: "array" }` — with no `name` property anywhere.** So **Prisma 7 via driver adapters emits *unnamed* prepared statements and is pooler-safe by default**, which retires the entire legacy `?pgbouncer=true` / `statement_cache_size=0` story from the Rust-query-engine era. (Prisma's own docs now say *"we recommend **not** setting `pgbouncer=true`"* on PgBouncer ≥1.21 — see §5.6.) This independently confirms §5.7's recommendation.
2. **`rowMode: "array"`.** That is now **three** independent implementations — Prisma, Drizzle, and this document's recommendation — converging on array row mode for the same two reasons (no per-row object allocation; correct handling of duplicate column names in JOINs).

Packaging contrast worth noting: unlike Drizzle, `@prisma/adapter-pg` takes `pg` as a **real dependency** (`pg ^8.16.3`, plus `postgres-array`, `@types/pg`, `@prisma/driver-adapter-utils`), not a peer. That's the model we should *not* copy — it takes version control away from the user.

**Status:** driver adapters went **GA in Prisma 6.16.0 (2025-09-10)**, and in **Prisma 7 an adapter is mandatory** (the 7.0.0 release removed `datasources`/`datasourceUrl`/bare `new PrismaClient()`; the runtime literally carries the string `"adapter is required"`). Prisma is now Rust-free for *queries* — `@prisma/client@7.9.1` ships no `.node` binaries, only a WASM query compiler; the only remaining Rust binary is the schema engine for migrate/introspect. Current: 7.9.1 (2026-07-27). Prisma 8 is in Early Access, nothing on npm.

The interface (from the shipped `@prisma/driver-adapter-utils@7.9.1` `.d.ts`) is heavier than Kysely's because it spans four databases:

```ts
export interface SqlDriverAdapter extends SqlQueryable {
  queryRaw(params: SqlQuery): Promise<SqlResultSet>
  executeRaw(params: SqlQuery): Promise<number>
  executeScript(script: string): Promise<void>
  startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction>
  getConnectionInfo?(): ConnectionInfo
  dispose(): Promise<void>
}
export interface SqlResultSet {
  columnTypes: ColumnType[]; columnNames: string[]
  rows: unknown[][]            // ← array rows again
  lastInsertId?: string
}
```

**Two things worth stealing, one worth avoiding:**

- **Steal:** `ConnectionInfo { schemaName?, maxBindValues?, supportsRelationJoins }` — a clean capability-negotiation channel. Real values: pg/neon → no `maxBindValues`, `supportsRelationJoins: true`; Prisma Postgres → 16384; D1 → 98, `false`. We need the same for HTTP-only adapters that can't do interactive transactions.
- **Steal:** its `customParsers` for `pg` — Prisma **independently reached the identical conclusion as §1.5**: keep `NUMERIC` as a string (no precision loss), keep `DATE` as `YYYY-MM-DD` (explicitly suppressing pg's `Date`), normalise `TIMESTAMP`, strip the offset from `TIMETZ`, leave JSON stringified. Note also it sets `name` **only** if you supply a `statementNameGenerator` — i.e. unnamed by default, confirming §5.7.
- **Avoid:** normalising to a numeric `ColumnTypeEnum` (`Int32:0, Int64:1, … UnknownNumber:128`). That layer exists *only* because Prisma spans MySQL/SQLite/MSSQL. Its telling failure mode is the fallback for anything user-defined:
  ```js
  // Postgres custom types (types that come from extensions and user's enums).
  if (fieldTypeId >= FIRST_NORMAL_OBJECT_ID /* 16384 */) return ColumnTypeEnum.Text
  ```
  **Every user enum, domain, composite and extension type collapses to `Text`.** Being PG-only, we can instead resolve those dynamic OIDs from the user's schema at codegen time — which is precisely the moat described in §7.3.

### 3b.4 `drizzle-orm`'s peer-dependency model is the packaging answer

Zero `dependencies` + optional `peerDependencies` per driver is exactly the "minimal runtime dependencies" property we want, and it is *already proven at scale* — 18.2M weekly downloads. Adopt it verbatim.

---

## 4. Writing our own wire-protocol client

### 4.1 Honest scope of PG frontend/backend protocol v3

From [postgresql.org/docs/current/protocol-flow.html](https://www.postgresql.org/docs/current/protocol-flow.html):

**Startup & encryption negotiation**
- `SSLRequest` (magic 80877103) → 1 byte `'S'`/`'N'`, then TLS handshake, then `StartupMessage`. Must read **exactly one byte** before starting TLS (CVE-2021-23222 buffer stuffing) and must **ignore a pre-auth `ErrorResponse`** (CVE-2024-10977).
- PG17+ `sslnegotiation=direct` (skip the request round trip). `GSSENCRequest` for GSSAPI encryption.
- `StartupMessage`, `NegotiateProtocolVersion`, `ParameterStatus` × N, `BackendKeyData`, `ReadyForQuery`.

**Authentication** — 8 distinct `Authentication*` messages: Ok, CleartextPassword, MD5Password, GSS, GSSContinue, SSPI, SASL, SASLContinue, SASLFinal.
- SCRAM-SHA-256 alone is a multi-round-trip RFC 5802 implementation: nonce generation, `SaltedPassword = Hi(Normalize(password), salt, i)`, `ClientKey`/`StoredKey`/`ClientSignature`/`ServerSignature`, SASLprep normalisation, and server-signature verification. `pg`'s implementation is **262 LOC** (`lib/crypto/sasl.js`) plus **122 LOC** of `cert-signatures.js` for `-PLUS` channel binding (`tls-server-end-point` requires parsing the server cert's signature algorithm to pick the right hash).
- Getting SCRAM *subtly* wrong is a security bug, not a functionality bug. Missing server-signature verification = MITM.

**Query paths**
- Simple: `Query` → `RowDescription`/`DataRow*`/`CommandComplete`/`ReadyForQuery`. Gotcha: multi-statement strings run in an *implicit transaction* that rolls back entirely on first error.
- Extended: `Parse`/`Bind`/`Describe`/`Execute`/`Close`/`Sync`/`Flush` + `ParseComplete`/`BindComplete`/`ParameterDescription`/`NoData`/`PortalSuspended`/`CloseComplete`. Named vs unnamed statements and portals have **different lifetimes** (session vs transaction vs "until next Parse/Bind").
- Pipelining: correctness hinges on counting `ReadyForQuery` per `Sync`, **not** command completions, because skipped commands never complete.

**Data**
- Text and binary formats **per column**, negotiated in `Bind`. Binary means implementing wire encodings for int2/4/8, float4/8, numeric (base-10000 digit groups + weight/sign/dscale — genuinely fiddly), timestamp/timestamptz (µs since 2000-01-01), date (days since 2000-01-01), interval, uuid, bytea, bool, plus **generic array headers** (ndim, flags, elem OID, dims, lower bounds), **ranges** (flag byte + bounds), and **composite/record** (nfields, then per-field OID+len+data).
- Text format needs its own parsers: PG array literal grammar with quoting/escaping/`NULL`, range literal grammar, record literal grammar, `hex`/`escape` bytea, interval in 3 possible `IntervalStyle`s, and the `DateStyle`/`TimeZone` session settings that change how dates arrive.

**COPY** — `CopyInResponse`/`CopyOutResponse`/`CopyBothResponse`/`CopyData`/`CopyDone`/`CopyFail`, with mode-locked message handling and `Flush`/`Sync` silently ignored mid-copy. Copy-both is needed only for logical replication.

**Async & control** — `NoticeResponse`, `NotificationResponse` (LISTEN/NOTIFY; must be accepted at *any* point, not just at boundaries), `ParameterStatus` (15+ hard-wired GUCs; `search_path` added in v18, `scram_iterations` in v16), `ErrorResponse` field parsing (`S/V/C/M/D/H/P/p/q/W/s/t/c/d/n/F/L/R`), `CancelRequest` on a second connection using `BackendKeyData`, `Terminate`.

Roughly **60 distinct message types** across 11 phases.

### 4.2 Effort anchors (measured, not guessed)

| Reference implementation | Scope | LOC |
|---|---|---|
| `pg-protocol@1.16.0` `src/` (TS) | **Message codec only** — parser 414, serializer 280, messages 262, buffer r/w 168; tests 941 | **~1,120 prod + ~1,110 test** |
| `pg-types@2.2.0` `lib/` | Text + binary parsers, array parser, builtins | **556** |
| `pg` `lib/` (JS) | Client, connection, pool glue, SASL, params, results | **~2,200** (excl. `native/`) |
| **`pg` full stack (pure JS)** | codec + types + client | **≈ 3,900 prod LOC** |
| `postgres.js` `src/` | **Complete client**: connection+pipelining+pool+types+COPY+listen+cursors+replication | **2,694** |
| `jackc/pgx` `pgproto3/` (Go) | Message codec only | **5,342** |
| `jackc/pgx` `pgconn/` (Go) | Connection, auth, TLS, low-level exec | **5,692** |
| `jackc/pgx` `pgtype/` (Go) | Type system, text+binary, arrays/ranges/composites | **18,500** |
| `jackc/pgx` total (non-test) | Full driver + pool + toolkit | **39,450** |

*(Go LOC measured by `git clone --depth 1 https://github.com/jackc/pgx` on 2026-08-14.)*

The `pgtype` number is the honest warning: **the type system is 3.5× the size of the protocol codec.** People who say "the PG wire protocol is simple" are correct about the codec and wrong about everything downstream of it.

### 4.3 Realistic effort estimate

For a **v1 in-scope client** — TCP + TLS (incl. `sslnegotiation=direct`), SCRAM-SHA-256 (+ `-PLUS`), MD5 & cleartext for legacy, extended query protocol with named + unnamed statements, portals/cursors, pipelining, text-format parsing for the ~40 OIDs an ORM actually maps (incl. arrays, ranges, composites), binary format for the hot numeric/temporal subset, COPY in/out, LISTEN/NOTIFY, `CancelRequest`, full `ErrorResponse` field parsing, connection pool, reconnect/backoff:

- **Code: 3,500 – 5,000 LOC prod + 3,000 – 5,000 LOC test.** (`postgres.js` proves 2,700 is possible; add TS types, binary formats and a stricter error model.)
- **Calendar: 4 – 7 months for one strong engineer to reach "I'd put this in production."** Breakdown: ~3 weeks to first `SELECT 1` over TLS with SCRAM; ~6 weeks to feature-complete happy path; **the remaining 60–70% of the time is the long tail** — partial-packet reassembly across TCP boundaries, backpressure, `DateStyle`/`IntervalStyle`/`TimeZone` GUC interactions, numeric binary edge cases (NaN, ±Infinity in PG14+, negative dscale), array nulls and non-default lower bounds, `NOTICE` interleaving mid-`COPY`, cancellation races, pooler quirks, PG version matrix (14→18), Node version matrix, IPv6/unix sockets/`PGSERVICEFILE`/`.pgpass`/`PGSSLROOTCERT`.
- **Ongoing: an open-ended maintenance tax.** Every PG major release can add auth methods, GUCs and protocol tweaks. `pg` and `postgres.js` both shipped `sslnegotiation=direct` work in 2026 because PG17 required it — that is the steady-state cost we'd be signing up for, forever, for a project whose value proposition is the *ORM*, not the socket.

### 4.4 What an ORM needs vs. what a general driver needs

| Need | ORM (`pg-orm-ts`) | General driver |
|---|---|---|
| Parameterised extended-protocol execution | **Essential** | Essential |
| OID-level result parsing control | **Essential** (this is our type-safety contract) | Nice |
| Row-as-array result mode (avoid per-row object alloc, and handle duplicate column names from JOINs) | **Essential** | Nice |
| `RowDescription` field metadata (type OID + name + table OID + column attnum) exposed to the caller | **Essential** — powers introspection, codegen, and duplicate-column disambiguation | Often hidden |
| Transactions + savepoints + isolation levels + `getTransactionStatus()` | **Essential** | Essential |
| COPY | **Important** — bulk insert / seed / fixture loading | Important |
| Cursors / streaming | **Important** — `.stream()` on large selects | Important |
| Advisory locks (just SQL) | **Essential for migrations** | N/A |
| LISTEN/NOTIFY | Nice | Important |
| Logical replication | Out of scope for v1 | Nice |
| Large objects, `FunctionCall`, GSSAPI/SSPI | **Out of scope** | Expected |
| Binary result formats | Nice (perf), not correctness | Nice |

The right-hand column is where the effort blows up, and **most of it is stuff the ORM will never call.** Conversely, the two ORM-critical items that drivers under-serve — *rich `RowDescription` metadata* and *ORM-owned OID parsing* — are both already reachable through `pg`'s public API. **We do not need to own the socket to own the type system.**

#### The `Describe`-without-`Execute` trick (verified available in both drivers)

This deserves calling out because it is the single highest-leverage protocol feature for a *type-safe* ORM, and neither driver hides it:

`pg-protocol/src/messages.ts:146-151` exposes every `RowDescription` field:

```ts
public readonly name, tableID, columnID, dataTypeID, dataTypeSize, dataTypeModifier, format
```

and `ParameterDescriptionMessage` exposes `dataTypeIDs: number[]`.

So for any SQL string, you can send `Parse` + `Describe('S')` + `Sync` **without ever executing it** and get back, from the server itself: the inferred **parameter type OIDs**, and the **result column names + type OIDs + typmods + source table OID + source column attnum**. That is:

- `dataTypeModifier` (typmod) → `varchar(255)` length, `numeric(10,2)` precision/scale
- `tableID` + `columnID` → join back to `pg_attribute.attnotnull` to derive **nullability**, which the protocol does not otherwise give you
- the whole thing → compile-time-accurate TS types for arbitrary raw SQL (the `pgtyped`/`sqlc` approach), and a cheap way to validate migrations and query builders against the live schema

In `pg` this is `client.query({ text, name, values: [] })` with a `Describe`-only path, or more directly through the `Connection` API. In `postgres.js` it is the built-in `sql``...``.describe()` (`query.js:115` sets `onlyDescribe`). **Both give us this for free — an own-wire-client argument evaporates here too.**

---

## 5. Pooling reality check

### 5.1 The core conflict

Poolers in **transaction pooling mode** multiplex many clients over few server connections, reassigning the server connection at every transaction boundary. Session state does not follow the client.

PgBouncer publishes an official feature matrix ([pgbouncer.org/features.html](https://www.pgbouncer.org/features.html) — "transaction pooling breaks client expectations of the server **by design**"). The asymmetries matter more than the headline:

| Feature | Session | Transaction |
|---|---|---|
| `SET` / `RESET` | Yes | **Never** |
| **`LISTEN`** | Yes | **Never** |
| **`NOTIFY`** | Yes | **Yes** ← asymmetric! |
| `WITHOUT HOLD` cursor | Yes | **Yes** ← transaction-scoped, so fine |
| `WITH HOLD` cursor | Yes | **Never** |
| Protocol-level prepared plans | Yes | **Yes**, if `max_prepared_statements ≠ 0` |
| SQL `PREPARE` / `DEALLOCATE` | Yes | **Never** |
| `ON COMMIT DROP` temp tables | Yes | **Yes** ← fine |
| `PRESERVE`/`DELETE ROWS` temp tables | Yes | **Never** |
| `LOAD` | Yes | **Never** |
| Session advisory locks | Yes | **Never** (`pg_advisory_xact_lock` is fine) |

### 5.2 PgBouncer's prepared-statement support is now ON BY DEFAULT

This substantially changes the conventional wisdom and is the most important 2026 update in this section.

- **1.21.0** (2023-10-16, "The one with prepared statements") added protocol-level named prepared statement support in transaction mode via `max_prepared_statements`.
- **1.24.0** (2025-01-10) **changed the default from `0` to `200`.** Changelog verbatim: *"Enable prepared statement support by default, `max_prepared_statements` is now set to 200 by default."*
- Current release: **1.25.2** (2026-05-08). Note 1.25.1 fixed **CVE-2025-12819** (unauthenticated arbitrary SQL during auth) — worth knowing if we advise users on pooler versions.

Mechanism: PgBouncer maps each *unique query string* to an internal name `PGBOUNCER_{id}`, prepares it on the server under that name only, keeps a per-client name→internal map, and rewrites `Parse`/`Bind`/`Describe`/`Close` in flight. Statements are **shared across clients**, so with `pool_size=20` and 100 clients issuing the same SQL it is parsed 20 times, not 100. `max_prepared_statements` is a per-server-connection LRU.

**But the caveats are sharp:**

- **SQL-level `PREPARE`/`EXECUTE`/`DEALLOCATE` are forwarded straight through and remain broken.** Only `DEALLOCATE ALL`/`DISCARD ALL` are special-cased (they clear PgBouncer's tracking).
- **Unnamed statements are not tracked**, just forwarded.
- **The DDL landmine**, docs verbatim: *"If the return or argument types of a prepared statement changes across executions then PostgreSQL currently throws an error such as: `ERROR: cached plan must not change result type`… you can run `RECONNECT` on the PgBouncer admin console after doing the migration."* Directly relevant to us: **our own migration tool can trigger this in a user's running app.**
- **Client-name `DEALLOCATE` breaks it.** PgBouncer's FAQ documents PHP/PDO being incompatible unless PHP 8.4+ *and* libpq 17. Root cause: drivers that clean up with SQL `DEALLOCATE <client-name>` send a name the server never saw. libpq 17 added `PQclosePrepared` (protocol `Close`) to fix this.

### 5.3 Pooler support matrix (2026)

| Pooler | Named prepared statements in transaction mode | Notes |
|---|---|---|
| **PgBouncer 1.25.2** | ✅ **on by default** (since 1.24.0) | active |
| **Neon** (PgBouncer) | ✅ `max_prepared_statements=1000` | pooled hosts carry a **`-pooler`** suffix |
| **Cloudflare Hyperdrive** | ✅ since 2024-06-28 | per-client Parse map + per-conn LRU with auto-`DEALLOCATE`; explicitly notes *unnamed* statements get no cross-connection benefit |
| **AWS RDS Proxy** | ✅ since 2023-11-10 | multiplexes the extended protocol; **no longer pins on it** |
| **PgDog** | ✅ | pgcat's successor; ignores client `Close` by design; optional SQL-`PREPARE` rewriting (off by default) |
| **pgcat** | ✅ since v1.1.0 | ⚠️ **stale**: last release 2024-11-11, last commit 2025-02-27; README still wrongly claims no support |
| **Supavisor** (Supabase) | ❌ **No** | Supabase docs still ship a page titled "Disabling Prepared statements". Ports: `6543` = transaction, `5432` = session |
| **pgpool-II 4.7.x** | n/a | session-level pooling only; different constraint set |

**RDS Proxy still pins** on: `SET`, SQL `PREPARE`/`DISCARD`/`DEALLOCATE`/`EXECUTE`, temp sequences/tables/views, **declaring cursors**, `LISTEN`, `LOAD`, `nextval`/`setval`, `pg_advisory_lock`/`pg_try_advisory_lock` (**explicitly not** the `_xact_` variants), and **any statement over 16 KB**. Also: *"If you use connection pooling libraries with `DISCARD ALL` query configured as a reset query, RDS Proxy pins your client connection on release."* Session pinning filters are **MySQL-only** — there is no PostgreSQL opt-out.

### 5.4 The `Flush` vs `Sync` rule — the key protocol insight

> **An unnamed extended-protocol statement is safe under transaction pooling if and only if the `Parse` and the `Bind`/`Execute` are not separated by a `Sync`.**

Why: the spec says *"An unnamed prepared statement lasts only until the next Parse… is issued"* and that `Sync` *"causes the backend to close the current transaction if it's not inside a `BEGIN`/`COMMIT` block"*, then emits `ReadyForQuery`. **`ReadyForQuery` is exactly where a transaction pooler may release the server connection.** `Flush` produces no `ReadyForQuery`, so it is safe to split across a `Flush` but never across a `Sync`.

`pgx` (Go) documents this failure mode explicitly in its `QueryExecMode` docs, and it is the best prior art in any ecosystem:

| pgx mode | Behaviour | Round trips |
|---|---|---|
| `CacheStatement` (**default**) | auto-prepare + cache named statements | 1 (warm) |
| `CacheDescribe` | **cache the statement *description*; assume it doesn't change; no named statements** | **1** |
| `DescribeExec` | Describe on every execution via the unnamed statement — *"**may cause problems with connection poolers that switch the underlying connection between round trips**"* | 2 |
| `Exec` | infer param types from Go types, text format | 1 |
| `SimpleProtocol` | simple protocol; *"only… if connecting to a proxy… that does not support the extended protocol"* | 1 |

pgx's `DescribeExec` warns about poolers because it `Sync`s. **postgres.js's superficially identical two-round-trip `prepare:false` path uses `Flush`, so it is pooler-safe** — but still pays the extra RTT (§2.4).

### 5.5 How the drivers behave

| Driver | Under transaction pooling |
|---|---|
| **`pg`** | Prepared statements are opt-in via `name`, so **the default is already both safe and optimal**: unnamed `Parse`+`Bind`+`Describe('P')`+`Execute`+`Sync` corked into **one write, one round trip**, with param types inferred client-side. Setting `name` gives you the classic errors, and `pg` has **no statement cache and no auto-retry** — recovery is on us. `queryMode: 'extended'` (8.12.0+) forces the extended protocol even for parameterless queries. |
| **`postgres.js`** | `prepare: false` is safe (`Flush`, not `Sync`) but costs **2 RTT per execution forever** (§2.4). `prepare: true` self-heals via retry on `FetchPreparedStatement`/`RevalidateCachedQuery`/`transformAssignedExpr`. |
| **`@neondatabase/serverless`** | HTTP mode is one-shot; WS mode inherits `pg` semantics. Neon's PgBouncer allows named statements. |

Errors to know: `26000` `invalid_sql_statement_name` (routine `FetchPreparedStatement`), `42P05` `duplicate_prepared_statement`, `0A000` `cached plan must not change result type`, and — with PgBouncer ≥1.21 — a third variant, `prepared statement "PGBOUNCER_x" does not exist`, which means something cleared PgBouncer's per-client tracking.

### 5.6 Prior art on detecting pooler mode: **there is none**

Every driver and ORM in every ecosystem requires a manual flag: Prisma `?pgbouncer=true`, postgres.js `prepare:false`, Drizzle (inherits the driver's), JDBC `prepareThreshold=0`, PDO `ATTR_EMULATE_PREPARES`, asyncpg `statement_cache_size=0`, psycopg3 `prepare_threshold=None`, Npgsql `Max Auto Prepare=0` (**note: Npgsql, the only mainstream driver with true auto-prepare, ships it OFF**), pgx `QueryExecMode`.

That is simultaneously a gap we could fill and a strong hint about the right answer: **the ecosystem's solution has been to make the safe thing the default so that detection is unnecessary.**

Instructive failure: Prisma issue [#21799](https://github.com/prisma/prisma/issues/21799) — combining the legacy `pgbouncer=true` workaround with a *modern* PgBouncer that has `max_prepared_statements>0` produces `prepared statement "PGBOUNCER_x" does not exist`. Closed as not planned; the fix is to remove the flag. Prisma's own docs now say: *"We recommend **not** setting `pgbouncer=true` if you're using PgBouncer 1.21.0 or later."* **A client-side pooler workaround became the bug.** We should be very reluctant to add one.

### 5.7 What `pg-orm-ts` should default to

1. **Default to unnamed extended-protocol statements with client-side param type inference.** One round trip, zero session state, works on *every* pooler in §5.3 including Supavisor and pgpool-II, and on RDS Proxy without pinning. `pg` gives us exactly this by simply not setting `name`. The only cost is a server-side re-parse — **not** a round trip.
2. **First optimization should be caching the *description*, not the statement** — pgx's `CacheDescribe`. Cache `(sql → param OIDs, result field OIDs/typmods)` in a process-wide map, skip `Describe`, still emit an unnamed `Parse` every time. One RTT, no server state, no pooler coupling, and it hands us the metadata we need for typed results and binary decoding for free. Invalidate on `0A000`/`42P18`/`42804`.
3. **Named statements: opt-in, per-physical-connection, LRU-bounded, self-healing.** If offered: clean up with the protocol `Close` message (`'C'`,`'S'`,name) — **never** SQL `DEALLOCATE <name>`, which is precisely what broke PHP/PDO against PgBouncer. Retry-after-evict on `26000`/`42P05`/`0A000`. Downgrade the pool to unnamed permanently after N recurrences and log loudly.
4. **Never emit `DISCARD ALL` / `DEALLOCATE ALL`** as a reset query — it clears PgBouncer's per-client tracking *and* pins RDS Proxy connections.
5. **Never emit SQL-level `PREPARE`/`EXECUTE`/`DEALLOCATE`.** Universally unsupported or pinning; only PgDog handles it, behind an off-by-default flag.
6. **Opt-in `pipeline: true`,** off by default (coarser error isolation in `pg`; §1.4).
7. **Don't ship our own pool for v1;** delegate to the adapter. But own the *policy*: default `max` low (5–10, `1` for serverless) and document the **N instances × pool max × pooler `default_pool_size`** multiplication that is how people actually exhaust `max_connections`.
8. **Ship a two-URL model out of the box** (`DATABASE_URL` pooled + `DIRECT_URL` direct). Every managed provider needs it (Prisma's `DIRECT_URL`, Neon's `-pooler` host, Supabase 6543 vs 5432). Route **migrations, `LISTEN`, session advisory locks, `WITH HOLD` cursors, `LOAD`, and logical replication** to the direct URL — by *feature*, not by connection.
9. **Prefer transaction-scoped variants everywhere:** `SET LOCAL`, `pg_advisory_xact_lock`, `ON COMMIT DROP` temp tables, `WITHOUT HOLD` cursors. All work under transaction pooling *and* avoid RDS Proxy pinning. **Our migration lock must be `pg_advisory_xact_lock`.**
10. **Don't auto-detect; make detection unnecessary — then use heuristics only to *upgrade*.** Since the default is safe, a false negative costs performance, never correctness. Optional low-risk upgrade signals: Neon `-pooler` hostname; Supabase `:6543` (stay unnamed) vs `:5432`; explicit user config. A `pg_backend_pid()`-changes-across-transactions probe can power a *warning*, but should never silently switch modes. Note PgBouncer's `SHOW POOLS` admin console exposes `pool_mode` but needs admin credentials and **only speaks the simple query protocol**, so it is a CLI diagnostic, not a runtime detector.

---

## 6. Decision matrix

Scores 1 (bad) – 5 (excellent), weighted for *this* project.

| Criterion | Weight | (a) `pg` | (b) `postgres.js` | (c) Own wire client | (d) Adapter iface + `pg` default |
|---|---|---|---|---|---|
| **Maintenance risk** | ×3 | 5 — 7 releases in 2026, multiple committers | **2 — ~4 commits in 2026, bus factor 1, 230 open issues** | 1 — risk becomes ours, forever | 5 — plus we can swap out if `pg` ever stalls |
| **Effort to v1** | ×3 | 5 — days | 5 — days | **1 — 4–7 months** | 4 — days + ~300 LOC of seam |
| **Perf** | ×1 | 5 — within ~5% of best on raw throughput, **and 1 RTT vs 2 in pooler-safe mode** (§2.4) | 3 — ~3% ahead raw, but `prepare:false` costs 2 RTT/query forever | 5 — theoretical ceiling (binary formats) | 5 |
| **Dependency count** | ×2 | 3 — 13 pkgs, but 11 are same-author | **5 — zero deps** | 5 — zero deps | 5 — `peerDependency`, so **0 deps we own** |
| **Type-parsing control** | ×3 | 4 — per-client `types` override; must ship our own table anyway | 4 — `types` option, less granular, text-only | 5 — total control incl. binary | 4 — we own the table; adapter just hands us bytes |
| **Testability** | ×2 | 3 — needs a real PG or heavy mocking | 3 — same | 4 — can unit-test the codec | **5 — mock the 6-method interface; PGlite adapter for integration** |
| **Security posture** | ×2 | 5 — SCRAM-SHA-256-**PLUS** channel binding, `scramMaxIterations`, PG17 direct TLS | **3 — no channel binding** (§2.8) | 2 — we'd own every SCRAM/TLS CVE | 5 |
| **Ecosystem / user familiarity** | ×2 | 5 — everyone already has `pg` installed | 3 | 1 | 5 |
| **Runtime reach (edge/serverless)** | ×1 | 4 — `pg-cloudflare`, Neon is API-compatible | 4 — `cf/` build | 2 | 5 |
| **Weighted total (max 95)** | | **83** | **68** | **52** | **89** |

---

## 7. Recommendation in detail

### 7.1 Adopt (d): a thin adapter interface, `pg` as the sole v1 implementation

Model the interface on **Kysely's `Dialect`/`Driver`/`DatabaseConnection`** — the cleanest minimal seam in the TS ecosystem — rather than Prisma's heavier `SqlDriverAdapter` (which needs its own `ColumnType` normalisation enum precisely because it must span MySQL/SQLite/PG; we are PG-only and can skip that entire layer).

Sketch (Kysely's shape, plus the PG-specific metadata Kysely structurally cannot carry):

```ts
export interface PgDriver {
  init(): Promise<void>
  acquireConnection(): Promise<PgConnection>
  releaseConnection(conn: PgConnection): Promise<void>
  destroy(): Promise<void>
}

export interface PgConnection {
  /** Extended protocol. `name` omitted => unnamed statement (pooler-safe default, §5). */
  execute(sql: string, params: readonly unknown[], opts?: {
    name?: string
    rowMode?: 'array' | 'object'     // we default to 'array', like Drizzle
  }): Promise<PgResult>

  stream(sql: string, params: readonly unknown[], chunkSize: number): AsyncIterable<PgResult>

  /** Parse + Describe + Sync, no Execute. Powers raw-SQL typing & migration validation (§4.4). */
  describe?(sql: string): Promise<{ paramTypes: number[]; fields: readonly PgField[] }>

  cancel?(): Promise<void>
}

export interface PgResult {
  rows: unknown[][] | Record<string, unknown>[]
  rowCount: number | null
  command: string
  /** REQUIRED. This is our introspection + codegen + nullability input. */
  fields: readonly PgField[]
}

export interface PgField {
  name: string
  dataTypeID: number        // OID -> our parser table
  dataTypeModifier: number  // typmod -> varchar(n), numeric(p,s)
  tableID: number           // -> pg_attribute for NOT NULL
  columnID: number
  format: 'text' | 'binary'
}
```

Transactions (`begin`/`commit`/`rollback`/savepoints) live **above** this interface as plain SQL emitted by the ORM, rather than as driver methods as in Kysely — PostgreSQL's transaction syntax is identical across every adapter, so there is nothing to abstract. That trims the interface to **4 driver methods + 2 required connection methods**.

The `pg` adapter is a ~150-line file. Because Neon's driver is deliberately `pg`-API-compatible, `@neondatabase/serverless` drops into the same adapter with a constructor swap.

### 7.2 Declare `pg` as a `peerDependency`, not a `dependency`

```jsonc
{
  "dependencies":         {},                                  // ← genuinely empty
  "peerDependencies":     { "pg": ">=8.23.0" },
  "peerDependenciesMeta": { "pg": { "optional": true } },
  "devDependencies":      { "pg": "^8.23.0", "@types/pg": "^8.21.0" }
}
```

This is what Drizzle does (zero `dependencies`, ~30 optional peers) and it is correct here: `pg-orm-ts` genuinely has **zero runtime dependencies**, the user chooses and controls the driver version (important for security patching), and duplicate-`pg`-instance bugs (two pools, two type-parser registries) are impossible. Require `pg >= 8.23.0` so we can rely on `pipeline`, `getTransactionStatus()` and `sslnegotiation=direct`.

**Go one step further than Drizzle and adopt Kysely's structural typing (§3b.1).** `pg` ships **no bundled types**, so the naive approach forces a `@types/pg` dependency on every consumer. Instead, declare our own minimal structural interface for the handful of `pg` shapes we touch:

```ts
// We deliberately do NOT `import type { Pool } from 'pg'` — that would add a
// hard @types/pg dependency and break duck-typed drop-ins like Neon's Pool.
export interface PgLikePool {
  connect(): Promise<PgLikePoolClient>
  end(): Promise<void>
}
export interface PgLikePoolClient {
  query(config: { text: string; values?: unknown[]; rowMode?: 'array'; types?: TypeParserTable }): Promise<PgLikeResult>
  release(err?: boolean): void
}
```

Then `pgOrm({ pool })`. Payoff: **zero dependencies *and* zero peer dependencies**, `@types/pg` needed only in our own devDeps, and `@neondatabase/serverless`'s `Pool` plus Cloudflare Hyperdrive work with no adapter code at all — exactly as they do for Kysely today. (`@neondatabase/serverless@1.1.0` inlined its types and switched `Buffer`→`Uint8Array`, so *nominal* type identity with `@types/pg` is gone anyway; structural typing is the only approach that stays robust to that.)

Finally, ship a **one-function escape hatch** modelled on `drizzle-orm/pg-proxy`, whose entire driver contract is:

```ts
type RemoteCallback = (sql: string, params: unknown[], method: 'all' | 'execute') => Promise<{ rows: unknown[] }>
```

That is the cheapest possible way to let a user adapt an exotic backend (an HTTP proxy, a test double, a queue) without us writing or maintaining an adapter.

### 7.3 Own the type layer unconditionally

Ship `pg-orm-ts`'s own OID→parser table and pass it via `new Pool({ types })`. **Never** call the global `pg.types.setTypeParser` — it mutates process-wide state and would corrupt other libraries in the user's app. Mandatory overrides given the §1.5 measurements:

| OID | Type | `pg-types@2.2.0` default | `pg-orm-ts` default |
|---|---|---|---|
| 1082 | `date` | local-midnight `Date` (**shifts the day**) | `PlainDate` / `'2026-08-14'` string |
| 1114 | `timestamp` | local-time `Date` | `PlainDateTime` / string (no implicit zone) |
| 1184 | `timestamptz` | `Date` (correct) | `Date` (keep) |
| 20 | `int8` | string | `bigint` |
| 1700 | `numeric` | string | string (or user-pluggable Decimal) |
| 3904/3906/3908/3910/3912/3926 | ranges | **unparsed string** | parsed range object |
| 2249 | `record` / composites | unparsed | parsed per registered composite type |
| user-defined enums/domains/composites | — | unparsed | resolved from our schema catalogue at codegen time |

The last row is the real differentiator and the reason this must live in the ORM: **only the ORM knows the user's schema**, so only the ORM can map a user enum's dynamic OID to a TypeScript union. No general driver can do that. This is our moat, and it costs nothing extra in driver choice.

Note how Prisma fails here precisely because it is multi-dialect — `fieldTypeId >= 16384 → ColumnTypeEnum.Text` collapses *every* user enum, domain, composite and extension type to `Text` (§3b.3). Being PG-only, we resolve those OIDs from the schema catalogue instead.

**This recommendation is not speculative — it is the convergent conclusion of every mature implementation:**

| ORM | What it does to the driver's type parsers |
|---|---|
| **Drizzle** | Installs identity/no-op parsers for all temporal + numeric OIDs, decodes in core via `mapFromDriverValue`; v1.0 formalises this into per-driver **codec tables** |
| **Prisma** | Overrides `getTypeParser` **per query**; keeps `NUMERIC` string, keeps `DATE` as `YYYY-MM-DD` *explicitly to suppress pg's `Date`*, normalises `TIMESTAMP`, strips `TIMETZ` offset |
| **Kysely** | Punts entirely — docs: *"Kysely never touches the runtime types the driver returns"* — and tells you to call `pg-types`' `setTypeParser` yourself |
| **`pg-orm-ts`** | Own the table (Drizzle/Prisma model), pass it via the adapter, **never** mutate globals |

Two independent teams converged on "neutralise the driver, decode in core", and the third explicitly declines to offer type safety here. That settles it.

### 7.4 Explicitly deferred

- **`postgres.js` adapter** — publish the interface, accept a community `@pg-orm-ts/adapter-postgresjs`. Do not make it the default; the maintenance data in §2.2 forbids it.
- **PGlite adapter** — high value for our own test suite (integration tests with no Docker) and worth doing early *internally* even if not shipped.
- **Own wire client** — revisit only if (i) we hit a concrete `pg` limitation we cannot patch upstream, or (ii) the project has real adoption and a dedicated maintainer. The adapter interface means this is a non-breaking change whenever we want it.

### 7.5 Concrete v1 defaults

| Setting | Default | Why |
|---|---|---|
| Statement mode | **unnamed + cached description** (pgx `CacheDescribe` shape) | 1 RTT, no server state, safe on *every* pooler incl. Supavisor; no `Sync` between Parse and Bind (§5.4) |
| `preparedStatements: 'named'` | opt-in | Per-connection LRU; cleanup via protocol `Close`, **never** SQL `DEALLOCATE`; retry-after-evict on `26000`/`42P05`/`0A000` |
| `pipeline` | `false` (opt-in) | `pg`'s pipeline mode destroys the connection on error; coarser isolation (§1.4) |
| Result row mode | **`array`** internally | Avoids per-row object allocation and correctly handles duplicate column names from JOINs (as Drizzle does) |
| Binary result format | on for the hot numeric/temporal subset | `pg` supports it per query; postgres.js cannot at any setting |
| Pool | delegated to adapter; `max` 5–10 (`1` serverless) | Document the N × max × `default_pool_size` multiplication |
| Reset query | **none** | `DISCARD ALL` clears PgBouncer tracking *and* pins RDS Proxy |
| Connection URLs | `DATABASE_URL` + `DIRECT_URL` | Route migrations, `LISTEN`, session locks, `WITH HOLD` cursors to direct |
| Migration lock | `pg_advisory_xact_lock` | Session-scoped advisory locks break under transaction pooling *and* pin RDS Proxy |
| TLS | `require` when the host is not localhost | Match modern managed-PG expectations; `pg` also gives us SCRAM-SHA-256-PLUS |

---

## 8. Sources

- npm registry, `npm view` / `api.npmjs.org/downloads`, queried 2026-08-14
- Source inspection of locally installed `pg@8.23.0`, `pg-protocol@1.16.0`, `pg-types@2.2.0`, `pg-pool@3.14.0`, `postgres@3.4.9`, `@neondatabase/serverless@1.1.0`, `kysely@0.29.5`, `drizzle-orm@0.45.2`, `@prisma/adapter-pg@7.9.1`
- `git clone --depth 1 https://github.com/jackc/pgx` — LOC measured 2026-08-14
- https://github.com/brianc/node-postgres — repo stats, issues, PRs
- https://raw.githubusercontent.com/brianc/node-postgres/master/CHANGELOG.md — release notes
- https://github.com/brianc/node-postgres/commits/master — commit activity
- https://github.com/brianc/node-postgres/issues/2646 — "implement pipelining mode allowed by libpq 14"
- https://github.com/brianc/node-postgres/issues/3193 — "Pipeline mode"
- https://github.com/brianc/node-postgres/pull/2706 — "[WIP][POC] Use pipelining mode"
- https://github.com/brianc/node-postgres/issues/3391 — "Performance: pg VS postgres.js VS Bun.SQL" (2025-02-21)
- https://github.com/porsager/postgres — repo stats, README claims
- https://github.com/porsager/postgres/commits/master — commit activity
- https://github.com/porsager/postgres/releases — release history
- https://github.com/nigrosimone/postgres-benchmarks — pg vs pg-native vs postgres.js, Node 26.7
- https://www.postgresql.org/docs/current/protocol-flow.html — protocol v3 message flow
- https://www.postgresql.org/docs/current/libpq-pipeline-mode.html — pipeline mode semantics

**ORM adapter patterns (§3b) & runtimes (§3.4):**
- https://raw.githubusercontent.com/kysely-org/kysely/master/src/dialect/postgres/postgres-dialect-config.ts — the *"we don't use the type from `pg` here to not have a dependency to it"* structural-typing docblock
- https://kysely.dev/docs/recipes/data-types — *"Kysely never touches the runtime types the driver returns"*
- https://github.com/prisma/prisma/blob/7.9.1/packages/driver-adapter-utils/src/types.ts — `SqlDriverAdapter`, `SqlResultSet`, `ConnectionInfo`
- https://github.com/prisma/prisma/blob/7.9.1/packages/adapter-pg/src/conversion.ts — OID→`ColumnType`, the `>= 16384 → Text` fallback, `customParsers`
- https://www.prisma.io/changelog/2025-09-10 — driver adapters + Rust-free ORM GA (6.16.0)
- https://github.com/prisma/prisma/releases/tag/7.0.0 — adapter now mandatory
- https://orm.drizzle.team/docs/latest-releases — v1.0 still in prerelease (rc.4, 2026-06-27)
- https://pglite.dev/docs/ — *"PGlite is single user/connection"*; PG 18.3
- https://bun.com/docs/api/sql — `Bun.sql` API surface
- https://github.com/oven-sh/bun/issues/25035 — no `setTypeParser` equivalent in Bun.sql
- https://nodejs.org/docs/latest-v26.x/api/sqlite.html — `node:sqlite` still Stability 1.2 (RC)
- https://docs.deno.com/deploy/reference/databases/ — Deno's own guidance is `npm:pg`

**Poolers (§5):**
- https://www.pgbouncer.org/changelog.html — 1.21.0 prepared statements; **1.24.0 default 0→200**; 1.25.2 (2026-05-08)
- https://www.pgbouncer.org/features.html — official session-vs-transaction feature matrix
- https://www.pgbouncer.org/faq.html — PHP/PDO incompatibility (SQL `DEALLOCATE` vs protocol `Close`)
- https://raw.githubusercontent.com/pgbouncer/pgbouncer/master/doc/config.md — `max_prepared_statements`, `server_reset_query`, `cached plan must not change result type` / `RECONNECT`
- https://www.crunchydata.com/blog/prepared-statements-in-transaction-mode-for-pgbouncer
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html — pinning list; `pg_advisory_xact_lock` explicitly exempt; `DISCARD ALL` reset query pins
- https://aws.amazon.com/blogs/database/amazon-rds-proxy-multiplexing-support-for-postgresql-extended-query-protocol/ (2023-11-10)
- https://blog.cloudflare.com/postgres-named-prepared-statements-supported-hyperdrive/ (2024-06-28)
- https://neon.com/docs/connect/connection-pooling — `max_prepared_statements=1000`; `-pooler` hostname
- https://supabase.com/docs/guides/troubleshooting/disabling-prepared-statements-qL8lEL — per-client guidance; Supavisor tx mode has **no** prepared statements
- https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/pgbouncer — *"we recommend **not** setting `pgbouncer=true`"* on PgBouncer ≥1.21
- https://github.com/prisma/prisma/issues/21799 — legacy client workaround breaking a modern pooler; closed as not planned
- https://raw.githubusercontent.com/jackc/pgx/master/conn.go — `QueryExecMode` docs; the `DescribeExec` pooler warning
- https://www.npgsql.org/doc/prepare.html — `Max Auto Prepare` defaults to **0**
- https://github.com/postgresml/pgcat — ⚠️ last commit 2025-02-27; README stale
- https://docs.pgdog.dev/features/connection-pooler/prepared-statements/
- https://www.pkgpulse.com/guides/pg-vs-postgres-js-vs-neon-serverless-postgresql-drivers-2026 — ⚠️ unreliable, cited only to flag its unsupported "2-3x" claim

**Validation note:** all code-behaviour claims (pipelining, prepared-statement paths, SCRAM channel binding, type-parser defaults, `RowDescription` fields, adapter interfaces) were verified by reading the installed package source and, for `pg-types`, by executing its parsers on sample text input in Node. Claims were *not* additionally validated against a live server (a probe against the local PostgreSQL 18 instance was intentionally not run). The type-parser results in §1.5 are from real `pg-types@2.2.0` execution and are the most load-bearing empirical finding.
