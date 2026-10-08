import { Controller, Get, Inject, Injectable, Param, Post, Sse, UseGuards } from '@nestjs/common'
import { startPglite } from '@pg-prime/testing'
import type { PgliteServer } from '@pg-prime/testing'
import { defineSchema, pgPrime } from 'pg-prime'
import type { Db } from 'pg-prime'
import { interval, map } from 'rxjs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PgPrimeModule,
  RequestTransaction,
  Transactional,
  TransactionHost,
  getDbToken,
} from '../../src/index.js'
import type { ContextError, PgPrimeModuleOptions } from '../../src/index.js'
import { rollbackScopeFor } from '../../src/testing.js'
import type { RollbackScope } from '../../src/testing.js'
import { Auth, TENANT, serve, tenantOf, tenantSettings } from '../fixture.js'

const schema = defineSchema({})
let server: PgliteServer
let db: Db
beforeAll(async () => {
  server = await startPglite()
  db = pgPrime({ connection: server.url, schema, poolOptions: { max: 1 }, devGuard: true })
  await db.sql`create table n1_notes (tenant text, title text unique)`.execute()
})
afterAll(async () => {
  await db.end()
  await server.stop()
})

@Injectable()
class Notes {
  constructor(@Inject(TransactionHost) readonly host: TransactionHost) {}
  @Transactional()
  async add(title: string) {
    await this.host.db
      .sql`insert into n1_notes values (current_setting(${TENANT}, true), ${title})`.execute()
  }
  @Transactional()
  async titles() {
    const rows = await this.host.db.sql`select title from n1_notes
      where tenant is not distinct from nullif(current_setting(${TENANT}, true), '') order by title`.execute()
    return rows.map((r) => r['title'])
  }
  @Transactional({ isolation: 'serializable' })
  async serializable() {}
}

@Controller('notes')
@UseGuards(Auth)
class NotesController {
  constructor(
    @Inject(TransactionHost) readonly host: TransactionHost,
    @Inject(Notes) readonly notes: Notes,
  ) {}
  @Get('setting')
  async setting() {
    return { tenant: await tenantOf(this.host.db), tx: this.host.inTransaction }
  }
  @Get('never')
  @RequestTransaction('never')
  async never() {
    const settings = this.host.settings
    try {
      void this.host.db
      return { settings }
    } catch (e) {
      return { settings, code: (e as ContextError).code }
    }
  }
  @Sse('live')
  @RequestTransaction('never')
  live() {
    return interval(1).pipe(map((n) => ({ data: { n } })))
  }
  @Get('serializable')
  async serializable() {
    return {
      code: await this.notes.serializable().then(
        () => null,
        (e: ContextError) => e.code,
      ),
    }
  }
  @Get('meta')
  @Transactional()
  async meta() {
    return { tx: this.host.inTransaction }
  }
  @Get()
  async list() {
    return this.notes.titles()
  }
  @Post(':title')
  async add(@Param('title') title: string) {
    await this.notes.add(title)
    return this.notes.titles()
  }
  @Post(':title/fail')
  async fail(@Param('title') title: string) {
    await this.notes.add(title)
    throw new Error('after the write')
  }
}

@Controller('always')
@RequestTransaction('always')
class AlwaysController {
  constructor(@Inject(TransactionHost) readonly host: TransactionHost) {}
  @Get()
  tx() {
    return { tx: this.host.inTransaction }
  }
  @Get('never')
  @RequestTransaction('never')
  never() {
    return { tx: this.host.inTransaction }
  }
}

const app = (opts: Omit<PgPrimeModuleOptions, 'db'> = { request: { settings: tenantSettings } }) =>
  serve({
    imports: [PgPrimeModule.forRoot({ db, end: false, ...opts })],
    controllers: [NotesController, AlwaysController],
    providers: [Notes],
  })
type App = Awaited<ReturnType<typeof app>>
const STREAM = [0, 1, 2].map((n) => `data: {"n":${n}}`)

/** The first `n` events of an SSE route; then hangs up. */
async function events({ app }: App, path: string, n: number) {
  const ac = new AbortController()
  const res = await fetch((await app.getUrl()) + path, { signal: ac.signal })
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  let text = ''
  while ((text.match(/^data:/gm)?.length ?? 0) < n) {
    const { value, done } = await reader.read()
    if (done) break
    text += value
  }
  ac.abort()
  return text.match(/^data:.*$/gm)!.slice(0, n)
}

describe('lifecycle', () => {
  it('forRootAsync over config boots, and close ends its db', async () => {
    const { app: a, get } = await serve({
      imports: [
        PgPrimeModule.forRootAsync({
          inject: [],
          useFactory: async () => ({
            config: { connection: server.url, schema, poolOptions: { max: 1 } },
          }),
        }),
      ],
      controllers: [NotesController],
      providers: [Notes],
    })
    expect(await get('/notes/setting')).toEqual({ tenant: null, tx: false })
    const end = vi.spyOn(a.get<Db>(getDbToken()), 'end')
    await a.close()
    expect(end).toHaveBeenCalledOnce()
  })
})

