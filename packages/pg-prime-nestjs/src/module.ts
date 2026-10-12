import type {
  DynamicModule,
  InjectionToken,
  ModuleMetadata,
  OptionalFactoryDependency,
  Provider,
} from '@nestjs/common'
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core'
import { TransactionHost } from '@pg-prime/context'
import type { Propagation } from '@pg-prime/context'
import { ConfigError, pgPrime } from 'pg-prime'
import type { AnySchema, Db, PgPrimeOptions } from 'pg-prime'
import { RequestInterceptor } from './request.js'
import type { RequestOptions } from './request.js'
import { DEFAULT, getDbToken, getHostToken, optionsToken, register } from './tokens.js'

export interface PgPrimeModuleOptions<Sc extends AnySchema = AnySchema> {
  /** Exactly one of `db` and `config` (passed to `pgPrime`). */
  db?: Db<Sc>
  config?: PgPrimeOptions<Sc>
  /** Default `true`: `db.end()` on application shutdown. */
  end?: boolean
  /** The host's default propagation, `'join'` unless set; `@Transactional({ propagation })` overrides it. */
  propagation?: Propagation
  strict?: boolean
  /** Unset: the interceptor is a pass-through and requests get no scope. */
  request?: RequestOptions
}

export interface PgPrimeModuleAsyncOptions<Sc extends AnySchema = AnySchema> {
  imports?: ModuleMetadata['imports']
  inject?: (InjectionToken | OptionalFactoryDependency)[]
  useFactory(...args: any[]): PgPrimeModuleOptions<Sc> | Promise<PgPrimeModuleOptions<Sc>>
}

export class PgPrimeModule {
  static forRoot<Sc extends AnySchema>(
    opts: PgPrimeModuleOptions<Sc> & { name?: string },
  ): DynamicModule {
    const name = opts.name ?? DEFAULT
    return build(name, { provide: optionsToken(name), useValue: opts })
  }

  static forRootAsync<Sc extends AnySchema>(
    opts: PgPrimeModuleAsyncOptions<Sc> & { name?: string },
  ): DynamicModule {
    const name = opts.name ?? DEFAULT
    const { useFactory, inject = [] } = opts
    return build(name, { provide: optionsToken(name), useFactory, inject }, opts.imports)
  }
}

function build(
  name: string,
  options: Provider,
  imports: ModuleMetadata['imports'] = [],
): DynamicModule {
  const [OPTS, DB, HOST] = [optionsToken(name), getDbToken(name), getHostToken(name)]
  return {
    module: PgPrimeModule,
    global: true,
    imports,
    providers: [
      options,
      {
        provide: DB,
        inject: [OPTS],
        useFactory: (o: PgPrimeModuleOptions) => {
          if (!o.db === !o.config) {
            throw new ConfigError(`PgPrimeModule '${name}': pass exactly one of db and config.`)
          }
          return o.db ?? pgPrime(o.config!)
        },
      },
      {
        provide: HOST,
        inject: [OPTS, DB],
        useFactory: (o: PgPrimeModuleOptions, db: Db) => new TransactionHost(db, o),
      },
      {
        provide: `pg-prime:lifecycle:${name}`,
        inject: [OPTS, DB, HOST],
        useFactory: (o: PgPrimeModuleOptions, db: Db, host: TransactionHost) => {
          const unregister = register(name, host)
          // Runs after every add-on's beforeApplicationShutdown, so relays stop before the pool drains.
          return {
            onApplicationShutdown: async () => {
              unregister()
              if (o.end !== false) await db.end()
            },
          }
        },
      },
      {
        provide: APP_INTERCEPTOR,
        inject: [OPTS, HOST, Reflector],
        useFactory: (o: PgPrimeModuleOptions, host: TransactionHost, r: Reflector) =>
          new RequestInterceptor(host, r, o.request),
      },
    ],
    exports: [DB, HOST],
  }
}
