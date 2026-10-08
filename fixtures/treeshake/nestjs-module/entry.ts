// design/19 §8.2: `PgPrimeModule.forRoot` + `@Transactional()`, the package's typical import
// (context included; Nest and rxjs are peers and stay external).
import { PgPrimeModule, Transactional } from '@pg-prime/nestjs'
import type { Db } from 'pg-prime'

export function run(db: Db): unknown {
  const create = { value: async () => 1 }
  Transactional()(create, 'create', create)
  return PgPrimeModule.forRoot({ db, request: { settings: () => ({ 'app.tenant_id': '1' }) } })
}
