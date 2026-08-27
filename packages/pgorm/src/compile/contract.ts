/**
 * The compiler contract (03 §1.3). This is the seam every other layer builds against:
 * `compile(ast) -> { sql, binds, shape, meta }`, with no database involved.
 */

import type { AnyCodec } from '../codec/index.js'
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

/**
 * `oid` is the codec's `paramOid` — the type the ORM declares for this `$n` in `Parse`.
 *
 * `undefined` means "the codec claims no type", which is `unknown`'s honest answer and the enum's
 * answer until `resolveDynamic` runs. The executor sends `0` for those, which is the wire spelling
 * of "unspecified, infer from context" — see `paramTypesOf`. Declaring the type matters: PG resolves
 * an operator against a *typed* parameter, and `where "amount" > $1` with an untyped `$1` is where
 * `42P18 indeterminate_datatype` comes from.
 */
export type Bind =
  | { k: 'value'; encoded: string | Uint8Array | null; oid: number | undefined }
  | { k: 'slot'; name: string; codec: AnyCodec }

/**
 * The `paramTypes` array for `Parse`, positionally aligned with `binds`.
 *
 * `0` for a bind with no declared type: the protocol's own "unspecified, infer from context".
 * Measured equivalent to 705 (`unknown`) in every position tested — see `unknownCodec`.
 */
export function paramTypesOf(binds: readonly Bind[]): readonly number[] {
  return binds.map((b) => (b.k === 'value' ? (b.oid ?? 0) : (b.codec.paramOid ?? 0)))
}

/** Decode plan. Indexes are positions in the driver's array row (`rowMode: 'array'`). */
export type ResultShape =
  | { k: 'row'; fields: readonly FieldPlan[] }
  | { k: 'scalar'; idx: number; codec: AnyCodec }
  | { k: 'void' }

export type FieldPlan =
  | { key: string; k: 'col'; idx: number; codec: AnyCodec }
  | { key: string; k: 'json'; idx: number; plan: JsonPlan; nullable: boolean }
  /**
   * A `nest({...})` group (03 §2.2). It owns no column index of its own: its children carry their
   * own `idx` into the same flat row, which is what makes grouping free — the SQL is unchanged and
   * the object is assembled by the decoder. `sentinel` is an index into the *row*, not into
   * `fields`; see `GroupPlan` in `./ast.ts` for why it exists.
   */
  | {
      key: string
      k: 'group'
      fields: readonly FieldPlan[]
      nullable: boolean
      sentinel: number | undefined
      /**
       * Row indexes whose simultaneous NULL means "this group is null", overriding both
       * `sentinel` and the decoder's own heuristic. The join-aware choice lives in the builder
       * (which knows whether the group came from a LEFT JOIN and which of its columns the schema
       * declares NOT NULL); this field is how it says so without the decoder having to guess.
       * Empty means "never null".
       */
      witnesses?: readonly number[] | undefined
    }

export type JsonPlan =
  | { k: 'obj'; fields: readonly { key: string; plan: JsonPlan }[]; nullable: boolean }
  | { k: 'arr'; item: JsonPlan }
  /** Uses `codec.decodeJson`. */
  | { k: 'leaf'; codec: AnyCodec }
