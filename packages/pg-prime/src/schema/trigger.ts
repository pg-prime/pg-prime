import { SchemaError } from '../sql/errors.js'
import { checkName } from './column.js'
import type { TableExtra } from './extras.js'
import type { AnyRef } from './ref.js'
import type { META } from './symbols.js'

/** BEFORE UPDATE … FOR EACH ROW: `NEW.<col> := now()`. */
export function updatedAtTrigger(
  column: AnyRef & { readonly [META]: { readonly pg: 'timestamptz' | 'timestamp' } },
): TableExtra {
  const rt = (column as Partial<AnyRef> | null)?.$
  const pgType = rt?.column.ddl.pgType
  if (rt === undefined || (pgType !== 'timestamptz' && pgType !== 'timestamp')) {
    throw new SchemaError(
      `pg-prime: updatedAtTrigger() needs a timestamptz or timestamp column; got ${pgType ?? 'something that is not a column'}.`,
    )
  }
  checkName(`pgprime_set_${rt.dbName}`, `updatedAtTrigger(${rt.key}) trigger name`)
  return { node: 'updatedAtTrigger', column: rt.dbName }
}
