// Run by `bun` itself (test/pg/bun-app.test.ts): injection relies on emitted parameter metadata only.
import 'reflect-metadata'
import { Controller, Get, Injectable, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { PgPrimeModule, Transactional, TransactionHost } from '@pg-prime/nestjs'
import { defineSchema, pgPrime } from 'pg-prime'

@Injectable()
class Settings {
  constructor(readonly host: TransactionHost) {}
  @Transactional()
  async tenant() {
    const row = await this.host.db
      .sql`select current_setting('app.tenant_id', true) as t`.executeTakeFirst()
    return { tenant: row!['t'], tx: this.host.inTransaction }
  }
}

@Controller()
class Routes {
  constructor(readonly settings: Settings) {}
  @Get()
  get() {
    return this.settings.tenant()
  }
}

const db = pgPrime({ connection: process.env['PG_PRIME_TEST_URL']!, schema: defineSchema({}) })
const end = db.end.bind(db)
Object.defineProperty(db, 'end', {
  value: async () => {
    await end()
    console.log('db ended')
  },
})

@Module({
  imports: [
    PgPrimeModule.forRoot({
      db,
      request: {
        settings: (ctx) => {
          const t = ctx.switchToHttp().getRequest().headers['x-tenant'] as string | undefined
          return t ? { 'app.tenant_id': t } : undefined
        },
      },
    }),
  ],
  controllers: [Routes],
  providers: [Settings],
})
class App {}

const app = await NestFactory.create(App, { logger: false })
app.enableShutdownHooks()
await app.listen(0, '127.0.0.1')
console.log(`listening ${await app.getUrl()}`)
