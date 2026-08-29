/**
 * The handle types (design/07 §1.3, §1.5 layer 2; design/12 §3 S).
 *
 * `07` §1.5 is honest that **no** type-level construct can stop a captured outer `db` from being
 * used inside a transaction callback — TS has no effect system. What TypeScript *can* do is the
 * converse, and these probes are the assertion that it does:
 *
 *  (a) a function that requires a transaction takes `Tx` and cannot be handed a `Db`;
 *  (b) a helper that works either way takes `Queryable` and accepts all three;
 *  (c) a handle cannot escape its callback through the return value (`NoHandleEscape`);
 *  (d) `SavepointOptions` has no `isolation` / `accessMode` / `deferrable` / `retry` **by type**;
 *  (e) `deferrable` is reachable only with `serializable` + `read only`.
 *
 * Compiled by `test/query/typecheck.test.ts` on both TS 5.9.3 and TS 7.0.2, which is what makes
 * every `@ts-expect-error` below a real gate: an unused one is TS2578.
 */

import { expectTypeOf } from 'expect-type'
import type {
  Db,
  DeleteQuery,
  InsertQuery,
  PreparedQuery,
  Query,
  Queryable,
  Session,
  SetQuery,
  Tx,
  UpdateQuery,
} from '../../../src/query/types.js'
import type { NoHandleEscape, SavepointOptions, TxOptions } from '../../../src/session/types.js'
import { defineSchema, pgTable } from '../../../src/schema/index.js'
import type { Assert, Eq } from './kit.js'

const users = pgTable('users', (t) => ({ id: t.bigint().primaryKey(), email: t.text() }))
const schema = defineSchema({ users })
type S = typeof schema

declare const db: Db<S>
declare const tx: Tx<S>
declare const session: Session<S>

// ── (a) the three handles are mutually NON-assignable ────────────────────────

declare function debit(handle: Tx<S>): Promise<void>
declare function pinned(handle: Session<S>): Promise<void>

void debit(tx)
// @ts-expect-error Db is not a Tx — this is the check that makes "must run in a transaction" real.
void debit(db)
// @ts-expect-error a Session is not a Tx either: it has no transaction open.
void debit(session)
void pinned(session)
// @ts-expect-error a Tx is not a Session — session-level state is exactly what it cannot hold.
void pinned(tx)

// ── (b) Queryable is the shared supertype, and helpers should take it ────────

declare function findUser(q: Queryable<S>): Promise<void>
void findUser(db)
void findUser(tx)
void findUser(session)

type _DbIsQueryable = Assert<Eq<Db<S> extends Queryable<S> ? true : false, true>>
type _TxIsQueryable = Assert<Eq<Tx<S> extends Queryable<S> ? true : false, true>>
type _SessionIsQueryable = Assert<Eq<Session<S> extends Queryable<S> ? true : false, true>>
type _DbIsNotTx = Assert<Eq<Db<S> extends Tx<S> ? true : false, false>>
type _TxIsNotDb = Assert<Eq<Tx<S> extends Db<S> ? true : false, false>>
type _SessionIsNotDb = Assert<Eq<Session<S> extends Db<S> ? true : false, false>>

// ── (c) NoHandleEscape — shallow, one conditional, no recursion ──────────────

type _EscapedTx = Assert<
  Eq<NoHandleEscape<Tx<S>>, ['Error: a Tx/Session handle escaped its callback. It is closed and unusable.', never]>
>
type _EscapedSession = Assert<
  Eq<
    NoHandleEscape<Session<S>>,
    ['Error: a Tx/Session handle escaped its callback. It is closed and unusable.', never]
  >
>
/** An ordinary value passes straight through — the guard must cost nothing in the normal case. */
type _PlainRow = Assert<Eq<NoHandleEscape<{ id: bigint }>, { id: bigint }>>
type _PlainUnion = Assert<Eq<NoHandleEscape<number | string>, number | string>>
/**
 * Deliberately SHALLOW: a handle nested inside an object is not caught, and `07` §1.5 says so —
 * a deep walk would cost instantiations at every `transaction()` call site (risk #1 in
 * `research/SUMMARY.md`) to catch a mistake nobody makes. This probe pins the choice so a later
 * "improvement" to a deep walk is a visible diff rather than a silent budget regression.
 */
type _NestedIsNotCaught = Assert<Eq<NoHandleEscape<{ handle: Tx<S> }>, { handle: Tx<S> }>>

async function returnsARow(): Promise<{ id: bigint }> {
  return db.transaction(async () => ({ id: 1n }))
}
void returnsARow

// The error type is what the call site sees, so returning the handle is a compile error at the
// point where it is *used*, which is the only place a message can help.
declare const escaped: Promise<
  NoHandleEscape<Tx<S>>
>
type _EscapeIsNotAHandle = Assert<Eq<Awaited<typeof escaped> extends Tx<S> ? true : false, false>>

// ── (d) SavepointOptions is missing four keys BY CONSTRUCTION ────────────────

void tx.savepoint(async () => undefined, { timeoutMs: 100, label: 'probe' })
// @ts-expect-error isolation cannot change mid-transaction, so the option does not exist.
void tx.savepoint(async () => undefined, { isolation: 'serializable' })
// @ts-expect-error nor can the access mode.
void tx.savepoint(async () => undefined, { accessMode: 'read only' })
// @ts-expect-error nor deferrable.
void tx.savepoint(async () => undefined, { deferrable: true })
// @ts-expect-error a 40001 aborts the WHOLE transaction; retrying a savepoint is meaningless.
void tx.savepoint(async () => undefined, { retry: true })

