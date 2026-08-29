/**
 * The redaction policy (design/07 §4.3) and call-site capture (§7.4).
 *
 * ## Three decisions, each with a reason
 *
 *  1. **`sql` is included by default.** Our SQL is `$n`-parameterised by construction, so the text
 *     carries no user value; without it an error report is close to useless. Truncated at 4 KB.
 *  2. **`params` are redacted by default.** Parameters are *precisely* the PII, the tokens and the
 *     password hashes, and errors flow into third-party trackers. `paramCount` and `paramTypes`
 *     are always present and are enough to debug an arity or type mismatch.
 *  3. **PG's `DETAIL` is redacted by default, and this is the one everybody gets wrong.** A unique
 *     violation's detail reads `Key (email)=(alice@example.com) already exists.` — every ORM
 *     surveyed passes that straight into `error.message`, which puts a user's email in a log line.
 *     We parse it, keep the **columns** (safe, and genuinely useful: PG does not otherwise tell
 *     you which columns of a composite key collided) and drop the values.
 *
 * The one exception is `40P01`, whose `detail` names both processes and both relations and
 * contains no user data at all. Dropping it would throw away the only thing that makes a deadlock
 * diagnosable, so it is kept verbatim — recorded as an amendment to §4.3 in the AS BUILT note.
 */

/** `07` §4.3 — the `errors` key of `DbConfig`. */
export interface ErrorOptions {
  /** Default `true`. Our SQL never inlines a user value. */
  readonly includeSql?: boolean
  /** Default 4096, then elided with a marker. */
  readonly maxSqlLength?: number
  /** Default `false`. Parameters are the PII. */
  readonly includeParams?: boolean
  /** Default `false`. See the header — `DETAIL` leaks user values. */
  readonly includeDetail?: boolean
  /** Default `NODE_ENV !== 'production'`. A few microseconds per query. */
  readonly captureCallSite?: boolean
}

export interface ResolvedErrorOptions {
  readonly includeSql: boolean
  readonly maxSqlLength: number
  readonly includeParams: boolean
  readonly includeDetail: boolean
  readonly captureCallSite: boolean
}

export function resolveErrorOptions(
  opts: ErrorOptions | undefined,
  production: boolean,
): ResolvedErrorOptions {
  return {
    includeSql: opts?.includeSql ?? true,
    maxSqlLength: opts?.maxSqlLength ?? 4096,
    includeParams: opts?.includeParams ?? false,
    includeDetail: opts?.includeDetail ?? false,
    captureCallSite: opts?.captureCallSite ?? !production,
  }
}

export function redactSql(sql: string | undefined, o: ResolvedErrorOptions): string | undefined {
  if (sql === undefined || !o.includeSql) return undefined
  if (sql.length <= o.maxSqlLength) return sql
  return `${sql.slice(0, o.maxSqlLength)}… [${sql.length - o.maxSqlLength} more characters elided]`
}

/**
 * `Key (email, tenant_id)=(alice@example.com, 7) already exists.`
 *
 * The grammar is stable across every class-23 detail PostgreSQL produces (`ri_ReportViolation`
 * and `_bt_check_unique` build it the same way), which is why parsing it is safe where parsing a
 * *message* would not be. A detail that does not match is dropped entirely rather than guessed at.
 */
export interface ParsedDetail {
  readonly columns: readonly string[]
  readonly values: readonly string[]
  /** The referenced table of an FK detail (`… is not present in table "users".`). */
  readonly referencedTable?: string
}

const KEY_RE = /Key \(([^)]*)\)=\(((?:[^()]|\([^()]*\))*)\)/
const IN_TABLE_RE = /in table "([^"]+)"/

