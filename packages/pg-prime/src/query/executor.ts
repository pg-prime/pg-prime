/**
 * The executor (design/09 WS6; `03` §1.3–1.4 and §3.2; `07` §2, §6.3, §7.5).
 *
 * WS4 shipped `src/query/run.ts` — compile → `PgQuery` → `buildDecoder` and nothing more — with
 * the boundary written into its docblock. This file is the rest of it, and it is deliberately a
 * *module of functions over a `PgConnection`* rather than a class hierarchy: the only thing that
 * differs between `db.execute()` and `tx.execute()` is where the connection comes from, and
 * `Runner` (`./builder-state.ts`) is the two-line seam that says so.
 *
 * ## What happens on one execution, in order
 *
 *  1. `bindsToParams` walks `Compiled.binds` **once**, taking `encoded` for a `value` bind and
 *     calling `codec.encode` for a `slot` — so a prepared query re-encodes its parameters per
 *     execution and re-does nothing else (`03` §1.4b).
 *  2. the statement goes out as `mode: 'unnamed'` (the default, `07` §2.1) or `'named'` with a
 *     per-connection cached statement name (`07` §2.4).
 *  3. `assertShape` compares each declared codec's OID against `RowDescription.dataTypeID` when
 *     dev mode is on, and throws `CodecMismatchError` **before** decoding (`03` §3.2). Decoding
 *     first would hand back a value that is already wrong, which is the bug the check exists for.
 *  4. any column whose codec is `unknownCodec` — an untyped `sql` fragment — is resolved against
 *     the registry by the OID the server just reported, so `` sql`now()`.asUnsafe<Date>() ``
 *     yields a `Date` and not the string (`03` §3.2's "untyped fragments still decode correctly").
 *  5. the decode plan is memoised per `(Compiled, registry, generation, serverParameters, OID
 *     signature)`. The OID signature is in the key because of step 4: two executions of the same
 *     statement against a database where the fragment's type changed must not share a decoder.
 *
 * ## What is deliberately not here
 *
 * Savepoints, `40001` retry, `AsyncLocalStorage`, `LISTEN`, `COPY`, the pooler profile and
 * `db.diagnose()` are `07`'s session layer, which has no workstream in `09` yet. `cachedDescribe`
 * as an *exec mode* is likewise absent: what `07` §2.2 says it buys — a precomputed decode plan —
 * is what {@link describeCache} gives the one statement kind that cannot get it statically, and
 * the other half (binary result formats) is blocked on `02` §4.4 regardless.
 */

import type { AnyCodec, CodecRegistry } from '../codec/index.js'
import { unknownCodec } from '../codec/index.js'
import type { Bind, Compiled, FieldOrigin, FieldPlan, ResultShape } from '../compile/contract.js'
import { paramTypesOf } from '../compile/contract.js'
import type { DecoderMode } from '../compile/decode.js'
import { assertCodegenAvailable, buildDecoder } from '../compile/decode.js'
import type {
  PgConnection,
  PgField,
  PgParam,
  PgQuery,
  PgRawValue,
  PgResultChunk,
} from '../driver/index.js'
import { BuilderError } from '../sql/errors.js'
import { CodecMismatchError } from './errors.js'

// ─────────────────────────────────────────────────────────────────────────────
// Options and environment
// ─────────────────────────────────────────────────────────────────────────────

/** `07` §2.1's two modes the query builder can reach. `simple` is the migrator's, never ours. */
export type StatementMode = 'unnamed' | 'named'

/** `07` §2.4, verbatim. */
export interface PreparedStatementOptions {
  /**
   * Max named statements per *physical connection*. Default 100 — deliberately under PgBouncer's
   * per-server-connection default of 200, since PgBouncer shares one server connection across
   * clients and its own LRU is the real ceiling.
   */
  readonly maxPerConnection?: number
  /**
   * Consecutive self-heal events before this pool permanently downgrades to `unnamed` and logs at
   * error level. Default 3.
   */
  readonly downgradeAfterFailures?: number
  /** Statement-name prefix. Default `pgprime`. Names are `${prefix}_${fnv1a(sql)}_${seq}`. */
  readonly prefix?: string
}

export interface ExecOptions {
  /**
   * Dev-mode `assertShape` (`03` §3.2). Defaults to `NODE_ENV !== 'production'`.
   *
   * `false` in production is not a shrug: the check compares metadata the server sent anyway, so
   * it cannot catch anything a single test run against the same schema would not have caught, and
   * it costs one integer comparison per column per query.
   */
  readonly assertShape?: boolean
  /** `07` §2.1. Default `'unnamed'` — one round trip, zero session state, safe on every pooler. */
  readonly statement?: StatementMode
  readonly preparedStatements?: PreparedStatementOptions
  /**
   * How a result row is materialised (`03` §1.3). Default `'closure'`.
   *
   * `'codegen'` builds the row with `new Function` and is measurably faster
   * (`design/09` §3.7's follow-up has the numbers); it is opt-in and never the default because a
   * Content-Security-Policy without `unsafe-eval` — a Cloudflare Worker, a hardened Electron
   * renderer — forbids it. Choosing it on such a runtime throws **here**, at `pgPrime()`, not at
   * the first query.
   */
  readonly decoder?: DecoderMode
}

