/**
 * The compiler contract (03 §1.3). This is the seam every other layer builds against:
 * `compile(ast) -> { sql, binds, shape, meta }`, with no database involved.
 */

import type { Codec } from '../sql/codec.js'
import type { QualifiedName } from './ast.js'

export interface Compiled<Row = unknown> {
  /** Complete SQL text with `$1..$n`. Never contains a user-supplied value. */
  readonly sql: string
  /**
   * Bind plan. Entries are either a concrete value already run through `codec.encode`, or a
   * placeholder slot filled at `execute()` time on a prepared query.
   */
  readonly binds: readonly Bind[]
  /** How to turn `unknown[][]` (rowMode: 'array') into `Row[]`. Carries codecs. */
  readonly shape: ResultShape
  /** Cheap metadata for cache-invalidation hooks, tracing, and lint rules. */
  readonly meta: CompiledMeta
  /** Phantom: keeps `Compiled<Row>` invariant in `Row` (D10). */
  readonly __row?: (r: Row) => Row
}

export interface CompiledMeta {
  readonly kind: 'select' | 'insert' | 'update' | 'delete' | 'setop'
  readonly reads: readonly QualifiedName[]
  readonly writes: readonly QualifiedName[]
  readonly placeholders: readonly string[]
  /** True iff `sql.unsafeRaw` text reached the output. Powers the lint rule + audit. */
  readonly usedUnsafeRaw: boolean
}

export type Bind =
  | { k: 'value'; encoded: string | Uint8Array | null }
  | { k: 'slot'; name: string; codec: Codec }

/** Decode plan. Indexes are positions in the driver's array row (`rowMode: 'array'`). */
export type ResultShape =
  | { k: 'row'; fields: readonly FieldPlan[] }
  | { k: 'scalar'; idx: number; codec: Codec }
  | { k: 'void' }

export type FieldPlan =
  | { key: string; k: 'col'; idx: number; codec: Codec }
  | { key: string; k: 'json'; idx: number; plan: JsonPlan; nullable: boolean }

export type JsonPlan =
  | { k: 'obj'; fields: readonly { key: string; plan: JsonPlan }[]; nullable: boolean }
  | { k: 'arr'; item: JsonPlan }
  /** Uses `codec.decodeJson`. */
  | { k: 'leaf'; codec: Codec }
