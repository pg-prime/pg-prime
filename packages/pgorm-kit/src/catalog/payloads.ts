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

export interface ColumnPayload extends Payload {
  readonly kind: "column";
  /** `format_type(atttypid, atttypmod)` — always schema-qualified for user types */
  readonly type: string;
  readonly notNull: boolean;
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
  readonly primary: boolean;
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
