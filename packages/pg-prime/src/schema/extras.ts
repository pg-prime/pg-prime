import { SchemaError } from '../sql/errors.js'
import type { AnyFragment } from '../sql/fragment.js'
import { checkName } from './column.js'
import { checkFkAction, fragmentDdlText } from './ddl.js'
import type { FkAction, ForeignKeyOptions, RefLike } from './ddl.js'
import type { AnyRef } from './ref.js'

/**
 * Table-level nodes (design/05 D5): one heterogeneous array of tagged nodes,
 * extensible by extension packs without an API change.
 *
 * Every node is plain frozen data plus — for `foreignKey` — one thunk, which is the same
 * lazy-resolution device `.references()` uses (design/11 §1.7).
 */
export type TableExtra =
  | { readonly node: 'primaryKey'; readonly name: string | undefined; readonly columns: readonly string[] }
  | {
      readonly node: 'index'
      readonly name: string
      readonly unique: boolean
      readonly columns: readonly string[]
    }
  | { readonly node: 'comment'; readonly text: string }
  | {
      readonly node: 'unique'
      readonly name: string | undefined
      readonly columns: readonly string[]
      readonly nullsNotDistinct: boolean
    }
  | { readonly node: 'check'; readonly name: string; readonly expression: string }
  | {
      readonly node: 'foreignKey'
      readonly name: string | undefined
      /** Local column DB names, in order. */
      readonly columns: readonly string[]
      /** Referenced columns, resolved at emit time and paired positionally with `columns`. */
      readonly references: () => readonly RefLike[]
      readonly onDelete: FkAction | undefined
      readonly onUpdate: FkAction | undefined
      readonly deferrable: boolean
      readonly initiallyDeferred: boolean
    }
  | { readonly node: 'renamedFrom'; readonly from: string }

function dbNames(refs: readonly AnyRef[], what: string): readonly string[] {
  if (refs.length === 0) throw new SchemaError(`pg-prime: ${what} was given no columns.`)
  return refs.map((r) => r.$.dbName)
}

export function primaryKey(...refs: AnyRef[]): TableExtra {
  return { node: 'primaryKey', name: undefined, columns: dbNames(refs, 'primaryKey()') }
}

class IndexBuilder {
  #name: string
  #unique: boolean
  constructor(name: string, unique: boolean) {
    this.#name = name
    this.#unique = unique
  }
  on(...refs: AnyRef[]): TableExtra {
    return {
      node: 'index',
      name: this.#name,
      unique: this.#unique,
      columns: dbNames(refs, `${this.#unique ? 'uniqueIndex' : 'index'}("${this.#name}")`),
    }
  }
}

export function index(name: string): IndexBuilder {
  checkName(name, `index("${name}") index name`)
  return new IndexBuilder(name, false)
}

export function uniqueIndex(name: string): IndexBuilder {
  checkName(name, `uniqueIndex("${name}") index name`)
  return new IndexBuilder(name, true)
}

export function comment(text: string): TableExtra {
  if (typeof text !== 'string') {
    throw new SchemaError(`pg-prime: comment() expects a string; received ${typeof text}.`)
  }
  return { node: 'comment', text }
}

/**
 * `unique('u_ab').on(t.a, t.b)` — a UNIQUE **constraint** (design/05 §2.4).
 *
 * Distinct from `uniqueIndex`, and deliberately so: a constraint is a `pg_constraint` row that an
 * FK can point at, an index is not, and `pg_dump` prints the two differently. Both spellings exist
 * because both objects exist.
 */
class UniqueBuilder {
  #name: string | undefined
  #nullsNotDistinct = false
  constructor(name: string | undefined) {
    this.#name = name
  }
  /** PG15+: `UNIQUE NULLS NOT DISTINCT` — two NULLs collide instead of both being allowed. */
  nullsNotDistinct(): UniqueBuilder {
    this.#nullsNotDistinct = true
    return this
  }
  on(...refs: AnyRef[]): TableExtra {
    return {
      node: 'unique',
      name: this.#name,
      columns: dbNames(refs, `unique(${this.#name === undefined ? '' : `"${this.#name}"`})`),
      nullsNotDistinct: this.#nullsNotDistinct,
    }
  }
}

export function unique(name?: string): UniqueBuilder {
  if (name !== undefined) checkName(name, `unique("${name}") constraint name`)
  return new UniqueBuilder(name)
}

/**
 * `check('c_positive', sql`…`)` — a table-level CHECK.
 *
 * The name is mandatory here (unlike `.check()` on a column, where the server's
 * `<table>_<column>_check` is derivable): PostgreSQL's own default for a multi-column check is
 * the bare `<table>_check`, which collides the moment a second one is declared.
 */
export function check(name: string, expression: AnyFragment): TableExtra {
  checkName(name, `check("${name}") constraint name`)
  const text = fragmentDdlText(expression, `check("${name}")`)
  if (text.trim() === '') throw new SchemaError(`pg-prime: check("${name}") has an empty expression.`)
  return { node: 'check', name, expression: text }
}

/**
 * `foreignKey({ columns: [t.a], references: () => [other.cols.id], onDelete: 'cascade' })`.
 *
 * This is also the spelling for a **self**-referencing key — `references: () => [t.id]`, using the
 * extras callback's own parameter — and for the composite case `.references()` cannot express.
 */
export interface ForeignKeyExtraInput extends ForeignKeyOptions {
  readonly columns: readonly AnyRef[]
  /**
   * A thunk, for the same reason `.references()` takes one (design/11 §1.7).
   *
   * In a **mutually** referencing pair, annotate it once — `(): readonly RefLike[] => [...]` —
   * or TypeScript reports TS7022/TS7024 while walking the two tables' inference loop.
   */
  readonly references: () => readonly RefLike[]
}

export function foreignKey(input: ForeignKeyExtraInput): TableExtra {
  if (typeof input.references !== 'function') {
    throw new SchemaError(
      'pg-prime: foreignKey({ references }) takes a THUNK — references: () => [orgs.id] — so ' +
        'that a mutually-referencing pair of tables can be declared in either order.',
    )
  }
  if (input.name !== undefined) checkName(input.name, `foreignKey({ name: "${input.name}" })`)
  return {
    node: 'foreignKey',
    name: input.name,
    columns: dbNames(input.columns, 'foreignKey({ columns })'),
    references: input.references,
    onDelete: checkFkAction(input.onDelete, 'foreignKey({ onDelete })'),
    onUpdate: checkFkAction(input.onUpdate, 'foreignKey({ onUpdate })'),
    deferrable: input.deferrable ?? input.initiallyDeferred ?? false,
    initiallyDeferred: input.initiallyDeferred ?? false,
  }
}

/** Table-level rename annotation (design/05 §5.1). */
export function renamedFrom(from: string): TableExtra {
  checkName(from, `renamedFrom("${String(from)}")`)
  return { node: 'renamedFrom', from }
}
