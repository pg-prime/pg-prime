/**
 * Standalone schema objects the differ already models as Tier-M facts but the DSL could
 * not declare: **domains** (design/05 §3.3), **sequences** (§3.5) and **extensions**
 * (§3.10).
 *
 * They exist here because `pg-prime pull` (design/06 §6.2's twelfth command) has to emit a
 * TypeScript schema that round-trips a database it did not create, and `06` §2.2 puts
 * `type` (enum, domain, composite), `sequence` and `extension` in Tier M — diffed, and
 * therefore *dropped* if the desired state cannot name them. A DSL that cannot say
 * `CREATE DOMAIN` turns every domain in an adopted database into a `DROP DOMAIN` in the
 * first generated migration, which is precisely the "permanent drift" §5.3 exists to
 * prevent.
 *
 * **Everything here is runtime metadata and nothing here is generic.** Each function
 * returns a frozen plain object; not one type parameter is introduced, so the type budget
 * (`bench:types`) cannot move. They are collected by the kit's `loadSchema` off the module's
 * exports, exactly as tables already are, so `defineSchema(...)` does not change either.
 */

import { SchemaError } from '../sql/errors.js'
import { checkName } from './column.js'

/* --------------------------------- domains -------------------------------- */

export interface PgDomainOptions {
  readonly schema?: string
  /** `NOT NULL` on the domain itself. */
  readonly notNull?: boolean
  /** `DEFAULT <expr>`, as DDL text — the server's own spelling is what round-trips. */
  readonly default?: string
  readonly collation?: string
  /**
   * `CONSTRAINT <name> CHECK (<expr>)`, one per entry, as DDL text.
   *
   * Text and not a `sql` fragment: a domain CHECK talks about `VALUE`, which is not a
   * column and has no `Ref` to interpolate, so the fragment tag would buy nothing and
   * cost the caller a `sql` import.
   */
  readonly checks?: readonly { readonly name: string; readonly expression: string }[]
  /** design/05 §5.1's annotation. A carrier; `generate` decides whether it fires. */
  readonly renamedFrom?: string
}

export interface PgDomain {
  readonly kind: 'domain'
  readonly name: string
  /** `format_type`'s spelling of the base type, e.g. `character varying(25)`. */
  readonly baseType: string
  readonly schema: string | undefined
  readonly notNull: boolean
  readonly default: string | undefined
  readonly collation: string | undefined
  readonly checks: readonly { readonly name: string; readonly expression: string }[]
  readonly renamedFrom: string | undefined
}

export function pgDomain(name: string, baseType: string, options?: PgDomainOptions): PgDomain {
  checkName(name, `pgDomain("${name}") type name`)
  if (typeof baseType !== 'string' || baseType.trim() === '') {
    throw new SchemaError(`pg-prime: pgDomain("${name}") needs a base type, e.g. pgDomain('email', 'text').`)
  }
  if (options?.schema !== undefined) checkName(options.schema, `pgDomain("${name}") schema name`)
  if (options?.renamedFrom !== undefined) checkName(options.renamedFrom, `pgDomain("${name}", { renamedFrom })`)
  for (const c of options?.checks ?? []) checkName(c.name, `pgDomain("${name}") check name "${c.name}"`)
  return Object.freeze({
    kind: 'domain' as const,
    name,
    baseType,
    schema: options?.schema,
    notNull: options?.notNull ?? false,
    default: options?.default,
    collation: options?.collation,
    checks: Object.freeze([...(options?.checks ?? [])]),
    renamedFrom: options?.renamedFrom,
  })
}

/* -------------------------------- sequences ------------------------------- */

export interface PgSequenceOptions {
  readonly schema?: string
  /** `AS bigint` — PostgreSQL's own default. */
  readonly dataType?: string
  readonly start?: string
  readonly increment?: string
  readonly minValue?: string
  readonly maxValue?: string
  readonly cache?: string
  readonly cycle?: boolean
  /**
   * `OWNED BY schema.table.column`. A `serial` column is exactly a sequence with this set
   * plus a `DEFAULT nextval(...)`, and without it the sequence survives its table's `DROP`.
   */
  readonly ownedBy?: { readonly schema?: string; readonly table: string; readonly column: string }
  readonly renamedFrom?: string
}

export interface PgSequence {
  readonly kind: 'sequence'
  readonly name: string
  readonly schema: string | undefined
  readonly dataType: string | undefined
  readonly start: string | undefined
  readonly increment: string | undefined
  readonly minValue: string | undefined
  readonly maxValue: string | undefined
  readonly cache: string | undefined
  readonly cycle: boolean
  readonly ownedBy: { readonly schema?: string; readonly table: string; readonly column: string } | undefined
  readonly renamedFrom: string | undefined
}

export function pgSequence(name: string, options?: PgSequenceOptions): PgSequence {
  checkName(name, `pgSequence("${name}") sequence name`)
  if (options?.schema !== undefined) checkName(options.schema, `pgSequence("${name}") schema name`)
  if (options?.renamedFrom !== undefined) checkName(options.renamedFrom, `pgSequence("${name}", { renamedFrom })`)
  if (options?.ownedBy !== undefined) {
    checkName(options.ownedBy.table, `pgSequence("${name}", { ownedBy.table })`)
    checkName(options.ownedBy.column, `pgSequence("${name}", { ownedBy.column })`)
    if (options.ownedBy.schema !== undefined) {
      checkName(options.ownedBy.schema, `pgSequence("${name}", { ownedBy.schema })`)
    }
  }
  return Object.freeze({
    kind: 'sequence' as const,
    name,
    schema: options?.schema,
    dataType: options?.dataType,
    start: options?.start,
    increment: options?.increment,
    minValue: options?.minValue,
    maxValue: options?.maxValue,
    cache: options?.cache,
    cycle: options?.cycle ?? false,
    ownedBy: options?.ownedBy === undefined ? undefined : Object.freeze({ ...options.ownedBy }),
    renamedFrom: options?.renamedFrom,
  })
}

/* ------------------------------- extensions ------------------------------- */

export interface PgExtensionOptions {
  /** `CREATE EXTENSION … SCHEMA <name>`. */
  readonly schema?: string
}

export interface PgExtension {
  readonly kind: 'extension'
  readonly name: string
  readonly schema: string | undefined
}

/**
 * `pgExtension('uuid-ossp')`.
 *
 * Declare-only, exactly as `06` §2.2 has it: created if absent, never dropped, and the
 * version is deliberately not declarable — it is a property of what the DBA installed on
 * the cluster, not of the schema in the repository.
 */
export function pgExtension(name: string, options?: PgExtensionOptions): PgExtension {
  checkName(name, `pgExtension("${name}") extension name`)
  if (options?.schema !== undefined) checkName(options.schema, `pgExtension("${name}") schema name`)
  return Object.freeze({ kind: 'extension' as const, name, schema: options?.schema })
}
