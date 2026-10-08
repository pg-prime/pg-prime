import { pgEvents } from '@pg-prime/events'
import type { Events, SubscriptionDef } from '@pg-prime/events'
import { ConfigError, migrateOwnedSchema, ownedSchemaSql, quoteIdentPart } from 'pg-prime'
import type { AsyncDisposable_, Db, OwnedSchemaFile, Queryable } from 'pg-prime'
import type { PayloadOf, QueueDef, ResultOf } from './define.js'
import { NotStartedError, SchemaVersionError } from './errors.js'
import { createHooks } from './hooks.js'
import type { Hooks, MqHooks } from './hooks.js'
import { bind } from './queue/bind.js'
import type { BindOptions, Binding } from './queue/bind.js'
import { flow } from './queue/flow.js'
import type { FlowRef, FlowRoot } from './queue/flow.js'
import { queueHandle } from './queue/handle.js'
import type { QueueHandle } from './queue/handle.js'
import { MIGRATIONS } from './schema/migrations.js'
import { upsertQueue } from './sql/admin.js'
import { tables } from './sql/tables.js'
import type { Tables } from './sql/tables.js'
import { ASYNC_DISPOSE } from './util.js'

export interface MqConfig<D extends Record<string, QueueDef<any, any>>> {
  db: Db
  /** Default `'pgprime_mq'`. */
  schema?: string
  /** Default true; false only checks the version and throws `SchemaVersionError` when behind. */
  autoMigrate?: boolean
  /** The `pgEvents` instance bindings read through; created on the first `bind` when absent. */
  events?: Events<any>
  define?: D
  hooks?: MqHooks
  /** Engine wake-up NOTIFYs; default true. False: workers find work by polling. */
  notify?: boolean
}

export interface Mq<D extends Record<string, QueueDef<any, any>>> extends AsyncDisposable_ {
  readonly queues: { readonly [K in keyof D]: QueueHandle<PayloadOf<D[K]>, ResultOf<D[K]>> }
  /** An ad hoc queue (per-tenant queues): `await handle.start()` before `{ tx }` sends. */
  queue<T, R>(def: QueueDef<T, R>): QueueHandle<T, R>
  /** Inserts a whole tree in one statement: inner nodes wait for their children. */
  flow(root: FlowRoot<any>, opts?: { tx?: Queryable<any> }): Promise<FlowRef>
  /** Every entry of the subscription becomes exactly one message of `queue`. */
  bind<E, T>(sub: SubscriptionDef<E>, queue: QueueDef<T, any>, opts?: BindOptions<E, T>): Binding
  /** Migrates and upserts the declared queues; required before any `{ tx }` call. */
  start(): Promise<void>
  /** Applies missing schema versions, whatever `autoMigrate` says. */
  migrate(): Promise<{ from: number; to: number }>
  observe(hooks: MqHooks): () => void
  /** Stops every worker and binding this instance started; `db` stays open. */
  close(): Promise<void>
}

/** What the handles share. */
export interface Core {
  readonly db: Db
  readonly t: Tables
  readonly hooks: Hooks
  /** Workers and bindings, closed by `mq.close()`. */
  readonly running: Set<{ close(): Promise<void> }>
  /** Ensures the schema, then upserts the queue's row (once per instance). */
  ready(def: QueueDef<any, any>): Promise<void>
  forget(def: QueueDef<any, any>): void
  assertStarted(what: string): void
  events(): Events<any>
}

/** The migrations as files to vendor into a kit project (they converge with `migrate()`). */
export function migrationSql(opts: { schema?: string } = {}): OwnedSchemaFile[] {
  return ownedSchemaSql({ schema: opts.schema ?? 'pgprime_mq', migrations: MIGRATIONS })
}

export function pgMq<const D extends Record<string, QueueDef<any, any>> = {}>(
  config: MqConfig<D>,
): Mq<D> {
  const { db, define = {} as D } = config
  const schema = config.schema ?? 'pgprime_mq'
  quoteIdentPart(schema)
  const hooks = createHooks(config.hooks)
  const memo = new Map<string, Promise<void>>()
  let events = config.events
  let ensuring: Promise<unknown> | undefined
  let ensured = false

  const migrate = async (apply: boolean): Promise<{ from: number; to: number }> => {
    try {
      const r = await migrateOwnedSchema(db, { schema, migrations: MIGRATIONS, apply })
      if (r.to < MIGRATIONS.length) {
        throw new SchemaVersionError(
          `@pg-prime/mq: schema ${schema} is at version ${r.to} and this client needs ` +
            `${MIGRATIONS.length}. Run mq.migrate() or vendor migrationSql()'s files.`,
        )
      }
      ensured = true
      return r
    } catch (e) {
      throw e instanceof ConfigError ? new SchemaVersionError(e.message, e) : e
    }
  }
  const ensure = (): Promise<unknown> =>
    (ensuring ??= migrate(config.autoMigrate !== false).catch((e: unknown) => {
      ensuring = undefined
      throw e
    }))

  const core: Core = {
    db,
    t: tables(schema, config.notify !== false),
    hooks,
    running: new Set(),
    ready(def) {
      let p = memo.get(def.name)
      if (p === undefined) {
        p = ensure().then(() => upsertQueue(db, core.t, def))
        p.catch(() => memo.delete(def.name))
        memo.set(def.name, p)
      }
      return p
    },
    forget: (def) => void memo.delete(def.name),
    assertStarted(what) {
      if (!ensured) throw new NotStartedError(what)
    },
    events: () => (events ??= pgEvents({ db })),
  }

  const close = async (): Promise<void> => {
    await Promise.all([...core.running].map((r) => r.close()))
  }
  const mq: Omit<Mq<D>, keyof AsyncDisposable_> = {
    queues: Object.freeze(
      Object.fromEntries(Object.entries(define).map(([k, d]) => [k, queueHandle(core, d)])),
    ) as Mq<D>['queues'],
    queue: (def) => queueHandle(core, def),
    flow: (root, opts = {}) => flow(core, root, opts.tx),
    bind: (sub, def, opts) => bind(core, sub, def, queueHandle(core, def), opts),
    async start() {
      await ensure()
      for (const d of Object.values(define)) await core.ready(d)
      await events?.start()
    },
    migrate: async () => {
      const r = await migrate(true)
      ensuring = Promise.resolve(r)
      return r
    },
    observe: (h) => hooks.observe(h),
    close,
  }
  return Object.assign(mq, { [ASYNC_DISPOSE]: close }) as unknown as Mq<D>
}
