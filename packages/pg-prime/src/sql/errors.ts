/**
 * Error types owned by the `sql` tag and the compiler.
 *
 * These are deliberately nominal-ish (a `code` discriminant) so that consumers can
 * branch without `instanceof` across realm boundaries.
 */

export type PgPrimeErrorCode =
  | 'INVALID_IDENTIFIER'
  | 'UNSAFE_LITERAL'
  | 'UNSUPPORTED_NODE'
  | 'TOO_MANY_PARAMETERS'
  | 'INVALID_FRAGMENT'
  | 'NO_CODEC'
  | 'NULL_OPERAND'
  | 'DECODE_PLAN'
  | 'BUILDER'
  | 'SCHEMA'
  | 'CODEC_MISMATCH'

export class PgPrimeError extends Error {
  readonly code: PgPrimeErrorCode
  constructor(code: PgPrimeErrorCode, message: string) {
    super(message)
    this.name = new.target.name
    this.code = code
  }
}

/**
 * Thrown when a part cannot be represented as a Postgres identifier *losslessly*. See `ident.ts`
 * for the reject-vs-truncate rationale.
 *
 * The message is deliberately **site-neutral**: `quoteIdentPart` is called from `sql.ident`, from
 * every node constructor that pre-quotes a table/column/alias, and from the emitter's projection
 * aliases, so "sql.ident: …" was a false lead in three cases out of four.
 */
export class InvalidIdentifierError extends PgPrimeError {
  /** The offending part, verbatim (safe to log: it never reaches SQL). */
  readonly part: unknown
  /** Position of the offending part within the `ident(...)` call. */
  readonly index: number
  readonly reason: IdentRejectReason

  constructor(reason: IdentRejectReason, index: number, part: unknown, detail: string) {
    super(
      'INVALID_IDENTIFIER',
      `pg-prime: identifier part ${index} rejected (${reason}): ${detail}`,
    )
    this.reason = reason
    this.index = index
    this.part = part
  }
}

export type IdentRejectReason =
  | 'not-a-string'
  | 'empty'
  | 'nul-byte'
  | 'lone-surrogate'
  | 'too-long'
  | 'no-parts'

/** Thrown by `sql.lit` when handed a string (D7 — the GHSA-8cpq CVE class). */
export class UnsafeLiteralError extends PgPrimeError {
  constructor(message: string) {
    super('UNSAFE_LITERAL', message)
  }
}

/** Thrown by the compiler for AST nodes outside the spike's implemented subset. */
export class UnsupportedNodeError extends PgPrimeError {
  readonly nodeKind: string
  constructor(nodeKind: string, where: string) {
    super('UNSUPPORTED_NODE', `compiler: node kind '${nodeKind}' is not implemented (${where})`)
    this.nodeKind = nodeKind
  }
}

/**
 * The wire protocol caps parameters at 65535 (int16). `03` §1.4.
 *
 * Names the statement kind, because the fix differs: an INSERT gets `strategy: 'unnest'` (one
 * parameter per column regardless of row count), a SELECT with a huge `IN` list gets `= any($1)`,
 * which the builder already emits for `inList`.
 */
export class TooManyParametersError extends PgPrimeError {
  readonly count: number
  readonly statement: string
  constructor(count: number, statement = 'statement') {
    super(
      'TOO_MANY_PARAMETERS',
      `compiled ${statement} uses ${count} bind parameters; the PostgreSQL wire protocol caps ` +
        `parameters at 65535. Use strategy: 'unnest' or chunk the batch.`,
    )
    this.count = count
    this.statement = statement
  }
}

/** Thrown when a value is passed where a Fragment/AST node is structurally required. */
export class InvalidFragmentError extends PgPrimeError {
  constructor(message: string) {
    super('INVALID_FRAGMENT', message)
  }
}

/**
 * Thrown by `metaOf` when a column's declared PostgreSQL type has no codec in the registry.
 *
 * It fires at schema→metadata time, once, and never at query time: a column with no codec cannot
 * be encoded or decoded, so discovering it while a statement is in flight would mean the query
 * had already reached the server. The message names the column and the type it asked for,
 * because the two fixes are different (register a codec, or fix the DSL).
 */
