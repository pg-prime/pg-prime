/**
 * The codec registry — design/02-driver.md §4.3 and §4.6.
 *
 * §4.6 is the moat: Prisma collapses every OID `>= 16384` to `Text` because it must span four
 * databases. Being PG-only we resolve them against the live catalogue. OIDs of user types are NOT
 * stable across databases (dev vs prod vs shadow), so they are never baked into generated code —
 * only NAMES are, and the OID is resolved once per physical database on first connect.
 */

import { ALTERNATE_CODECS, arrayCodec, builtinCodecs } from './builtins.js'
import { writeArrayLiteral } from './array.js'
import { PgDecodeError } from './types.js'
import type { AnyCodec, Codec, CodecContext, CodecRegistry, DynamicTypeRequest } from './types.js'
import type { PgConnection, PgField, PgRawValue } from '../driver/types.js'

export class Registry implements CodecRegistry {
  readonly #byOid = new Map<number, AnyCodec>()
  readonly #byName = new Map<string, AnyCodec>()
  #pendingDynamic = new Set<string>()
  #serverParameters: Readonly<Record<string, string>> = {}

  constructor(codecs: readonly AnyCodec[] = builtinCodecs()) {
    for (const c of codecs) this.register(c)
    // Alternates are addressable by name only; they deliberately share an OID with a default.
    for (const c of ALTERNATE_CODECS) this.#byName.set(c.name, c)
  }

  get resolved(): boolean {
    return this.#pendingDynamic.size === 0
  }

  /** Session GUCs handed to every `CodecContext`. Set by the runtime on connect. */
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
          `pgorm: OID ${codec.oid} is already claimed by codec '${existing.name}'; pass { override: true } to replace it with '${codec.name}'.`,
        )
      }
      this.#byOid.set(codec.oid, codec)
    }
    this.#byName.set(codec.name, codec)
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

    const found = new Map<string, CatalogueRow>()
    for (const row of rows) {
      const r: CatalogueRow = {
        oid: Number(row[0]),
        typname: row[1] ?? '',
        nspname: row[2] ?? '',
        typtype: row[3] ?? '',
        typarray: Number(row[4] ?? 0),
        typelem: Number(row[5] ?? 0),
        typbasetype: Number(row[6] ?? 0),
        typdelim: row[7] ?? ',',
      }
      found.set(`${r.nspname}.${r.typname}`, r)
      if (!found.has(r.typname)) found.set(r.typname, r)
    }

    // enum labels, in enumsortorder
    const enumOids = requests
      .map((r) => found.get(qname(r))?.oid)
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
      const cat = found.get(qname(req)) ?? found.get(req.name)
      if (!cat) {
        throw new Error(
          `pgorm: type "${qname(req)}" declared in the schema does not exist in this database.`,
        )
      }
      const expected = KIND_TO_TYPTYPE[req.kind]
      if (cat.typtype !== expected) {
        throw new Error(
          `pgorm: type "${qname(req)}" is declared as a ${req.kind} but pg_type.typtype is '${cat.typtype}'.`,
        )
      }

      let codec: AnyCodec
      if (req.kind === 'enum') {
        const actual = labels.get(cat.oid) ?? []
        if (req.enumLabels) {
          const want = [...req.enumLabels]
          if (want.length !== actual.length || want.some((l, i) => l !== actual[i])) {
            throw new Error(
              `pgorm: enum "${qname(req)}" labels differ. schema: [${want.join(', ')}] · database: [${actual.join(', ')}]. Run a migration before starting the app.`,
            )
          }
        }
        codec = enumCodec(req.name, cat.oid, actual) as unknown as AnyCodec
      } else if (req.kind === 'domain') {
        const base = this.#byOid.get(cat.typbasetype)
        if (!base) {
          throw new Error(
            `pgorm: domain "${qname(req)}" has base type OID ${cat.typbasetype}, for which no codec is registered.`,
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
        codec = { ...base, name: req.name, oid: cat.oid, paramOid: 705, sqlName: req.name }
      } else {
        throw new Error(
          `pgorm: dynamic resolution of '${req.kind}' types is not implemented in this spike (enum and domain are).`,
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
}

const KIND_TO_TYPTYPE: Record<DynamicTypeRequest['kind'], string> = {
  enum: 'e',
  composite: 'c',
  domain: 'd',
  range: 'r',
  multirange: 'm',
  base: 'b',
}

/** §4.3 — the single query that powers `resolveDynamic`. PG 15+ compatible. */
const CATALOGUE_SQL = `
select t.oid::text, t.typname, n.nspname, t.typtype,
       t.typarray::text, t.typelem::text, t.typbasetype::text, t.typdelim
from pg_catalog.pg_type t
join pg_catalog.pg_namespace n on n.oid = t.typnamespace
where t.typname = any($1::text[])`

function qname(r: DynamicTypeRequest): string {
  return r.schema ? `${r.schema}.${r.name}` : r.name
}
function dynKey(r: DynamicTypeRequest): string {
  return `${r.kind}:${qname(r)}`
}

/** Decode is identity + a membership assert — the cheapest possible enum. */
export function enumCodec(
  name: string,
  oid: number,
  labels: readonly string[],
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
    sqlName: name,
    typeClass: 'enum',
    jsonEncode: 'native',
    encode: (v) => check(v, v),
    decodeText: (raw) => check(raw, raw),
    decodeJson: (raw) => check(raw, raw),
  }
}

/** The default registry: every built-in scalar + its array codec, plus the named alternates. */
export function createRegistry(): Registry {
  return new Registry()
}
