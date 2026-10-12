// design/19 §8.2: a `TransactionHost`, a settings scope and a host transaction, the package's
// typical import.
import { TransactionHost } from '@pg-prime/context'
import type { Db } from 'pg-prime'

export async function run(db: Db): Promise<void> {
  const host = new TransactionHost(db)
  await host.run({ settings: { 'app.tenant_id': '1' } }, () =>
    host.transaction(async () => {
      await host.db.sql`select 1`.execute()
    }),
  )
}
