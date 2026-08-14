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

/** Relative specifier from a scenario dir to the schema package source. */
const SRC = '../../../../packages/pgorm/src/schema/index.js'

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
  const out = [`import { defineRelations, defineSchema, pgEnum, pgTable } from '${SRC}'`, ``]
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
        picks.push(k % 2 === 0 ? `r${k}: r.many.${target}()` : `r${k}: r.maybeOne.${target}()`)
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
  })
  console.log(dir)
}
