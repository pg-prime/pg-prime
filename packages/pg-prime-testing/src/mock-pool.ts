/**
 * `createMockPool()` — the tier-0 driver double (design/08 §4.1).
 *
 * `pg-prime`'s driver seam is **structural**: `pgPrime({ pool })` takes anything shaped like a
 * `pg.Pool` (`PgLikePool`, design/02 §3), so the unit tier costs nothing to build. This pool
 * records every statement it is handed and replays a script of answers, which turns "what SQL does
 * this code emit, with which binds, in which order?" into an ordinary assertion — no database, no
 * I/O, and a whole suite in milliseconds.
 *
 * ```ts
 * const pool = createMockPool({ script: [{ rows: [['1', 'ada@example.com']] }] })
 * const db = pgPrime({ pool, schema })
 * await db.from(db.h.users).select(({ users: u }) => ({ id: u.id, email: u.email })).execute()
 * expect(pool.queries[0]?.text).toContain('from "public"."users"')
 * ```
 *
 * ## Three things worth knowing
 *
 * 1. **Rows are wire rows.** pg-prime asks for `rowMode: 'array'`, so a scripted row is an array
 *    of the raw *text* PostgreSQL would send — `'1'`, not `1n`. The codecs in your schema decode
 *    it, which is the point: a mock that hands back already-decoded objects tests nothing about
 *    the decode path.
 * 2. **The `pg_settings` handshake is answered for you** and is not recorded. pg-prime reads a
 *    handful of GUCs once per physical connection (design/02 §4.7); that is a handshake, not a
 *    statement your test wrote, so it never consumes a script step and never appears in
 *    {@link MockPool.queries}. Override the values with `serverParameters` if a test needs, say,
 *    an older `server_version_num`.
 * 3. **Errors are scripted as data.** A step with a `code` is thrown as a duck-typed server error
 *    — `{ severity, code, message, … }`, exactly the shape `pg` raises and the shape pg-prime's
 *    `normaliseError` detects (it never uses `instanceof`). So `23505` really does arrive as a
 *    `UniqueViolationError` with its constraint name.
 */

import type { PgLikeClient, PgLikePool, PgLikeQueryConfig, PgLikeResult } from 'pg-prime'

/** How pg-prime asked for a statement to be run, recovered from the `pg` query config. */
export type MockQueryMode = 'simple' | 'unnamed' | 'named'

/** One statement the pool was handed, in the order it was handed over. */
export interface RecordedQuery {
  readonly text: string
  /** `$1..$n`, already encoded by the codecs. Empty for a simple-protocol statement. */
  readonly values: readonly unknown[]
  /**
   * `simple` when nothing forced the extended protocol, `named` when a prepared-statement name
   * was sent, `unnamed` otherwise — design/02 §5.3's three paths, read back off the wire config.
   */
  readonly mode: MockQueryMode
  /** Did the caller ask for binary results? pg-prime never does; a `true` here is a bug. */
  readonly binary: boolean
  readonly rowMode: 'array' | undefined
  /** The prepared-statement name, when `mode` is `'named'`. */
  readonly name: string | undefined
  /** Which mock client answered it — `0` for the first connection the pool handed out. */
  readonly client: number
  /** The config verbatim, for the rare assertion the fields above do not cover. */
  readonly config: PgLikeQueryConfig
}

/** A column description. Only `name` and `dataTypeID` are ever read; the rest have defaults. */
export interface MockField {
  name: string
  tableID: number
  columnID: number
  dataTypeID: number
  dataTypeSize: number
  dataTypeModifier: number
  format: 'text' | 'binary'
}

