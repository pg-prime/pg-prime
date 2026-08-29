/**
 * `.prepare()` and `placeholder()` — design/03 §1.4 (b), design/09 WS6.
 *
 * ## The one sentence that separates two things every other ORM conflates
 *
 * *`.prepare()` caches **our** work; `{ statement: 'named' }` caches **Postgres's**.* (`03` §1.4.)
 * A `PreparedQuery` is a client-side artifact: the SQL text, the bind plan with its holes, the
 * decode plan, and the `meta`. Nothing has touched a server. Asking for `{ statement: 'named' }`
 * additionally pins the server-side named statement of `07` §2.4, with its per-connection LRU and
 * its self-heal — a different feature, with pooler consequences, opted into by name.
 *
 * ## Why placeholders are a free function and not a `$` scope
 *
 * `03` §1.4's sketch spells the hole as a second lambda parameter: `.where(({users: u}, $) =>
 * u.email.eq($.email))`. That cannot be typed. `$`'s shape is `P`, and `P` is supplied at
 * `.prepare<P>()` — *after* the `.where()` that used it — so a typed `$` needs `P` threaded
 * through `Query` as a fourth type parameter, which is the one shape `04` §1.3 rule 3 forbids.
 * An untyped `$` costs every lambda in every query a parameter it will never use; measured in
 * `09` §3.6.
 *
 * So a placeholder is a value, like every other operand, and reaches the operators through the
 * same door a column does — fork F1's rule, applied to the one case `03` wrote before the fork
 * was decided:
 *
 * ```ts
 * const byEmail = db.from(db.h.users)
 *   .select(({ users: u }) => ({ id: u.id, email: u.email }))
 *   .where(({ users: u }) => eq(u.email, placeholder('email', textCodec)))
 *   .prepare<{ email: string }>('users_by_email')
 *
 * await byEmail.execute({ email: 'a@b.c' })   // no AST walk, no compile
 * ```
 *
 * `P` is written by hand and checked at runtime against `meta.placeholders`: a missing or extra
 * key throws a `BuilderError` naming it. Linking the two statically would need the same fourth
 * type parameter, and the runtime check catches the same mistake one test run later.
 */

import type { AnyCodec, CodecOut } from '../codec/index.js'
import type { Compiled, CompiledMeta } from '../compile/contract.js'
import { placeholder as placeholderNode } from '../compile/nodes.js'
import { BuilderError } from '../sql/errors.js'
import type { BuilderCtx, QueryRunOptions } from './builder-state.js'
import type { ExplainOptions, ExplainResult, StatementMode, StreamOptions } from './executor.js'
import { assertNoExtraPlaceholders } from './executor.js'
import {
  explainWith,
  mergeRun,
  runnerOf,
  streamWith,
  takeFirst,
  toSQLOf,
  withRunOption,
} from './terminals.js'
import type { SqlSnapshot } from './terminals.js'
import type { Expr } from './types.js'

/**
 * A named hole, filled at `execute(params)` on a prepared query.
 *
 * The codec is mandatory and is the same one a column or `val(...)` would carry, so the hole is a
 * class-gated operand (`eq(u.email, placeholder('email', textCodec))` typechecks; comparing it
 * with a `numeric` column does not) and its `$n` is declared to `Parse` with a real OID rather
 * than left for PostgreSQL to infer — which is what `02` §2.3 says avoids `42P18`.
 */
export function placeholder<C extends AnyCodec>(
  name: string,
  codec: C,
): Expr<CodecOut<C>, C['name']> {
  if (typeof name !== 'string' || name.length === 0) {
    throw new BuilderError('pg-prime: placeholder(name, codec) needs a non-empty name.')
  }
  return placeholderNode(name, codec) as unknown as Expr<CodecOut<C>, C['name']>
}

export interface PrepareOptions {
  /**
   * `'named'` additionally pins server-side prepared statements for this query (`07` §2.4).
   * Default: whatever `pgPrime({ statement })` says, which defaults to `'unnamed'`.
   */
  readonly statement?: StatementMode
}

/**
 * A compiled statement with typed holes (`03` §1.4b).
 *
 * `execute()` walks `binds` once, calls `codec.encode` per slot per execution, and re-does nothing
 * else: no AST walk, no `compile()`, no `buildDecoder`. The tier-0 suite pins all three with spies,
 * because "we cached it" is exactly the kind of claim that is true on the day it is written.
 */