export function parseDetail(detail: string | undefined): ParsedDetail | undefined {
  if (detail === undefined) return undefined
  const m = KEY_RE.exec(detail)
  if (m === null) return undefined
  const columns = (m[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  const values = splitTopLevel(m[2] ?? '')
  const table = IN_TABLE_RE.exec(detail)?.[1]
  return table === undefined ? { columns, values } : { columns, values, referencedTable: table }
}

/** Split on commas that are not inside parentheses — a composite key value may itself be a row. */
function splitTopLevel(s: string): readonly string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(s.slice(start).trim())
  return out.filter((v) => v !== '')
}

/**
 * What survives redaction, and whether anything was dropped.
 *
 * `detailRedacted: true` records that we rewrote it, so a reader who sees `Key (email) already
 * exists` knows the value was removed on purpose rather than never sent.
 */
export function redactDetail(
  detail: string | undefined,
  sqlstate: string,
  o: ResolvedErrorOptions,
): { detail?: string; detailRedacted: boolean } {
  if (detail === undefined) return { detailRedacted: false }
  if (o.includeDetail) return { detail, detailRedacted: false }
  // A deadlock's DETAIL is `Process 123 waits for ShareLock on transaction 456; blocked by process
  // 789.` — no user value anywhere in it, and it is the only thing that makes 40P01 diagnosable.
  if (sqlstate === '40P01') return { detail, detailRedacted: false }
  const parsed = parseDetail(detail)
  if (parsed === undefined || parsed.columns.length === 0) return { detailRedacted: true }
  const cols = parsed.columns.join(', ')
  const suffix =
    parsed.referencedTable === undefined ? '' : ` (referencing table "${parsed.referencedTable}")`
  return { detail: `Key (${cols})=(…) [values redacted]${suffix}`, detailRedacted: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// Call-site capture (§7.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The stack trace on a rejected database promise points at *our* internals. `07` §7.4 calls
 * capturing the caller's frame "the single highest-value debugging feature in the whole runtime
 * layer", and it costs a few microseconds, so it is on outside production and off inside.
 *
 * `Error.captureStackTrace` is V8-only; the `new Error().stack` fallback keeps the feature working
 * on a runtime without it, at the cost of one extra frame to elide.
 */
const CAPTURE = (Error as { captureStackTrace?: (t: object, f?: unknown) => void })
  .captureStackTrace

/** Frames belonging to this library, elided so the first line is the user's own code. */
const INTERNAL =
  /[/\\](?:src|dist)[/\\](?:query|session|errors|driver|observe|pooler|compile|codec|sql)[/\\]/

/**
 * How deep to look for the caller's frame. At most four of our own frames sit between the boundary
 * and user code on any path that captures, so eight is generous; lowering it is the one change
 * that makes the feature silently return `undefined`, which is why it is a named constant.
 */
const CAPTURE_FRAMES = 8

/** V8's structured-frame hook: return the CallSite array instead of formatting a string. */
function rawFrames(_e: unknown, frames: readonly CallSiteLike[]): readonly CallSiteLike[] {
  return frames
}

interface CallSiteLike {
  getFileName?: () => string | null | undefined
  toString: () => string
}

/**
 * **It does not read `.stack`.** That makes V8 format every captured frame into a string and this
 * function then discards all but one of the lines. With `prepareStackTrace` handing back the raw
 * `CallSite[]`, the search runs over structured frames and exactly one is formatted: the one
 * returned. Measured (design/12 §4 P item 0): the two captures a pooled statement used to make
 * cost 42 µs and now cost 13, which is what makes `07` §7.4's "a few microseconds per query" true.
 * Both globals are restored in a `finally` with nothing awaited between, so nothing can observe
 * them changed.
 */
export function captureCallSite(boundary?: unknown): string | undefined {
  if (CAPTURE === undefined) return fromStackString(new Error('call-site').stack)
  const E = Error as unknown as {
    prepareStackTrace?: unknown
    stackTraceLimit: number
  }
  const prevPrepare = E.prepareStackTrace
  const prevLimit = E.stackTraceLimit
  const holder: { stack?: unknown } = {}
  try {
    E.prepareStackTrace = rawFrames
    E.stackTraceLimit = CAPTURE_FRAMES
    CAPTURE(holder, boundary)
    const frames = holder.stack
    if (!Array.isArray(frames)) return fromStackString(frames as string | undefined)
    for (const f of frames as readonly CallSiteLike[]) {
      const file = f.getFileName?.()
      if (file === undefined || file === null) continue
      if (file.startsWith('node:')) continue
      if (INTERNAL.test(file)) continue
      return `at ${f.toString()}`
    }
    return undefined
  } finally {
    E.prepareStackTrace = prevPrepare
    E.stackTraceLimit = prevLimit
  }
}

/** The fallback: a formatted stack, scanned line by line. */
function fromStackString(stack: string | undefined): string | undefined {
  if (stack === undefined) return undefined
  const lines = stack.split('\n')
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('at ')) continue
    if (INTERNAL.test(t)) continue
    if (t.includes('node:internal')) continue
    return t
  }
  return undefined
}