type _NoIsolation = Assert<Eq<'isolation' extends keyof SavepointOptions ? true : false, false>>
type _NoRetry = Assert<Eq<'retry' extends keyof SavepointOptions ? true : false, false>>

// ── (e) deferrable is gated by the TxOptions union ───────────────────────────

void db.transaction(async () => undefined, {
  isolation: 'serializable',
  accessMode: 'read only',
  deferrable: true,
})
// @ts-expect-error DEFERRABLE without READ ONLY is silently ignored by PostgreSQL, which is worse.
void db.transaction(async () => undefined, { isolation: 'serializable', deferrable: true })
// @ts-expect-error and it is meaningless below SERIALIZABLE.
void db.transaction(async () => undefined, { isolation: 'repeatable read', deferrable: true })
// @ts-expect-error 'read uncommitted' is not offered: PostgreSQL silently gives you read committed.
void db.transaction(async () => undefined, { isolation: 'read uncommitted' })

const readOnlySerializable: TxOptions = {
  isolation: 'serializable',
  accessMode: 'read only',
  deferrable: false,
}
void readOnlySerializable

// ── the surfaces each handle has, and the ones it does not ───────────────────

expectTypeOf(db.kind).toEqualTypeOf<'db'>()
expectTypeOf(tx.kind).toEqualTypeOf<'tx'>()
expectTypeOf(session.kind).toEqualTypeOf<'session'>()
expectTypeOf(tx.attempt).toEqualTypeOf<number>()
expectTypeOf(tx.depth).toEqualTypeOf<number>()
expectTypeOf(tx.status).toEqualTypeOf<'idle' | 'active' | 'failed'>()
expectTypeOf(session.backendPid).toEqualTypeOf<number | undefined>()

// @ts-expect-error only the root handle can open a dedicated LISTEN connection (07 §6.5).
void tx.listen
// @ts-expect-error `session()` pins a connection; you are already on one.
void tx.session
// @ts-expect-error a session-level GUC is not a transaction-local one.
void tx.set
// @ts-expect-error rollbackWith belongs to a transaction, not to the pool-backed root.
void db.rollbackWith
// @ts-expect-error and neither does setLocal, which needs a transaction to be local to.
void db.setLocal

/** `withOptions` preserves the handle type, so a scoped `Tx` is still a `Tx`. */
type _ScopedTx = Assert<Eq<ReturnType<Tx<S>['withOptions']>, Tx<S>>>
type _ScopedDb = Assert<Eq<ReturnType<Db<S>['withOptions']>, Queryable<S>>>

// ── the builder-level option methods (07 §6.1, §6.2, §1.5, §2.3) ─────────────
//
// `07` §6.1 spells `db.select(...).signal(s)` and §6.2 `.timeout(ms)`. design/12 §3 S shipped both
// handle-level because `Query` was another workstream's file that round; these four probes are the
// assertion that the builder now carries them AND that they change nothing about the row type,
// which is the only way a "thin setter" can be wrong at the type level.

type H = (typeof schema)['h']['users']
declare const q: Query<{ users: H }, { id: bigint }>
declare const ins: InsertQuery<H, { id: bigint }>
declare const upd: UpdateQuery<H, { id: bigint }, never>
declare const del: DeleteQuery<H, { id: bigint }>
declare const setq: SetQuery<{ id: bigint }, readonly [unknown]>
declare const prep: PreparedQuery<{ email: string }, { id: bigint }>
declare const signal: AbortSignal

type _QuerySignal = Assert<Eq<ReturnType<typeof q.signal>, typeof q>>
type _QueryTimeout = Assert<Eq<ReturnType<typeof q.timeout>, typeof q>>
type _QueryOutside = Assert<Eq<ReturnType<typeof q.outsideTransaction>, typeof q>>
type _QueryExecMode = Assert<Eq<ReturnType<typeof q.withExecMode>, typeof q>>
type _InsertSignal = Assert<Eq<ReturnType<typeof ins.signal>, typeof ins>>
type _UpdateTimeout = Assert<Eq<ReturnType<typeof upd.timeout>, typeof upd>>
type _DeleteOutside = Assert<Eq<ReturnType<typeof del.outsideTransaction>, typeof del>>
type _SetExecMode = Assert<Eq<ReturnType<typeof setq.withExecMode>, typeof setq>>
type _PreparedSignal = Assert<Eq<ReturnType<typeof prep.signal>, typeof prep>>

/** The row type is untouched, which is the whole claim of "thin setter". */
expectTypeOf(q.signal(signal).timeout(50).outsideTransaction().execute()).toEqualTypeOf<
  Promise<{ id: bigint }[]>
>()
expectTypeOf(prep.timeout(50).execute({ email: 'a' })).toEqualTypeOf<Promise<{ id: bigint }[]>>()

// @ts-expect-error `.timeout()` takes milliseconds, not a Duration string — `07` §6.2's `timeoutMs`.
void q.timeout('30s')
// @ts-expect-error the exec mode is `07` §2.1's two protocol modes, not free text.
void q.withExecMode('prepared')
// @ts-expect-error `.outsideTransaction()` is a statement of intent and takes nothing.
void q.outsideTransaction(true)
