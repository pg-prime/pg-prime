/**
 * The root of the error hierarchy (design/07 §4.1–§4.3).
 *
 * ## Why the root moved here from `src/sql/errors.ts`
 *
 * `07` §4.2 makes `PgPrimeError` the single ancestor of *everything* the library throws — the
 * builder's `BuilderError`, the compiler's `TooManyParametersError`, and the ~50 runtime classes
 * in `./classes.ts`. `src/sql/errors.ts` owned the root and is imported by `sql/ident.ts`, which
 * the compiler imports, which `./classes.ts` would have to import back for `UsageError`. Putting
 * the three universal ancestors in a leaf module with **no imports at all** breaks that cycle
 * before it exists; `src/sql/errors.ts` re-exports `PgPrimeError` so every existing import path
 * still resolves.
 *
 * Nothing in this file imports anything. That is the property that makes it safe.
 */

/**
 * A stable, programmatic discriminator for the errors that have no SQLSTATE.
 *
 * `PgPrimeError.code` is typed `string` rather than this union because `07` §4.3 defines it as
 * *the SQLSTATE, when the server gave one* — `'23505'` on a `UniqueViolationError`. The union
 * remains the documented vocabulary for the builder/compiler side and is what those classes pass.
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
  | 'CONFIG'
  | 'USAGE'

/** Which handle a statement was issued on. `07` §4.3, and the `handle` attribute of every event. */
export type HandleKind = 'db' | 'tx' | 'session'

/**
 * `07` §4.3's `context`. Present on every error the *runtime* raises and absent on the ones the
 * builder raises before a handle is involved, which is why every field including `handle` is
 * optional here and non-optional on `QueryError`.
 */
export interface ErrorContext {
  readonly label?: string
  readonly attempt?: number
  readonly durationMs?: number
  readonly handle?: HandleKind
  /**
   * Why a `57014` happened: the backend's own `statement_timeout` versus a `CancelRequest` we
   * sent. `07` §6.2 — "the first means the server gave up, the second means we did and the server
   * may still be working".
   */
  readonly reason?: 'statement_timeout' | 'lock_timeout' | 'cancel'
  readonly queryId?: string
  readonly txId?: string
  readonly depth?: number
}

/**
 * `instanceof PgPrimeError` reliably answers "did this come from the database layer" (`07` §4.1).
 */
export class PgPrimeError extends Error {
  /** SQLSTATE when the server gave one (`'23505'`), otherwise a {@link PgPrimeErrorCode}. */
  readonly code: string
  /** Captured at query start, so you get the real call site instead of an async stack. `07` §7.4. */
  readonly callSite?: string
  readonly context?: ErrorContext

  constructor(code: string, message: string, options?: ErrorInit) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = new.target.name
    this.code = code
    if (options?.callSite !== undefined) this.callSite = options.callSite
    if (options?.context !== undefined) this.context = options.context
  }
}

export interface ErrorInit {
  readonly cause?: unknown
  readonly callSite?: string
  readonly context?: ErrorContext
}

/**
 * Programmer error — ours or yours, never the database's (`07` §4.2).
 *
 * The distinction is operational: a `UsageError` is never transient, so nothing in `07` §3.4's
 * retry policy will ever re-run a transaction that raised one.
 */
export class UsageError extends PgPrimeError {
  constructor(message: string, options?: UsageErrorInit) {
    super(options?.code ?? 'USAGE', message, options)
  }
}

/** `code` is here so a pre-existing usage error keeps the discriminator it already published. */
export interface UsageErrorInit extends ErrorInit {
  readonly code?: string
}

/**
 * An invalid configuration. Thrown **eagerly**, at `pgPrime(...)`, and not at the first query
 * (`07` §4.2, and §2.3's "restriction is loud and immediate").
 */
export class ConfigError extends PgPrimeError {
  constructor(message: string, options?: ErrorInit) {
    super('CONFIG', message, options)
  }
}
