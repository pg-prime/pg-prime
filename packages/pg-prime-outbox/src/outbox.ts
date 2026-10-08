import { ConfigError, migrateOwnedSchema, sql } from 'pg-prime'
import type { Queryable } from 'pg-prime'
import { channelOf, hooksOf } from './context.js'
import type { TopicCtx } from './context.js'
import type { OutboxDef } from './define.js'
import { NotStartedError, SchemaVersionError } from './errors.js'
import { startRelay } from './relay/relay.js'
import { DEFAULT_SCHEMA, MIGRATIONS } from './schema.js'
import { createTopic, discard, listParked, replay, setPaused, stats } from './sql/admin.js'
import { writeRecords } from './sql/write.js'
import type { WriteItem } from './sql/write.js'
import type { Outbox, OutboxConfig, OutboxTopic, Relay, WriteResult } from './types.js'

const ASYNC_DISPOSE: symbol =
  (Symbol as { asyncDispose?: symbol }).asyncDispose ?? Symbol.for('Symbol.asyncDispose')
const LATEST = MIGRATIONS.length

export function pgOutbox<const D extends Record<string, OutboxDef<any>> = {}>(
  config: OutboxConfig<D>,
): Outbox<D> {
  const { db, autoMigrate = true } = config
  const schema = config.schema ?? DEFAULT_SCHEMA
  const s = sql.ident(schema)
  const hooks = hooksOf(config.hooks)
  const relays = new Set<Relay>()
  const handles = new Map<OutboxDef<any>, OutboxTopic<any>>()

  const migrate = async (apply: boolean): Promise<{ from: number; to: number }> => {
    try {
      return await migrateOwnedSchema(db, { schema, migrations: MIGRATIONS, apply })
    } catch (e) {
      if (e instanceof ConfigError) throw new SchemaVersionError(e.message, { cause: e })
      throw e
    }
  }

  let ensured: Promise<void> | undefined
  const ensure = (): Promise<void> =>
    (ensured ??= migrate(autoMigrate)
      .then(({ to }) => {
        if (to < LATEST) {
          throw new SchemaVersionError(
            `@pg-prime/outbox: schema ${schema} is at version ${to} and this client needs ` +
              `${LATEST}. Run outbox.migrate(), apply migrationSql(), or set autoMigrate: true.`,
          )
        }
      })
      .catch((e: unknown) => {
        ensured = undefined
        throw e
      }))

  const topic = <T>(def: OutboxDef<T>): OutboxTopic<T> => {
    let h = handles.get(def) as OutboxTopic<T> | undefined
    if (h === undefined) handles.set(def, (h = topicHandle(def)))
    return h
  }

  const topicHandle = <T>(def: OutboxDef<T>): OutboxTopic<T> => {
    const t = def.topic
    let started: Promise<void> | undefined
    let ready = false
    const start = (): Promise<void> =>
      (started ??= (async () => {
        await ensure()
        const partitions = await createTopic(ctx)
        if (partitions !== def.partitions) {
          throw new ConfigError(
            `@pg-prime/outbox: topic ${t} exists with ${partitions} partitions and this ` +
              `declaration says ${def.partitions}. Partitions are immutable; use a new topic.`,
          )
        }
        ready = true
      })().catch((e: unknown) => {
        started = undefined
        throw e
      }))

    const ctx: TopicCtx<T> = {
      db,
      s,
      def,
      chan: channelOf(schema, t),
      hooks,
      start,
      decode: (r) => ({
        id: r['id'] as bigint,
        key: r['key'] as string | null,
        idem: r['idem'] as string,
        payload: def.codec === undefined ? (r['payload'] as T) : def.codec.decode(r['payload']),
        headers: r['headers'] as Record<string, string> | null,
        attempts: r['attempts'] as number,
        createdAt: r['created_at'] as Date,
      }),
    }

    const writeMany = async (
      items: readonly WriteItem<T>[],
      { tx }: { tx: Queryable<any> },
    ): Promise<WriteResult[]> => {
      if (!ready) {
        // Starting inside the caller's transaction would wait for a second pool connection.
        if (tx.kind !== 'db') {
          throw new NotStartedError(
            `@pg-prime/outbox: topic ${t} was written before start(). Call await outbox.start() ` +
              `(or outbox.topic(def).start()) once at boot, outside any transaction.`,
          )
        }
        await start()
      }
      return writeRecords(ctx, items, tx)
    }
    const afterStart = async <R>(f: () => Promise<R>): Promise<R> => {
      await start()
      return f()
    }

    return {
      name: t,
      start,
      write: async (payload, { tx, ...rest }) =>
        (await writeMany([{ payload, ...rest }], { tx }))[0]!,
      writeMany,
      relay(sink, opts = {}) {
        const r = startRelay(ctx, sink, opts, (x) => relays.delete(x))
        relays.add(r)
        return r
      },
      parked: ({ limit = 100, after = 0n } = {}) => afterStart(() => listParked(ctx, limit, after)),
      replay: (ids) => afterStart(() => replay(ctx, ids)),
      discard: (ids) => afterStart(() => discard(ctx, ids)),
      pause: () => afterStart(() => setPaused(ctx, true)),
      resume: () => afterStart(() => setPaused(ctx, false)),
      stats: () => afterStart(() => stats(ctx)),
    }
  }

  const close = async (): Promise<void> => {
    await Promise.all([...relays].map((r) => r.close()))
  }
  const topics = Object.fromEntries(
    Object.entries(config.define ?? {}).map(([k, def]) => [k, topic(def)]),
  )

  return {
    topics,
    topic,
    async start() {
      await ensure()
      await Promise.all(Object.values(topics).map((h) => h.start()))
    },
    migrate: () => migrate(true),
    close,
    [ASYNC_DISPOSE]: close,
  } as unknown as Outbox<D>
}
