/**
 * Branded type-error **sentences** for the query layer (design/04 §4.1, ported from Kysely's
 * `KyselyTypeError`).
 *
 * The mechanism: instead of letting a constraint mismatch spew, a type resolves to
 * `OrmTypeError<'one sentence'>`. Because `OrmTypeError` has exactly one member — an `ERR`-keyed
 * phantom — reading any property off it produces a one-line diagnostic with the sentence printed
 * verbatim inside the type name.
 *
 * ── Why this file exports *strings* and not `OrmTypeError<…>` aliases ─────────────────────────
 *
 * A named generic alias is what TypeScript prints, and it prints it **unexpanded**. Measured:
 *
 *     type GroupByNeedsParentKey<A, K> = OrmTypeError<`…sentence…`>
 *     → error TS2339: Property 'nope' does not exist on type 'GroupByNeedsParentKey<"u", "id">'.
 *
 *     OrmTypeError<GroupByNeedsParentKeyMsg<'u', 'id'>>          // inlined at the use site
 *     → error TS2339: Property 'nope' does not exist on type
 *       'OrmTypeError<"relation projection on \"u\" needs its primary key in groupBy()…">'.
 *
 * The first hides the entire sentence behind the alias name, which defeats the only thing the
 * mechanism is for. Template-literal *string* aliases are resolved eagerly, so exporting the
 * message and wrapping it in `OrmTypeError<…>` at the use site keeps one home for the wording and
 * still prints it. This is a real trap and it is why `src/query/types.ts` never references an
 * `OrmTypeError` alias.
 *
 * Two rules every message here obeys, both from design/04 §4 (D9):
 *
 *  1. **One line, under 300 characters.** The whole point of §4's measurement (3 lines / 641 chars
 *     against Kysely's 10 / 1 402 and Drizzle's 14 / 3 226) is that the sentence is readable *in
 *     the terminal*, without expanding an overload cascade.
 *  2. **The sentence says what to do**, not what went wrong. "add `t.u.id` to the grouping list"
 *     beats "invalid grouping".
 *
 * The rendered text of each is a committed golden — `tools/type-errors/`, checked by
 * `test/query/type-errors.test.ts` on both compilers. Editing a sentence here without updating the
 * golden fails CI, which is the point: these strings are public API.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Set operations (design/03 §2.8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * design/03 §2.8's message, verbatim: `union branch 2 has no column "kind"`.
 *
 * `B` is the 1-based index of the offending branch. It is a real count, not a hard-coded `2`:
 * `SetQuery` carries a tuple whose length is the number of branches so far, so
 * `a.union(b).union(c)` names branch 3 when `c` is the one that does not match.
 */
export type SetOpMissingColumnMsg<
  B extends string,
  K extends string,
> = `union branch ${B} has no column "${K}"`

export type SetOpExtraColumnMsg<
  B extends string,
  K extends string,
> = `union branch ${B} has an extra column "${K}" that branch 1 does not select`

export type SetOpColumnTypeMismatchMsg<
  B extends string,
  K extends string,
> = `union branch ${B} column "${K}" has a different type than branch 1`

// ─────────────────────────────────────────────────────────────────────────────
// GROUP BY guard (design/03 §2.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one guard rail design/03 §2.3 asks for: a relation *row-set* projection compiles to a
 * `LEFT JOIN LATERAL` correlated on the parent's primary key, so after a `GROUP BY` that key must
 * still be in the grouping list or the parent row is not identifiable.
 *
 * Relation *aggregates* (`count`, `sum`) are scalar subqueries and are never guarded.
 */
export type GroupByNeedsParentKeyMsg<
  A extends string,
  K extends string,
> = `relation projection on "${A}" needs its primary key in groupBy(): add t.${A}.${K}, or move the relation into a subquery`

// ─────────────────────────────────────────────────────────────────────────────
// CTEs (design/03 §2.7)
// ─────────────────────────────────────────────────────────────────────────────

export type CteNameTakenMsg<N extends string> =
  `a CTE named "${N}" is already declared on this query — pick another name`

// ─────────────────────────────────────────────────────────────────────────────
// Set operations, `$if` and the bulk insert — the sentinels the audit added
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A set-operation branch that yields rows but is not a `SELECT`.
 *
 * `INSERT … RETURNING` is a `RowSource`, so `RowSource<O>` alone let it into a `union`. The
 * `SELECT_SOURCE` brand (`./types.ts`) is what excludes it; this is what it says when it does.
 */
export type SetOpNeedsSelectMsg =
  'a set operation takes a SELECT: an insert/update/delete … returning … yields rows but is not a union branch'

/** A set-operation branch that has not been projected yet. */
export type SetOpNeedsProjectionMsg =
  'a set operation needs a projection on both branches: call .select(…) before .union(…)'

/** `.execute()` on a query that has no projection — the type-level half of `03` §2.1's rule. */
export type ExecuteNeedsProjectionMsg =
  'this query has no projection yet: call .select(…) or .selectAll(…) before .execute()'

