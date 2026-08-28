/**
 * The codec registry — design/02-driver.md §4.3 and §4.6.
 *
 * §4.6 is the moat: Prisma collapses every OID `>= 16384` to `Text` because it must span four
 * databases. Being PG-only we resolve them against the live catalogue. OIDs of user types are NOT
 * stable across databases (dev vs prod vs shadow), so they are never baked into generated code —
 * only NAMES are, and the OID is resolved once per physical database on first connect.
 */

import { ALTERNATE_CODECS, arrayCodec, builtinCodecs, unknownCodec } from './builtins.js'
import { writeArrayLiteral } from './array.js'
import { PgDecodeError, PgEncodeError } from './types.js'
import type { AnyCodec, Codec, CodecContext, CodecRegistry, DynamicTypeRequest } from './types.js'
import type { PgConnection, PgField, PgRawValue } from '../driver/types.js'
// `src/sql/ident.ts` is a pure string module with no imports of its own, so this edge closes no
// cycle: `src/sql/fragment.ts` depends on `src/codec`, `src/sql/ident.ts` depends on nothing.
import { quoteIdentPart } from '../sql/ident.js'

export class Registry implements CodecRegistry {
  readonly #byOid = new Map<number, AnyCodec>()
  readonly #byName = new Map<string, AnyCodec>()
  #pendingDynamic = new Set<string>()
  #serverParameters: Readonly<Record<string, string>> = {}
  #generation = 0
  #onUnknownOid: ((info: { oid: number; column: string }) => void) | undefined

  constructor(codecs: readonly AnyCodec[] = builtinCodecs()) {
    for (const c of codecs) this.register(c)
    // Alternates are addressable by name only; they deliberately share an OID with a default.
    for (const c of ALTERNATE_CODECS) this.#byName.set(c.name, c)
    // `unknown` claims no OID at all, so it is name-only for a different reason: it must never
    // win a `forOid` lookup. It is not in `builtinCodecs()` because it has no round trip to
    // golden — decode is identity — and `r5-golden` requires one per shipped codec.
    this.#byName.set(unknownCodec.name, unknownCodec as unknown as AnyCodec)
  }

  get resolved(): boolean {
    return this.#pendingDynamic.size === 0
  }

  /** See `CodecRegistry.generation`. Bumped by `register`, hence by `resolveDynamic` too. */
  get generation(): number {
    return this.#generation
  }

  /**
   * Session GUCs handed to every `CodecContext` this registry builds (§4.7).
   *
   * ⚠️ AS BUILT: the query runtime does NOT call this — `src/query/run.ts` assembles its own
   * `CodecContext` from the live connection, which is strictly more correct (a pooled registry
   * outlives any one session, and `TimeZone`/`IntervalStyle` are per-session). It stays because
   * it is the only way to populate the context for a registry used OUTSIDE a query run — every
   * live codec suite calls it after `acquire()` — and because a codec that asserts on a GUC has
   * nowhere else to read one. Setting it is optional and affects nothing else.
   */
  setServerParameters(p: Readonly<Record<string, string>>): void {
    this.#serverParameters = p
  }

  forOid(oid: number): AnyCodec | undefined {
    return this.#byOid.get(oid)
  }

  byName(name: string): AnyCodec | undefined {
    return this.#byName.get(name)
  }

  register(codec: AnyCodec, options?: { override?: boolean }): void {
    if (codec.oid !== undefined) {
      const existing = this.#byOid.get(codec.oid)
      if (existing && existing.name !== codec.name && options?.override !== true) {
        throw new Error(
          `pg-prime: OID ${codec.oid} is already claimed by codec '${existing.name}'; pass { override: true } to replace it with '${codec.name}'.`,
        )
      }
    }
    /**
     * Evict the OID this NAME used to claim.
     *
     * A registry is per physical database (§4.6) but nothing stopped one from being re-resolved
     * against a second one, and `resolveDynamic` re-registers `mood` under the new database's
     * OID. Without this delete the old OID kept pointing at the old codec, so the moment that
     * OID was reused for an unrelated type in the new database, its columns decoded through a
     * stale enum and every row threw "not a member of enum". Prefer `clone()` over re-resolving;
     * this is the backstop for when someone does it anyway.
     */
    const previous = this.#byName.get(codec.name)
    if (
      previous !== undefined &&
      previous.oid !== undefined &&
      previous.oid !== codec.oid &&
      this.#byOid.get(previous.oid) === previous
    ) {
      this.#byOid.delete(previous.oid)
    }
    if (codec.oid !== undefined) this.#byOid.set(codec.oid, codec)
    this.#byName.set(codec.name, codec)
    this.#generation++
  }

