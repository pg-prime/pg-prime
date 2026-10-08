import { inTransactionFrame } from 'pg-prime'
import type { AnySchema, Db, NoHandleEscape, Queryable, Tx, TxOptions } from 'pg-prime'
import { ContextError } from './errors.js'
import type { ContextErrorCode } from './errors.js'
import { capture, restore } from './pin.js'
import { newStorage } from './storage.js'
import type { AsyncStorage } from './storage.js'

export type Setting = string | number | boolean
export type Settings = Readonly<Record<string, Setting>>
export type Propagation = 'join' | 'savepoint' | 'new'
export type HostTxOptions = TxOptions & { readonly propagation?: Propagation }

export interface TransactionHostOptions {
  /** Default `'join'`; a call's own `propagation` overrides it. */
  readonly propagation?: Propagation
  /** Default `true`: reading `db` in a scope with settings but no transaction throws. */
  readonly strict?: boolean
  /** Default: a new `AsyncLocalStorage`. */
  readonly storage?: AsyncStorage<unknown>
}

/** What `request()` takes: the scope's settings and whether the request runs in a transaction. */
export interface RequestScope {
  readonly settings?: Settings
  readonly transaction?: boolean | HostTxOptions
}

interface Store {
  readonly tx?: Tx
  /** Under a pin: the request savepoint that stands in for the pool. */
  readonly base?: Tx
  readonly settings: Record<string, Setting>
}

type Fn<T> = (tx: Tx) => Promise<T>

const NONE: Settings = Object.freeze({})
const fail = (code: ContextErrorCode, message: string): never => {
  throw new ContextError(code, message)
}
const hasKeys = (o: object): boolean => {
  for (const _ in o) return true
  return false
}

/** @internal Set by `rollbackScope` from `./testing`. */
export let setPin: (host: TransactionHost<any>, tx: Tx | undefined) => void

/** The active transaction for the current async context, with propagation and scoped settings. */
export class TransactionHost<Sc extends AnySchema = AnySchema> {
  readonly root: Db<Sc>
  readonly #storage: AsyncStorage<Store>
  readonly #strict: boolean
  readonly #propagation: Propagation
  /** Transactions with a host savepoint in flight: their names are depth-derived per connection. */
  readonly #busy = new WeakSet<Tx>()
  /** Every setting name the host has applied, so a pinned savepoint can restore it. */
  readonly #keys = new Set<string>()
  #pin: Tx | undefined

  static {
    setPin = (host, tx) => {
      host.#pin = tx
    }
  }

  constructor(root: Db<Sc>, opts: TransactionHostOptions = {}) {
    this.root = root
    this.#storage = (opts.storage ?? newStorage()) as AsyncStorage<Store>
    this.#strict = opts.strict ?? true
    this.#propagation = opts.propagation ?? 'join'
  }

  /** The active transaction, else the root (or, under a pin, the pinned transaction). */
  get db(): Queryable<Sc> {
    return this.current()
  }

