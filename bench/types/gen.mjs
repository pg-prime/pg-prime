// Deterministic generator for the type-budget scenarios (design/04 §3.6).
//
//   node gen.mjs --name headline --tables 100 --cols 12 --rels 2 --rows --usages 200
//
// Emits bench/types/.gen/<name>/{schema.gen.ts,rows.gen.ts,usages.gen.ts,tsconfig.json}.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const GEN_ROOT = join(HERE, '.gen')

/** Relative specifiers from a scenario dir to the package sources. */
const SRC = '../../../../packages/pgorm/src/schema/index.js'
const Q = '../../../../packages/pgorm/src/query/types.js'
const CODEC = '../../../../packages/pgorm/src/codec/index.js'

const ARM = (f) => `../../arms/${f}.js`

/**
 * The arms of the WS0 fork measurement (design/09 §3.0).
 *
 * `base04` is design/04 §2 as written. Each `f*` arm swaps in design/03's spelling for exactly one
 * fork and changes nothing else, so `base04 − f<n>` prices that fork alone. All four are
 * **frozen**: an arm that grows new features stops measuring its fork.
 *
 * `decided` is the live, shipped surface. It is measured and printed alongside the arms but is
 * never part of an admissibility verdict, and it is not a fork arm — WS1 grew it well past
 * `base04`'s feature set (see `arms/f3-scope.ts`). Its real gate is `run.mjs` + `budget.json`.
 *
 * The flags drive the generated query text, so a shape is written once and spelled per arm.
 */
export const ARMS = {
  base04: {
    executor: 'Executor04',
    from: ARM('base-04'),
    relationsOnScope: false,
    methods: false,
    nest: true,
    label: 'design/04 §2 as written',
  },
  f1: {
    executor: 'ExecutorM',
    from: ARM('f1-methods'),
    relationsOnScope: false,
    methods: true,
    nest: true,
    label: 'F1 operators as ref methods (03 §2.9)',
  },
  f2: {
    executor: 'ExecutorBare',
    from: ARM('f2-bare'),
    relationsOnScope: false,
    methods: false,
    nest: false,
    label: 'F2 bare nested literals (03 §2.2)',
  },
  /**
   * F3 arm B — the fork that won, as a **frozen minimal delta over `base04`**.
   *
   * WS0 measured this fork against the shipped surface, because at that moment the two were the
   * same file. They no longer are (WS1 added left-join nullability, the GROUP BY guard, CTEs, set
   * ops), so the arm was split out into `arms/f3-scope.ts` — see that file's header. The live
   * surface is measured by `run.mjs` against `budget.json`, not here.
   */
  f3: {
    executor: 'Executor3',
    from: ARM('f3-scope'),
    relationsOnScope: true,
    methods: false,
    nest: true,
    label: 'F3 relation accessors on the table scope (03 §2.3)',
  },
  /** The live, shipped surface. Informational in the fork bench; gated in `run.mjs`. */
  decided: {
    executor: 'Executor',
    from: Q,
    relationsOnScope: true,
    methods: false,
    nest: true,
    label: 'live surface (WS0 decision + everything since)',
  },
  /** Control, not an arm: f1's ref reconstruction with the operator intersection removed. */
  plain: {
    executor: 'ExecutorPlain',
    from: ARM('control-plain-refs'),
    relationsOnScope: false,
    methods: false,
    nest: true,
    label: 'control: f1 minus the operator methods',
  },
}

/** 12 columns per table (id + c0..c10), covering every builder in the spike. */
function columns(count) {
  const all = [
    `    id: t.uuid().primaryKey().defaultSql('gen_random_uuid()'),`,
    `    c0: t.text(),`,
    `    c1: t.text().nullable(),`,
    `    c2: t.integer(),`,
    `    c3: t.bigint().default(0n),`,
    `    c4: t.boolean().default(false),`,
    `    c5: t.timestamptz().defaultSql('now()'),`,
    `    c6: t.date().nullable(),`,
    `    c7: t.numeric(),`,
    `    c8: t.jsonb().$type<{ a: number }>(),`,
    `    c9: t.text().array().default([]),`,
    `    c10: t.enum(kind).default('a'),`,
    `    c11: t.smallint().nullable(),`,
    `    c12: t.text().$default(() => ''),`,
    `    c13: t.bigint().generatedAlways(),`,
  ]
  return all.slice(0, count).join('\n')
}