/** Everything an execution needs that is not the statement. One per `pgPrime(...)`. */
export interface ExecEnv {
  readonly registry: CodecRegistry
  readonly assertShape: boolean
  readonly statement: StatementMode
  readonly maxPerConnection: number
  readonly downgradeAfterFailures: number
  readonly prefix: string
  readonly decoder: DecoderMode
  /** Mutable: the self-heal counter and the one-way downgrade (`07` §2.4 policy 4). */
  readonly named: { selfHeals: number; downgraded: boolean }
}

let productionDefault: boolean | undefined

/**
 * `process` through `globalThis`, resolved once and cached — the same rule `src/sql/fragment.ts`
 * follows and for the same two reasons: zero `@types` dependencies, and a bundler that hoists this
 * module above the app's configuration must not pin the answer at module-evaluation time.
 */
function inProduction(): boolean {
  productionDefault ??=
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
      'NODE_ENV'
    ] === 'production'
  return productionDefault
}

export function makeEnv(registry: CodecRegistry, opts: ExecOptions | undefined): ExecEnv {
  const p = opts?.preparedStatements
  // Fail at construction, not at the first row: `new Function` either works in this runtime or it
  // does not, and finding out under load is the whole complaint against eval-based fast paths.
  if (opts?.decoder === 'codegen') assertCodegenAvailable()
  return {
    registry,
    assertShape: opts?.assertShape ?? !inProduction(),
    statement: opts?.statement ?? 'unnamed',
    maxPerConnection: p?.maxPerConnection ?? 100,
    downgradeAfterFailures: p?.downgradeAfterFailures ?? 3,
    prefix: p?.prefix ?? 'pgprime',
    decoder: opts?.decoder ?? 'closure',
    named: { selfHeals: 0, downgraded: false },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Binds → wire parameters
// ─────────────────────────────────────────────────────────────────────────────

/** The parameters a prepared query is executed with: one per declared placeholder. */
export type PlaceholderValues = Readonly<Record<string, unknown>>

/**
 * One pass over `binds`, `codec.encode` per slot per execution (`03` §1.4b's contract, and the
 * tier-0 assertion that pins it).
 *
 * `null` is short-circuited here for the same reason `Emitter.bindValue` short-circuits it: SQL
 * NULL is not a value of any type, and letting it reach `encode` makes every codec responsible
 * for a case none of them accepts.
 */
export function bindsToParams(
  binds: readonly Bind[],
  values: PlaceholderValues | undefined,
): readonly PgParam[] {
  const out: PgParam[] = new Array(binds.length) as PgParam[]
  for (let i = 0; i < binds.length; i++) {
    const b = binds[i] as Bind
    if (b.k === 'value') {
      out[i] = b.encoded
      continue
    }
    if (values === undefined || !Object.hasOwn(values, b.name)) {
      throw new BuilderError(
        `pg-prime: prepared query is missing a value for placeholder "${b.name}". ` +
          `Pass it to .execute({ ${b.name}: … }).`,
      )
    }
    const v = values[b.name]
    out[i] = v === null || v === undefined ? null : b.codec.encode(v as never)
  }
  return out
}

/** An extra key is a typo, and a typo that is silently ignored is a query that filters on nothing. */
export function assertNoExtraPlaceholders(
  declared: readonly string[],
  values: PlaceholderValues | undefined,
): void {
  if (values === undefined) return
  for (const k of Object.keys(values)) {
    if (!declared.includes(k)) {
      throw new BuilderError(
        `pg-prime: .execute() was given "${k}", which this prepared query has no placeholder for ` +
          `(it declares: ${declared.length > 0 ? declared.join(', ') : 'none'}).`,
      )
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// assertShape (03 §3.2)
// ─────────────────────────────────────────────────────────────────────────────

/** `json` (114) and `jsonb` (3802) — the only two OIDs a relation/`nest` column can arrive as. */
const JSON_OIDS = new Set([114, 3802])

/**
 * Compare every declared codec's OID against the `dataTypeID` the server reported.
 *
 * Four cases are skipped, each for a stated reason:
 *
 *  - **no field metadata at all** (`fields.length === 0`) — a statement with no RETURNING, or an
 *    adapter that did not report one. There is nothing to compare against.
 *  - **`codec.oid === undefined`** — the codec claims no OID. That is an enum or a domain before
 *    `resolveDynamic` has run (`02` §4.6), and comparing against nothing would fire on every
 *    query against a schema with an enum in it.
 *  - **`unknownCodec`** — an untyped fragment declares nothing, so there is nothing to be wrong
 *    about; it is resolved dynamically instead ({@link resolveDynamicShape}).
 *  - **a `json` field** — a relation projection or a `json_agg`. Its OID is `json` or `jsonb`
 *    depending on the declared variant, and the *decoder* does not care which (`09` §3.5), so the
 *    check is "is it one of the two" and not "is it the one we guessed".
 *
 * A `nest({...})` group is walked into: its members are ordinary columns at their own row
 * positions, and they are exactly as capable of being wrong as a top-level one.
 */
export function assertShape(
  compiled: Compiled<unknown>,
  fields: readonly PgField[],
  registry: CodecRegistry,
): void {
  if (fields.length === 0) return
  const shape = compiled.shape
  if (shape.k === 'void') return
  if (shape.k === 'scalar') {
    checkOne(shape.codec, shape.idx, 'scalar', fields, registry, compiled.origins)
    return
  }
  walkFields(shape.fields, fields, registry, compiled.origins)
}

function walkFields(
  plan: readonly FieldPlan[],
  fields: readonly PgField[],
  registry: CodecRegistry,
  origins: readonly (FieldOrigin | undefined)[] | undefined,
): void {
  for (const f of plan) {
    if (f.k === 'group') {
      walkFields(f.fields, fields, registry, origins)
      continue
    }
    if (f.k === 'json') {
      const got = fields[f.idx]
      if (got !== undefined && !JSON_OIDS.has(got.dataTypeID)) {
        throw new CodecMismatchError({
          column: f.key,
          declared: 'json',
          declaredOid: 3802,
          actual: registry.forOid(got.dataTypeID)?.name,
          actualOid: got.dataTypeID,
          origin: origins?.[f.idx],
        })
      }
      continue
    }
    checkOne(f.codec, f.idx, f.key, fields, registry, origins)
  }
}

function checkOne(
  codec: AnyCodec,
  idx: number,
  key: string,
  fields: readonly PgField[],
  registry: CodecRegistry,
  origins: readonly (FieldOrigin | undefined)[] | undefined,
): void {
  if (codec === unknownCodec) return
  const declaredOid = codec.oid
  if (declaredOid === undefined) return
  const got = fields[idx]
  if (got === undefined || got.dataTypeID === declaredOid) return
  throw new CodecMismatchError({
    column: key,
    declared: codec.name,
    declaredOid,
    actual: registry.forOid(got.dataTypeID)?.name,
    actualOid: got.dataTypeID,
    origin: origins?.[idx],
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic-OID decode for untyped fragments (03 §3.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The row positions whose codec is `unknownCodec`, i.e. the ones the `RowDescription` decides.
 *
 * Memoised per `Compiled` because it is a pure function of a frozen plan, and because the common
 * answer is the empty array — a builder query with no `asUnsafe` fragment must not pay a walk of
 * its projection per execution.
 */
const DYNAMIC = new WeakMap<object, readonly number[]>()

function dynamicIndexes(compiled: Compiled<unknown>): readonly number[] {
  const hit = DYNAMIC.get(compiled)
  if (hit !== undefined) return hit
  const out: number[] = []
  collectDynamic(compiled.shape, out)
  const frozen = Object.freeze(out)
  DYNAMIC.set(compiled, frozen)
  return frozen
}

function collectDynamic(shape: ResultShape, out: number[]): void {
  if (shape.k === 'void') return
  if (shape.k === 'scalar') {
    if (shape.codec === unknownCodec) out.push(shape.idx)
    return
  }
  collectDynamicFields(shape.fields, out)
}

function collectDynamicFields(fields: readonly FieldPlan[], out: number[]): void {
  for (const f of fields) {
    if (f.k === 'group') collectDynamicFields(f.fields, out)
    else if (f.k === 'col' && f.codec === unknownCodec) out.push(f.idx)
  }
}

/**
 * Rebuild the decode plan with each untyped column's codec resolved from its reported OID.
 *
 * An OID with no codec keeps `unknownCodec`, whose `decodeText` is the identity — the same answer
 * `Registry.planFor` gives, and for the same reason: at runtime an unregistered type must not
 * take the query down, and guessing is worse than handing back the wire text.
 *
 * Returns the shape **by reference** when nothing is dynamic, which is every builder query.
 */
export function resolveDynamicShape(
  shape: ResultShape,
  dynamic: readonly number[],
  fields: readonly PgField[],
  registry: CodecRegistry,
): ResultShape {
  if (dynamic.length === 0) return shape
  const resolved = new Map<number, AnyCodec>()
  for (const idx of dynamic) {
    const got = fields[idx]
    if (got === undefined) continue
    const codec = registry.forOid(got.dataTypeID)
    if (codec !== undefined) resolved.set(idx, codec)
  }
  if (resolved.size === 0) return shape
  if (shape.k === 'scalar') {
    const codec = resolved.get(shape.idx)
    return codec === undefined ? shape : { k: 'scalar', idx: shape.idx, codec }
  }
  if (shape.k === 'void') return shape
  return { k: 'row', fields: substitute(shape.fields, resolved) }
}

function substitute(
  fields: readonly FieldPlan[],
  resolved: ReadonlyMap<number, AnyCodec>,
): readonly FieldPlan[] {
  return fields.map((f) => {
    if (f.k === 'group') return { ...f, fields: substitute(f.fields, resolved) }
    if (f.k !== 'col') return f
    const codec = resolved.get(f.idx)
    return codec === undefined ? f : { ...f, codec }
  })
}

/** The OID signature of the dynamic columns — part of the decoder memo key, and nothing else. */
function oidSignature(dynamic: readonly number[], fields: readonly PgField[]): string {
  if (dynamic.length === 0) return ''
  let s = ''
  for (const idx of dynamic) s += `${fields[idx]?.dataTypeID ?? 0},`
  return s
}

// ─────────────────────────────────────────────────────────────────────────────
// The decode-plan memo
// ─────────────────────────────────────────────────────────────────────────────

interface DecoderMemo {
  readonly registry: CodecRegistry
  readonly generation: number
  readonly serverParameters: Readonly<Record<string, string>>
  readonly oids: string
  readonly mode: DecoderMode
  readonly decode: (rows: readonly (readonly (string | null)[])[]) => unknown[]
}

const DECODERS = new WeakMap<object, DecoderMemo>()

/**
 * The decode plan, memoised per `Compiled` (`03` §1.3: "built once per `Compiled`").
 *
 * One entry deep and *revalidated* rather than a cache. A decoder is only reusable for the same
 * registry, the same registry **generation** (an enum's OID appears there after `resolveDynamic`),
 * the same session parameters (`TimeZone`, `DateStyle` — per connection, which is why the context
 * comes from the connection), and — WS6's addition — the same **OID signature** for whatever
 * columns are decoded dynamically. Without that last component, a statement whose untyped fragment
 * changed type after a migration would keep decoding with the old codec forever.
 */
export function decoderFor<Row>(
  compiled: Compiled<Row>,
  registry: CodecRegistry,
  serverParameters: Readonly<Record<string, string>>,
  fields: readonly PgField[],
  mode: DecoderMode = 'closure',
): (rows: readonly (readonly (string | null)[])[]) => Row[] {
  const dynamic = dynamicIndexes(compiled as Compiled<unknown>)
  const oids = oidSignature(dynamic, fields)
  const hit = DECODERS.get(compiled)
  if (
    hit !== undefined &&
    hit.registry === registry &&
    hit.generation === registry.generation &&
    hit.serverParameters === serverParameters &&
    hit.oids === oids &&
    hit.mode === mode
  ) {
    return hit.decode as unknown as (rows: readonly (readonly (string | null)[])[]) => Row[]
  }
  const shape = resolveDynamicShape(compiled.shape, dynamic, fields, registry)
  const decode = buildDecoder<Row>(shape, { typmod: -1, registry, serverParameters }, mode)
  DECODERS.set(compiled, {
    registry,
    generation: registry.generation,
    serverParameters,
    oids,
    mode,
    decode: decode as unknown as DecoderMemo['decode'],
  })
  return decode
}

// ─────────────────────────────────────────────────────────────────────────────
// Named statements (07 §2.4)
// ─────────────────────────────────────────────────────────────────────────────

/** FNV-1a over the SQL text. Deterministic, so `pg_prepared_statements` reads the same twice. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

let nameSeq = 0

/** Per **physical connection**, never process-wide: a named statement lives on a backend. */
const STATEMENTS = new WeakMap<object, Map<string, string>>()

/**
 * The cache key is `conn.serverParameters`, **not** the `PgConnection` itself.
 *
 * `07` §2.4 says the cache is scoped "per physical connection … discarded when the connection is
 * destroyed", and the `PgConnection` object is not that: the pg adapter builds a fresh
 * `PgConnectionImpl` on every `acquire()`, so keying on it gave a cache per *checkout*. Measured
 * on PG 17.11 (`test/pg/executor.test.ts`): five pooled executions of one prepared query minted
 * five names and left five statements on the backend — the exact opposite of what naming them is
 * for, plus a leak that only ends when the backend recycles.
 *
 * `serverParameters` is the right key because the pg adapter caches it in a WeakMap keyed by the
 * underlying `pg` client (`loadServerParameters`), so it is one object per *physical* connection
 * for exactly that connection's lifetime — which is the lifetime a named statement has.
 *
 * The failure mode of the assumption is benign in both directions, which is why it is affordable:
 * an adapter that returns a fresh parameters object per checkout degrades to the per-checkout
 * behaviour we just fixed (one extra `Parse`, one leaked statement), and an adapter that shared
 * one object across two backends would produce a `26000`, which the self-heal below already
 * handles. Neither can return the wrong rows.
 */
function statementsOf(conn: PgConnection): Map<string, string> {
  const key = conn.serverParameters as object
  let m = STATEMENTS.get(key)
  if (m === undefined) {
    m = new Map()
    STATEMENTS.set(key, m)
  }
  return m
}

/**
 * `hash(sql) + ':' + paramOidSignature` (`07` §2.4).
 *
 * Both halves are required. The same SQL text with different inferred parameter types is a
 * genuinely different statement, and keying on text alone is how you get `42804` on the second
 * call.
 */
function statementKey(sql: string, paramTypes: readonly number[]): string {
  return `${fnv1a(sql)}:${paramTypes.join(',')}`
}

/**
 * Reserve a server-side name for this statement on this connection, evicting LRU if needed.
 *
 * Eviction sends the protocol `Close`, **never** SQL `DEALLOCATE`: the name PgBouncer gave the
 * server is its own, so a forwarded `DEALLOCATE <our name>` fails (`07` §2.4, and it is exactly
 * what breaks PHP/PDO against PgBouncer). An adapter with no `closeStatement` evicts by
 * forgetting — the server-side statement leaks until the connection recycles, which is still
 * strictly better than emitting `DEALLOCATE`.
 */
async function nameFor(conn: PgConnection, env: ExecEnv, key: string): Promise<string> {
  const m = statementsOf(conn)
  const hit = m.get(key)
  if (hit !== undefined) {
    // Move to the most-recently-used end. `Map` iterates in insertion order, which is the whole
    // LRU implementation.
    m.delete(key)
    m.set(key, hit)
    return hit
  }
  while (m.size >= env.maxPerConnection) {
    const oldest = m.keys().next()
    if (oldest.done === true) break
    const victim = m.get(oldest.value)
    m.delete(oldest.value)
    if (victim !== undefined && conn.closeStatement !== undefined) {
      await conn.closeStatement(victim).catch(() => {})
    }
  }
  const name = `${env.prefix}_${key.slice(0, key.indexOf(':'))}_${(nameSeq = (nameSeq + 1) % 1e6)}`
  // NAMEDATALEN - 1. The prefix is configurable, so this is a real bound and not a formality.
  if (name.length > 63) {
    throw new BuilderError(
      `pg-prime: prepared-statement name "${name}" is ${name.length} bytes; PostgreSQL allows 63. ` +
        `Shorten preparedStatements.prefix.`,
    )
  }
  m.set(key, name)
  return name
}

function forget(conn: PgConnection, key: string): void {
  STATEMENTS.get(conn.serverParameters as object)?.delete(key)
}

/** `07` §2.4's table, as data. */
const SELF_HEAL: Readonly<Record<string, 'reprepare' | 'invalidate-and-reprepare'>> = {
  '26000': 'reprepare', //                invalid_sql_statement_name — a pooler lost our statement
  '42P05': 'reprepare', //                duplicate_prepared_statement — our map is stale
  '0A000': 'invalidate-and-reprepare', // cached plan must not change result type (post-DDL)
  '42P18': 'invalidate-and-reprepare', // indeterminate_datatype
  '42804': 'invalidate-and-reprepare', // datatype_mismatch
}

/** SQLSTATE of anything that crossed the driver seam (`02` §7 D12: plain data, never a class). */
export function sqlStateOf(e: unknown): string | undefined {
  const raw = e as
    | { code?: unknown; pgPrime?: { server?: { sqlstate?: string } } }
    | null
    | undefined
  const direct = raw?.pgPrime?.server?.sqlstate
  if (typeof direct === 'string') return direct
  return typeof raw?.code === 'string' && raw.code.length === 5 ? raw.code : undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// The description / decode-plan cache (03 §1.4c)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `03` §1.4c asks for a bounded LRU keyed on SQL text for `sql`-tag statements with no declared
 * codecs, so `Parse + Describe` is not paid per execution.
 *
 * **AS BUILT, and it is a deviation worth reading.** With `rowMode: 'array'` the `RowDescription`
 * arrives with *every* result whether we cache anything or not, and in unnamed mode `Parse` is
 * sent per execution regardless (that is what "unnamed" means). So there is no round trip and no
 * `Describe` to save. What there *is* to save is the thing `07` §2.2 identifies as
 * `cachedDescribe`'s real payoff: **decode-plan construction**, one `registry.planFor(fields)` walk
 * per result. That is what this caches, and `builds` is the counter a test asserts on — not
 * `Parse` messages, which would be a count of something that did not change.
 */
export interface DescribeCacheStats {
  readonly hits: number
  readonly misses: number
  /** Decode plans actually constructed. The number the tier-1 test pins. */
  readonly builds: number
  readonly size: number
}

interface DescribeEntry {
  readonly registry: CodecRegistry
  readonly generation: number
  readonly oids: string
  readonly names: readonly string[]
  readonly decode: readonly ((raw: PgRawValue) => unknown)[]
}

const DESCRIBE_MAX = 256
const describeEntries = new Map<string, DescribeEntry>()
const describeCounters = { hits: 0, misses: 0, builds: 0 }

export function describeCacheStats(): DescribeCacheStats {
  return { ...describeCounters, size: describeEntries.size }
}

/** Drop everything. Called on `0A000` / `42P18` / `42804`, and by tests between cases. */
export function clearDescribeCache(resetCounters = false): void {
  describeEntries.clear()
  if (resetCounters) {
    describeCounters.hits = 0
    describeCounters.misses = 0
    describeCounters.builds = 0
  }
}

/** The name-keyed decoder for a fragment-only statement, from the cache when it is still valid. */
export function dynamicRowDecoder(
  sql: string,
  fields: readonly PgField[],
  registry: CodecRegistry,
): (rows: readonly (readonly PgRawValue[])[]) => Record<string, unknown>[] {
  let oids = ''
  for (const f of fields) oids += `${f.dataTypeID},`
  const hit = describeEntries.get(sql)
  if (
    hit !== undefined &&
    hit.registry === registry &&
    hit.generation === registry.generation &&
    hit.oids === oids
  ) {
    describeCounters.hits += 1
    // Refresh recency.
    describeEntries.delete(sql)
    describeEntries.set(sql, hit)
    return rowMapper(hit)
  }
  describeCounters.misses += 1
  describeCounters.builds += 1
  const entry: DescribeEntry = {
    registry,
    generation: registry.generation,
    oids,
    names: fields.map((f) => f.name),
    decode: registry.planFor(fields),
  }
  if (describeEntries.size >= DESCRIBE_MAX) {
    const oldest = describeEntries.keys().next()
    if (oldest.done !== true) describeEntries.delete(oldest.value)
  }
  describeEntries.delete(sql)
  describeEntries.set(sql, entry)
  return rowMapper(entry)
}

function rowMapper(
  entry: DescribeEntry,
): (rows: readonly (readonly PgRawValue[])[]) => Record<string, unknown>[] {
  const { names, decode } = entry
  return (rows) =>
    rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (let i = 0; i < names.length; i++) {
        out[names[i] as string] = (decode[i] as (raw: PgRawValue) => unknown)(row[i] ?? null)
      }
      return out
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution
// ─────────────────────────────────────────────────────────────────────────────

export interface RunOptions {
  readonly params?: PlaceholderValues | undefined
  readonly statement?: StatementMode | undefined
  readonly signal?: AbortSignal | undefined
  /**
   * An out-parameter the session layer fills so `07` §7.1's `serverMs` / `decodeMs` split is
   * measured rather than estimated.
   *
   * A mutable slot rather than a return value because `runOn` returns rows and every caller in the
   * builder wants exactly rows; threading a second value through five terminals to serve one
   * observer would cost more than this does. Absent ⇒ nothing is timed, which is the default and
   * the hot path.
   */
  readonly timing?: RunTiming | undefined
}

/** Filled by {@link runOn} when {@link RunOptions.timing} is supplied. Milliseconds. */
export interface RunTiming {
  serverMs: number
  decodeMs: number
}

function queryFor(
  compiled: Compiled<unknown>,
  opts: RunOptions | undefined,
  paramTypes: readonly number[],
): PgQuery {
  return {
    text: compiled.sql,
    params: bindsToParams(compiled.binds, opts?.params),
    paramTypes,
    ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
  }
}

/**
 * One statement on one connection: encode, send, check the shape, decode.
 *
 * The self-heal loop runs **at most twice** and only in named mode (`07` §2.4 policy 1). It is
 * safe here and nowhere else: `execute()` delivers rows all at once, so "no rows have been
 * delivered to the caller yet" is true by construction until this function returns. `stream()`
 * deliberately has no equivalent — re-issuing a cursor mid-iteration would silently restart it.
 */
export async function runOn<Row>(
  conn: PgConnection,
  compiled: Compiled<Row>,
  env: ExecEnv,
  opts?: RunOptions,
): Promise<Row[]> {
  const paramTypes = paramTypesOf(compiled.binds)
  const base = queryFor(compiled as Compiled<unknown>, opts, paramTypes)
  const wantNamed = (opts?.statement ?? env.statement) === 'named' && !env.named.downgraded
  const key = wantNamed ? statementKey(compiled.sql, paramTypes) : ''

  for (let attempt = 0; ; attempt++) {
    const named = wantNamed && !env.named.downgraded
    const query: PgQuery = named
      ? { ...base, mode: 'named', statementName: await nameFor(conn, env, key) }
      : base
    try {
      const timing = opts?.timing
      const sentAt = timing === undefined ? 0 : performance.now()
      const result = await conn.execute(query)
      const gotAt = timing === undefined ? 0 : performance.now()
      if (named) env.named.selfHeals = 0
      if (env.assertShape) {
        assertShape(compiled as Compiled<unknown>, result.fields, env.registry)
      }
      const rows = decoderFor(
        compiled,
        env.registry,
        conn.serverParameters,
        result.fields,
        env.decoder,
      )(result.rows as never)
      if (timing !== undefined) {
        timing.serverMs = gotAt - sentAt
        timing.decodeMs = performance.now() - gotAt
      }
      return rows
    } catch (e) {
      const action = healAction(e, conn, named, attempt)
      if (action === undefined) throw e
      if (action === 'invalidate-and-reprepare') clearDescribeCache()
      forget(conn, key)
      if (++env.named.selfHeals >= env.downgradeAfterFailures) downgrade(env, e)
    }
  }
}

/**
 * `07` §2.4's policy 1–3, as one predicate.
 *
 * Retry at most once; only for a statement we named (an unnamed statement has no server-side
 * object to have lost); and only when the session is **idle**, i.e. not in a transaction block at
 * all.
 *
 * ⚠️ **AMENDS `07` §2.4 policy 2**, which says "not in a *failed* transaction (`25P02`)" and
 * implies testing `transactionStatus === 'E'`. That cannot be implemented over `pg`: the error
 * callback fires before the `ReadyForQuery` that carries the new status, so the status read at
 * catch time is still `'T'` and the guard lets the retry through. Measured — the tier-2 case
 * flipped between surfacing `26000` and surfacing `25P02` run to run, which is the race.
 *
 * Requiring `'I'` is both implementable and correct: inside a transaction the failing statement
 * has *already* aborted the block, so every retry there is a `25P02` waiting to happen, and the
 * status is `'T'`/`'E'` either side of the race. Outside one it is `'I'` either side. The cost is
 * that a named statement lost mid-transaction is surfaced rather than healed, which is what
 * policy 2 wanted anyway.
 */
function healAction(
  e: unknown,
  conn: PgConnection,
  named: boolean,
  attempt: number,
): 'reprepare' | 'invalidate-and-reprepare' | undefined {
  const state = sqlStateOf(e)
  if (state !== undefined && (state === '0A000' || state === '42P18' || state === '42804')) {
    // The result *type* changed: every cached plan for this SQL is wrong on every connection,
    // whether or not we were using a named statement (`07` §2.4 policy 3).
    clearDescribeCache()
  }
  if (!named || attempt > 0 || state === undefined) return undefined
  if (conn.transactionStatus !== 'I') return undefined
  return SELF_HEAL[state]
}

/**
 * `07` §2.4 policy 4: repeated self-healing means our model of the environment is wrong, so the
 * pool goes to the always-correct mode and shouts. A one-way door for the process lifetime.
 */
function downgrade(env: ExecEnv, cause: unknown): void {
  if (env.named.downgraded) return
  env.named.downgraded = true
  const state = sqlStateOf(cause) ?? 'unknown'
  console.error(
    `pg-prime: prepared statements self-healed ${env.named.selfHeals} times in a row ` +
      `(last SQLSTATE ${state}); permanently downgrading this pool to unnamed extended protocol. ` +
      `See docs/pooler-compatibility.md.`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming (07 §6.3)
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamOptions {
  /** Rows per `FETCH`. Default 1 000 (`07` §6.3). */
  readonly batchSize?: number
  readonly signal?: AbortSignal
}

/**
 * Rows off a server-side cursor, decoded.
 *
 * The transaction and the connection are the **runner's** to own (`Runner.scope`), not this
 * function's: at the root `db.stream()` is one connection inside one `BEGIN`, and inside
 * `db.transaction()` it joins the caller's. Both are `07` §6.3's rule and both are the only cursor
 * form (`WITHOUT HOLD`) that works under transaction pooling.
 *
 * Back-pressure is the consumer's `await` — the next `FETCH` is issued when the current batch is
 * exhausted, which is exactly when this generator is resumed.
 */
export async function* streamOn<Row>(
  conn: PgConnection,
  compiled: Compiled<Row>,
  env: ExecEnv,
  opts?: StreamOptions & RunOptions,
): AsyncIterable<Row> {
  const paramTypes = paramTypesOf(compiled.binds)
  const query = queryFor(compiled as Compiled<unknown>, opts, paramTypes)
  let decode: ((rows: readonly (readonly (string | null)[])[]) => Row[]) | undefined
  const chunks: AsyncIterable<PgResultChunk> = conn.stream(query, opts?.batchSize ?? 1000)
  for await (const chunk of chunks) {
    if (decode === undefined) {
      if (env.assertShape) {
        assertShape(compiled as Compiled<unknown>, chunk.fields, env.registry)
      }
      decode = decoderFor(compiled, env.registry, conn.serverParameters, chunk.fields, env.decoder)
    }
    for (const row of decode(chunk.rows as never)) yield row
  }
}

/**
 * The same cursor, one array per `FETCH` (`07` §6.3, and decision 10 of design/12 §1).
 *
 * **A batch IS a FETCH.** That is the decision `09` §3.6 said needed making, and it is made this
 * way because the alternative — a re-batching layer that buffers rows until it has exactly
 * `batchSize` of them — would add a copy per batch to serve a promise the cursor already keeps:
 * every chunk but the last has exactly `batchSize` rows, because that is what `FETCH FORWARD n`
 * returns. Re-batching would cost memory and gain nothing except the guarantee that the *last*
 * batch is full, which it cannot be anyway.
 *
 * The empty terminal chunk a cursor yields when the row count is an exact multiple of the batch
 * size is swallowed: `for await (const batch of …)` handing back `[]` is a footgun, and the
 * iteration is over either way.
 */
export async function* streamBatchesOn<Row>(
  conn: PgConnection,
  compiled: Compiled<Row>,
  env: ExecEnv,
  opts?: StreamOptions & RunOptions,
): AsyncIterable<Row[]> {
  const paramTypes = paramTypesOf(compiled.binds)
  const query = queryFor(compiled as Compiled<unknown>, opts, paramTypes)
  let decode: ((rows: readonly (readonly (string | null)[])[]) => Row[]) | undefined
  const chunks: AsyncIterable<PgResultChunk> = conn.stream(query, opts?.batchSize ?? 1000)
  for await (const chunk of chunks) {
    if (decode === undefined) {
      if (env.assertShape) {
        assertShape(compiled as Compiled<unknown>, chunk.fields, env.registry)
      }
      decode = decoderFor(compiled, env.registry, conn.serverParameters, chunk.fields, env.decoder)
    }
    if (chunk.rows.length === 0) continue
    yield decode(chunk.rows as never)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPLAIN (07 §7.5)
// ─────────────────────────────────────────────────────────────────────────────

export interface ExplainOptions {
  /** Default false. **TRUE EXECUTES THE QUERY.** */
  readonly analyze?: boolean
  readonly verbose?: boolean
  /** Default true. */
  readonly costs?: boolean
  /** Default true when `analyze`; PostgreSQL rejects it without `analyze` before 16. */
  readonly buffers?: boolean
  readonly wal?: boolean
  /** Default true when `analyze`. */
  readonly timing?: boolean
  /** Default true — surfaces non-default planner GUCs. */
  readonly settings?: boolean
  readonly summary?: boolean
  /** Default `'json'`. */
  readonly format?: 'text' | 'json'
  /** Safety rail for mutating statements under `analyze`. Default true. */
  readonly rollback?: boolean
  readonly signal?: AbortSignal
}

/** One node of `EXPLAIN (FORMAT JSON)`'s plan tree. Loosely typed on purpose: PG grows keys. */
export interface ExplainNode {
  readonly 'Node Type': string
  readonly 'Relation Name'?: string
  readonly 'Plan Rows'?: number
  readonly 'Actual Rows'?: number
  readonly 'Actual Loops'?: number
  readonly Plans?: readonly ExplainNode[]
  readonly [key: string]: unknown
}

export interface ExplainResult {
  /**
   * The typed plan tree — present iff `format` was `'json'` (the default).
   *
   * **Deviates from `07` §7.5**, which types it non-optional. A typed tree cannot be recovered
   * from PostgreSQL's *text* rendering without writing a parser for it, and running a second
   * `EXPLAIN` to get both would execute a mutating statement twice under `analyze`. One request,
   * one format, and `text` is always there.
   */
  readonly plan: ExplainNode | undefined
  /** Always available. `String(result)` is this. */
  readonly text: string
  readonly planningTimeMs?: number
  readonly executionTimeMs?: number
  /** True iff `analyze` was requested, i.e. iff the statement really ran. */
  readonly executed: boolean
  /** True iff we wrapped it and rolled it back. */
  readonly rolledBack: boolean
  toString(): string
}

/** `insert` / `update` / `delete`, and any statement carrying a data-modifying CTE. */
export function isMutating(compiled: Compiled<unknown>): boolean {
  const k = compiled.meta.kind
  return k === 'insert' || k === 'update' || k === 'delete' || compiled.meta.writes.length > 0
}

function explainPrefix(o: ExplainOptions): string {
  const analyze = o.analyze === true
  const parts: string[] = []
  if (analyze) parts.push('analyze true')
  if (o.verbose === true) parts.push('verbose true')
  if (o.costs === false) parts.push('costs false')
  // `buffers` / `timing` / `wal` are ANALYZE-only before PG 16 (`EXPLAIN option BUFFERS requires
  // ANALYZE`), so they are emitted only with it — the default is "on when analyzing", per `07`.
  if (analyze) {
    if (o.buffers !== false) parts.push('buffers true')
    if (o.timing !== false) parts.push('timing true')
    if (o.wal === true) parts.push('wal true')
  }
  if (o.settings !== false) parts.push('settings true')
  if (o.summary !== undefined) parts.push(`summary ${o.summary ? 'true' : 'false'}`)
  parts.push(`format ${o.format === 'text' ? 'text' : 'json'}`)
  return `explain (${parts.join(', ')}) `
}

/**
 * `EXPLAIN` with the query's own binds.
 *
 * The parameters go out exactly as they would for the statement itself — the extended protocol
 * accepts a parameterised `EXPLAIN`, and a plan for `$1 = 'literal we inlined'` would be a plan
 * for a different query. (`EXPLAIN (GENERIC_PLAN)` is the *other* question, and is what
 * `test/live/_harness.ts`'s `planProbe` asks.)
 */
export async function explainOn(
  conn: PgConnection,
  compiled: Compiled<unknown>,
  env: ExecEnv,
  opts: ExplainOptions | undefined,
  run: RunOptions | undefined,
): Promise<ExplainResult> {
  const o = opts ?? {}
  const analyze = o.analyze === true
  const text = explainPrefix(o) + compiled.sql
  const query: PgQuery = {
    text,
    params: bindsToParams(compiled.binds, run?.params),
    paramTypes: paramTypesOf(compiled.binds),
    ...(o.signal !== undefined ? { signal: o.signal } : {}),
  }
  const result = await conn.execute(query)
  const lines = result.rows.map((r) => (r[0] === null || r[0] === undefined ? '' : String(r[0])))
  const raw = lines.join('\n')
  if (o.format === 'text') {
    return makeResult(undefined, raw, analyze, false, undefined, undefined)
  }
  const parsed = JSON.parse(raw) as readonly {
    Plan: ExplainNode
    'Planning Time'?: number
    'Execution Time'?: number
  }[]
  const top = parsed[0]
  return makeResult(top?.Plan, raw, analyze, false, top?.['Planning Time'], top?.['Execution Time'])
}

export function makeResult(
  plan: ExplainNode | undefined,
  text: string,
  executed: boolean,
  rolledBack: boolean,
  planningTimeMs: number | undefined,
  executionTimeMs: number | undefined,
): ExplainResult {
  return Object.freeze({
    plan,
    text,
    executed,
    rolledBack,
    ...(planningTimeMs !== undefined ? { planningTimeMs } : {}),
    ...(executionTimeMs !== undefined ? { executionTimeMs } : {}),
    toString: () => text,
  })
}

/** `EXPLAIN ANALYZE UPDATE …` performs the update. This is the rail nobody else ships (`07` §7.5). */
export function needsRollbackRail(
  compiled: Compiled<unknown>,
  o: ExplainOptions | undefined,
): boolean {
  return o?.analyze === true && o?.rollback !== false && isMutating(compiled)
}
