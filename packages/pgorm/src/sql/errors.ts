/**
 * Error types owned by the `sql` tag and the compiler.
 *
 * These are deliberately nominal-ish (a `code` discriminant) so that consumers can
 * branch without `instanceof` across realm boundaries.
 */

export type PgOrmErrorCode =
  | 'INVALID_IDENTIFIER'
  | 'UNSAFE_LITERAL'
  | 'UNSUPPORTED_NODE'
  | 'TOO_MANY_PARAMETERS'
  | 'INVALID_FRAGMENT'

export class PgOrmError extends Error {
  readonly code: PgOrmErrorCode
  constructor(code: PgOrmErrorCode, message: string) {
    super(message)
    this.name = new.target.name
    this.code = code
  }
}

/**
 * Thrown by `sql.ident` when a part cannot be represented as a Postgres identifier
 * *losslessly*. See `ident.ts` for the reject-vs-truncate rationale.
 */
export class InvalidIdentifierError extends PgOrmError {
  /** The offending part, verbatim (safe to log: it never reaches SQL). */
  readonly part: unknown
  /** Position of the offending part within the `ident(...)` call. */
  readonly index: number
  readonly reason: IdentRejectReason

  constructor(reason: IdentRejectReason, index: number, part: unknown, detail: string) {
    super(
      'INVALID_IDENTIFIER',
      `sql.ident: part ${index} rejected (${reason}): ${detail}`,
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
export class UnsafeLiteralError extends PgOrmError {
  constructor(message: string) {
    super('UNSAFE_LITERAL', message)
  }
}

/** Thrown by the compiler for AST nodes outside the spike's implemented subset. */
export class UnsupportedNodeError extends PgOrmError {
  readonly nodeKind: string
  constructor(nodeKind: string, where: string) {
    super('UNSUPPORTED_NODE', `compiler: node kind '${nodeKind}' is not implemented (${where})`)
    this.nodeKind = nodeKind
  }
}

/** The wire protocol caps parameters at 65535 (int16). §1.4. */
export class TooManyParametersError extends PgOrmError {
  readonly count: number
  constructor(count: number) {
    super(
      'TOO_MANY_PARAMETERS',
      `compiled statement uses ${count} bind parameters; the PostgreSQL wire protocol caps ` +
        `parameters at 65535. Use strategy: 'unnest' or chunk the batch.`,
    )
    this.count = count
  }
}

/** Thrown when a value is passed where a Fragment/AST node is structurally required. */
export class InvalidFragmentError extends PgOrmError {
  constructor(message: string) {
    super('INVALID_FRAGMENT', message)
  }
}
