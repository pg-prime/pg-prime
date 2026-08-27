import type { Payload } from "../ir/hash.js";

/**
 * The v1-M payload shapes. Every one of these is IDENTITY-FREE — grep for a
 * field holding the fact's own name and you will not find one.
 */

export interface SchemaPayload extends Payload {
  readonly kind: "schema";
}

export interface TablePayload extends Payload {
  readonly kind: "table";
  /** `r` ordinary, `p` partitioned parent */
  readonly relkind: "r" | "p";
  /** `p` permanent, `u` unlogged, `t` temp */
  readonly persistence: string;
  readonly rowSecurity: boolean;
}

/**
 * Stands in for a name PostgreSQL generated from the object's own identity, so the
 * payload can record THAT a name exists without recording the name (I1). Same device as
 * `%ID%` in an index definition: substitute the identity back in and you have the name.
 */
export const GENERATED_NAME = "%GENERATED%";

export interface ColumnPayload extends Payload {
  readonly kind: "column";
  /** `format_type(atttypid, atttypmod)` — always schema-qualified for user types */
  readonly type: string;
  readonly notNull: boolean;
  /**
   * The NOT NULL constraint's name, on servers that have one (design/06 §3.3 AS BUILT).
   *
   * PostgreSQL 18 catalogues NOT NULL as a real `pg_constraint` row (`contype = 'n'`), so
   * for the first time it has a name a user can choose and `pg_dump` can print. Three
   * states, and the difference between them is the whole point:
   *
   *  - `null`   — the server does not catalogue NOT NULL constraints (PG < 18), or the
   *               column is nullable. There is nothing to name, so the same fixture
   *               extracted on 15/16/17 and on 18-with-default-names produces no diff;
   *  - `%GENERATED%` — catalogued under the server's own default,
   *               `defaultNotNullName(table, column)`. Derivable from the id, so it is
   *               not stored: a rename must not perturb the column's hash (I1);
   *  - anything else — the USER named it. That is a real attribute of the schema, it is
   *               carried into `CREATE TABLE`, and a rename leaves it alone.
   *
   * Not modelled: `convalidated` for a `contype = 'n'` row. PG 18 lets you add one
   * `NOT VALID`, and `attnotnull` is set either way, so an unvalidated NOT NULL reads
   * here as an ordinary one. The D10 dump oracle is what would catch that; it is the
   * same Tier-M gap it was before this field existed.
   */
  readonly notNullConstraint: string | null;
  /** `pg_get_expr(adbin, adrelid)` or null */
  readonly default: string | null;
  /** `a` always, `d` by default, null = not an identity column */
  readonly identity: string | null;
  /** `s` stored generated, null = not generated */
  readonly generated: string | null;
  readonly collation: string | null;
}

export interface ConstraintPayload extends Payload {
  readonly kind: "constraint";
  /** p | f | u | c | x */
  readonly contype: string;
  /**
   * `pg_get_constraintdef` with any trailing ` NOT VALID` lifted out into
   * `validated`, so validation state is an orthogonal axis rather than a
   * substring — that is what lets us emit ADD…NOT VALID + VALIDATE and still
   * converge on a plain validated constraint (design/06 §3.5).
   */
  readonly definition: string;
  readonly validated: boolean;
  readonly deferrable: boolean;
}

export interface IndexPayload extends Payload {
  readonly kind: "index";
  /** `pg_get_indexdef` with the index's OWN name replaced by `%ID%` (I1). */
  readonly definition: string;
  readonly unique: boolean;
  readonly valid: boolean;
}

export interface TypePayload extends Payload {
  readonly kind: "type";
  /** `e` enum (the only typtype the spike models) */
  readonly typtype: string;
}

export interface EnumLabelPayload extends Payload {
  /**
   * The discriminator and nothing else. A label's identity IS its text, which
   * lives in the id (I1); its position is `ordinal` (unhashed) and is diffed as
   * an ordered list, so appending a value never perturbs its neighbours' hashes.
   */
  readonly kind: "enumLabel";
}

export interface SequencePayload extends Payload {
  readonly kind: "sequence";
  readonly dataType: string;
  readonly start: string;
  readonly increment: string;
  readonly minValue: string;
  readonly maxValue: string;
  readonly cache: string;
  readonly cycle: boolean;
  /** encoded column StableId, or null */
  readonly ownedBy: string | null;
}

export type AnyPayload =
  | SchemaPayload
  | TablePayload
  | ColumnPayload
  | ConstraintPayload
  | IndexPayload
  | TypePayload
  | EnumLabelPayload
  | SequencePayload;