/**
 * The sentence `$if` reports when the `true` branch **drops** a column the query already had.
 *
 * `select()` replaces the projection rather than adding to it (Kysely's `$if` formula assumes the
 * opposite), so a branch that re-selects fewer columns leaves the type claiming a column the SQL
 * no longer returns.
 */
export type IfDropsColumnMsg<K extends string> =
  `$if(boolean, …) would drop the already-selected column "${K}": select() replaces the projection, so the branch must re-select every column the query already has`

/** `valuesMany()` handed rows that do not all carry the same columns. */
export type HeterogeneousBulkMsg =
  'valuesMany() needs every row to have the same columns: one bulk INSERT is one statement with one column list'

// ─────────────────────────────────────────────────────────────────────────────
// Runtime errors the executor throws (design/09 WS6)
//
// This file is otherwise type-level. `CodecMismatchError` lives here because `09` WS6's Files
// line names `src/query/errors.ts` for it, and because it belongs with the other query-layer
// diagnostics: it is the *value*-level twin of the branded sentences above — same rule (say what
// to do, not what went wrong), same status as public API, same "the golden is the test".
// ─────────────────────────────────────────────────────────────────────────────

import type { FieldOrigin } from '../compile/contract.js'
import { PgPrimeError } from '../sql/errors.js'

/** Everything `CodecMismatchError`'s message is rendered from. Exported so a caller can branch. */
export interface CodecMismatch {
  /** The projection key — what the caller named the column. */
  readonly column: string
  /** The codec the query declared for it. */
  readonly declared: string
  /** That codec's OID, or `undefined` for a codec that claims none (a pending enum). */
  readonly declaredOid: number | undefined
  /** The registry's name for what PostgreSQL actually sent, or `undefined` for an unknown OID. */
  readonly actual: string | undefined
  /** `PgField.dataTypeID` — what the server said in `RowDescription`. */
  readonly actualOid: number
  /** Where the declaration was made, when we know (03 §3.2). */
  readonly origin?: FieldOrigin | undefined
}

/**
 * `03` §3.2's message, rendered. Kept a pure function so the golden is a unit test and not a
 * live one, and so the two variants below cannot drift apart.
 *
 * Three lines, plus a fourth when we know where the declaration was written:
 *
 *     column "total" was declared as codec `int4` (oid 23)
 *     but Postgres returned `numeric` (oid 1700).
 *       at src/reports.ts:42
 *     Fix: use codecs.numeric, or cast in SQL.
 *
 * A **schema column** gets a different third and fourth line, because the mistake is a different
 * one: the caller's source is innocent and the database has drifted away from the `pgTable(...)`
 * declaration, so pointing at their call site would send them to fix the wrong file.
 */
export function renderCodecMismatch(m: CodecMismatch): string {
  const declaredOid = m.declaredOid === undefined ? 'no oid' : `oid ${m.declaredOid}`
  const actual = m.actual === undefined ? `an unregistered type` : `\`${m.actual}\``
  const lines = [
    `column "${m.column}" was declared as codec \`${m.declared}\` (${declaredOid})`,
    `but Postgres returned ${actual} (oid ${m.actualOid}).`,
  ]
  const column = m.origin?.column
  if (column !== undefined) {
    lines.push(
      `  ${column} is schema drift: the database no longer matches the pgTable(...) declaration.`,
    )
    lines.push(
      m.actual === undefined
        ? `Fix: run the pending migration, or register a codec for oid ${m.actualOid}.`
        : `Fix: run the pending migration, or declare ${column} as ${m.actual}.`,
    )
    return lines.join('\n')
  }
  const site = m.origin?.site
  if (site !== undefined) lines.push(`  ${site}`)
  lines.push(
    m.actual === undefined
      ? `Fix: register a codec for oid ${m.actualOid}, or cast in SQL.`
      : `Fix: use codecs.${m.actual}, or cast in SQL.`,
  )
  return lines.join('\n')
}

/**
 * The check that turns D6 from a promise into a test failure (`03` §1.3, §3.2).
 *
 * Thrown when a declared codec's OID and the `dataTypeID` PostgreSQL reported in `RowDescription`
 * disagree — in dev mode only (`NODE_ENV !== 'production'`, or `pgPrime({ assertShape: true })`),
 * because it costs one integer comparison per column per query and buys nothing in production
 * that a test run has not already bought.
 *
 * It is thrown **before** any row is decoded. Decoding first and then complaining would hand back
 * a value that is already wrong (`int4.decodeText('10.50')` is `10`), which is the exact bug the
 * check exists to prevent.
 */
export class CodecMismatchError extends PgPrimeError {
  declare readonly code: 'CODEC_MISMATCH'
  readonly mismatch: CodecMismatch
  constructor(mismatch: CodecMismatch) {
    super('CODEC_MISMATCH', renderCodecMismatch(mismatch))
    this.mismatch = mismatch
  }
}
