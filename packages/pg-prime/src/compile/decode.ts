/**
 * `buildDecoder(shape, ctx)` — the other half of the compiler contract (03 §1.3).
 *
 * Called once per `(Compiled, connection class)`, returns `(rows: unknown[][]) => Row[]`.
 *
 * The `ctx` is the WS2 seam: real codecs take a `CodecContext` (registry, session
 * ParameterStatus, column name) so that container codecs can recurse and so that a decode failure
 * names the column it happened in. It is bound HERE, once per plan — never per row and never per
 * cell — which is why threading it costs nothing on the hot path. `typmod` is `-1` because a
 * compiled plan predates the `RowDescription`; the executor is what has `dataTypeModifier`, and no
 * built-in reads it today. It is a **tree of
 * closures, not `new Function`**: CSP-restricted runtimes (Workers, some Electron/Deno
 * configurations) forbid eval, and a closure tree measured within noise of generated code.
 * If benchmarks later disagree, codegen becomes an opt-in flag, never the default.
 *
 * Two properties fall out of the plan being *positional*:
 *  - two joined tables both exposing `id` cannot clobber each other;
 *  - nothing looks up an OID at decode time on the hot path — codecs travel with the plan.
 *
 * And the payoff (D4 / R5): a nested leaf is decoded with `codec.decodeJson`, whose input the
 * compiler has already cast appropriately (`int8`/`numeric` → `::text`). So `id` is a
 * `bigint` and `amount` is a precision-exact `string` at depth 0 and at depth 3 alike.
 */

import { PgDecodeError, defaultRegistry } from '../codec/index.js'
import type { CodecContext } from '../codec/index.js'
import { DecodePlanError } from '../sql/errors.js'
import type { FieldPlan, JsonPlan, ResultShape } from './contract.js'

/**
 * A projection key the decoder must never assign with `obj[key] = …`.
 *
 * `{}['__proto__'] = v` does not create a property: it *replaces the object's prototype*, so a
 * row would come back with the wrong shape and, if the value were attacker-controlled JSON,
 * with attacker-controlled inherited properties. The builder rejects the key earlier; this is
 * the backstop for a hand-built plan, and it fires once per plan rather than once per row.
 */
function assertPlanKey(key: string): void {
  if (key === '__proto__') {
    throw new DecodePlanError(
      "pg-prime: '__proto__' cannot be a result key — assigning it would replace the row's " +
        'prototype instead of adding a property. Alias the column to another name.',
    )
  }
}

/** A required object that PostgreSQL answered with SQL NULL. Never fabricate a value for it. */
function missingRequiredRow(ctx: CodecContext): never {
  const column = ctx.column ?? '<row>'
  throw new PgDecodeError(
    'json',
    null,
    `required relation "${column}" returned no row (the correlation matched nothing, or the ` +
      'foreign key dangles). Declare the relation optional to decode it as null.',
  )
}

type Decoder<T> = (rows: readonly (readonly unknown[])[]) => T[]

/**
 * The context a decoder built without an executor gets: the process-wide built-in registry and no
 * session parameters. Tier-0 tests and `.toSQL()`-style inspection use it; a real `execute()`
 * passes its connection's own.
 */
export function defaultDecodeContext(): CodecContext {
  return { typmod: -1, registry: defaultRegistry(), serverParameters: {} }
}

/** Same context, with the column named — so a decode error says which column blew up. */
function forColumn(ctx: CodecContext, column: string): CodecContext {
  return { ...ctx, column }
}

function jsonDecoder(plan: JsonPlan, ctx: CodecContext): (v: unknown) => unknown {
  switch (plan.k) {
    case 'leaf': {
      const codec = plan.codec
      return (v) => (v === null || v === undefined ? null : codec.decodeJson(v, ctx))
    }
    case 'arr': {
      const item = jsonDecoder(plan.item, ctx)
      return (v) => {
        if (v === null || v === undefined) return []
        return (v as readonly unknown[]).map(item)
      }
    }
    case 'obj': {
      // Precompute the field decoders once, not per row.
      const fields = plan.fields.map((f) => {
        assertPlanKey(f.key)
        return [f.key, jsonDecoder(f.plan, forColumn(ctx, f.key))] as const
      })
      const nullable = plan.nullable
      return (v) => {
        if (v === null || v === undefined) {
          // `{}` here is the worst possible answer: it is typed as the full row, so every
          // required field of it reads back as `undefined` and the mistake surfaces arbitrarily
          // far from the query. A required relation that returned no row is an error.
          return nullable ? null : missingRequiredRow(ctx)
        }
        const src = v as Record<string, unknown>
        const out: Record<string, unknown> = {}
        for (const [key, dec] of fields) out[key] = dec(src[key])
        return out
      }
    }
  }
}

/**
 * Every *column* index reachable under a field plan — the fallback witness for a `nest` group
 * that projected no NOT NULL column (`GroupPlan.sentinel` in `../compile/ast.ts`).
 *
 * A `k: 'json'` member is deliberately excluded: a `many` relation column is
 * `coalesce(json_agg(…), '[]')`, which is never NULL, so including it would mean the group is
 * never judged null however many of its real columns are. An empty result means "no witness",
 * and the caller then treats the group as never-null rather than always-null.
 */