function schemaFile({ tables, cols, rels }) {
  const out = [`import { defineRelations, defineSchema, pgEnum, pgTable, REFS } from '${SRC}'`, ``]
  out.push(`export const kind = pgEnum('kind', ['a', 'b', 'c'])`, ``)

  for (let i = 0; i < tables; i++) {
    out.push(`export const t${i} = pgTable('t${i}', (t) => ({`)
    out.push(columns(cols))
    out.push(`}))`, ``)
  }

  out.push(`export const tables = {`)
  for (let i = 0; i < tables; i++) out.push(`  t${i},`)
  out.push(`}`, ``)

  if (rels > 0) {
    out.push(`export const rels = defineRelations(tables, (r) => ({`)
    for (let i = 0; i < tables; i++) {
      const picks = []
      for (let k = 0; k < rels; k++) {
        const target = `t${(i + k + 1) % tables}`
        // `from`/`to` are required (design/09 §3.5 decision 4: there is no `.references()` to
        // infer from), and `defineSchema` now also checks the two columns are comparable — so the
        // correlation has to be a real one, `id` (uuid) against `id` (uuid).
        const cfg = `{ from: t${i}[REFS].id, to: ${target}[REFS].id }`
        picks.push(
          k % 2 === 0 ? `r${k}: r.many.${target}(${cfg})` : `r${k}: r.maybeOne.${target}(${cfg})`,
        )
      }
      out.push(`  t${i}: { ${picks.join(', ')} },`)
    }
    out.push(`}))`, ``)
    out.push(`export const schema = defineSchema(tables, rels)`, ``)
  } else {
    out.push(`export const schema = defineSchema(tables)`, ``)
  }
  return out.join('\n')
}

/** All three row shapes materialised for every table (design/04 §3.5 headline). */
function rowsFile({ tables }) {
  const names = Array.from({ length: tables }, (_, i) => `t${i}`)
  const out = [
    `import type { Insertable, Selectable, Updateable } from '${SRC}'`,
    `import type { ${names.join(', ')} } from './schema.gen.js'`,
    ``,
  ]
  for (let i = 0; i < tables; i++) {
    out.push(`export declare const s${i}: Selectable<typeof t${i}>`)
    out.push(`export declare const i${i}: Insertable<typeof t${i}>`)
    out.push(`export declare const u${i}: Updateable<typeof t${i}>`)
  }
  return out.join('\n')
}

/**
 * One "query-shaped" type usage: a 4-key projection over the select row, a
 * relation contract, the insert and update shapes, and a column-ref touch.
 *
 * `distinct` fixes how many *distinct* tables the usages touch, independently
 * of how many the schema declares. That separation is essential: design/04
 * §3.2 notes a usage that introduces a new table costs ~2.6× one over an
 * already-instantiated table (661 vs 251), so comparing a 25-table schema
 * against a 100-table schema at equal usage count but unequal distinct-table
 * count measures the instantiation cache, not schema-size dependence.
 */
function usagesFile({ tables, usages, rels, distinct }) {
  const span = Math.min(distinct ?? Math.min(tables, 25), tables)
  const used = new Set()
  for (let q = 0; q < usages; q++) used.add(q % span)
  const names = [...used].sort((a, b) => a - b).map((i) => `t${i}`)
  const out = [
    `import type { Insertable, Loaded, Refs, Selectable, Updateable } from '${SRC}'`,
    `import type { schema${names.length ? ', ' + names.join(', ') : ''} } from './schema.gen.js'`,
    ``,
  ]
  for (let q = 0; q < usages; q++) {
    const i = q % span
    out.push(`type S${q} = Selectable<typeof t${i}>`)
    out.push(
      `type P${q} = { a: S${q}['c0']; b: S${q}['c3']; c: S${q}['c7']; d: S${q}['c10'] }`,
    )
    out.push(`export declare const q${q}: P${q}[]`)
    out.push(`export declare const ins${q}: Insertable<typeof t${i}>`)
    out.push(`export declare const upd${q}: Updateable<typeof t${i}>`)
    out.push(`export declare const ref${q}: Refs<typeof t${i}>['c5']`)
    if (rels > 0) {
      out.push(
        `export function rel${q}(x: Loaded<(typeof schema)['h']['t${i}'], 'r0'>): unknown { return x.r0 }`,
      )
    }
    out.push(``)
  }
  return out.join('\n')
}