  /**
   * A copy carrying the same built-ins and everything registered so far, and NO pending
   * resolution state.
   *
   * This is the supported way to obey §4.6's "one registry per physical database": clone the one
   * that holds your app's registrations, then `resolveDynamic` the clone against that database's
   * catalogue. Sharing a single registry across dev/prod/shadow silently mixes user-type OIDs,
   * which are not stable across databases.
   */
  clone(): Registry {
    const copy = new Registry([])
    for (const [oid, c] of this.#byOid) copy.#byOid.set(oid, c)
    for (const [name, c] of this.#byName) copy.#byName.set(name, c)
    copy.#serverParameters = this.#serverParameters
    return copy
  }

  /**
   * Debug hook, called ONCE PER COLUMN PER RowDescription (never per row) for an OID with no
   * codec — the case `planFor` handles by passing the raw text through.
   *
   * It is a callback and not a throw on purpose: an unregistered type is a *compile* error in the
   * schema DSL, and at runtime a `select` of some incidental catalogue column must not take the
   * query down. But silence made "why is this column a string?" unanswerable, so the seam exists.
   * Pass `undefined` to clear it.
   */
  onUnknownOid(handler: ((info: { oid: number; column: string }) => void) | undefined): void {
    this.#onUnknownOid = handler
  }

  #ctx(field: PgField): CodecContext {
    return {
      typmod: field.dataTypeModifier,
      registry: this,
      serverParameters: this.#serverParameters,
      column: field.name,
    }
  }

  /**
   * One decoder per column, built ONCE per RowDescription — never per row. `null` is
   * short-circuited here, which is why `Codec.decodeText` can be non-nullable in its signature
   * (pg's `Result._parseRowAsArray` writes `null` directly without consulting a parser — verified).
   */
  planFor(fields: readonly PgField[]): readonly ((raw: PgRawValue) => unknown)[] {
    return fields.map((f) => {
      const codec = this.#byOid.get(f.dataTypeID)
      const ctx = this.#ctx(f)
      if (!codec) {
        // Unknown OID: hand back the raw text rather than guessing. The schema DSL is where an
        // unregistered type becomes a compile error; at runtime we must not silently coerce.
        this.#onUnknownOid?.({ oid: f.dataTypeID, column: f.name })
        return (raw: PgRawValue) => raw
      }
      const decodeText = codec.decodeText
      const decodeBinary = codec.decodeBinary
      return (raw: PgRawValue) => {
        if (raw === null) return null
        if (typeof raw === 'string') return decodeText(raw, ctx)
        if (decodeBinary) return decodeBinary(raw, ctx)
        throw new PgDecodeError(codec.name, '<binary>', 'this codec has no decodeBinary')
      }
    })
  }

  /**
   * The R5 counterpart of `planFor`: one decoder per column for values that arrive inside a
   * `json_agg` payload. The compiler pairs this with the per-codec JSON cast declared by
   * `Codec.jsonEncode`.
   */
  jsonPlanFor(codecs: readonly (AnyCodec | undefined)[]): readonly ((raw: unknown) => unknown)[] {
    return codecs.map((codec) => {
      if (!codec) return (raw: unknown) => raw
      const ctx: CodecContext = {
        typmod: -1,
        registry: this,
        serverParameters: this.#serverParameters,
      }
      const decodeJson = codec.decodeJson
      return (raw: unknown) => (raw === null || raw === undefined ? null : decodeJson(raw, ctx))
    })
  }

  /** The `::text` (or nothing) the compiler must emit inside `json_build_object`. */
  jsonCastFor(codec: AnyCodec): string {
    return codec.jsonEncode === 'text' ? '::text' : ''
  }

  // ── §4.6 dynamic resolution ────────────────────────────────────────────────

  /**
   * Resolve user-defined types by name → OID against the live catalogue.
   *
   * Verified live. A label/attribute mismatch between the TS schema and `pg_catalog` is a HARD
   * ERROR at connect, not a runtime surprise — this is the `migrate verify` story extended to
   * types. Every resolved type gets its array codec for free from `t.typarray`, using the
   * catalogue's `t.typdelim` (⚠️ NOT always `,` — `box`/`_box` use `;`).
   */
  async resolveDynamic(
    connection: PgConnection,
    requests: readonly DynamicTypeRequest[],
  ): Promise<void> {
    if (requests.length === 0) return
    for (const r of requests) this.#pendingDynamic.add(dynKey(r))

    const names = requests.map((r) => r.name)
    const rows = (
      await connection.execute({
        text: CATALOGUE_SQL,
        params: [writeArrayLiteral(names)],
        paramTypes: [1009], // text[]
        mode: 'unnamed',
      })
    ).rows as readonly (readonly (string | null)[])[]

    const catalogue: CatalogueRow[] = rows.map((row) => ({
      oid: Number(row[0]),
      typname: row[1] ?? '',
      nspname: row[2] ?? '',
      typtype: row[3] ?? '',
      typarray: Number(row[4] ?? 0),
      typelem: Number(row[5] ?? 0),
      typbasetype: Number(row[6] ?? 0),
      typdelim: row[7] ?? ',',
      visible: row[8] === 't',
    }))

    /**
     * Match each request to exactly ONE catalogue row.
     *
     * ⚠️ This used to key a map by `nspname.typname` with a BARE-NAME fallback, which resolved
     * `{ schema: 'public', name: 'mood' }` to whichever `mood` the catalogue happened to return
     * first — `a.mood` in a database that has no `public.mood` at all. Everything downstream then
     * looked right (the codec had an OID, `resolved` was true) and every row of the real column
     * threw "not a member of enum", because the enum-label query keyed off the qualified hit that
     * did not exist and minted the codec with zero labels.
     *
     * A qualified request now matches on `(nspname, typname)` and NOTHING else. An unqualified
     * one resolves the way PostgreSQL itself would, through `pg_type_is_visible` — which is
     * `search_path` order, including the masking rule that makes a later schema's same-named type
     * invisible. The ambiguity throw below is therefore a backstop rather than the common path,
     * and it is the right answer if a future catalogue ever reports two visible candidates.
     */
    const resolvedRows = new Map<DynamicTypeRequest, CatalogueRow>()
    for (const req of requests) {
      const candidates = catalogue.filter((c) =>
        req.schema === undefined
          ? c.typname === req.name && c.visible
          : c.typname === req.name && c.nspname === req.schema,
      )
      const hit = candidates[0]
      if (hit === undefined || candidates.length === 0) {
        throw new Error(
          `pg-prime: type "${qname(req)}" declared in the schema does not exist in this database.`,
        )
      }
      if (candidates.length > 1) {
        throw new Error(
          `pg-prime: type "${req.name}" is ambiguous on this search_path — it exists in [${candidates
            .map((c) => c.nspname)
            .join(
              ', ',
            )}]. Qualify it in the schema, e.g. { schema: '${candidates[0]!.nspname}', name: '${req.name}' }.`,
        )
      }
      resolvedRows.set(req, hit)
    }

    // enum labels, in enumsortorder — from the SAME rows the requests resolved to, never from a
    // second, differently-keyed lookup.
    const enumOids = requests
      .filter((r) => r.kind === 'enum')
      .map((r) => resolvedRows.get(r)?.oid)
      .filter((o): o is number => o !== undefined)
    const labels = new Map<number, string[]>()
    if (enumOids.length > 0) {
      const lr = (
        await connection.execute({
          text: `select enumtypid::text, enumlabel from pg_catalog.pg_enum
                 where enumtypid = any($1::oid[]) order by enumtypid, enumsortorder`,
          params: [writeArrayLiteral(enumOids.map(String))],
          paramTypes: [1009],
          mode: 'unnamed',
        })
      ).rows as readonly (readonly (string | null)[])[]
      for (const row of lr) {
        const oid = Number(row[0])
        const list = labels.get(oid) ?? []
        list.push(row[1] ?? '')
        labels.set(oid, list)
      }
    }

    for (const req of requests) {
      const cat = resolvedRows.get(req)!
      const expected = KIND_TO_TYPTYPE[req.kind]
      if (cat.typtype !== expected) {
        throw new Error(
          `pg-prime: type "${qname(req)}" is declared as a ${req.kind} but pg_type.typtype is '${cat.typtype}'.`,
        )
      }

      let codec: AnyCodec
      if (req.kind === 'enum') {
        const actual = labels.get(cat.oid) ?? []
        if (req.enumLabels) {
          const want = [...req.enumLabels]
          if (want.length !== actual.length || want.some((l, i) => l !== actual[i])) {
            throw new Error(
              `pg-prime: enum "${qname(req)}" labels differ. schema: [${want.join(', ')}] · database: [${actual.join(', ')}]. Run a migration before starting the app.`,
            )
          }
        }
        codec = enumCodec(req.name, cat.oid, actual, sqlNameOf(req)) as unknown as AnyCodec
      } else if (req.kind === 'domain') {
        const base = this.#byOid.get(cat.typbasetype)
        if (!base) {
          throw new Error(
            `pg-prime: domain "${qname(req)}" has base type OID ${cat.typbasetype}, for which no codec is registered.`,
          )
        }
        // paramOid widened to `unknown` (705) so PG applies the domain's own cast + constraints.
        //
        // ⚠️ MEASURED on PG 17.11 (not recorded in 02 §4.6): PostgreSQL reports a SCALAR domain
        // column in the RowDescription as its BASE type OID, never as the domain's own OID. So
        // this registration is never hit by `forOid` for a scalar — which is harmless, because
        // the base codec decodes to the identical value — and the codec earns its keep on the
        // PARAMETER side and in the schema DSL. The derived ARRAY codec below is different: a
        // domain[] column IS reported under its own user OID, so without it those columns fall
        // back to raw text. See test/codec/registry.test.ts.
        //
        // `arrayOid` comes from the DOMAIN's `typarray`, not from the spread base: inheriting
        // `int4`'s 1007 made `arrayCodecOf(domainCodec)` claim that a `pgprime_pos[]` value is an
        // `int4[]`, which is the one OID `assertShape` would then compare a live `dataTypeID`
        // against and reject.
        const { arrayOid: _baseArrayOid, ...withoutArrayOid } = base
        const derived = {
          ...withoutArrayOid,
          name: req.name,
          oid: cat.oid,
          paramOid: 705,
          sqlName: sqlNameOf(req),
        }
        codec = cat.typarray ? { ...derived, arrayOid: cat.typarray } : derived
      } else {
        throw new Error(
          `pg-prime: dynamic resolution of '${req.kind}' types is not implemented in this spike (enum and domain are).`,
        )
      }

      this.register(codec, { override: true })
      if (cat.typarray) {
        this.register(
          arrayCodec(codec as unknown as Codec<never, unknown>, cat.typarray, {
            delimiter: cat.typdelim,
            name: `${req.name}[]`,
          }) as unknown as AnyCodec,
          { override: true },
        )
      }
      this.#pendingDynamic.delete(dynKey(req))
    }
  }
}

interface CatalogueRow {
  oid: number
  typname: string
  nspname: string
  typtype: string
  typarray: number
  typelem: number
  typbasetype: number
  typdelim: string
  /** `pg_type_is_visible` — i.e. reachable unqualified on THIS session's `search_path`. */
  visible: boolean
}

const KIND_TO_TYPTYPE: Record<DynamicTypeRequest['kind'], string> = {
  enum: 'e',
  composite: 'c',
  domain: 'd',
  range: 'r',
  multirange: 'm',
  base: 'b',
}

/**
 * §4.3 — the single query that powers `resolveDynamic`. PG 15+ compatible.
 *
 * It deliberately filters on `typname` only and disambiguates in TypeScript: one round trip
 * covers qualified and unqualified requests together, and `pg_type_is_visible` (the same function
 * `\dT` uses) answers "which one would PostgreSQL pick for the bare name?" — `current_schemas`
 * order including the masking rule — without us reimplementing `search_path` resolution.
 */
const CATALOGUE_SQL = `
select t.oid::text, t.typname, n.nspname, t.typtype,
       t.typarray::text, t.typelem::text, t.typbasetype::text, t.typdelim,
       case when pg_catalog.pg_type_is_visible(t.oid) then 't' else 'f' end
from pg_catalog.pg_type t
join pg_catalog.pg_namespace n on n.oid = t.typnamespace
where t.typname = any($1::text[])`

function qname(r: DynamicTypeRequest): string {
  return r.schema ? `${r.schema}.${r.name}` : r.name
}

/**
 * The name the *compiler* must splice for a `::type` cast — schema-qualified and quoted.
 *
 * Found in WS4: a bulk insert emits `$1::<sqlName>` on its first row (03 §2.6), and an enum whose
 * `sqlName` was the bare `user_role` raised `42704 type "user_role" does not exist` against any
 * database where the type is not on `search_path` — which is every namespaced test schema, and
 * every production schema that is not `public`. The registry KEY stays the bare name, because
 * that is what `ColumnDdl.enumName` carries and what `codecFor` looks up; only the SQL spelling
 * is qualified. `arrayCodec` derives `"ns"."user_role"[]` from it for free.
 */
function sqlNameOf(r: DynamicTypeRequest): string {
  return r.schema ? `${quoteIdentPart(r.schema)}.${quoteIdentPart(r.name)}` : quoteIdentPart(r.name)
}
function dynKey(r: DynamicTypeRequest): string {
  return `${r.kind}:${qname(r)}`
}

/** Decode is identity + a membership assert — the cheapest possible enum. */
export function enumCodec(
  name: string,
  oid: number,
  labels: readonly string[],
  sqlName: string = name,
): Codec<string, string> {
  const set = new Set(labels)
  const check = (v: unknown, raw: unknown): string => {
    if (typeof v !== 'string' || !set.has(v))
      throw new PgDecodeError(name, raw, `not a member of enum ${name} [${labels.join(', ')}]`)
    return v
  }
  return {
    name,
    oid,
    paramOid: oid,
    sqlName,
    typeClass: 'enum',
    jsonEncode: 'native',
    // §4.2: encode MUST throw `PgEncodeError` outside TIn. A bad *parameter* used to raise
    // `PgDecodeError`, so a caller catching encode failures (to report which insert value was
    // wrong) saw a class that says the SERVER sent us something we could not read.
    encode: (v) => {
      if (typeof v !== 'string' || !set.has(v))
        throw new PgEncodeError(name, v, `a member of enum ${name} [${labels.join(', ')}]`)
      return v
    },
    decodeText: (raw) => check(raw, raw),
    decodeJson: (raw) => check(raw, raw),
  }
}

/** The default registry: every built-in scalar + its array codec, plus the named alternates. */
export function createRegistry(): Registry {
  return new Registry()
}

let DEFAULT: Registry | undefined

/**
 * The process-wide registry used when no explicit one is supplied — by `metaOf`, by the compile
 * layer's default codecs, and by tier-0 tests.
 *
 * Lazy, because building it allocates 50 codecs and a real application always has a connection (and
 * therefore its own registry, carrying that database's resolved user-type OIDs) before it compiles
 * a query. One registry per *physical database* is the rule from 02 §4.6: user-type OIDs are not
 * stable across dev / prod / shadow, so sharing this one across two databases with different enum
 * OIDs would be a bug. It exists for the built-ins, which are stable everywhere.
 *
 * ⚠️ Calling `resolveDynamic` on THIS registry is discouraged, for exactly that reason: it is a
 * process singleton, so the second database to resolve overwrites the first one's user-type OIDs
 * for every caller. Use `defaultRegistry().clone()` (or `createRegistry()`) per physical database
 * and hand that registry to the query layer. It is deliberately not an error — the query layer
 * still falls back to this registry — but it is the one way to make a correct-looking application
 * decode another database's rows.
 */
export function defaultRegistry(): Registry {
  return (DEFAULT ??= new Registry())
}
