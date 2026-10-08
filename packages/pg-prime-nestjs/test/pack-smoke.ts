// The consumer body tools/pack-smoke.mjs compiles and runs in a project holding only the
// tarballs (plus Nest from the registry), so every import here goes through the published
// export maps.
import 'reflect-metadata'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import * as api from '@pg-prime/nestjs'
import * as testing from '@pg-prime/nestjs/testing'

if (typeof api !== 'object' || typeof testing !== 'object') {
  throw new Error('pack-smoke: @pg-prime/nestjs did not load')
}
class AppModule {}
Module({})(AppModule)
const app = await NestFactory.createApplicationContext(AppModule, { logger: false })
await app.close()
console.log('pack-smoke @pg-prime/nestjs consumer OK')
