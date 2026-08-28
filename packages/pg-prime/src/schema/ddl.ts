/**
 * DDL-affecting runtime metadata shared by columns and table extras (design/05 §2.3, §2.4).
 *
 * Everything here is **runtime metadata only**. Not one field of this file is reachable from
 * `ColMeta`, so adding a modifier costs zero type instantiations — the rule design/11 §3 K2a
 * states and `bench/types` gates.
 *
 * `SchemaError` at declaration time rather than a diagnostic at generate time: a schema file is
 * imported once, at process start, and a mistake there is cheapest to report where it is written.
 */

import type { RawNode, RawPart } from '../compile/ast.js'
import { SchemaError } from '../sql/errors.js'
import { quoteIdentPart } from '../sql/ident.js'
import { toNode, type AnyFragment } from '../sql/fragment.js'

/** `ON DELETE` / `ON UPDATE` — design/05 §2.3's exact five spellings, lower-case as written there. */
export type FkAction = 'cascade' | 'restrict' | 'no action' | 'set null' | 'set default'

const FK_ACTIONS: readonly FkAction[] = [
  'cascade',
  'restrict',
  'no action',
  'set null',
  'set default',
]

export function checkFkAction(value: unknown, what: string): FkAction | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !FK_ACTIONS.includes(value as FkAction)) {
    throw new SchemaError(
      `pg-prime: ${what} is ${JSON.stringify(value)}; a referential action must be one of ` +
        `${FK_ACTIONS.map((a) => JSON.stringify(a)).join(', ')}.`,
    )
  }
  return value as FkAction
}

/** Options accepted by `.references()` and by the `foreignKey()` extra. */
export interface ForeignKeyOptions {
  readonly name?: string
  readonly onDelete?: FkAction
  readonly onUpdate?: FkAction
  readonly deferrable?: boolean
  readonly initiallyDeferred?: boolean
}

/**
 * A resolved-later foreign key (design/11 §1.7).
 *
 * `target` is a **thunk** because the referenced table is usually declared further down the same
 * file; a direct value would make every self-referencing or mutually-referencing pair a
 * `ReferenceError` at import time. The kit calls it once, at emit time.
 */
export interface RefSpec {
  /** Returns the referenced column reference(s), positionally paired with the local columns. */
  readonly target: () => readonly RefLike[]
  readonly name: string | undefined
  readonly onDelete: FkAction | undefined
  readonly onUpdate: FkAction | undefined
  readonly deferrable: boolean
  readonly initiallyDeferred: boolean
}

/**
 * The shape `RefSpec.target()` must produce: a column reference's runtime metadata.
 *
 * Declared structurally rather than as `AnyRef` so that `ddl.ts` — which `column.ts` imports —
 * does not have to import `ref.ts`, which imports `column.ts`.
 */
export interface RefLike {
  readonly $: {
    readonly table: string
    readonly schema: string | undefined
    readonly dbName: string
  }
}

/** A `CHECK`. The expression is opaque text; the shadow database normalizes it (design/05 §7.2). */
export interface CheckSpec {
  readonly name: string | undefined
  readonly expression: string
}

/** `UNIQUE` as a constraint (not an index). */
export interface UniqueSpec {
  readonly name: string | undefined
  readonly nullsNotDistinct: boolean
}

/**
 * The DDL text of a `sql` fragment, with **bind parameters rejected**.
 *
 * A `CHECK` is stored in the catalog as a parsed expression tree; there is no `$1` in a
 * `pg_constraint` row and no way to supply one. `` sql`${userInput} > 0` `` therefore cannot mean
 * what it looks like it means, and the failure without this check is a `42P02` from PostgreSQL at
 * apply time — three steps and one shadow database away from the line that wrote it.
 *
 * A column *reference* interpolated into the hole (`` sql`${t.price} > 0` ``) is the one value the
 * tag turns into a parameter that this position CAN render: it is an identifier, and the schema
 * layer knows its resolved DB name. Anything else is data, and data is refused.
 */
export function fragmentDdlText(fragment: AnyFragment, what: string): string {
  return renderRaw(toNode(fragment), what)
}

function renderRaw(node: RawNode, what: string): string {
  let out = node.chunks[0] ?? ''
  for (let i = 0; i < node.parts.length; i++) {
    out += renderPart(node.parts[i] as RawPart, what)
    out += node.chunks[i + 1] ?? ''
  }
  return out
}

function renderPart(part: RawPart, what: string): string {
  switch (part.k) {
    case 'raw':
      return renderRaw(part, what)
    case 'ident':
      return part.quoted
    case 'unsafeRaw':
      return part.text
    case 'col':
      return part.qn
    case 'lit':
      return part.value === null ? 'NULL' : String(part.value)
    case 'param': {
      const name = refDbName(part.value)
      if (name !== undefined) return quoteIdentPart(name)
      throw new SchemaError(
        `pg-prime: ${what} interpolates a bind parameter. A CHECK expression is stored in the ` +
          `catalog as a parsed expression, so it can never carry a $n; write the value into the ` +
          `template as SQL text, or use sql.lit(...) for a number/boolean.`,
      )
    }
    default:
      throw new SchemaError(
        `pg-prime: ${what} interpolates a '${part.k}' expression, which the DDL emitter cannot ` +
          `render. Use plain SQL text, sql.ident(...), sql.lit(...) or a column reference.`,
      )
  }
}

/** A `Ref`'s resolved DB column name, or `undefined` when the value is not a column reference. */
function refDbName(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const runtime = (value as { $?: unknown }).$
  if (typeof runtime !== 'object' || runtime === null) return undefined
  const dbName = (runtime as { dbName?: unknown }).dbName
  return typeof dbName === 'string' ? dbName : undefined
}
