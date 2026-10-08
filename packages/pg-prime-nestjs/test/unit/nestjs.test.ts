import 'reflect-metadata'
import { Controller, Get, Inject, Injectable, Module } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { NestFactory, Reflector } from '@nestjs/core'
import { createMockPool } from '@pg-prime/testing'
import { ConfigError, defineSchema, pgPrime } from 'pg-prime'
import type { Db } from 'pg-prime'
import { firstValueFrom, of } from 'rxjs'
import { describe, expect, it, vi } from 'vitest'
import {
  ContextError,
  InjectDb,
  PgPrimeModule,
  RequestTransaction,
  Transactional,
  TransactionHost,
  getDbToken,
  getHostToken,
  provideAddOn,
} from '../../src/index.js'
import { RequestInterceptor } from '../../src/request.js'
import { rollbackScopeFor } from '../../src/testing.js'

const schema = defineSchema({})
const mockDb = () => {
  const pool = createMockPool()
  const db = pgPrime({ pool, schema })
  const end = vi.spyOn(db, 'end')
  return { pool, db, ended: () => end.mock.calls.length > 0 }
}
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: unknown) => (e instanceof ContextError ? e.code : e),
  )

@Injectable()
class Inner {
  constructor(@Inject(TransactionHost) readonly host: TransactionHost) {}
  @Transactional()
  async run() {
    return this.host.tx()
  }
  @Transactional({ propagation: 'savepoint' })
  async nested() {
    return this.host.tx()
  }
}

@Injectable()
class Outer {
  constructor(
    @Inject(TransactionHost) readonly host: TransactionHost,
    @Inject(Inner) readonly inner: Inner,
  ) {}
  @Transactional()
  async both() {
    return [this.host.tx(), await this.inner.run(), await this.inner.nested()]
  }
}

async function boot(
  opts: Parameters<typeof PgPrimeModule.forRoot>[0],
  providers: any[] = [Inner, Outer],
) {
  class App {}
  Module({ imports: [PgPrimeModule.forRoot(opts)], providers })(App)
  return NestFactory.createApplicationContext(App, { logger: false, abortOnError: false })
}

describe('module', () => {
  it('provides the db and the host, and ends the db on close', async () => {
    const { db, ended } = mockDb()
    const app = await boot({ db })
    expect(app.get(getDbToken())).toBe(db)
    expect(app.get(getHostToken())).toBe(app.get(TransactionHost))
    expect(app.get(TransactionHost).root).toBe(db)
    await app.close()
    expect(ended()).toBe(true)
  })

  it('end: false leaves the db open', async () => {
    const { db, ended } = mockDb()
    await (await boot({ db, end: false })).close()
    expect(ended()).toBe(false)
  })

  it('refuses both or neither of db and config', async () => {
    const { db } = mockDb()
    await expect(boot({})).rejects.toThrow(ConfigError)
    await expect(boot({ db, config: { pool: createMockPool(), schema } })).rejects.toThrow(
      ConfigError,
    )
  })

  it('forRootAsync injects from an imported module; a named connection has its own tokens', async () => {
    const { db } = mockDb()
    const other = mockDb()
    class Conf {}
    Module({ providers: [{ provide: 'DB', useValue: db }], exports: ['DB'] })(Conf)
    @Injectable()
    class UsesB {
      constructor(@InjectDb('b') readonly db: Db) {}
    }
    class App {}
    Module({
      imports: [
        PgPrimeModule.forRootAsync({
          imports: [Conf],
          inject: ['DB'],
          useFactory: (d: Db) => ({ db: d }),
        }),
        PgPrimeModule.forRoot({ name: 'b', db: other.db }),
      ],
      providers: [UsesB],
    })(App)
    const app = await NestFactory.createApplicationContext(App, {
      logger: false,
      abortOnError: false,
    })
    expect(app.get(TransactionHost).root).toBe(db)
    expect(app.get<TransactionHost>(getHostToken('b')).root).toBe(other.db)
    expect(app.get(UsesB).db).toBe(other.db)
    await app.close()
    expect(other.ended()).toBe(true)
  })

  it('provideAddOn starts at bootstrap and closes before the db ends', async () => {
    const { db, ended } = mockDb()
    const order: string[] = []
    const addOn = (d: Db) => ({
      d,
      start: async () => void order.push('start'),
      close: async () => void order.push(`close, ended=${ended()}`),
    })
    const app = await boot({ db }, [
      Inner,
      ...provideAddOn('ADD_ON', addOn),
      ...provideAddOn('IDLE', () => ({ start: async () => void order.push('idle start') }), {
        start: false,
      }),
    ])
    expect(app.get<{ d: Db }>('ADD_ON').d).toBe(db)
    expect(order).toEqual(['start'])
    await app.close()
    expect(order).toEqual(['start', 'close, ended=false'])
    expect(ended()).toBe(true)
  })
})

