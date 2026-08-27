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
 * built-in reads it today.
 *
 * ## Two builders, and which one is the default
 *
 * The default is a **tree of closures, not `new Function`**: CSP-restricted runtimes (Workers,
 * some Electron/Deno configurations) forbid `eval`, and `03` §1.3's disposition was "if benchmarks
 * later disagree, codegen becomes an opt-in flag, never the default".
 *
 * They disagree, and the measurement says exactly where. A closure tree cannot build a row as an
 * object *literal*: the keys are only known at run time, so it must write twelve dynamic
 * properties into a fresh object. Measured on the 10 000 × 12 fixture with identity codecs on
 * both sides — so the only difference is the shape of the row loop — that is **~1.92 ms against
 * ~0.07 ms** for the same loop written as an object literal, a 21–27× gap that no amount of
 * hoisting inside the closure tree closes (a template clone, which fixes the hidden class, buys
 * 12 %; generated code closes it to 1.9–2.2×). Through real codecs the row loop is ~20 % of a
 * decode, so the same structural gap reads as 1.50–1.55× a same-checks hand mapper for the
 * closure tree and 1.126–1.168× for the generated one — design/03 Appendix B asks for 1.15.
 *
 * So there are two builders behind one function:
 *
 *  - `'closure'` (default) — the tree below, with the row loop specialised as far as it goes
 *    without `eval`: parallel `keys`/`decoders` arrays instead of a destructured tuple per row, a
 *    **template clone** so every row object starts life with the finished hidden class and the
 *    per-field stores are plain writes rather than twelve map transitions, and the `col` cell
 *    decode fused into `rowFieldDecoder` so a plain column costs one closure call and not two.
 *    Going further — inlining the cell decode into the loop itself, so there is no per-cell call
 *    at all — was implemented and measured at **1.520 against 1.542**, inside the run-to-run
 *    spread and *worse* on identity codecs (one call site sees twelve codec shapes instead of
 *    twelve monomorphic ones), and was not kept (design/09 §3.7 follow-up).
 *  - `'codegen'` (opt-in, `pgPrime({ decoder: 'codegen' })`) — {@link codegenRowDecoder} builds
 *    the same plan into a real object literal with `new Function`. It is the technique
 *    `pg-native` and postgres.js use for row materialisation. Nothing user-controlled is
 *    interpolated: result keys go through {@link jsString} (and `__proto__` is refused at plan
 *    time, as it is for the closure tree), column indexes are asserted to be non-negative
 *    integers, and every codec, sub-decoder and `CodecContext` is passed in as a bound parameter
 *    rather than named in the source. The generated function is checked against the closure tree
 *    in tier 0 (`test/compile/decode-oracle.test.ts`), which is R1's "three implementations
 *    agreeing" — closure tree, generated code, hand-written mapper.
 *
 * `pgPrime()` refuses `{ decoder: 'codegen' }` up front on a runtime where `new Function` is
 * unavailable ({@link assertCodegenAvailable}), so a CSP policy is a configuration error at
 * start-up and never a surprise on the first query.
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
  if (f.k === 'col') {
    // Fused, not `fieldDecoder` behind an index closure. A plain column is the overwhelmingly
    // common field and it is the one the decode budget is measured on; going through two closures
    // to read one cell doubled the call count on the hottest line in the library for no gain. The
    // body is `fieldDecoder`'s `col` branch verbatim, so the two cannot disagree.
    assertPlanKey(f.key)
    const ctx = forColumn(parent, f.key)
    const codec = f.codec
    const idx = f.idx
    return (row) => {
      const raw = row[idx]
      if (raw === null || raw === undefined) return null
      return typeof raw === 'string' ? codec.decodeText(raw, ctx) : raw
    }
  }
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

/**
 * Which row builder {@link buildDecoder} uses. `'closure'` is the default and the only one that
 * works under a Content-Security-Policy that forbids `eval` — see the module docblock.
 */
export type DecoderMode = 'closure' | 'codegen'

/**
 * Does this runtime allow `new Function`?
 *
 * Called once, from `pgPrime({ decoder: 'codegen' })`, so that a CSP-restricted runtime is a
 * start-up error naming the option rather than a `EvalError` from inside the first query's decode
 * — which is the failure people report as "the ORM crashed after the query worked in dev".
 */
export function assertCodegenAvailable(): void {
  try {
    // eslint-disable-next-line no-new-func
    const probe = new Function('return 1') as () => number
    if (probe() !== 1) throw new Error('probe returned the wrong value')
  } catch (cause) {
    throw new DecodePlanError(
      "pg-prime: { decoder: 'codegen' } needs `new Function`, and this runtime does not allow it " +
        '(a Content-Security-Policy without `unsafe-eval`, a Cloudflare Worker, or a locked-down ' +
        "Electron/Deno). Remove the option — the default 'closure' decoder needs no code " +
        `generation and decodes to exactly the same values. (${String(cause)})`,
    )
  }
}

/**
 * A JavaScript string literal for `key`, safe to place in generated source.
 *
 * `JSON.stringify` escapes the quote, the backslash and every control character, and since ES2019
 * it escapes lone surrogates too — but U+2028 and U+2029 are legal in a JSON string and were, for
 * a long time, illegal *unescaped* in a JavaScript one. Escaping them costs nothing and removes
 * the last way a projection key could end a string literal early. Keys additionally go through
 * {@link assertPlanKey} before they get here.
 */
