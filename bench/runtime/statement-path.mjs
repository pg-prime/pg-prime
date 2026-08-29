// The **statement path** with the database taken out of it: what one `execute()` costs on the
// client between the compiled query and the driver seam, and back.
//
// ─── Why this exists, and why it is a PR gate rather than a nightly one ─────
//
// design/08 §5 splits the perf work in two: ratios against a real server run nightly on a fixed
// runner, and everything deterministic and I/O-free gates every PR, because "gating PRs on noise
// trains people to re-run CI until it passes". Until design/12 §4 P there was nothing in the PR
// half that could see the *session layer*: `bench:compile` measured the builder and the decoder,
// and the nine e2e pairs — the only thing that measured `run` → `acquire` → `execute` → `release`
// — need a server and therefore run once a night.
//
// That gap has a name now. design/12 §3 S added hooks, timing, call-site capture, the dev guard,
// error mapping and per-statement timeouts to exactly that path, every one of them green on its
// own tests, and the cost only appeared in the nightly's cheapest case — `point select by PK`,
// 1.286 → 1.603 — a day after the merge. A constant per-statement cost is invisible in a ratio
// whose denominator is a network round trip, and it is *obvious* here.
//
// ─── The null driver ────────────────────────────────────────────────────────
//
// A `PgDriver` that returns a fixed result. It parses no SQL and invents no rows beyond the two
// it is given, because a mock that tried to be a database would be a second implementation to
// keep honest. What it preserves is the shape of the seam: `acquire` and `release` are async, so
// the lease still costs a tick; `execute` resolves a `PgResult` with `fields`, so `decoderFor`
// still runs and the row is still decoded through real codecs.
//
// So the number this produces is "our client-side work per statement, with the socket removed" —
// not a latency, and never comparable with one. It is gated as a ratio to `sampler.mjs`'s
// reference workload, like every other time in this bench, and by bytes/op, which is
// machine-independent.
//
// ─── The three arms ─────────────────────────────────────────────────────────
//
//   pre-session   `driver.acquire()` → `runOn(...)` → `driver.release()`. Literally what
//                 `src/query/run.ts` did before design/12 §3 S, so it is the floor the session
//                 layer is measured against rather than an invented one.
//   production    the real `Db` with `NODE_ENV=production`'s defaults — no call-site capture, no
//                 dev guard, no hooks. What a deployed process pays.
//   dev           the real `Db` with the defaults `07` §7.4 and §1.5 ship — call-site capture and
//                 the guard on. Reported, not gated: it is a debugging aid whose cost is a
//                 documented trade, and a budget on it would gate a feature nobody runs in
//                 production.

/** A `PgField` with everything but the OID defaulted. */
function field(name, dataTypeID) {
  return {
    name,
    dataTypeID,
    dataTypeModifier: -1,
    tableID: 0,
    columnID: 0,
    dataTypeSize: -1,
    format: 'text',
  }
}

const NOTICES = Object.freeze([])

/**
 * A driver that answers every statement with the same three-column row.
 *
 * One frozen `PgResult`, reused: the allocation being measured is *ours*, and a driver that minted
 * a fresh result per call would add its own to the number.
 */
export function nullDriver() {
  const result = Object.freeze({
    rows: Object.freeze([Object.freeze(['1', 'ada@example.com', 'Ada'])]),
    fields: Object.freeze([field('id', 20), field('email', 25), field('name', 25)]),
    rowCount: 1,
    command: 'SELECT',
    notices: NOTICES,
  })
  const serverParameters = Object.freeze({ server_version: '17.0', TimeZone: 'UTC' })
  const connection = {
    serverParameters,
    transactionStatus: 'I',
    execute: () => Promise.resolve(result),
    // eslint-disable-next-line require-yield
    async *stream() {
      yield { rows: result.rows, fields: result.fields, done: true }
    },
  }
  return {
    adapter: 'null',
    async init() {},
    async acquire() {
      return connection
    },
    async release() {},
    async destroy() {},
    capabilities: {
      adapter: 'null',
      execModes: ['unnamed', 'named', 'simple'],
      binaryResults: false,
      paramTypeOids: true,
      describe: false,
      richFieldMetadata: true,
      cursors: true,
      copyIn: false,
      copyOut: false,
      listenNotify: false,
      cancel: false,
      multipleStatementsPerSession: true,
      maxConnections: undefined,
      maxParams: 65535,
      serverVersionNum: 170000,
    },
  }
}

/**
 * The three arms, as thunks over one shared driver and one shared compiled statement.
 *
 * The query is **built once and compiled once**, deliberately: the builder chain has its own
 * gates two sections up in `run.mjs`, and mixing them in here would make a compile regression
 * look like a statement-path regression. What varies between the arms is only what wraps the
 * `execute`.
 */
export async function statementPathArms(api, fixture, ns) {
  const fx = fixture.makeFixture(ns)
  const h = fx.schema.h
  const driver = nullDriver()
  await driver.init()
  const registry = new api.Registry()

  const query = (db) =>
    db
      .from(h.users)
      .select(({ users: u }) => ({ id: u.id, email: u.email, name: u.name }))
      .where(({ users: u }) => api.eq(u.id, 1n))

  const compiled = query(api.compileOnly(fx.schema)).compile()

  const mk = (extra) => api.pgPrime({ driver, schema: fx.schema, registry, ...extra })
  const production = mk({ errors: { captureCallSite: false }, devGuard: false })
  const dev = mk({ errors: { captureCallSite: true }, devGuard: true })

  return {
    /**
     * The pre-session-layer path, transcribed from `src/query/run.ts` at `fb723f4`:
     *
     * ```ts
     * async use(f) {
     *   const conn = await this.#driver.acquire()
     *   try { return await f(conn) } finally { await this.#driver.release(conn) }
     * }
     * run(compiled, opts) { return this.use((conn) => runOn(conn, compiled, this.env, opts)) }
     * ```
     *
     * Written out rather than simplified, because the `use` wrapper is itself an `async` frame and
     * a "floor" that quietly dropped one would flatter every measurement taken against it.
     */
    preSession: async (runOn, makeEnv) => {
      const env = makeEnv(registry, {})
      const use = async (f) => {
        const conn = await driver.acquire()
        try {
          return await f(conn)
        } finally {
          await driver.release(conn)
        }
      }
      return () => use((conn) => runOn(conn, compiled, env))
    },
    production: () => () => production.run(compiled),
    dev: () => () => dev.run(compiled),
    compiled,
  }
}
