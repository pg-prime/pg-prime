/**
 * `isUniqueViolation(e, users.email)` — type-safe, refactor-proof constraint matching (design/07
 * §4.4).
 *
 * The status quo everywhere is `err.constraint === 'users_email_key'`, which breaks silently the
 * moment somebody renames a column and regenerates the constraint name. Passing the *column
 * reference* makes a rename a compile error, and it is available only to a library that owns the
 * schema.
 *
 * Both predicates are deliberately permissive about *how much* you say: with no arguments they
 * are a plain `instanceof`, with a `ConstraintRef` they compare identity, and with column
 * references they require every named column to be part of the violated constraint. The last form
 * is the common one and reads as "was it *this* uniqueness that broke".
 */

import {
  CheckViolationError,
  ForeignKeyViolationError,
  IntegrityConstraintError,
  NotNullViolationError,
  UniqueViolationError,
} from './classes.js'
import type { ColumnRef, ConstraintRef } from './refs.js'

function matches(
  e: IntegrityConstraintError,
  args: readonly (ColumnRef | ConstraintRef)[],
): boolean {
  if (args.length === 0) return true
  const first = args[0]
  if (first !== undefined && isConstraintRef(first)) {
    return e.constraint !== undefined && e.constraint.name === first.name
  }
  const have = e.columns
  if (have === undefined) return false
  for (const a of args) {
    const col = a as ColumnRef
    if (!have.some((c) => c.$.dbName === col.$.dbName && c.$.table === col.$.table)) return false
  }
  return true
}

function isConstraintRef(v: ColumnRef | ConstraintRef): v is ConstraintRef {
  return (
    typeof (v as ConstraintRef).kind === 'string' && typeof (v as ConstraintRef).name === 'string'
  )
}

export function isUniqueViolation(
  e: unknown,
  ...cols: readonly ColumnRef[]
): e is UniqueViolationError
export function isUniqueViolation(e: unknown, constraint: ConstraintRef): e is UniqueViolationError
export function isUniqueViolation(
  e: unknown,
  ...args: readonly (ColumnRef | ConstraintRef)[]
): e is UniqueViolationError {
  return e instanceof UniqueViolationError && matches(e, args)
}

export function isForeignKeyViolation(
  e: unknown,
  ...cols: readonly ColumnRef[]
): e is ForeignKeyViolationError
export function isForeignKeyViolation(e: unknown, fk: ConstraintRef): e is ForeignKeyViolationError
export function isForeignKeyViolation(
  e: unknown,
  ...args: readonly (ColumnRef | ConstraintRef)[]
): e is ForeignKeyViolationError {
  return e instanceof ForeignKeyViolationError && matches(e, args)
}

export function isCheckViolation(
  e: unknown,
  ...cols: readonly ColumnRef[]
): e is CheckViolationError
export function isCheckViolation(e: unknown, constraint: ConstraintRef): e is CheckViolationError
export function isCheckViolation(
  e: unknown,
  ...args: readonly (ColumnRef | ConstraintRef)[]
): e is CheckViolationError {
  return e instanceof CheckViolationError && matches(e, args)
}

export function isNotNullViolation(
  e: unknown,
  ...cols: readonly ColumnRef[]
): e is NotNullViolationError {
  return e instanceof NotNullViolationError && matches(e, cols)
}