describe('@Transactional', () => {
  it('joins by default, a per-call savepoint nests, and the label is Class.method', async () => {
    const pool = createMockPool()
    const labels: unknown[] = []
    const db = pgPrime({
      pool,
      schema,
      hooks: { onTransactionStart: (e) => void labels.push(e.label) },
    })
    const app = await boot({ db })
    const [outer, joined, nested] = await app.get(Outer).both()
    expect(joined).toBe(outer)
    expect(nested).not.toBe(outer)
    expect(pool.texts).toEqual([
      'begin',
      'savepoint "pgprime_sp_1"',
      'release savepoint "pgprime_sp_1"',
      'commit',
    ])
    expect(labels).toEqual(['Outer.both'])
    await app.close()
  })

  it('the module propagation is the default', async () => {
    const { pool, db } = mockDb()
    const app = await boot({ db, propagation: 'savepoint' })
    await app.get(Outer).both()
    expect(pool.texts.filter((t) => t.startsWith('savepoint'))).toHaveLength(2)
    await app.close()
  })

  it('keeps route metadata and the method name on either side of the route decorator', () => {
    @Controller('x')
    class C {
      @Get('a')
      @Transactional()
      async a() {}
      @Transactional()
      @Get('b')
      async b() {}
    }
    expect(Reflect.getMetadata('path', C.prototype.a)).toBe('a')
    expect(Reflect.getMetadata('path', C.prototype.b)).toBe('b')
    expect(C.prototype.a.name).toBe('a')
  })

  it("uses the instance's own host, else the registry; none or two live → loud", async () => {
    class Plain {
      @Transactional()
      async run() {
        return 1
      }
    }
    expect(await code(new Plain().run())).toBe('CONTEXT_NOT_REGISTERED')
    const [pa, pb] = [mockDb(), mockDb()]
    const a = await boot({ db: pa.db })
    expect(await new Plain().run()).toBe(1)
    const b = await boot({ db: pb.db })
    expect(await code(new Plain().run())).toBe('CONTEXT_DUPLICATE_HOST')
    pa.pool.reset()
    await b.get(Outer).both()
    expect(pa.pool.texts).toEqual([])
    expect(pb.pool.texts).toContain('begin')
    await b.close()
    expect(await new Plain().run()).toBe(1)
    await a.close()
    expect(await code(new Plain().run())).toBe('CONTEXT_NOT_REGISTERED')
  })

  it('a named connection resolves its own host', async () => {
    const { pool, db } = mockDb()
    class Named {
      @Transactional({ connection: 'b' })
      async run() {}
    }
    const app = await boot({ name: 'b', db }, [])
    await new Named().run()
    expect(pool.texts).toEqual(['begin', 'commit'])
    await app.close()
  })
})

class Routes {
  plain() {}
  @RequestTransaction('never')
  never() {}
  @RequestTransaction('always')
  always() {}
}
@RequestTransaction('always')
class AlwaysRoutes {
  plain() {}
  @RequestTransaction('never')
  never() {}
}