/** One scripted answer: a result set. */
export interface MockResult {
  /** Wire rows: each row an array of the text PostgreSQL would send, or `null`. */
  readonly rows?: readonly (readonly (string | null)[])[]
  /**
   * Column descriptions. Only needed when the statement's result shape is *dynamic* — a bare
   * `db.sql\`…\`` fragment, whose codecs pg-prime picks from the OIDs the server reports. A
   * statement built from the schema carries its own codecs, so `fields` can be omitted.
   * A string is shorthand for a `text` column of that name.
   */
  readonly fields?: readonly (string | MockField)[]
  /** Defaults to `rows.length`. `null` is what pg reports for a command that returns no count. */
  readonly rowCount?: number | null
  /** Defaults to `'SELECT'`. */
  readonly command?: string
}

/**
 * One scripted answer: a server error.
 *
 * `code` and `severity` are what pg-prime's duck-typed detection keys on; everything else is
 * optional and is passed through to the error class, so `constraint` / `table` / `detail` land in
 * the message a `UniqueViolationError` prints.
 */
export interface MockError {
  /** SQLSTATE. Its presence is what makes a step an error rather than a result. */
  readonly code: string
  readonly message?: string
  readonly severity?: string
  readonly detail?: string
  readonly hint?: string
  readonly position?: string | number
  readonly schema?: string
  readonly table?: string
  readonly column?: string
  readonly dataType?: string
  readonly constraint?: string
  readonly where?: string
  readonly routine?: string
}

/**
 * A scripted step, or a function that produces one from the statement it is answering.
 *
 * The function form is how a mock answers a *class* of statement rather than a position: a script
 * of one `(q) => q.text.startsWith('insert') ? { command: 'INSERT', rowCount: 1 } : { rows: [] }`
 * survives a change in the number of statements the code under test emits.
 */
export type MockStep = MockResult | MockError | ((query: RecordedQuery) => MockResult | MockError)

export interface MockPoolOptions {
  /** Answers, in order. Runs out → every later statement gets an empty `SELECT` result. */
  readonly script?: readonly MockStep[]
  /**
   * What the `pg_settings` handshake reports. Merged over {@link DEFAULT_SERVER_PARAMETERS}, so
   * `{ server_version_num: '150013' }` changes one value and keeps the rest.
   */
  readonly serverParameters?: Readonly<Record<string, string>>
  /** `pool.options.max`, which pg-prime reads for `capabilities.maxConnections`. Default 10. */
  readonly max?: number
}

/** The recording pool. Satisfies `PgLikePool`, so it goes straight into `pgPrime({ pool })`. */
export interface MockPool extends PgLikePool {
  /** Every statement, across every connection, in the order the pool saw it. */
  readonly queries: readonly RecordedQuery[]
  /** `queries.map((q) => q.text)` — the assertion most golden tests actually want. */
  readonly texts: readonly string[]
  /** How many script steps have been consumed. */
  readonly stepsUsed: number
  /** How many connections the pool has handed out, and how many are still checked out. */
  readonly connectCount: number
  readonly checkedOut: number
  /** Was `end()` called? `pgPrime`'s `db.end()` reaches it. */
  readonly ended: boolean
  /** Append more answers to the script, mid-test. */
  push(...steps: MockStep[]): void
  /** Forget every recorded statement and every unconsumed step. */
  reset(): void
}

/** The GUCs pg-prime asserts on each physical connection (design/02 §4.7), all at their defaults. */
export const DEFAULT_SERVER_PARAMETERS: Readonly<Record<string, string>> = Object.freeze({
  DateStyle: 'ISO, MDY',
  IntervalStyle: 'postgres',
  TimeZone: 'UTC',
  standard_conforming_strings: 'on',
  client_encoding: 'UTF8',
  integer_datetimes: 'on',
  server_version: '17.11',
  server_version_num: '170011',
  search_path: '"$user", public',
  application_name: '',
})

/** How pg-prime spells the handshake. Matched on a substring so a reword here does not break it. */
const SERVER_PARAMS_MARKER = 'pg_catalog.pg_settings'

