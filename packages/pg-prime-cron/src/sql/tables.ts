import { sql } from 'pg-prime'
import type { AnyFragment, Queryable } from 'pg-prime'

export type Q = Queryable<any>

export interface Tables {
  readonly s: AnyFragment
  readonly r: AnyFragment
  readonly m: AnyFragment
  readonly st: AnyFragment
}

export function tables(schema: string): Tables {
  return {
    s: sql.ident(schema, 'schedules'),
    r: sql.ident(schema, 'runs'),
    m: sql.ident(schema, 'meta'),
    st: sql.ident(schema, 'run_state'),
  }
}

export const ms = (n: number): AnyFragment => sql`(${n}::float8 * interval '1 ms')`

export const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v))

export const OPEN: AnyFragment = sql.unsafeRaw(`('pending', 'running', 'cancelling')`)