/**
 * A query-SHAPED type usage is not a query. `usagesFile` above measures the former (projection
 * off the select row + insert + update + a ref + a `Loaded` contract, ~40 instantiations); these
 * are the real thing, built by calling the WS0 prototype builder, and they are what design/04
 * §3.5's three per-query budget lines are actually about:
 *
 *   shape 1 → instantiationsPerDistinctQuerySimpleSelect            budget 1500
 *   shape 2 → instantiationsPerDistinctQueryJoinAggSqlNest          budget 2000
 *   shape 3 → instantiationsPerDistinctQueryWithRelationProjection  budget 2750
 *
 * Every emitted query also has a `use{q}` consumer, so the projection's property types are
 * actually resolved rather than left as an uninstantiated mapped type; and the first query of
 * each file carries a strict `Eq<…>` assertion of its result type. That assertion is the bench's
 * own oracle (R1): an arm whose inference silently degrades to `any` would otherwise measure as
 * gloriously cheap. tsc errors fail the run.
 */
const SHAPES = {
  1: {
    row: "{ a: string; b: bigint; c: string; d: 'a' | 'b' | 'c' }",
    keys: ['a', 'b', 'c', 'd'],
    imports: (arm) => (ARMS[arm].methods ? [] : ['eq']),
    body(arm, q, i) {
      const where = ARMS[arm].methods ? `t.u.c2.eq(${q})` : `eq(t.u.c2, ${q})`
      return [
        `  .from(schema.h.t${i}, 'u')`,
        `  .where((t) => ${where})`,
        `  .select((t) => ({ a: t.u.c0, b: t.u.c3, c: t.u.c7, d: t.u.c10 }))`,
      ]
    },
  },
  2: {
    row: '{ a: string; n: bigint; s: string; g: { x: string; y: Date } }',
    keys: ['a', 'n', 's', 'g'],
    imports: (arm) => ['fn', 'sql'].concat(ARMS[arm].methods ? [] : ['eq', 'gt'], ARMS[arm].nest ? ['nest'] : []),
    body(arm, q, i, j) {
      const on = ARMS[arm].methods ? 't.a.c2.eq(t.b.c2)' : 'eq(t.a.c2, t.b.c2)'
      const where = ARMS[arm].methods ? `t.a.c3.gt(${q}n)` : `gt(t.a.c3, ${q}n)`
      const group = ARMS[arm].nest ? 'nest({ x: t.b.c0, y: t.b.c5 })' : '{ x: t.b.c0, y: t.b.c5 }'
      return [
        `  .from(schema.h.t${i}, 'a')`,
        `  .innerJoin(schema.h.t${j}, 'b', (t) => ${on})`,
        `  .where((t) => ${where})`,
        `  .select((t) => ({`,
        `    a: t.a.c0,`,
        `    n: fn.count(),`,
        '    s: sql`coalesce(${t.b.c7}, ' + "'0')`.as(numericCodec),",
        `    g: ${group},`,
        `  }))`,
      ]
    },
  },
  3: {
    row: '{ a: string; rel: { x: string; y: bigint }[] }',
    keys: ['a', 'rel'],
    imports: (arm) => (ARMS[arm].methods ? [] : ['eq']),
    body(arm, q, i) {
      const outer = ARMS[arm].methods ? `t.u.c2.eq(${q})` : `eq(t.u.c2, ${q})`
      const inner = ARMS[arm].methods ? 'p.c4.eq(false)' : 'eq(p.c4, false)'
      // F3's whole point: the accessor is reached through the scope, not a second parameter.
      const lambda = ARMS[arm].relationsOnScope ? '(t)' : '(t, r)'
      // WS5 turned the picker into an accessor object: `.many(q => …)`, never a bare call.
      const acc = ARMS[arm].relationsOnScope ? 't.u.r0.many' : 'r.u.r0.many'
      return [
        `  .from(schema.h.t${i}, 'u')`,
        `  .where((t) => ${outer})`,
        `  .select(${lambda} => ({`,
        `    a: t.u.c0,`,
        `    rel: ${acc}((s) =>`,
        `      s`,
        `        .where((p) => ${inner})`,
        `        .orderBy((p) => p.c5)`,
        `        .limit(5)`,
        `        .select((p) => ({ x: p.c0, y: p.c3 })),`,
        `    ),`,
        `  }))`,
      ]
    },
  },
  /**
   * WS-L E19 — **20 chained joins**. Not one of design/04 §3.5's three lines; added because the
   * audit measured it and nothing gated it. Every `innerJoin` widens `S` by one alias, so
   * `ScopeOf<S>` is re-instantiated at each step and the cost of a join chain is the one place the
   * "linear in query size" claim could quietly become quadratic. Measured at the time of writing:
   * +7 765 instantiations on 5.9.3 over a simple select.
   */
  5: {
    row: '{ a: string; z: string }',
    keys: ['a', 'z'],
    imports: () => ['eq'],
    body(arm, q, i, _j, span) {
      const at = (n) => `a${n}`
      const alias = (n) => `t${(i + n) % span}`
      const out = [`  .from(schema.h.${alias(0)}, '${at(0)}')`]
      for (let n = 1; n <= 20; n++) {
        out.push(
          `  .innerJoin(schema.h.${alias(n)}, '${at(n)}', (t) => eq(t.${at(n - 1)}.c2, t.${at(n)}.c2))`,
        )
      }
      out.push(`  .select((t) => ({ a: t.${at(0)}.c0, z: t.${at(20)}.c0 }))`)
      return out
    },
  },
  /**
   * WS-L E19 — a **4-level nested relation projection**. The relation graph is lazy by design
   * (04 §1.5: targets are names, nothing is enumerated), and the only way to prove that stays true
   * at depth is to project through it. Measured at the time of writing: ~941 instantiations/query.
   */
  6: {
    row:
      '{ a: string; l1: { b: string; l2: { c: string; l3: { d: string; l4: { e: string }[] }[] }[] }[] }',
    keys: ['a', 'l1'],
    imports: () => [],
    body(arm, q, i) {
      return [
        `  .from(schema.h.t${i}, 'u')`,
        `  .select((t) => ({`,
        `    a: t.u.c0,`,
        `    l1: t.u.r0.many((s1) =>`,
        `      s1.select((p1) => ({`,
        `        b: p1.c0,`,
        `        l2: p1.r0.many((s2) =>`,
        `          s2.select((p2) => ({`,
        `            c: p2.c0,`,
        `            l3: p2.r0.many((s3) =>`,
        `              s3.select((p3) => ({`,
        `                d: p3.c0,`,
        `                l4: p3.r0.many((s4) => s4.select((p4) => ({ e: p4.c0 }))),`,
        `              })),`,
        `            ),`,
        `          })),`,
        `        ),`,
        `      })),`,
        `    ),`,
        `  }))`,
      ]
    },
  },
  // Diagnostic, NOT one of design/04 §3.5's three budget lines. Shapes 1-3 exercise `eq`/`gt`,
  // which both F1 arms spell almost identically; this one is six CLASS-SPECIFIC operators, which
  // is where the two spellings actually diverge. Both arms gate by PG type class (see
  // `src/query/ops-free.ts`), so this compares cost at equal safety.
  4: {
    row: "{ a: string; b: bigint; c: string; d: 'a' | 'b' | 'c' }",
    keys: ['a', 'b', 'c', 'd'],
    imports: (arm) =>
      ARMS[arm].methods
        ? ['and', 'eq']
        : ['and', 'eq', 'gt', 'has', 'hasKey', 'ilike', 'jsonPathText', 'startsWith'],
    body(arm, q, i) {
      const preds =
        ARMS[arm].methods
          ? [
              `      t.u.c0.ilike('x%'),`,
              `      t.u.c9.has('v'),`,
              `      t.u.c8.hasKey('plan'),`,
              `      eq(t.u.c8.pathText(['a', 'b']), 'z'),`,
              `      t.u.c3.gt(${q}n),`,
              `      t.u.c0.startsWith('a'),`,
            ]
          : [
              `      ilike(t.u.c0, 'x%'),`,
              `      has(t.u.c9, 'v'),`,
              `      hasKey(t.u.c8, 'plan'),`,
              `      eq(jsonPathText(t.u.c8, ['a', 'b']), 'z'),`,
              `      gt(t.u.c3, ${q}n),`,
              `      startsWith(t.u.c0, 'a'),`,
            ]
      return [
        `  .from(schema.h.t${i}, 'u')`,
        `  .where((t) =>`,
        `    and(`,
        ...preds,
        `    ),`,
        `  )`,
        `  .select((t) => ({ a: t.u.c0, b: t.u.c3, c: t.u.c7, d: t.u.c10 }))`,
      ]
    },
  },
}

