import { ConfigError, migrateOwnedSchema, quoteIdentPart } from 'pg-prime'
import type { AsyncDisposable_, Db } from 'pg-prime'
import { channelHandle, engineChannel } from './channel.js'
import type { ChannelHandle } from './channel.js'
import type {
  ChannelDef,
  EventsDefinitions,
  PayloadOf,
  SubscriptionDef,
  TopicDef,
} from './define.js'
import { NotStartedError, SchemaVersionError } from './errors.js'
import { createHooks } from './hooks.js'
import type { EventsHooks, Hooks } from './hooks.js'
import { BEGINNING, seed } from './log/cursor.js'
import { MIGRATIONS } from './log/migrations.js'
import { statements } from './log/sql.js'
import type { Statements } from './log/sql.js'
import { subscriptionHandle } from './log/subscription.js'
import type { SubscriptionHandle } from './log/subscription.js'
import { topicHandle } from './log/topic.js'
import type { TopicHandle } from './log/topic.js'
import { ASYNC_DISPOSE } from './util.js'

export interface EventsConfig<D extends EventsDefinitions> {
  db: Db
  /** Default `'pgprime_events'`. */
  schema?: string
  /** Default true; false only checks the version and throws `SchemaVersionError` when behind. */
  autoMigrate?: boolean
  define?: D
  hooks?: EventsHooks
}

export interface Events<D extends EventsDefinitions> extends AsyncDisposable_ {
  readonly channels: {
    readonly [K in keyof D['channels']]: ChannelHandle<PayloadOf<D['channels'][K]>>
  }
  readonly topics: { readonly [K in keyof D['topics']]: TopicHandle<PayloadOf<D['topics'][K]>> }
  readonly subscriptions: {
    readonly [K in keyof D['subscriptions']]: SubscriptionHandle<PayloadOf<D['subscriptions'][K]>>
  }
  channel<T>(def: ChannelDef<T>): ChannelHandle<T>
  topic<T>(def: TopicDef<T>): TopicHandle<T>
  subscription<T>(def: SubscriptionDef<T>): SubscriptionHandle<T>
  /** Migrates and upserts the declared topics and subscriptions; required before any `{ tx }` call. */
  start(): Promise<void>
  /** Applies missing schema versions, whatever `autoMigrate` says. */
  migrate(): Promise<{ from: number; to: number }>
  observe(hooks: EventsHooks): () => void
  /** Stops every reader and tail this instance started; `db` stays open. */
  close(): Promise<void>
}

/** What the handles share. */
export interface Core {
  readonly db: Db
  readonly sql: Statements
  readonly hooks: Hooks
  /** Readers and tails, closed by `events.close()`. */
  readonly running: Set<{ close(): Promise<void> }>
  topicChannel(topic: string): string
  /** Ensures the schema, then upserts the topic, or the subscription with its cursor seeded once. */
  ready(def: TopicDef<any> | SubscriptionDef<any>): Promise<void>
  forget(def: SubscriptionDef<any>): void
  assertStarted(what: string): void
}

export function pgEvents<const D extends EventsDefinitions = {}>(
  config: EventsConfig<D>,
): Events<D> {
  const { db, define = {} as D } = config
  const schema = config.schema ?? 'pgprime_events'
  quoteIdentPart(schema)
  const sql = statements(schema)
  const hooks = createHooks(config.hooks)
  let ensuring: Promise<{ from: number; to: number }> | undefined
  let ensured = false
  const memo = new Map<string, Promise<void>>()
  const key = (def: TopicDef<any> | SubscriptionDef<any>): string =>
    def.kind === 'topic' ? `t/${def.name}` : `s/${def.topic.name}/${def.name}`

  const migrate = async (apply: boolean): Promise<{ from: number; to: number }> => {
    try {
      const r = await migrateOwnedSchema(db, { schema, migrations: MIGRATIONS, apply })
      if (r.to < MIGRATIONS.length) {
        throw new SchemaVersionError(
          `@pg-prime/events: schema ${schema} is at version ${r.to} and this client needs ` +
            `${MIGRATIONS.length}. Run events.migrate() or vendor ownedSchemaSql's files.`,
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
    sql,
    hooks,
    running: new Set(),
    topicChannel: (topic) => engineChannel(schema, 't', topic),
    ready(def) {
      const k = key(def)
      let p = memo.get(k)
      if (p === undefined) {
        p = (async () => {
          await ensure()
          if (def.kind === 'topic') {
            return sql.upsertTopic(db, def.name, def.keepMs, def.keepUntilConsumed)
          }
          await core.ready(def.topic)
          const c =
            def.from === 'beginning'
              ? BEGINNING
              : await sql.seedNow(db).then((x) => seed(x.xmax, x.xip))
          await sql.upsertSubscription(db, def.topic.name, def.name, def.types, c)
        })()
        p.catch(() => memo.delete(k))
        memo.set(k, p)
      }
      return p
    },
    forget: (def) => void memo.delete(key(def)),
    assertStarted(what) {
      if (!ensured) throw new NotStartedError(what)
    },
  }

  const handles = <V, H>(defs: Readonly<Record<string, V>> | undefined, f: (d: V) => H): never =>
    Object.freeze(
      Object.fromEntries(Object.entries(defs ?? {}).map(([k, d]) => [k, f(d)])),
    ) as never
  const close = async (): Promise<void> => {
    await Promise.all([...core.running].map((r) => r.close()))
  }
  return {
    channels: handles(define.channels, (d) => channelHandle(db, d)),
    topics: handles(define.topics, (d) => topicHandle(core, d)),
    subscriptions: handles(define.subscriptions, (d) => subscriptionHandle(core, d)),
    channel: <T>(def: ChannelDef<T>) => channelHandle(db, def),
    topic: <T>(def: TopicDef<T>) => topicHandle(core, def),
    subscription: <T>(def: SubscriptionDef<T>) => subscriptionHandle(core, def),
    async start() {
      await ensure()
      for (const d of Object.values(define.topics ?? {})) await core.ready(d)
      for (const d of Object.values(define.subscriptions ?? {})) await core.ready(d)
    },
    migrate: async () => {
      const r = await migrate(true)
      ensuring = Promise.resolve(r)
      return r
    },
    observe: (h: EventsHooks) => hooks.observe(h),
    close,
    [ASYNC_DISPOSE]: close,
  } as unknown as Events<D>
}
