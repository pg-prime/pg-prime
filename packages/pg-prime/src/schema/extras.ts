import type { AnyRef } from './ref.js'

/**
 * Table-level nodes (design/05 D5): one heterogeneous array of tagged nodes,
 * extensible by extension packs without an API change.
 *
 * The spike carries a representative subset — enough to prove that the extras
 * callback receives the table's pre-computed `[REFS]` slot.
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

export function primaryKey(...refs: AnyRef[]): TableExtra {
  return { node: 'primaryKey', name: undefined, columns: refs.map((r) => r.$.dbName) }
}

class IndexBuilder {
  #name: string
  #unique: boolean
  constructor(name: string, unique: boolean) {
    this.#name = name
    this.#unique = unique
  }
  on(...refs: AnyRef[]): TableExtra {
    return { node: 'index', name: this.#name, unique: this.#unique, columns: refs.map((r) => r.$.dbName) }
  }
}

export function index(name: string): IndexBuilder {
  return new IndexBuilder(name, false)
}

export function uniqueIndex(name: string): IndexBuilder {
  return new IndexBuilder(name, true)
}

export function comment(text: string): TableExtra {
  return { node: 'comment', text }
}
