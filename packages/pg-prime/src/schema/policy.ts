import { defaultRegistry, unknownCodec } from '../codec/index.js'
import { compileDdlExpr } from '../compile/compiler.js'
import { col, mkNode } from '../compile/nodes.js'
import { SchemaError } from '../sql/errors.js'
import { asExpr } from '../sql/fragment.js'
import type { AnyFragment } from '../sql/fragment.js'
import { quoteIdentPart } from '../sql/ident.js'
import { checkName } from './column.js'
import type { OUT } from './symbols.js'
import type { AnyTable, TableRuntime } from './table.js'

export type PolicyCommand = 'all' | 'select' | 'insert' | 'update' | 'delete'
export type PolicyRole = 'public' | 'current_user' | 'current_role' | 'session_user' | (string & {})
export type PolicyExpr = { readonly [OUT]: boolean | null } | AnyFragment
type Pred<T extends AnyTable> = (t: T['cols']) => PolicyExpr

interface PolicyBase<T extends AnyTable> {
  readonly on: T
  /** Default `'permissive'`. */
  readonly as?: 'permissive' | 'restrictive'
  /** Default `PUBLIC`. */
  readonly to?: readonly PolicyRole[]
}

export type PolicySpec<T extends AnyTable> = PolicyBase<T> &
  (
    | { readonly for?: 'all' | 'update'; readonly using?: Pred<T>; readonly withCheck?: Pred<T> }
    | { readonly for: 'select' | 'delete'; readonly using?: Pred<T>; readonly withCheck?: never }
    | { readonly for: 'insert'; readonly withCheck?: Pred<T>; readonly using?: never }
  )

export interface PolicyRuntime {
  readonly name: string
  readonly table: TableRuntime
  readonly command: PolicyCommand
  readonly permissive: boolean
  readonly roles: readonly string[]
  /**
   * CREATE POLICY text; evaluates the thunks. `schemaOf` maps a declared schema to the emitted one,
   * for the ON table and every typed FROM table.
   */
  ddl(schemaOf: (schema: string | undefined) => string): string
}

export interface Policy<T extends AnyTable> {
  readonly kind: 'policy'
  readonly name: string
  readonly $: PolicyRuntime
  /** Phantom, never present at runtime: ties the policy to its table's type. */
  readonly __table?: T
}

const COMMANDS: readonly PolicyCommand[] = ['all', 'select', 'insert', 'update', 'delete']
const ROLE_KEYWORDS = new Set(['public', 'current_user', 'current_role', 'session_user'])

/** A row-level security policy on `spec.on`, rendered by `migrate generate` into the `sql/` lane. */
export function definePolicy<T extends AnyTable>(name: string, spec: PolicySpec<T>): Policy<T> {
  const what = `definePolicy("${String(name)}")`
  checkName(name, `${what} name`)
  const table = (spec as { on?: Partial<AnyTable> } | null)?.on?.$
  if (table === undefined || !Array.isArray(table.columns) || table.view !== undefined) {
    throw new SchemaError(`pg-prime: ${what} needs \`on\`: a pgTable(...).`)
  }
  const command = spec.for ?? 'all'
  if (!COMMANDS.includes(command)) {
    throw new SchemaError(
      `pg-prime: ${what} \`for\` is ${JSON.stringify(command)}; use one of ${COMMANDS.join(', ')}.`,
    )
  }
  const as = spec.as ?? 'permissive'
  if (as !== 'permissive' && as !== 'restrictive') {
    throw new SchemaError(`pg-prime: ${what} \`as\` must be 'permissive' or 'restrictive'.`)
  }
  const roles = spec.to ?? ['public']
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new SchemaError(`pg-prime: ${what} \`to\` needs at least one role.`)
  }
  roles.forEach((r, i) => {
    checkName(r, `${what} role "${String(r)}"`)
    if (roles.indexOf(r) !== i) throw new SchemaError(`pg-prime: ${what} lists role "${r}" twice.`)
  })
  const { using, withCheck } = spec as { using?: unknown; withCheck?: unknown }
  for (const [key, fn] of [
    ['using', using],
    ['withCheck', withCheck],
  ] as const) {
    if (fn !== undefined && typeof fn !== 'function') {
      throw new SchemaError(`pg-prime: ${what} \`${key}\` must be a function: (t) => expression.`)
    }
  }
  if (using !== undefined && command === 'insert') {
    throw new SchemaError(`pg-prime: ${what} is FOR INSERT, which takes withCheck, not using.`)
  }
  if (withCheck !== undefined && (command === 'select' || command === 'delete')) {
    throw new SchemaError(
      `pg-prime: ${what} is FOR ${command.toUpperCase()}, which takes using, not withCheck.`,
    )
  }

  const render = (fn: unknown, key: string, schemaOf: (schema: string) => string): string => {
    const registry = defaultRegistry()
    const refs: Record<string, unknown> = {}
    for (const c of table.columns) {
      const codec = registry.byName(c.column.ddl.pgType) ?? unknownCodec
      refs[c.key] = mkNode({ ...col(table.name, c.dbName, codec), $: c })
    }
    return compileDdlExpr(
      asExpr((fn as (t: unknown) => AnyFragment)(Object.freeze(refs))),
      `${what} ${key}`,
      { alias: table.name, schemaOf },
    )
  }

  const runtime: PolicyRuntime = Object.freeze({
    name,
    table,
    command,
    permissive: as === 'permissive',
    roles: Object.freeze([...roles]),
    ddl(schemaOf: (schema: string | undefined) => string): string {
      const on = `${quoteIdentPart(schemaOf(table.schema))}.${quoteIdentPart(table.name)}`
      const to = roles.map((r) => (ROLE_KEYWORDS.has(r) ? r.toUpperCase() : quoteIdentPart(r)))
      let out =
        `CREATE POLICY ${quoteIdentPart(name)} ON ${on} AS ${as.toUpperCase()} ` +
        `FOR ${command.toUpperCase()} TO ${to.join(', ')}`
      if (using !== undefined) out += `\n  USING (${render(using, 'using', schemaOf)})`
      if (withCheck !== undefined) {
        out += `\n  WITH CHECK (${render(withCheck, 'withCheck', schemaOf)})`
      }
      return out
    },
  })
  return Object.freeze({ kind: 'policy' as const, name, $: runtime })
}