function jsString(key: string): string {
  return JSON.stringify(key).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/** A column index is written into generated source as a number, so it has to be one. */
function assertPlanIndex(idx: unknown, key: string): number {
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
    throw new DecodePlanError(
      `pg-prime: the result plan for "${key}" has a column index of ${String(idx)}, which is not a ` +
        'non-negative integer. A plan is compiler output; a hand-built one must still be well formed.',
    )
  }
  return idx
}

/**
 * The `'codegen'` row builder: the plan, compiled to one function whose body is an object literal.
 *
 * The generated source names nothing but its own parameters. Every codec (`c0`, `c1`, …), every
 * per-column {@link CodecContext} (`x0`, …) and every fallback sub-decoder (`f0`, …) is passed
 * **by position** into the outer `new Function`, so no identifier derived from a schema, a column
 * name or a value ever appears as code. The only interpolated text is a result key inside a string
 * literal ({@link jsString}) and a column index proven to be an integer ({@link assertPlanIndex}).
 *
 * `col` fields are inlined — the same `null`/`undefined` short-circuit and the same
 * `typeof raw === 'string'` pass-through that {@link fieldDecoder} performs, so a driver that
 * pre-parses is handled identically — which also gives each `cN.decodeText(...)` its own
 * monomorphic call site, where the closure tree has one `dec(...)` site with twelve closures
 * behind it. That second effect is the *smaller* one, and the measurement says so: removing the
 * per-cell call from the closure tree without also getting the object literal buys nothing
 * (design/09 §3.7 follow-up). The literal is the gap. `json` and `group` fields keep the closure
 * tree's own decoder, bound as `fN`, so the two builders cannot diverge on the parts that are not
 * the row loop.
 */
function codegenRowDecoder<Row>(fields: readonly FieldPlan[], ctx: CodecContext): Decoder<Row> {
  const params: string[] = []
  const bound: unknown[] = []
  const decls: string[] = []
  const props: string[] = []

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] as FieldPlan
    assertPlanKey(f.key)
    const key = jsString(f.key)
    if (f.k === 'col') {
      const idx = assertPlanIndex(f.idx, f.key)
      params.push(`c${i}`, `x${i}`)
      bound.push(f.codec, forColumn(ctx, f.key))
      decls.push(`const v${i}=r[${idx}]`)
      props.push(
        `${key}:v${i}===null||v${i}===undefined?null:typeof v${i}==='string'?c${i}.decodeText(v${i},x${i}):v${i}`,
      )
    } else {
      params.push(`f${i}`)
      bound.push(rowFieldDecoder(f, ctx))
      props.push(`${key}:f${i}(r)`)
    }
  }

  const src =
    'return function decodeRows(rows){' +
    'const n=rows.length,out=new Array(n);' +
    'for(let i=0;i<n;i++){' +
    'const r=rows[i];' +
    `${decls.join(';')}${decls.length > 0 ? ';' : ''}` +
    `out[i]={${props.join(',')}}` +
    '}' +
    'return out}'

  // eslint-disable-next-line no-new-func
  const make = new Function(...params, src) as (...a: unknown[]) => Decoder<Row>
  return make(...bound)
}

/**
 * The `'closure'` row builder, specialised as far as it goes without `eval`.
 *
 * Two things it does that the first version did not, each worth its line:
 *
 *  - **Parallel arrays, indexed loop.** `for (const [key, idx, dec] of plans)` destructured a
 *    three-element tuple *per field per row*, which is an iterator plus three loads on the hottest
 *    line in the library.
 *  - **A template clone.** `{ ...TEMPLATE }` starts each row object on the map it will finish
 *    with, so the twelve stores are writes to existing slots rather than twelve hidden-class
 *    transitions. Measured on 10 000 × 12 rows with identity codecs, where it is the only thing
 *    happening: **2.28 ms → 2.01 ms**, 12 %. Through real codecs it is 2.4 %, because the codecs
 *    are most of the work.
 */
function closureRowDecoder<Row>(fields: readonly FieldPlan[], ctx: CodecContext): Decoder<Row> {
  const n = fields.length
  const keys: string[] = new Array(n) as string[]
  const decoders: ((row: readonly unknown[]) => unknown)[] = new Array(n) as ((
    row: readonly unknown[],
  ) => unknown)[]
  const template: Record<string, unknown> = {}
  for (let i = 0; i < n; i++) {
    const f = fields[i] as FieldPlan
    keys[i] = f.key
    decoders[i] = rowFieldDecoder(f, ctx)
    // `assertPlanKey` has already run inside `rowFieldDecoder`, so `__proto__` cannot reach here.
    template[f.key] = null
  }
  return (rows) => {
    const out: Row[] = new Array(rows.length) as Row[]
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as readonly unknown[]
      const obj: Record<string, unknown> = { ...template }
      for (let j = 0; j < n; j++) obj[keys[j] as string] = (decoders[j] as (r: readonly unknown[]) => unknown)(row)
      out[i] = obj as Row
    }
    return out
  }
}

export function buildDecoder<Row = unknown>(
  shape: ResultShape,
  ctx: CodecContext = defaultDecodeContext(),
  mode: DecoderMode = 'closure',
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

    case 'row':
      return mode === 'codegen'
        ? codegenRowDecoder<Row>(shape.fields, ctx)
        : closureRowDecoder<Row>(shape.fields, ctx)
  }
}
