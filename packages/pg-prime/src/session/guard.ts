/**
 * The dev-mode misuse guard (design/07 §1.5 layer 3, §1.6).
 *
 * ## What this is, precisely
 *
 * Drizzle's #1 bug is `db.transaction(async (tx) => { await db.insert(...) })`: the inner call
 * silently runs *outside* the transaction, on a different connection, and can deadlock against
 * its own transaction. `07` §1.5 is honest that no type-level construct can prevent it — TS has no
 * effect system and no way to invalidate a binding captured from an enclosing scope — so this is
 * the runtime layer of four, and it is the only one that catches capture at all in core.
 *
 * ## Why the import is dynamic, and why that is a gate rather than a nicety
 *
 * `node:async_hooks` is a core module, so it costs no dependency; but a **static** import puts it
 * in the graph of every bundle, including a Cloudflare Worker's and a browser preview's, where it
 * does not exist. `07` §1.6 also insists ALS stays off the production hot path so we never have to
 * defend a number. So the store is created lazily, on the first `transaction()` that runs with the
 * guard on, inside an `await` that already exists — and `tools/treeshake-check.mjs`'s hello-world
 * golden asserts `node:async_hooks` is not in the module set.
 *
 * A runtime without `AsyncLocalStorage` degrades to "guard off", never to a crash.
 *
 * ## False positives are legitimate
 *
 * Deliberately running an out-of-band query during a transaction — an audit row that must survive
 * the rollback — is `07` §3.8's only legitimate use of the outer handle, so there is an explicit
 * per-call opt-out (`outsideTransaction`) rather than an argument about it.
 */

import { HandleMisuseError } from '../errors/index.js'

/** The two members of `AsyncLocalStorage` we use, declared structurally so `@types/node` is not in the emit. */
interface AlsLike<T> {
  getStore(): T | undefined
  run<R>(store: T, fn: () => R): R
}

/** One frame per open transaction on the current async context. */
export interface GuardFrame {
  readonly txId: string
  readonly label: string | undefined
  readonly openedAt: string | undefined
  readonly depth: number
}

let store: AlsLike<readonly GuardFrame[]> | undefined
let pending: Promise<AlsLike<readonly GuardFrame[]> | undefined> | undefined
let unavailable = false

/**
 * Resolve the store, importing `node:async_hooks` at most once per process.
 *
 * Called from `transaction()` / `session()`, which are already `async`, so the import costs no
 * extra tick on any path that does not open a transaction.
 */
export async function ensureGuardStore(): Promise<AlsLike<readonly GuardFrame[]> | undefined> {
  if (store !== undefined || unavailable) return store
  pending ??= importStore()
  store = await pending
  if (store === undefined) unavailable = true
  return store
}

async function importStore(): Promise<AlsLike<readonly GuardFrame[]> | undefined> {
  try {
    const mod = (await import('node:async_hooks')) as unknown as {
      AsyncLocalStorage?: new () => AlsLike<readonly GuardFrame[]>
    }
    const Ctor = mod.AsyncLocalStorage
    return Ctor === undefined ? undefined : new Ctor()
  } catch {
    // No async_hooks: a Worker, a browser bundle, a Deno permission. The guard is a dev aid.
    return undefined
  }
}

/** The frames open on the current async context. Cheap: one `getStore()` when the guard has run. */
export function currentFrames(): readonly GuardFrame[] | undefined {
  return store?.getStore()
}

/** Run `fn` with one more frame on the stack. */
export function withFrame<R>(frame: GuardFrame, fn: () => R): R {
  if (store === undefined) return fn()
  const next = [...(store.getStore() ?? []), frame]
  return store.run(next, fn)
}

/**
 * Run `fn` with the frame stack **cleared**.
 *
 * This is what `07` §3.8's `REQUIRES_NEW` needs: `rootDb.transaction(...)` inside a callback is
 * legitimate and must not trip the guard on its own statements.
 */
export function withoutFrames<R>(fn: () => R): R {
  if (store === undefined) return fn()
  return store.run([], fn)
}

/**
 * The check, on the **root** `Db` handle only. A `Tx` or `Session` statement is by definition on
 * the right connection.
 */
export function assertNotInsideTransaction(callSite: string | undefined): void {
  const frames = store?.getStore()
  if (frames === undefined || frames.length === 0) return
  const top = frames[frames.length - 1] as GuardFrame
  throw new HandleMisuseError(
    `a statement was issued on the root db handle while transaction ${top.txId}` +
      `${top.label === undefined ? '' : ` (${top.label})`} is open on this async context. It would ` +
      `run on a DIFFERENT connection, outside your transaction, and can deadlock against it — ` +
      `which is the single most common bug in this shape of API (07 §1.5).\n` +
      `  the transaction was opened ${top.openedAt ?? 'at an unknown call site'}\n` +
      `  the statement was issued ${callSite ?? 'at an unknown call site'}\n` +
      `  Fix: name the callback parameter \`db\` so it shadows the outer handle, or — if you really ` +
      `mean an out-of-band statement that survives a rollback — write ` +
      `db.outsideTransaction().from(...) / run(q, { outsideTransaction: true }).`,
    { callSite: callSite ?? '', context: { handle: 'db' } },
  )
}

/**
 * `07` §3.2 — `Promise.all` inside a transaction is *serial*, because there is one connection.
 *
 * We cannot make it parallel; that is the protocol. We can make it visible, once per transaction,
 * at `warn`. Not an error: the code is correct, it is just not doing what it looks like.
 */
export function concurrentStatementsWarning(count: number): string {
  return (
    `pg-prime: ${count} statements were issued concurrently on one transaction handle; they ` +
    `execute SERIALLY, because a transaction is one connection. Use separate transactions, or ` +
    `db.session() plus explicit ordering, if you need parallelism (07 §3.2).`
  )
}

/** @internal — the tier-0 suite needs a clean store between cases. */
export function resetGuardForTests(): void {
  store = undefined
  pending = undefined
  unavailable = false
}