function queriesFile({ tables, queries }) {
  const { arm, shape, count } = queries
  const span = Math.min(queries.distinct ?? Math.min(tables, 25), tables)
  // `shape: 'mix'` cycles the three shapes, for the whole-program totals: the per-query metric
  // says what one more query costs, but the decision also needs what a whole codebase costs,
  // where a per-table one-time cost is amortised over however many queries touch that table.
  const mixed = shape === 'mix'
  const shapeAt = (q) => (mixed ? (q % 3) + 1 : shape)
  const config = ARMS[arm]
  if (!config) throw new Error(`unknown arm ${arm}`)
  if (!mixed && !SHAPES[shape]) throw new Error(`unknown query shape ${shape}`)

  const used = mixed ? [1, 2, 3] : [shape]
  const values = [...new Set(used.flatMap((sh) => SHAPES[sh].imports(arm)))].sort()
  const out = [
    `import { numericCodec } from '${CODEC}'`,
    values.length ? `import { ${values.join(', ')} } from '${Q}'` : '',
    `import type { RowOf } from '${Q}'`,
    `import type { ${config.executor} } from '${config.from}'`,
    `import { schema } from './schema.gen.js'`,
    ``,
    `type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false`,
    `type Assert<T extends true> = T`,
    ``,
    `declare const db: ${config.executor}`,
    ``,
  ].filter((l) => l !== '')

  const asserted = new Set()
  for (let q = 0; q < count; q++) {
    const sh = shapeAt(q)
    const spec = SHAPES[sh]
    const i = q % span
    const j = (q + 1) % span
    out.push(`const q${q} = db`)
    out.push(...spec.body(arm, q, i, j, span))
    out.push(
      `export function use${q}(r: RowOf<typeof q${q}>): unknown { return [${spec.keys
        .map((k) => `r.${k}`)
        .join(', ')}] }`,
    )
    if (!asserted.has(sh)) {
      asserted.add(sh)
      out.push(`type _Shape${sh} = Assert<Eq<RowOf<typeof q${q}>, ${spec.row}>>`)
    }
    out.push(``)
  }
  return out.join('\n')
}