function leafIndexes(fields: readonly FieldPlan[], into: number[] = []): number[] {
  for (const f of fields) {
    if (f.k === 'group') leafIndexes(f.fields, into)
    else if (f.k === 'col') into.push(f.idx)
  }
  return into
}

/**
 * A field decoder that reads the **whole row** rather than one cell.
 *
 * Only a `nest({...})` group needs this: its members live at their own positions in the same flat
 * row, and whether the object is `null` is a property of several of them at once. Everything else
 * delegates straight to {@link fieldDecoder} with its own index, so the shape of the hot path is
 * unchanged — and `buildDecoder` skips this wrapper entirely when no group is present.
 */
function rowFieldDecoder(
  f: FieldPlan,
  parent: CodecContext,
): (row: readonly unknown[]) => unknown {
  if (f.k !== 'group') {
    const dec = fieldDecoder(f, parent)
    const idx = f.idx
    return (row) => dec(row[idx])
  }
  assertPlanKey(f.key)
  const ctx = forColumn(parent, f.key)
  const members = f.fields.map((c) => [c.key, rowFieldDecoder(c, ctx)] as const)
  // Explicit witnesses win over the sentinel, which wins over "every column of the group":
  // only the builder knows whether the group came from a LEFT JOIN at all.
  const witnesses = f.witnesses ?? (f.sentinel === undefined ? leafIndexes(f.fields) : [f.sentinel])
  // Hoisted out of the row loop: `witnesses.every(closure)` allocated one closure per row.
  const witnessCount = f.nullable ? witnesses.length : 0
  return (row) => {
    if (witnessCount > 0) {
      let allNull = true
      for (let i = 0; i < witnessCount; i++) {
        const v = row[witnesses[i] as number]
        if (v !== null && v !== undefined) {
          allNull = false
          break
        }
      }
      if (allNull) return null
    }
    const out: Record<string, unknown> = {}
    for (const [key, dec] of members) out[key] = dec(row)
    return out
  }
}

function fieldDecoder(f: FieldPlan, parent: CodecContext): (raw: unknown) => unknown {
  assertPlanKey(f.key)
  const ctx = forColumn(parent, f.key)
  if (f.k === 'group') {
    // Unreachable: `rowFieldDecoder` intercepts groups. Kept total so the union stays exhaustive.
    throw new DecodePlanError(
      `pg-prime: the nest() group "${f.key}" has no single column index; it must be decoded ` +
        'from the whole row.',
    )
  }
  if (f.k === 'col') {
    const codec = f.codec
    return (raw) => {
      if (raw === null || raw === undefined) return null
      // Text protocol: the driver hands us strings. A driver that pre-parses (pg's default
      // type parsers) hands us a parsed value; pass it through rather than re-parsing.
      return typeof raw === 'string' ? codec.decodeText(raw, ctx) : raw
    }
  }
  const dec = jsonDecoder(f.plan, ctx)
  const nullable = f.nullable
  return (raw) => {
    // `dec(null)` is deliberate for a required field: a `many` relation decodes SQL NULL to `[]`
    // (`coalesce(json_agg(…), '[]')` should have done that already — this is the belt), while a
    // required `one` relation reaches the `obj` branch above and throws there rather than
    // fabricating `{}`.
    if (raw === null || raw === undefined) return nullable ? null : dec(null)
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
    return dec(parsed)
  }
}

export function buildDecoder<Row = unknown>(
  shape: ResultShape,
  ctx: CodecContext = defaultDecodeContext(),
): Decoder<Row> {
  switch (shape.k) {
    case 'void':
      return () => []

    case 'scalar': {
      const { idx, codec } = shape
      return (rows) =>
        rows.map((r) => {
          const raw = r[idx]
          return (raw === null || raw === undefined
            ? null
            : typeof raw === 'string'
              ? codec.decodeText(raw, ctx)
              : raw) as Row
        })
    }

    case 'row': {
      // A projection with a `nest({...})` in it needs whole-row decoders; without one — the
      // overwhelmingly common case, and the one the decode budget is measured on — the plan stays
      // the flat `[key, idx, decode]` triple the spike measured.
      if (shape.fields.some((f) => f.k === 'group')) {
        const grouped = shape.fields.map((f) => [f.key, rowFieldDecoder(f, ctx)] as const)
        return (rows) => {
          const out: Row[] = new Array(rows.length) as Row[]
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i] as readonly unknown[]
            const obj: Record<string, unknown> = {}
            for (const [key, dec] of grouped) obj[key] = dec(row)
            out[i] = obj as Row
          }
          return out
        }
      }
      const plans = shape.fields.map((f) => [f.key, (f as { idx: number }).idx, fieldDecoder(f, ctx)] as const)
      return (rows) => {
        const out: Row[] = new Array(rows.length) as Row[]
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i] as readonly unknown[]
          const obj: Record<string, unknown> = {}
          for (const [key, idx, dec] of plans) obj[key] = dec(row[idx])
          out[i] = obj as Row
        }
        return out
      }
    }
  }
}