describe('request context', () => {
  let s: App
  beforeAll(async () => (s = await app()))
  afterAll(() => s.app.close())
  afterEach(() => db.sql`truncate n1_notes`.execute())

  it("'whenSettings' opens a transaction exactly when the request has settings", async () => {
    expect(await s.get('/notes/setting', 't1')).toEqual({ tenant: 't1', tx: true })
    expect(await s.get('/notes/setting')).toEqual({ tenant: null, tx: false })
  })

  it('the handler mode beats the class mode, which beats the default', async () => {
    expect(await s.get('/always')).toEqual({ tx: true })
    expect(await s.get('/always/never', 't1')).toEqual({ tx: false })
    expect(await s.get('/notes/never', 't1')).toEqual({
      settings: { [TENANT]: 't1' },
      code: 'CONTEXT_UNSCOPED_QUERY',
    })
  })

  it('a global predicate decides where no decorator does', async () => {
    const p = await app({ request: { transaction: (ctx) => ctx.getHandler().name !== 'tx' } })
    expect(await p.get('/notes/setting')).toEqual({ tenant: null, tx: true })
    expect(await p.get('/always')).toEqual({ tx: true })
    expect(await p.get('/always/never')).toEqual({ tx: false })
    await p.app.close()
  })

  it('an error response rolls the request back; @Transactional joins the request transaction', async () => {
    expect(await s.call('/notes/a/fail', 't1', 'POST')).toMatchObject({ status: 500 })
    expect(await s.call('/notes/a', 't1', 'POST')).toEqual({ status: 201, body: ['a'] })
    expect(await s.call('/notes/a', 't1', 'POST')).toEqual({
      status: 409,
      body: { conflict: true },
    })
    expect(await s.get('/notes', 't1')).toEqual(['a'])
  })

  it('a serializable @Transactional inside a request transaction is refused', async () => {
    expect(await s.get('/notes/serializable', 't1')).toEqual({ code: 'CONTEXT_OPTIONS' })
    expect(await s.get('/notes/serializable')).toEqual({ code: null })
  })

  it('@Transactional on a route handler keeps the route', async () => {
    expect(await s.get('/notes/meta')).toEqual({ tx: true })
  })

  it('20 concurrent requests each see only their own settings', async () => {
    const seen = await Promise.all(
      Array.from({ length: 20 }, (_, i) => s.get('/notes/setting', `t${i}`)),
    )
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => ({ tenant: `t${i}`, tx: true })))
  })

  it("a 'never' route streams", async () => {
    expect(await events(s, '/notes/live', 3)).toEqual(STREAM)
  })

  it('is a pass-through without request options, pinned or not', async () => {
    const p = await app({})
    const check = async () => {
      expect(await p.get('/notes/setting', 't1')).toEqual({ tenant: null, tx: false })
      expect(await p.get('/always')).toEqual({ tx: false })
    }
    await check()
    const pin = await rollbackScopeFor(p.app)
    try {
      await check()
    } finally {
      await pin.rollback()
    }
    await p.app.close()
  })
})

describe('rollbackScopeFor', () => {
  let s: App
  let scope: RollbackScope
  beforeAll(async () => (s = await app()))
  afterAll(() => s.app.close())
  beforeEach(async () => (scope = await rollbackScopeFor(s.app)))
  afterEach(() => scope.rollback())

  it('test 1 writes', async () => {
    expect(await s.call('/notes/one', 't1', 'POST')).toEqual({ status: 201, body: ['one'] })
  })

  it("test 2 does not see test 1's write; two tenants stay apart", async () => {
    expect(await s.get('/notes', 't1')).toEqual([])
    await s.call('/notes/a', 't1', 'POST')
    await s.call('/notes/b', 't2', 'POST')
    expect(await s.get('/notes', 't1')).toEqual(['a'])
    expect(await s.get('/notes', 't2')).toEqual(['b'])
    expect(await s.get('/notes/setting')).toEqual({ tenant: null, tx: false })
  })

  it('a 409 constraint error does not break the next request', async () => {
    await s.call('/notes/a', 't1', 'POST')
    expect(await s.call('/notes/a', 't1', 'POST')).toMatchObject({ status: 409 })
    expect(await s.call('/notes/b', 't1', 'POST')).toEqual({ status: 201, body: ['a', 'b'] })
  })

  it("a 'never' route streams, and hanging up ends its request", async () => {
    expect(await events(s, '/notes/live', 3)).toEqual(STREAM)
    await vi.waitFor(async () =>
      expect(await s.call('/notes/a', 't1', 'POST')).toEqual({ status: 201, body: ['a'] }),
    )
  }, 5000)

  it('a second app in the process keeps its own, unpinned host', async () => {
    const other = await app()
    const host = s.app.get(TransactionHost)
    expect(other.app.get(TransactionHost)).not.toBe(host)
    expect([host.pinned, other.app.get(TransactionHost).pinned]).toEqual([true, false])
    expect(other.app.get(Notes).host).toBe(other.app.get(TransactionHost))
    await other.app.close()
  })
})