const textField = (name: string): MockField => ({
  name,
  tableID: 0,
  columnID: 0,
  dataTypeID: 25,
  dataTypeSize: -1,
  dataTypeModifier: -1,
  format: 'text',
})

const isError = (step: MockResult | MockError): step is MockError =>
  typeof (step as MockError).code === 'string'

/**
 * A `PgLikePool` that records and replays.
 *
 * Every connection it hands out shares one recording and one script — the pool is the unit of
 * assertion, because which pooled connection a statement landed on is not something a test that
 * asserts SQL should have to know.
 */
export function createMockPool(options: MockPoolOptions = {}): MockPool {
  const queries: RecordedQuery[] = []
  const script: MockStep[] = [...(options.script ?? [])]
  const params: Record<string, string> = {
    ...DEFAULT_SERVER_PARAMETERS,
    ...options.serverParameters,
  }
  const paramRows: (string | null)[][] = Object.entries(params).map(([k, v]) => [k, v])
  let stepsUsed = 0
  let connectCount = 0
  let checkedOut = 0
  let ended = false

  function answer(q: RecordedQuery): Promise<PgLikeResult> {
    const raw = script[stepsUsed]
    if (raw === undefined) return Promise.resolve(toResult({}))
    stepsUsed += 1

    const step = typeof raw === 'function' ? raw(q) : raw
    if (isError(step)) return Promise.reject(toServerError(step))
    return Promise.resolve(toResult(step))
  }

  function record(config: PgLikeQueryConfig, client: number): RecordedQuery {
    const q: RecordedQuery = {
      text: config.text,
      values: config.values ?? [],
      mode:
        config.queryMode === 'extended'
          ? config.name === undefined
            ? 'unnamed'
            : 'named'
          : 'simple',
      binary: config.binary === true,
      rowMode: config.rowMode,
      name: config.name,
      client,
      config,
    }
    queries.push(q)
    return q
  }

  const newClient = (index: number): MockClient => new MockClient(index, record, answer, paramRows)

  const pool: MockPool = {
    connect(): Promise<MockClient> {
      const index = connectCount
      connectCount += 1
      checkedOut += 1
      const client = newClient(index)
      client.onRelease = (): void => {
        checkedOut -= 1
      }
      return Promise.resolve(client)
    },
    end(): Promise<void> {
      ended = true
      return Promise.resolve()
    },
    options: { max: options.max ?? 10 },
    get totalCount(): number {
      return connectCount
    },
    get idleCount(): number {
      return Math.max(0, connectCount - checkedOut)
    },
    get waitingCount(): number {
      return 0
    },
    get queries(): readonly RecordedQuery[] {
      return queries
    },
    get texts(): readonly string[] {
      return queries.map((q) => q.text)
    },
    get stepsUsed(): number {
      return stepsUsed
    },
    get connectCount(): number {
      return connectCount
    },
    get checkedOut(): number {
      return checkedOut
    },
    get ended(): boolean {
      return ended
    },
    push(...steps: MockStep[]): void {
      script.push(...steps)
    },
    reset(): void {
      queries.length = 0
      script.length = 0
      stepsUsed = 0
    },
  }
  return pool
}

/**
 * One checked-out connection.
 *
 * A class rather than an object literal because `PgLikeClient.query` is **overloaded** — the
 * config form returns a promise and the Submittable form returns the submittable it was given —
 * and an object literal cannot declare two call signatures for one property.
 */
class MockClient implements PgLikeClient {
  readonly #index: number
  readonly #record: (config: PgLikeQueryConfig, client: number) => RecordedQuery
  readonly #answer: (q: RecordedQuery) => Promise<PgLikeResult>
  readonly #paramRows: readonly (readonly (string | null)[])[]
  readonly #listeners = new Map<string, Set<(arg: never) => void>>()
  /** Set by the pool so a `release()` can be counted. */
  onRelease: (() => void) | undefined
  /** One entry per `release()`, in order — `'destroy'` when the caller asked for the socket. */
  readonly releases: ('reuse' | 'destroy')[] = []