export class NoCodecError extends PgPrimeError {
  readonly table: string
  readonly column: string
  readonly pgType: string
  constructor(table: string, column: string, pgType: string, hint: string) {
    super(
      'NO_CODEC',
      `pg-prime: column "${table}"."${column}" is declared as PostgreSQL type '${pgType}', ` +
        `for which no codec is registered. ${hint}`,
    )
    this.table = table
    this.column = column
    this.pgType = pgType
  }
}

/**
 * Thrown when `null` is passed as the right-hand operand of an equality-family operator.
 *
 * `x = NULL` is never true — it is `NULL` — so a builder that accepted it would silently return
 * zero rows, which is the single most common SQL mistake and the one an ORM is best placed to
 * make impossible. The type layer rejects it first (`NonNullOperand` in `src/query/ops.types.ts`);
 * this is the backstop for a value that arrived as `T | null` from untyped JavaScript.
 *
 * Deliberately NOT rewritten to `IS NULL`. Two reasons: the SQL a query compiles to would then
 * depend on a runtime *value* rather than on the query's shape, so one call site would mint two
 * prepared statements and neither `.compile()` nor a golden would be stable; and `IS NULL` is not
 * what the caller wrote, so the rewrite would hide a bug rather than report it. `isNull(x)` and
 * `isDistinctFrom(x, y)` say each of the two things a caller might have meant.
 */
const OPERATOR_SYMBOL: Readonly<Record<string, string>> = {
  eq: '=',
  neq: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
  like: 'like',
  ilike: 'ilike',
  notLike: 'not like',
  notILike: 'not ilike',
  startsWith: '^@',
  between: 'between … and',
}

export class NullOperandError extends PgPrimeError {
  readonly operator: string
  constructor(operator: string) {
    super(
      'NULL_OPERAND',
      `pg-prime: ${operator}(a, null) would compile to \`a ${OPERATOR_SYMBOL[operator] ?? '='} NULL\`, ` +
        `which is NULL and therefore never true — the query would return no rows. ` +
        `Use isNull(a) / isNotNull(a) to test for NULL, or isDistinctFrom(a, b) for a ` +
        `null-safe comparison.`,
    )
    this.operator = operator
  }
}

/**
 * Thrown while *building* a decoder from a `ResultShape` — never while decoding a row.
 *
 * Every one of these is a malformed plan rather than bad data: a `nest()` group asked to decode
 * from a single column index, or a projection key of `__proto__`, which `obj[key] = …` would
 * turn into the row's *prototype* rather than into a property. Failing at plan-build time means
 * the failure lands once, on `.compile()`/`buildDecoder`, instead of once per row.
 */
export class DecodePlanError extends PgPrimeError {
  constructor(message: string) {
    super('DECODE_PLAN', message)
  }
}

/**
 * Thrown by the runtime builders (design/09 WS4) for a query that cannot be built.
 *
 * Every one of these is a case the *type* layer already rejects — a projection with a bare value,
 * a relation accessor that does not exist yet, `.execute()` on a builder with no executor. It
 * exists for the JavaScript caller and for the boundary where a value arrives untyped, and the
 * message names the fix rather than the violation (design/04 §4, the same rule the branded type
 * errors obey).
 */
export class BuilderError extends PgPrimeError {
  constructor(message: string) {
    super('BUILDER', message)
  }
}

/**
 * Thrown by `defineSchema(...)` when a declaration cannot be resolved — a relation that names a
 * table the registry does not have, a relation whose name collides with a column on the same
 * table (03 §4.1's first hard ask), a `from`/`to` pair of different lengths.
 *
 * It fires at *definition* time, which is the point: a schema file is evaluated once at module
 * load, so the failure lands on the import rather than on the first query that happens to touch
 * the relation.
 */
export class SchemaError extends PgPrimeError {
  constructor(message: string) {
    super('SCHEMA', message)
  }
}
