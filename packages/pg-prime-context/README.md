# @pg-prime/context

Ambient transactions for pg-prime on `AsyncLocalStorage`: a `TransactionHost` with propagation,
scoped settings for row-level security, and rollback-per-test.

> **Status: pre-alpha.** The API may change before 1.0.

```sh
pnpm add @pg-prime/context
```

```ts
import { TransactionHost } from '@pg-prime/context'
import { pgPrime, setting, uuidCodec } from 'pg-prime'

const tenantId = setting('app.tenant_id', uuidCodec)
const host = new TransactionHost(pgPrime({ connection: process.env.DATABASE_URL!, schema }))

// Per request: every transaction started in the scope sends the settings after BEGIN.
server.use((req, next) => host.run({ settings: tenantId.set(req.auth.tenantId) }, next))

export const createProject = (input: NewProject) =>
  host.transaction(async () => {
    await host.db.insertInto(host.db.h.projects).values(input).execute()
    await audit('project.created') // joins the same transaction
  })
```

- `propagation`: `'join'` (default), `'savepoint'` or `'new'`, per host and per call.
- Strict mode: reading `host.db` in a scope with settings but no transaction throws.
- `@pg-prime/context/testing`: `rollbackScope(host)` runs a whole test in one transaction.

Node ≥ 22.12 and Bun. Docs: [guide](https://pg-prime.dev/guides/ambient-transactions/),
[reference](https://pg-prime.dev/reference/context/).