  constructor(
    index: number,
    record: (config: PgLikeQueryConfig, client: number) => RecordedQuery,
    answer: (q: RecordedQuery) => Promise<PgLikeResult>,
    paramRows: readonly (readonly (string | null)[])[],
  ) {
    this.#index = index
    this.#record = record
    this.#answer = answer
    this.#paramRows = paramRows
  }

  query(config: PgLikeQueryConfig): Promise<PgLikeResult | PgLikeResult[]>
  query<T extends { submit(connection: never): unknown }>(submittable: T): T
  query(
    arg: PgLikeQueryConfig | { submit(connection: never): unknown },
  ): Promise<PgLikeResult | PgLikeResult[]> | unknown {
    if (typeof (arg as { submit?: unknown }).submit === 'function') {
      // COPY and cursor streaming go through pg's Submittable seam, which is a protocol
      // conversation rather than a request/response. Driving one from a script would be a
      // second, worse implementation of the wire protocol; `startPglite()` is the fixture for it.
      throw new Error(
        'createMockPool() does not drive pg Submittables (COPY, cursors). Those are wire-protocol ' +
          'conversations, not request/response — use startPglite() from @pg-prime/testing for them.',
      )
    }
    const config = arg as PgLikeQueryConfig
    if (config.text.includes(SERVER_PARAMS_MARKER)) {
      return Promise.resolve({
        rows: this.#paramRows.map((r) => [...r]),
        fields: [textField('name'), textField('setting')],
        rowCount: this.#paramRows.length,
        command: 'SELECT',
      })
    }
    return this.#answer(this.#record(config, this.#index))
  }

  on(event: 'notice' | 'notification' | 'error' | 'end', listener: (arg: never) => void): unknown {
    const set = this.#listeners.get(event) ?? new Set()
    set.add(listener)
    this.#listeners.set(event, set)
    return this
  }

  removeListener(event: string, listener: (arg: never) => void): unknown {
    this.#listeners.get(event)?.delete(listener)
    return this
  }

  /** Raise a `notice` / `notification` / `error` at the code under test, as `pg` would. */
  emit(event: 'notice' | 'notification' | 'error' | 'end', payload?: unknown): void {
    for (const l of this.#listeners.get(event) ?? []) (l as (arg: unknown) => void)(payload)
  }

  getTransactionStatus(): 'I' | 'T' | 'E' {
    return 'I'
  }

  readonly processID = 4242

  release(err?: Error | boolean): void {
    if (this.releases.length > 0) return
    this.releases.push(err === true || err instanceof Error ? 'destroy' : 'reuse')
    this.onRelease?.()
  }
}

function toResult(step: MockResult): PgLikeResult {
  const rows = step.rows ?? []
  return {
    rows: rows.map((r) => [...r]),
    fields: (step.fields ?? []).map((f) => (typeof f === 'string' ? textField(f) : f)),
    rowCount: step.rowCount === undefined ? rows.length : step.rowCount,
    command: step.command ?? 'SELECT',
  }
}

/**
 * A scripted error, in `pg`'s own shape.
 *
 * A plain `Error` with the fields hung off it, not a subclass: pg-prime detects a server error by
 * duck-typing (`typeof code === 'string' && typeof severity === 'string'`) and never by
 * `instanceof`, because pg's own error has `name === 'error'`, PGlite's class is minified and Neon
 * ships two of its own (design/02 §7 trap 2). Anything else here would be testing a lie.
 */
function toServerError(step: MockError): Error & Record<string, unknown> {
  const message = step.message ?? `mock server error ${step.code}`
  const err = new Error(message) as Error & Record<string, unknown>
  err.name = 'error'
  err.severity = step.severity ?? 'ERROR'
  for (const [k, v] of Object.entries(step)) {
    if (v !== undefined) err[k] = v
  }
  err['message'] = message
  return err
}