/**
 * Materialises the *ref surface* of every table, so the per-table declaration cost of fork F1's
 * `Ref & BaseOps & OpsByClass[...]` intersection is measurable as a slope rather than inferred
 * from the query numbers. Every column is touched, because a mapped type's property types are
 * computed lazily and an untouched ref record costs almost nothing.
 */
function refsFile({ tables, cols, refs }) {
  const arm = refs
  // 'plain' is the measurement control: the same mapped-type reconstruction as f1's ref record
  // but with no operator intersection, so `f1 − plain` is what the METHODS cost and
  // `plain − base` is what rebuilding the record costs.
  const REF_TYPES = { base04: 'RefsAt', f1: 'MRefsAt', plain: 'PlainRefsAt' }
  const type = REF_TYPES[arm]
  if (!type) throw new Error(`unknown refs arm ${arm}`)
  const names = ['id']
  for (let c = 0; c < cols - 1; c++) names.push(`c${c}`)
  const out = [
    arm === 'base04'
      ? `import type { RefsAt } from '${Q}'`
      : `import type { ${type} } from '${ARMS.f1.from}'`,
    `import type { schema } from './schema.gen.js'`,
    ``,
  ]
  for (let i = 0; i < tables; i++) {
    out.push(
      `export function r${i}(x: ${type}<(typeof schema)['h']['t${i}']>): unknown ` +
        `{ return [${names.map((n) => `x.${n}`).join(', ')}] }`,
    )
  }
  return out.join('\n')
}

const TSCONFIG = {
  extends: '../../../../tsconfig.base.json',
  compilerOptions: { noEmit: true, types: [] },
  include: ['./*.ts'],
}

export function generate(opts) {
  const dir = join(GEN_ROOT, opts.name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'schema.gen.ts'), schemaFile(opts))
  if (opts.rows) writeFileSync(join(dir, 'rows.gen.ts'), rowsFile(opts))
  if (opts.usages > 0) writeFileSync(join(dir, 'usages.gen.ts'), usagesFile(opts))
  if (opts.queries) writeFileSync(join(dir, 'queries.gen.ts'), queriesFile(opts))
  if (opts.refs) writeFileSync(join(dir, 'refs.gen.ts'), refsFile(opts))
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(TSCONFIG, null, 2) + '\n')
  return dir
}

if (process.argv[1] && process.argv[1].endsWith('gen.mjs')) {
  const argv = process.argv.slice(2)
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`)
    return i === -1 ? d : argv[i + 1]
  }
  const dir = generate({
    name: arg('name', 'adhoc'),
    tables: Number(arg('tables', 100)),
    cols: Number(arg('cols', 12)),
    rels: Number(arg('rels', 2)),
    rows: argv.includes('--rows'),
    usages: Number(arg('usages', 0)),
    distinct: arg('distinct') === undefined ? undefined : Number(arg('distinct')),
    queries: arg('arm')
      ? {
          arm: arg('arm'),
          shape: arg('shape', '1') === 'mix' ? 'mix' : Number(arg('shape', 1)),
          count: Number(arg('queries', 25)),
          distinct: arg('distinct') === undefined ? undefined : Number(arg('distinct')),
        }
      : undefined,
    refs: arg('refs'),
  })
  console.log(dir)
}