  current(): Queryable<Sc> {
    const s = this.#storage.getStore()
    if (s?.tx) return s.tx as Tx<Sc>
    if (this.#strict && s && hasKeys(s.settings)) {
      fail(
        'CONTEXT_UNSCOPED_QUERY',
        'host.db was read in a scope with settings but no transaction, and settings apply only ' +
          'inside one. Wrap the work in host.transaction(), or use host.outside() deliberately.',
      )
    }
    return (s?.base ?? this.#pin ?? this.root) as Queryable<Sc>
  }

  tx(): Tx<Sc> {
    const tx = this.#storage.getStore()?.tx
    return (tx ?? fail('CONTEXT_NO_TRANSACTION', 'host.tx() outside a host transaction.')) as Tx<Sc>
  }

  get inTransaction(): boolean {
    return this.#storage.getStore()?.tx !== undefined
  }

  get attempt(): number {
    return this.#storage.getStore()?.tx?.attempt ?? 0
  }

  get settings(): Settings {
    return this.#storage.getStore()?.settings ?? NONE
  }

  /** A `rollbackScope` holds this host's transactions. */
  get pinned(): boolean {
    return this.#pin !== undefined
  }

  outside(): Queryable<Sc> {
    return this.root.outsideTransaction()
  }

  /** A settings scope, inheriting the parent's. Refused inside a transaction. */
  run<T>(scope: { readonly settings?: Settings }, fn: () => T): T {
    const s = this.#storage.getStore()
    if (s?.tx) fail('CONTEXT_NESTED_SCOPE', 'run() inside a transaction; open the scope first.')
    return this.#storage.run(
      { ...s, settings: { ...s?.settings, ...this.#learn(scope.settings) } },
      fn,
    )
  }

  /** A request: a scope, in a host transaction when asked. Under a pin, always one savepoint. */
  async request<T>(scope: RequestScope, fn: () => Promise<T>): Promise<T> {
    const t = scope.transaction
    return this.run(scope, () => {
      if (t) return this.transaction(fn, t === true ? {} : t) as Promise<T>
      const s = this.#storage.getStore()!
      return this.#pin ? this.#pinned(s.base ?? this.#pin, s, fn, {}, true) : fn()
    })
  }

  setLocal(name: string, value: Setting): Promise<void>
  setLocal(settings: Settings): Promise<void>
  async setLocal(a: string | Settings, b?: Setting): Promise<void> {
    const settings = this.#learn(typeof a === 'string' ? { [a]: b! } : a)
    const s =
      this.#storage.getStore() ??
      fail('CONTEXT_NO_SCOPE', 'setLocal() outside a scope and a transaction.')
    if (s.tx) await s.tx.setLocal(settings)
    Object.assign(s.settings, settings)
  }

  /** Adopt an explicit `Tx`: sends the scope's settings to it, then runs `fn` with it active. */
  async within<T>(tx: Tx<Sc>, fn: () => Promise<T>): Promise<T> {
    const s = this.#storage.getStore()
    const settings = s?.settings ?? {}
    if (hasKeys(settings)) await tx.setLocal(settings)
    return this.#storage.run({ ...s, settings, tx: tx as Tx }, fn)
  }

  async transaction<T>(
    fn: (db: Tx<Sc>) => Promise<T>,
    opts: HostTxOptions = {},
  ): Promise<NoHandleEscape<T>> {
    const s = this.#storage.getStore()
    const { propagation = this.#propagation, ...o } = opts
    const run = fn as unknown as Fn<NoHandleEscape<T>>
    const outer = s?.tx
    this.#learn(o.localSettings)
    if (outer && propagation === 'join') {
      if (o.timeoutMs !== undefined || o.lockTimeoutMs !== undefined || o.localSettings) {
        fail(
          'CONTEXT_OPTIONS',
          'a join cannot set timeoutMs, lockTimeoutMs or localSettings; use propagation savepoint or new.',
        )
      }
      if (
        (o.isolation ?? outer.isolation) !== outer.isolation ||
        (o.accessMode ?? outer.accessMode) !== outer.accessMode
      ) {
        fail(
          'CONTEXT_OPTIONS',
          `cannot join a ${outer.isolation}, ${outer.accessMode} transaction with ${o.isolation ?? outer.isolation}, ${o.accessMode ?? outer.accessMode}.`,
        )
      }
      return run(outer)
    }
    if (outer && propagation === 'savepoint') {
      if ([o.isolation, o.accessMode, o.deferrable, o.retry].some((v) => v !== undefined)) {
        fail(
          'CONTEXT_OPTIONS',
          'a savepoint cannot set isolation, accessMode, deferrable or retry.',
        )
      }
      return this.#nest(outer, () =>
        outer.savepoint((sp) => this.#enter(s, sp, run), o),
      ) as Promise<NoHandleEscape<T>>
    }
    if (this.#pin) return this.#pinned(outer ?? s?.base ?? this.#pin, s, run, o)
    const settings = s?.settings ?? {}
    return this.root.transaction((tx) => this.#enter(s, tx, run, settings), {
      ...o,
      localSettings: { ...settings, ...o.localSettings },
    } as TxOptions) as Promise<NoHandleEscape<T>>
  }

  #learn(settings: Settings | undefined): Settings {
    for (const k in settings) this.#keys.add(k)
    return settings ?? NONE
  }

  #enter<T>(s: Store | undefined, tx: Tx, fn: Fn<T>, settings = s?.settings ?? {}): Promise<T> {
    return this.#storage.run({ ...s, settings, tx }, () => fn(tx))
  }

  async #nest<T>(on: Tx, open: () => Promise<T>): Promise<T> {
    if (this.#busy.has(on)) {
      fail(
        'CONTEXT_CONCURRENT_SAVEPOINT',
        on === this.#pin
          ? 'the pinned test transaction is already running a request; await it first.'
          : 'another host savepoint is in flight on this transaction; await it first.',
      )
    }
    this.#busy.add(on)
    try {
      return await open()
    } finally {
      this.#busy.delete(on)
    }
  }

  /** Where production opens a root transaction: a savepoint on `base` that leaves no settings behind. */
  #pinned<T>(base: Tx, s: Store | undefined, fn: Fn<T>, o: TxOptions, asBase = false): Promise<T> {
    const settings = s?.settings ?? {}
    const readOnly = o.accessMode === 'read only'
    const open = async (): Promise<T> => {
      const before = await capture(base, this.#keys)
      return base.savepoint(
        async (r) => {
          if (readOnly) await r.setLocal('transaction_read_only', 'on')
          const store = asBase ? { ...s, settings, base: r } : { ...s, settings, tx: r }
          const v = await this.#storage.run(store, () => fn(r))
          if (readOnly) return r.rollbackWith(v)
          await restore(r, before, this.#keys)
          return v
        },
        {
          ...o,
          localSettings: asBase ? { ...o.localSettings } : { ...settings, ...o.localSettings },
        },
      ) as Promise<T>
    }
    return inTransactionFrame(this.#pin!, () => this.#nest(base, open))
  }
}
