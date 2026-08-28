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
  /** `pg_class.relkind`: `r` ordinary, `p` partitioned parent */
  readonly relkind: "r" | "p";
  /** `pg_class.relpersistence`: `p` permanent, `u` unlogged, `t` temp */
  readonly persistence: string;
  /** `pg_class.relrowsecurity` */
  readonly rowSecurity: boolean;
  /**
   * `pg_partitioned_table.partstrat` — `r` range, `l` list, `h` hash — null when this
   * relation is not a partitioned parent. Kept apart from `relkind` because the two are
   * independently wrong in different ways: `relkind = 'p'` with no strategy is a catalog
   * we failed to read, and a strategy on an `r` is a fact we invented.
   */
  readonly partitionStrategy: string | null;
  /** `pg_get_partkeydef(oid)` — `RANGE (at)` etc., verbatim, without the `PARTITION BY`. */
  readonly partitionKey: string | null;
  /**
   * Encoded `table` StableId of the parent this relation is a partition OF
   * (`pg_inherits.inhparent` where `relispartition`), or null.
   *
   * The parent's NAME therefore appears in a child's payload. That is not an I1
   * violation — I1 forbids a fact's OWN name in its OWN payload — and it is what makes
   * `ATTACH`/`DETACH` a real delta rather than something reconstructed from an edge.
   */
  readonly partitionOf: string | null;
  /** `pg_get_expr(relpartbound, oid)` — `FOR VALUES FROM (…) TO (…)`, verbatim. */
  readonly partitionBound: string | null;
  /**
   * The bare name of the index this table is CLUSTERed on (`pg_index.indisclustered`), or
   * null.
   *
   * It lives on the TABLE rather than on the index because the clustered index is very
   * often a constraint's backing index, and those are not facts of their own (`Q_INDEXES`
   * filters them out) — so an `IndexPayload.clustered` would be invisible for exactly the
   * common case. `pg_dump` emits it as `ALTER TABLE … CLUSTER ON …`, which is how the D10
   * witness found it missing on all 68 of AdventureWorks' tables.
   */
  readonly clusterOn: string | null;
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
   * Whether it is VALIDATED is the orthogonal axis, `notNullValidated` below.
   */
  readonly notNullConstraint: string | null;
  /**
   * `pg_constraint.convalidated` for the `contype = 'n'` row, on servers that have one.
   *
   * PostgreSQL 18 accepts `ADD CONSTRAINT … NOT NULL … NOT VALID`, which sets
   * `attnotnull` *and* leaves `convalidated = false`: existing rows are not checked, new
   * ones are. `attnotnull` alone cannot tell the two apart, so before this field an
   * unvalidated NOT NULL read here as an ordinary one — `06` §3.3 AS BUILT named it as
   * the open gap and the D10 witness is what would have caught it.
   *
   *  - `null`   — the server does not catalogue NOT NULL constraints (PG < 18) or the
   *               column is nullable: there is nothing whose validity to state, and the
   *               same fixture must not diff between 17 and 18;
   *  - `true`   — validated (what `SET NOT NULL` and an inline `NOT NULL` produce);
   *  - `false`  — `NOT VALID`, awaiting `ALTER TABLE … VALIDATE CONSTRAINT`.
   */
  readonly notNullValidated: boolean | null;
  /**
   * The GENERATION expression of a stored generated column — `pg_get_expr(adbin, adrelid)`
   * when `attgenerated <> ''`, else null.
   *
   * An ordinary DEFAULT is NOT here: it is a `default` fact of its own (`05` §7.2), so a
   * default change is not a column change. A generation expression cannot be, because
   * PostgreSQL has no `ALTER COLUMN … SET EXPRESSION` that does not rewrite the table and
   * no way to make a plain column generated at all — it is part of the column's identity
   * in practice, and modelling it separately would produce a delta with no DDL.
   */
  readonly generationExpr: string | null;
  /** `pg_attribute.attidentity`: `a` always, `d` by default, null = not an identity column */
  readonly identity: string | null;
  /** `pg_attribute.attgenerated`: `s` stored, `v` virtual (PG 18), null = not generated */
  readonly generated: string | null;
  /** `pg_collation.collname`, only when it differs from the type's own collation */
  readonly collation: string | null;
}

/**
 * A column DEFAULT, as its own fact (`05` §7.2's `default` kind, `06` §2.2 Tier M).
 *
 * Split out of `ColumnPayload` because `ALTER COLUMN … SET DEFAULT` is a catalog-only
 * write while every other column change is a rewrite or a scan: folding the two together
 * made "the default changed" indistinguishable from "the column changed" at the grain the
 * hazard rules read, and I3 (granularity is one) says sub-entity state gets its own fact.
 */
export interface DefaultPayload extends Payload {
  readonly kind: "default";
  /** `pg_get_expr(pg_attrdef.adbin, adrelid)` — PostgreSQL's own spelling, never ours */
  readonly expression: string;
}