const ctxOf = (cls: any, handler: string, type = 'http', data: unknown = {}) =>
  ({
    getType: () => type,
    getClass: () => cls,
    getHandler: () => cls.prototype[handler],
    switchToRpc: () => ({ getData: () => data }),
  }) as unknown as ExecutionContext

describe('request interceptor', () => {
  const setup = (request?: ConstructorParameters<typeof RequestInterceptor>[2]) => {
    const { pool, db } = mockDb()
    const host = new TransactionHost(db)
    const probe = () => of({ tx: host.inTransaction, settings: host.settings })
    const run = (cls: any, handler: string, type?: string, data?: unknown) =>
      firstValueFrom(
        new RequestInterceptor(host, new Reflector(), request).intercept(
          ctxOf(cls, handler, type, data),
          {
            handle: probe,
          },
        ),
      ) as Promise<{ tx: boolean; settings: object }>
    return { pool, host, run }
  }

  it('is a pass-through without request options', () => {
    const { host } = setup()
    const handled = of(1)
    expect(
      new RequestInterceptor(host, new Reflector(), undefined).intercept(ctxOf(Routes, 'plain'), {
        handle: () => handled,
      }),
    ).toBe(handled)
  })

  it("'whenSettings' opens a transaction exactly when settings exist", async () => {
    let settings: Record<string, string> | undefined = { 'app.tenant_id': 't1' }
    const { pool, run } = setup({ settings: () => settings })
    expect(await run(Routes, 'plain')).toEqual({ tx: true, settings: { 'app.tenant_id': 't1' } })
    settings = undefined
    expect(await run(Routes, 'plain')).toEqual({ tx: false, settings: {} })
    expect(pool.texts).toEqual(['begin', 'select set_config($1,$2,true)', 'commit'])
  })

  it('precedence: handler > class > global predicate > default', async () => {
    const { run } = setup({ transaction: async (ctx) => ctx.getHandler().name === 'plain' })
    expect((await run(Routes, 'plain')).tx).toBe(true)
    expect((await run(Routes, 'never')).tx).toBe(false)
    expect((await run(AlwaysRoutes, 'plain')).tx).toBe(true)
    expect((await run(AlwaysRoutes, 'never')).tx).toBe(false)
    const dflt = setup({})
    expect((await dflt.run(Routes, 'plain')).tx).toBe(false)
    expect((await dflt.run(Routes, 'always')).tx).toBe(true)
  })

  it('scopes RPC handlers from their payload', async () => {
    const { run } = setup({
      settings: (ctx) =>
        ctx.getType() === 'rpc'
          ? { 'app.tenant_id': (ctx.switchToRpc().getData() as { t: string }).t }
          : undefined,
    })
    expect(await run(Routes, 'plain', 'rpc', { t: 'r1' })).toEqual({
      tx: true,
      settings: { 'app.tenant_id': 'r1' },
    })
  })

  it('a request transaction is labelled Class.handler', async () => {
    const labels: unknown[] = []
    const db = pgPrime({
      pool: createMockPool(),
      schema,
      hooks: { onTransactionStart: (e) => void labels.push(e.label) },
    })
    const i = new RequestInterceptor(new TransactionHost(db), new Reflector(), {
      transaction: 'always',
    })
    await firstValueFrom(i.intercept(ctxOf(Routes, 'plain'), { handle: () => of(1) }))
    expect(labels).toEqual(['Routes.plain'])
  })
})

describe('rollbackScopeFor', () => {
  it('pins the host of the app, or of a named connection', async () => {
    const app = await boot({ db: mockDb().db })
    const named = await boot({ name: 'b', db: mockDb().db }, [])
    const scope = await rollbackScopeFor(app)
    const b = await rollbackScopeFor(named, 'b')
    expect(app.get(TransactionHost).pinned).toBe(true)
    expect(named.get<TransactionHost>(getHostToken('b')).pinned).toBe(true)
    await scope.rollback()
    await b.rollback()
    expect(app.get(TransactionHost).pinned).toBe(false)
    await app.close()
    await named.close()
  })
})
