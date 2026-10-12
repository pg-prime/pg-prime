// The consumer body tools/pack-smoke.mjs compiles and runs in a project holding only the
// tarballs (plus Nest from the registry), so every import here goes through the published
// export maps. Decorators are applied in call form: the consumer has no decorator config.
import 'reflect-metadata'
import { Inject, Injectable, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { PgPrimeModule, Transactional, TransactionHost, getDbToken } from '@pg-prime/nestjs'
import { rollbackScopeFor } from '@pg-prime/nestjs/testing'
import { createMockPool } from '@pg-prime/testing'
import { defineSchema, pgPrime } from 'pg-prime'

class Service {
  constructor(readonly host: TransactionHost) {}
  async run() {
    return this.host.tx()
  }
}
Inject(TransactionHost)(Service, undefined, 0)
Injectable()(Service)
const run = Object.getOwnPropertyDescriptor(Service.prototype, 'run')!
Transactional()(Service.prototype, 'run', run)
Object.defineProperty(Service.prototype, 'run', run)

const pool = createMockPool()
const db = pgPrime({ pool, schema: defineSchema({}) })
class App {}
Module({ imports: [PgPrimeModule.forRoot({ db })], providers: [Service] })(App)

const app = await NestFactory.createApplicationContext(App, { logger: false })
await app.get(Service).run()
const provided = app.get(getDbToken())
const scope = await rollbackScopeFor(app)
await scope.rollback()
await app.close()
const texts = JSON.stringify(pool.texts)
const expected = ['begin', 'commit', 'begin', 'select set_config($1,$2,true)', 'rollback']
if (provided !== db || texts !== JSON.stringify(expected)) {
  throw new Error(`pack-smoke: unexpected statements ${texts}`)
}
console.log('pack-smoke @pg-prime/nestjs consumer OK')
