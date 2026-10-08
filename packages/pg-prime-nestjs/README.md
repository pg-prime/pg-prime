# @pg-prime/nestjs

A NestJS module for pg-prime: the configured `Db`, an ambient `TransactionHost`, `@Transactional()`,
request settings for row-level security, add-on lifecycle and rollback-per-test.

> **Status: pre-alpha.** The API may change.

```sh
pnpm add pg-prime @pg-prime/nestjs
```

```ts
@Module({
  imports: [
    PgPrimeModule.forRoot({
      config: { connection: process.env.DATABASE_URL!, schema },
      request: { settings: (ctx) => tenantId.set(ctx.switchToHttp().getRequest().auth.tenant) },
    }),
  ],
})
export class AppModule {}

@Injectable()
export class Projects {
  constructor(private readonly host: TransactionHost<typeof schema>) {}

  @Transactional()
  async create(name: string) {
    return this.host.db.insertInto(this.host.db.h.projects).values({ name }).execute()
  }
}
```

Peers: `@nestjs/common` and `@nestjs/core` 11 or 12, `rxjs` 7.8. Node ≥ 22.12 and Bun. Docs:
[guide](https://pg-prime.dev/guides/nestjs/), [reference](https://pg-prime.dev/reference/nestjs/).