export interface PreparedQuery<P, O> {
  /** The JS-side name the caller gave, for logs and error messages. Never the server-side one. */
  readonly name: string | undefined
  readonly sql: string
  /** `reads` / `writes` / `placeholders` / `usedUnsafeRaw`, as `03` §1.3 defines them. */
  readonly meta: CompiledMeta
  /** The frozen artifact. Identical on every call — this is what "prepared" means. */
  compile(): Compiled<O>
  /** Never throws on an unfilled hole; pass `params` to see them filled. */
  toSQL(params?: P): SqlSnapshot
  execute(params: P): Promise<O[]>
  executeTakeFirst(params: P): Promise<O | undefined>
  stream(params: P, opts?: StreamOptions): AsyncIterable<O>
  explain(params: P, opts?: ExplainOptions): Promise<ExplainResult>
  /**
   * `07` §6.1/§6.2's per-statement options, inherited from the builder that prepared this and
   * overridable here. The artifact is immutable, so each returns a **new** `PreparedQuery` over
   * the same compiled statement — no re-compile, no second decode plan, nothing re-derived.
   */
  signal(signal: AbortSignal): PreparedQuery<P, O>
  timeout(ms: number): PreparedQuery<P, O>
  outsideTransaction(): PreparedQuery<P, O>
  withExecMode(mode: StatementMode): PreparedQuery<P, O>
}

type Values = Readonly<Record<string, unknown>>

export class PreparedQueryImpl<O> implements PreparedQuery<Values, O> {
  readonly name: string | undefined
  readonly #ctx: BuilderCtx
  readonly #compiled: Compiled<O>
  readonly #statement: StatementMode | undefined
  readonly #runOptions: QueryRunOptions | undefined

  constructor(
    ctx: BuilderCtx,
    compiled: Compiled<O>,
    name: string | undefined,
    opts: PrepareOptions | undefined,
    run?: QueryRunOptions | undefined,
  ) {
    this.#ctx = ctx
    this.#compiled = compiled
    this.name = name
    this.#statement = opts?.statement
    this.#runOptions = run
    Object.freeze(this)
  }

  #with(patch: QueryRunOptions): PreparedQueryImpl<O> {
    return new PreparedQueryImpl(
      this.#ctx,
      this.#compiled,
      this.name,
      this.#statement === undefined ? undefined : { statement: this.#statement },
      withRunOption(this.#runOptions, patch),
    )
  }

  signal(signal: AbortSignal): PreparedQueryImpl<O> {
    return this.#with({ signal })
  }

  timeout(ms: number): PreparedQueryImpl<O> {
    return this.#with({ timeoutMs: ms })
  }

  outsideTransaction(): PreparedQueryImpl<O> {
    return this.#with({ outsideTransaction: true })
  }

  withExecMode(mode: StatementMode): PreparedQueryImpl<O> {
    return this.#with({ statement: mode })
  }

  get sql(): string {
    return this.#compiled.sql
  }

  get meta(): CompiledMeta {
    return this.#compiled.meta
  }

  compile(): Compiled<O> {
    return this.#compiled
  }

  toSQL(params?: Values): SqlSnapshot {
    return toSQLOf(this.#compiled as Compiled<unknown>, params)
  }

  #run(params: Values): QueryRunOptions {
    assertNoExtraPlaceholders(this.#compiled.meta.placeholders, params)
    // `.prepare({ statement })` is the *artifact's* mode and `.withExecMode()` is the caller's
    // later word on the same statement, so the setter wins — same precedence as everywhere else.
    const base = this.#runOptions
    if (base === undefined) {
      return this.#statement === undefined ? { params } : { params, statement: this.#statement }
    }
    return this.#statement === undefined || base.statement !== undefined
      ? { ...base, params }
      : { ...base, params, statement: this.#statement }
  }

  // `async`, and the three of them deliberately so: a bad `params` object is a *rejected
  // promise*, not a synchronous throw. `p.execute(x).catch(…)` is how a caller writes error
  // handling for something that returns a promise, and a method that sometimes throws before it
  // returns one makes that handler wrong exactly when it is needed.
  async execute(params: Values): Promise<O[]> {
    return runnerOf(this.#ctx).run(this.#compiled, this.#run(params))
  }

  async executeTakeFirst(params: Values): Promise<O | undefined> {
    return takeFirst(await this.execute(params))
  }

  async *stream(params: Values, opts?: StreamOptions): AsyncIterable<O> {
    yield* streamWith(this.#ctx, this.#compiled, mergeRun(this.#run(params), opts))
  }

  async explain(params: Values, opts?: ExplainOptions): Promise<ExplainResult> {
    return explainWith(this.#ctx, this.#compiled as Compiled<unknown>, opts, this.#run(params))
  }
}

/** Shared by every builder's `.prepare()`. One place that knows what a prepared artifact is. */
export function prepareFrom<O>(
  ctx: BuilderCtx,
  compiled: Compiled<O>,
  name?: string,
  opts?: PrepareOptions,
  run?: QueryRunOptions | undefined,
): PreparedQueryImpl<O> {
  return new PreparedQueryImpl(ctx, compiled, name, opts, run)
}
