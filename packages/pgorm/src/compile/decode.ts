/**
 * `buildDecoder(shape)` — the other half of the compiler contract (03 §1.3).
 *
 * Called once per `Compiled`, returns `(rows: unknown[][]) => Row[]`. It is a **tree of
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

import type { FieldPlan, JsonPlan, ResultShape } from './contract.js'

type Decoder<T> = (rows: readonly (readonly unknown[])[]) => T[]

function jsonDecoder(plan: JsonPlan): (v: unknown) => unknown {
  switch (plan.k) {
    case 'leaf': {
      const codec = plan.codec
      return (v) => (v === null || v === undefined ? null : codec.decodeJson(v))
    }
    case 'arr': {
      const item = jsonDecoder(plan.item)
      return (v) => {
        if (v === null || v === undefined) return []
        return (v as readonly unknown[]).map(item)
      }
    }
    case 'obj': {
      // Precompute the field decoders once, not per row.
      const fields = plan.fields.map((f) => [f.key, jsonDecoder(f.plan)] as const)
      const nullable = plan.nullable
      return (v) => {
        if (v === null || v === undefined) return nullable ? null : {}
        const src = v as Record<string, unknown>
        const out: Record<string, unknown> = {}
        for (const [key, dec] of fields) out[key] = dec(src[key])
        return out
      }
    }
  }
}

function fieldDecoder(f: FieldPlan): (raw: unknown) => unknown {
  if (f.k === 'col') {
    const codec = f.codec
    return (raw) => {
      if (raw === null || raw === undefined) return null
      // Text protocol: the driver hands us strings. A driver that pre-parses (pg's default
      // type parsers) hands us a parsed value; pass it through rather than re-parsing.
      return typeof raw === 'string' ? codec.decodeText(raw) : raw
    }
  }
  const dec = jsonDecoder(f.plan)
  return (raw) => {
    if (raw === null || raw === undefined) return f.nullable ? null : dec(null)
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
    return dec(parsed)
  }
}

export function buildDecoder<Row = unknown>(shape: ResultShape): Decoder<Row> {
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
              ? codec.decodeText(raw)
              : raw) as Row
        })
    }

    case 'row': {
      const plans = shape.fields.map((f) => [f.key, f.idx, fieldDecoder(f)] as const)
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
