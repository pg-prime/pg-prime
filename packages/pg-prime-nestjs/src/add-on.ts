import type { InjectionToken, Provider } from '@nestjs/common'
import type { Db } from 'pg-prime'
import { getDbToken } from './tokens.js'

/**
 * Provides `factory(db)` under `token`, starts it at bootstrap unless `start: false`, and closes it
 * in `beforeApplicationShutdown`, before the module ends the pool.
 */
export function provideAddOn<T extends { start?(): Promise<unknown>; close?(): Promise<unknown> }>(
  token: InjectionToken,
  factory: (db: Db) => T,
  opts: { connection?: string; start?: boolean } = {},
): Provider[] {
  return [
    { provide: token, useFactory: factory, inject: [getDbToken(opts.connection)] },
    {
      provide: Symbol('pg-prime:add-on'),
      inject: [token],
      useFactory: (a: T) => ({
        onApplicationBootstrap: () => (opts.start === false ? undefined : a.start?.()),
        beforeApplicationShutdown: () => a.close?.(),
      }),
    },
  ]
}