export interface ConstraintPayload extends Payload {
  readonly kind: "constraint";
  /**
   * `pg_constraint.contype`: p primary key | f foreign key | u unique | c check |
   * x exclusion. `n` (PG 18's NOT NULL) is deliberately absent — it belongs to its
   * column, and `ColumnPayload.notNullConstraint` / `notNullValidated` carry it, so a
   * column and "its" constraint can never disagree.
   */
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

/**
 * enum, domain and composite in one kind, discriminated by `typtype`.
 *
 * `05` §7.2 gives `enum`, `domain` and `composite` the same identity tuple
 * (`[schema, name]`) and `stable-id.ts`'s arity table has exactly one entry for that
 * shape, so they share the `type` kind rather than each getting a near-duplicate.
 * `pg_type` itself is organised the same way, which means the extractor asks one
 * question instead of three.
 */
export interface TypePayload extends Payload {
  readonly kind: "type";
  /** `pg_type.typtype`: `e` enum, `d` domain, `c` composite */
  readonly typtype: string;
  /* -------- domains (`typtype = 'd'`); null on every other typtype -------- */
  /** `format_type(typbasetype, typtypmod)` — the base type, schema-qualified */
  readonly baseType: string | null;
  /** `pg_type.typnotnull` */
  readonly notNull: boolean | null;
  /** `pg_get_expr(typdefaultbin, 0)`, else the literal `typdefault`, else null */
  readonly default: string | null;
  /** `pg_collation.collname`, only when it differs from the base type's own collation */
  readonly collation: string | null;
  /**
   * The domain's CHECK constraints, as `<name> <pg_get_constraintdef>` pairs sorted by
   * name. A domain constraint lives in `pg_constraint` keyed by `contypid` rather than
   * `conrelid`, so it cannot be a `constraint` fact — that id says `[schema, table, name]`
   * and a domain is not a table. Names are inside the payload because they are the
   * CHILD's names from the type's vantage point, which is the same asymmetry `rollupOf`
   * already relies on.
   */
  readonly checks: string[] | null;
}

/**
 * An attribute of a composite type. `column` is to `table` as this is to `type`.
 *
 * Its own kind rather than a list on `TypePayload` for I3's reason: a composite's
 * attribute is addressable (`ALTER TYPE … ADD/DROP/ALTER ATTRIBUTE`), so it is a fact.
 */
export interface TypeAttributePayload extends Payload {
  readonly kind: "typeAttribute";
  /** `format_type(atttypid, atttypmod)` */
  readonly type: string;
  readonly collation: string | null;
}

/**
 * `pg_description.description`, as its own fact keyed `[...targetIdentity, 'comment']`
 * (`05` §7.2). Its own fact and not a field on the target because a comment change must
 * not perturb the target's content hash — a `COMMENT ON` is a catalog write with no lock
 * and no rewrite, and folding it in would make every re-worded comment look like an
 * `ALTER TABLE`.
 */
export interface CommentPayload extends Payload {
  readonly kind: "comment";
  readonly text: string;
}

/**
 * `pg_extension`, declare-only (`06` §2.2 Tier M): created if absent, **never dropped**,
 * and its member objects are projected out of every other family through `pg_depend`
 * `deptype = 'e'`.
 *
 * `extversion` is deliberately ABSENT from the payload, and its absence is the design.
 * A version is a property of what the DBA installed on the cluster, not of the schema in
 * the repo; hashing it would make every plan carry `ALTER EXTENSION … UPDATE` (or, worse,
 * a downgrade) the moment two environments patched at different times, and a payload
 * field with no DDL behind it is a delta that can never converge. It is reported through
 * the Tier-O observation instead.
 */
export interface ExtensionPayload extends Payload {
  readonly kind: "extension";
  /** `pg_namespace.nspname` of `extnamespace` — diffed into `ALTER EXTENSION … SET SCHEMA` */
  readonly schema: string;
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
  | DefaultPayload
  | ConstraintPayload
  | IndexPayload
  | TypePayload
  | EnumLabelPayload
  | TypeAttributePayload
  | SequencePayload
  | CommentPayload
  | ExtensionPayload;

/* ------------------------------------------------------------------ */
/* Tier O — observed, never written (design/06 §2.2)                    */
/* ------------------------------------------------------------------ */

/**
 * Cluster-scoped or other-team-owned objects: introspected, reported by `status` and
 * `doctor`, **excluded from the diff and never dropped**.
 *
 * These are NOT facts. A fact is diffed, and the research is unambiguous that grants and
 * roles must never be diff-and-dropped by default. Putting them in `SchemaIR` would also
 * put them in the fingerprint, so granting one SELECT would look like schema drift and
 * refuse every pending migration (`06` §4.3's fingerprint gate). They travel beside the
 * IR on `ExtractResult.observed` instead.
 */
export interface ObservedObject {
  /** one of `06` §2.2's Tier-O kinds: `role`, `acl`, `publication`, `fdw`, … */
  readonly kind: string;
  /** human-addressable identity, e.g. `public.users` or `readonly@public` */
  readonly name: string;
  /** kind-specific, already stringified so a report never has to know the shape */
  readonly detail: string;
}
