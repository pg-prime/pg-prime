import {
  CATALOG_PROVENANCE,
  SchemaIR,
  type DependencyEdge,
  type Fact,
  type Provenance,
} from "../ir/fact.js";
import { commentId, encodeId, type StableId } from "../ir/stable-id.js";
import { defaultNotNullName, quoteQualified } from "../sql/ident.js";
import { GENERATED_NAME } from "./payloads.js";
import type {
  ColumnPayload,
  CommentPayload,
  ConstraintPayload,
  DefaultPayload,
  EnumLabelPayload,
  ExtensionPayload,
  IndexPayload,
  ObservedObject,
  SchemaPayload,
  SequencePayload,
  TablePayload,
  TypeAttributePayload,
  TypePayload,
} from "./payloads.js";

export interface CatalogClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly subject?: string;
  /** structured population count, for census diagnostics (`unmodeled_kind`) */
  readonly count?: number;
}

export interface ExtractResult {
  readonly ir: SchemaIR;
  readonly pgVersionNum: number;
  readonly diagnostics: readonly Diagnostic[];
  /**
   * Tier O (design/06 §2.2): roles, memberships, ACLs, default privileges, publications,
   * subscriptions, FDW/servers/user mappings/foreign tables, event triggers, collations
   * and aggregates. Introspected and reported, **never diffed and never dropped** — which
   * is why they sit here rather than in `ir`: a fact is diffed, and a fact is hashed into
   * the fingerprint, so a `GRANT` would otherwise read as schema drift.
   */
  readonly observed: readonly ObservedObject[];
}

export interface ExtractOptions {
  readonly schemas?: readonly string[];
  readonly provenance?: Provenance;
  readonly statementTimeout?: string;
  /**
   * Skip the Tier-O sweep (16 extra round trips). The shadow-clone proof re-extracts
   * twice per plan and does not look at observation, so it turns this off.
   */
  readonly observe?: boolean;
}

/* ------------------------------------------------------------------ */
/* pg_catalog only. `information_schema` is never queried (design §3.1) */
/* ------------------------------------------------------------------ */

const Q_SCHEMAS = `
SELECT n.nspname AS schema
FROM pg_namespace n
WHERE n.nspname = ANY($1)`;

/**
 * Relations no Tier-M family may emit a fact for.
 *
 * Applied to EVERY family, not just `pg_class`: excluding an extension's table while
 * still emitting its columns and indexes leaves orphan facts, and an orphan column
 * diffs into `ALTER TABLE … ADD COLUMN` on a table the plan never creates.
 *
 *  - `deptype = 'e'`  — owned by an extension (declare-only, design/06 §2.2).
 *  - classic table INHERITANCE (`CREATE TABLE … INHERITS (…)`) — still unmodelled, and
 *    still excluded at BOTH ends of the `pg_inherits` edge, because every DDL on a
 *    parent cascades to children the IR cannot see. Distinguished from partitioning by
 *    the child's `relispartition`: a partition's `pg_inherits` row is not inheritance.
 *
 * Partitioning is NO LONGER excluded — `relkind = 'p'` parents and `relispartition`
 * children are ordinary `table` facts carrying `partitionStrategy` / `partitionKey` /
 * `partitionOf` / `partitionBound` (design/06 §2.2 Tier M, "incl. partitioned parents &
 * partitions").
 */
const EXCLUDED_RELS = `
  SELECT x.oid FROM pg_class x
  WHERE EXISTS (SELECT 1 FROM pg_depend d
                WHERE d.classid = 'pg_class'::regclass AND d.objid = x.oid AND d.deptype = 'e')
     OR EXISTS (SELECT 1 FROM pg_inherits i
                JOIN pg_class ch ON ch.oid = i.inhrelid
                WHERE (i.inhrelid = x.oid OR i.inhparent = x.oid) AND NOT ch.relispartition)`;

const Q_TABLES = `
SELECT n.nspname AS schema, c.relname AS name, c.relkind, c.relpersistence, c.relrowsecurity,
       pt.partstrat,
       CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partition_key,
       pn.nspname AS parent_schema, pc.relname AS parent_name,
       CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END AS partition_bound
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_partitioned_table pt ON pt.partrelid = c.oid
LEFT JOIN pg_inherits inh ON inh.inhrelid = c.oid AND c.relispartition
LEFT JOIN pg_class pc ON pc.oid = inh.inhparent
LEFT JOIN pg_namespace pn ON pn.oid = pc.relnamespace
WHERE c.relkind IN ('r','p') AND n.nspname = ANY($1)
  AND c.oid NOT IN (${EXCLUDED_RELS})`;

/** Tier-M gaps that must never converge silently (design/06 §2.2 completeness rule). */
const Q_INHERITANCE = `
SELECT n.nspname AS schema, c.relname AS name,
       CASE WHEN EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
            THEN 'inheritanceChild' ELSE 'inheritanceParent' END AS kind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p')
  AND EXISTS (SELECT 1 FROM pg_inherits i
              JOIN pg_class ch ON ch.oid = i.inhrelid
              WHERE (i.inhrelid = c.oid OR i.inhparent = c.oid) AND NOT ch.relispartition)
ORDER BY n.nspname, c.relname`;

/**
 * The `nn` join is the PostgreSQL 18 NOT NULL constraint (`contype = 'n'`), joined on
 * `conkey = array[attnum]` exactly as `pg_dump` 18's own `getTableAttrs` does.
 *
 * It needs no version gate: on PG < 18 no row has `contype = 'n'`, so the LEFT JOIN
 * yields NULL and the IR records "not catalogued" — which is the truth on those servers,
 * and is why the same fixture diffs clean on 15/16/17 and on 18. Gating on the CATALOG
 * rather than on `server_version_num` also means a server that back-ports the feature is
 * handled without a version table.
 */
const Q_COLUMNS = `
SELECT n.nspname AS schema, c.relname AS "table", a.attname AS name, a.attnum,
       format_type(a.atttypid, a.atttypmod) AS type,
       a.attnotnull AS not_null,
       nn.conname AS not_null_constraint,
       nn.convalidated AS not_null_validated,
       pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
       nullif(a.attidentity, '') AS identity,
       nullif(a.attgenerated, '') AS generated,
       CASE WHEN a.attcollation <> t.typcollation AND a.attcollation <> 0
            THEN coll.collname ELSE NULL END AS collation,
       ut.typtype AS type_typtype,
       un.nspname AS type_schema,
       ut.typname AS type_name
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
LEFT JOIN pg_type ut ON ut.oid = a.atttypid
LEFT JOIN pg_namespace un ON un.oid = ut.typnamespace
LEFT JOIN pg_collation coll ON coll.oid = a.attcollation
LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
LEFT JOIN pg_constraint nn ON nn.conrelid = a.attrelid
                          AND nn.contype = 'n' AND nn.conkey = array[a.attnum]
WHERE a.attnum > 0 AND NOT a.attisdropped
  AND c.relkind IN ('r','p') AND n.nspname = ANY($1)
  AND c.oid NOT IN (${EXCLUDED_RELS})
ORDER BY n.nspname, c.relname, a.attnum`;

const Q_CONSTRAINTS = `
SELECT n.nspname AS schema, c.relname AS "table", con.conname AS name,
       con.contype, con.convalidated, con.condeferrable,
       pg_get_constraintdef(con.oid, false) AS definition,
       rn.nspname AS ref_schema, rc.relname AS ref_table
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_class rc ON rc.oid = con.confrelid
LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
WHERE n.nspname = ANY($1) AND con.contype IN ('p','f','u','c','x')
  AND con.coninhcount = 0
  AND c.oid NOT IN (${EXCLUDED_RELS})
  AND NOT EXISTS (SELECT 1 FROM pg_depend d
                  WHERE d.classid = 'pg_constraint'::regclass AND d.objid = con.oid AND d.deptype = 'e')`;

/**
 * Constraint-backing indexes are implied by their constraint and are never their own fact.
 *
 * Neither is a partition's copy of a parent's index: `CREATE INDEX ON <partitioned>`
 * makes one index per partition and records the relationship in `pg_inherits`, so
 * emitting them as facts would plan a `CREATE INDEX` PostgreSQL creates for us — and
 * name differently. The parent index (`relkind = 'I'`) is the fact; the children ride
 * along, exactly as they do for a human writing the same DDL.
 */
const Q_INDEXES = `
SELECT n.nspname AS schema, ic.relname AS name, c.relname AS "table",
       pg_get_indexdef(i.indexrelid) AS definition,
       i.indisunique AS unique, i.indisvalid AS valid
FROM pg_index i
JOIN pg_class ic ON ic.oid = i.indexrelid
JOIN pg_class c ON c.oid = i.indrelid
JOIN pg_namespace n ON n.oid = ic.relnamespace
WHERE n.nspname = ANY($1)
  AND c.oid NOT IN (${EXCLUDED_RELS})
  AND ic.oid NOT IN (${EXCLUDED_RELS})
  AND NOT EXISTS (SELECT 1 FROM pg_inherits pi WHERE pi.inhrelid = i.indexrelid)
  AND NOT EXISTS (SELECT 1 FROM pg_constraint con
                  WHERE con.conindid = i.indexrelid AND con.contype IN ('p','u','x'))`;

/**
 * enum + domain + composite in one query (design/06 §2.2 Tier M: "type (enum, domain,
 * composite)"). A composite is filtered to STANDALONE ones: every table, view and
 * sequence also owns a `typtype = 'c'` row, and emitting those would give each table a
 * phantom twin whose `CREATE TYPE` PostgreSQL rejects.
 */
const Q_TYPES = `
SELECT n.nspname AS schema, t.typname AS name, t.typtype,
       CASE WHEN t.typtype = 'd' THEN format_type(t.typbasetype, t.typtypmod) END AS base_type,
       CASE WHEN t.typtype = 'd' THEN t.typnotnull END AS not_null,
       CASE WHEN t.typtype = 'd'
            THEN coalesce(pg_get_expr(t.typdefaultbin, 0), quote_literal(t.typdefault)) END AS default_expr,
       CASE WHEN t.typtype = 'd' AND t.typcollation <> 0
              AND t.typcollation <> (SELECT bt.typcollation FROM pg_type bt WHERE bt.oid = t.typbasetype)
            THEN (SELECT coll.collname FROM pg_collation coll WHERE coll.oid = t.typcollation) END AS collation
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = ANY($1)
  AND (t.typtype IN ('e','d')
       OR (t.typtype = 'c'
           AND EXISTS (SELECT 1 FROM pg_class rc WHERE rc.oid = t.typrelid AND rc.relkind = 'c')))
  AND NOT EXISTS (SELECT 1 FROM pg_depend d
                  WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')`;

/**
 * A domain's CHECK constraints. Keyed by `contypid`, not `conrelid` — which is precisely
 * why they cannot be `constraint` facts: that id reads `[schema, table, name]` and a
 * domain is not a table.
 */
const Q_DOMAIN_CHECKS = `
SELECT n.nspname AS schema, t.typname AS type, con.conname AS name,
       pg_get_constraintdef(con.oid, false) AS definition
FROM pg_constraint con
JOIN pg_type t ON t.oid = con.contypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE con.contype = 'c' AND n.nspname = ANY($1)
ORDER BY n.nspname, t.typname, con.conname`;

/** Attributes of a standalone composite type — `pg_attribute` over `typrelid`. */
const Q_TYPE_ATTRIBUTES = `
SELECT n.nspname AS schema, t.typname AS type, a.attname AS name, a.attnum,
       format_type(a.atttypid, a.atttypmod) AS type_name,
       CASE WHEN a.attcollation <> at.typcollation AND a.attcollation <> 0
            THEN coll.collname END AS collation
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
JOIN pg_class rc ON rc.oid = t.typrelid AND rc.relkind = 'c'
JOIN pg_attribute a ON a.attrelid = rc.oid AND a.attnum > 0 AND NOT a.attisdropped
JOIN pg_type at ON at.oid = a.atttypid
LEFT JOIN pg_collation coll ON coll.oid = a.attcollation
WHERE t.typtype = 'c' AND n.nspname = ANY($1)
ORDER BY n.nspname, t.typname, a.attnum`;

/**
 * `pg_extension`, declare-only. Restricted to the managed schemas so `plpgsql` — which
 * lives in `pg_catalog` and exists in every database ever created — never becomes a
 * delta, while `CREATE EXTENSION hstore` (which lands in `public` by default) does.
 */
const Q_EXTENSIONS = `
SELECT e.extname AS name, n.nspname AS schema, e.extversion AS version
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE n.nspname = ANY($1)`;

/**
 * `pg_description`, for every Tier-M object class that can carry one.
 *
 * One UNION rather than a join per family, because the target's identity is the only
 * thing that differs and a `comment` fact is keyed by exactly that (`05` §7.2). `objsubid`
 * splits `pg_class` into the relation itself (0) and its columns (> 0); an index's and a
 * sequence's comments arrive through the same `pg_class` rows, discriminated by relkind.
 */
const Q_COMMENTS = `
  SELECT 'schema' AS target, n.nspname AS schema, '' AS name1, '' AS name2, d.description
  FROM pg_description d JOIN pg_namespace n ON n.oid = d.objoid
  WHERE d.classoid = 'pg_namespace'::regclass AND n.nspname = ANY($1)
UNION ALL
  SELECT CASE c.relkind WHEN 'S' THEN 'sequence' WHEN 'i' THEN 'index' WHEN 'I' THEN 'index'
                        ELSE 'table' END,
         n.nspname, c.relname, '', d.description
  FROM pg_description d JOIN pg_class c ON c.oid = d.objoid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE d.classoid = 'pg_class'::regclass AND d.objsubid = 0 AND n.nspname = ANY($1)
    AND c.relkind IN ('r','p','S','i','I')
    AND c.oid NOT IN (${EXCLUDED_RELS})
UNION ALL
  SELECT 'column', n.nspname, c.relname, a.attname, d.description
  FROM pg_description d JOIN pg_class c ON c.oid = d.objoid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid AND NOT a.attisdropped
  WHERE d.classoid = 'pg_class'::regclass AND d.objsubid > 0 AND n.nspname = ANY($1)
    AND c.relkind IN ('r','p') AND c.oid NOT IN (${EXCLUDED_RELS})
UNION ALL
  SELECT 'type', n.nspname, t.typname, '', d.description
  FROM pg_description d JOIN pg_type t ON t.oid = d.objoid
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE d.classoid = 'pg_type'::regclass AND n.nspname = ANY($1)
    AND (t.typtype IN ('e','d')
         OR (t.typtype = 'c'
             AND EXISTS (SELECT 1 FROM pg_class rc WHERE rc.oid = t.typrelid AND rc.relkind = 'c')))
UNION ALL
  SELECT 'constraint', n.nspname, c.relname, con.conname, d.description
  FROM pg_description d JOIN pg_constraint con ON con.oid = d.objoid
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE d.classoid = 'pg_constraint'::regclass AND n.nspname = ANY($1)
    AND con.contype IN ('p','f','u','c','x') AND c.oid NOT IN (${EXCLUDED_RELS})`;

const Q_ENUM_LABELS = `
SELECT n.nspname AS schema, t.typname AS type, e.enumlabel AS label,
       row_number() OVER (PARTITION BY t.oid ORDER BY e.enumsortorder) AS rank
FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = ANY($1)
ORDER BY n.nspname, t.typname, e.enumsortorder`;

const Q_SEQUENCES = `
SELECT n.nspname AS schema, c.relname AS name,
       s.seqtypid::regtype::text AS data_type,
       s.seqstart::text AS start, s.seqincrement::text AS increment,
       s.seqmin::text AS min_value, s.seqmax::text AS max_value,
       s.seqcache::text AS cache, s.seqcycle AS cycle,
       d.deptype,
       dn.nspname AS owned_schema, dc.relname AS owned_table, da.attname AS owned_column
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_sequence s ON s.seqrelid = c.oid
LEFT JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = c.oid
                     AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a','i')
LEFT JOIN pg_class dc ON dc.oid = d.refobjid
LEFT JOIN pg_namespace dn ON dn.oid = dc.relnamespace
LEFT JOIN pg_attribute da ON da.attrelid = d.refobjid AND da.attnum = d.refobjsubid
WHERE c.relkind = 'S' AND n.nspname = ANY($1)
  AND c.oid NOT IN (${EXCLUDED_RELS})
  AND (dc.oid IS NULL OR dc.oid NOT IN (${EXCLUDED_RELS}))`;

/**
 * `serial` is a column DEFAULT `nextval('t_id_seq')` plus a sequence, and pg_depend
 * records the attrdef -> sequence link. Without that edge the table is ordered before
 * the sequence its own DEFAULT calls, and the plan fails with
 * `relation "t_id_seq" does not exist`.
 */
const Q_DEFAULT_SEQUENCES = `
SELECT n.nspname AS schema, c.relname AS "table", a.attname AS column,
       sn.nspname AS seq_schema, s.relname AS seq_name
FROM pg_depend d
JOIN pg_attrdef ad ON ad.oid = d.objid
JOIN pg_class c ON c.oid = ad.adrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
JOIN pg_class s ON s.oid = d.refobjid
JOIN pg_namespace sn ON sn.oid = s.relnamespace
WHERE d.classid = 'pg_attrdef'::regclass AND d.refclassid = 'pg_class'::regclass
  AND s.relkind = 'S' AND d.deptype = 'n'
  AND n.nspname = ANY($1) AND sn.nspname = ANY($1)
  AND c.oid NOT IN (${EXCLUDED_RELS})
  AND s.oid NOT IN (${EXCLUDED_RELS})`;

/**
 * LK109's catalog test (design/06 §3.4): does this column DEFAULT call a function that
 * is not IMMUTABLE?
 *
 * `pg_depend` from the `pg_attrdef` row to `pg_proc` is how the server records which
 * functions an expression calls, so this is the same question the planner asks when it
 * decides whether `ADD COLUMN … DEFAULT` can use `attmissingval` instead of rewriting
 * the table. Reported as a diagnostic rather than stored in `DefaultPayload`: volatility
 * is a property of the FUNCTION, not of the schema, and hashing it would turn "somebody
 * redefined `bump()` as STABLE" into a delta with no DDL behind it — a plan that can
 * never converge.
 */
const Q_VOLATILE_DEFAULTS = `
SELECT DISTINCT n.nspname AS schema, c.relname AS "table", a.attname AS column
FROM pg_attrdef ad
JOIN pg_class c ON c.oid = ad.adrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
JOIN pg_depend d ON d.classid = 'pg_attrdef'::regclass AND d.objid = ad.oid
                AND d.refclassid = 'pg_proc'::regclass
JOIN pg_proc pr ON pr.oid = d.refobjid
WHERE pr.provolatile <> 'i' AND n.nspname = ANY($1)
  AND c.oid NOT IN (${EXCLUDED_RELS})`;

/**
 * The completeness rule (design/06 §2.2): enumerate everything, subtract Tiers M/R/O,
 * and report the remainder. Silence is never an option.
 *
 * The Tier-R half (`view`, `materializedView`, `function`, `procedure`, `trigger`,
 * `policy`, `rule`) is authored as repeatables and is expected to be non-empty; the
 * Tier-U half is `06` §2.2's list in full — casts, operator classes/families, the five
 * text-search catalogs, statistics objects, transforms, user-defined languages,
 * parameter ACLs and large objects. `--strict-unmodeled` (`diffIR`'s `strictUnmodeled`)
 * turns a non-empty Tier-U census into an error.
 *
 * Cluster-scoped kinds are counted without a schema filter — `pg_language`,
 * `pg_transform`, `pg_parameter_acl` and `pg_largeobject_metadata` have no namespace —
 * and are marked as such in `UNMODELED_SCOPE` so a report can say so.
 */
const Q_UNMODELED = `
SELECT 'view' AS kind, count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind='v' AND n.nspname = ANY($1)
UNION ALL SELECT 'materializedView', count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind='m' AND n.nspname = ANY($1)
UNION ALL SELECT 'function', count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname = ANY($1) AND p.prokind = 'f'
UNION ALL SELECT 'procedure', count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname = ANY($1) AND p.prokind = 'p'
UNION ALL SELECT 'trigger', count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = ANY($1)
UNION ALL SELECT 'policy', count(*)::int FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname = ANY($1)
UNION ALL SELECT 'rule', count(*)::int FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE r.rulename <> '_RETURN' AND n.nspname = ANY($1)
UNION ALL SELECT 'cast', count(*)::int FROM pg_cast ca
  JOIN pg_type st ON st.oid = ca.castsource JOIN pg_namespace sn ON sn.oid = st.typnamespace
  WHERE sn.nspname = ANY($1)
UNION ALL SELECT 'operatorClass', count(*)::int FROM pg_opclass o JOIN pg_namespace n ON n.oid=o.opcnamespace
  WHERE n.nspname = ANY($1)
UNION ALL SELECT 'operatorFamily', count(*)::int FROM pg_opfamily o JOIN pg_namespace n ON n.oid=o.opfnamespace
  WHERE n.nspname = ANY($1)
UNION ALL SELECT 'textSearchConfig', count(*)::int FROM pg_ts_config t JOIN pg_namespace n ON n.oid=t.cfgnamespace
  WHERE n.nspname = ANY($1)
UNION ALL SELECT 'textSearchDict', count(*)::int FROM pg_ts_dict t JOIN pg_namespace n ON n.oid=t.dictnamespace
  WHERE n.nspname = ANY($1)
UNION ALL SELECT 'textSearchParser', count(*)::int FROM pg_ts_parser t JOIN pg_namespace n ON n.oid=t.prsnamespace
  WHERE n.nspname = ANY($1)
UNION ALL SELECT 'textSearchTemplate', count(*)::int FROM pg_ts_template t JOIN pg_namespace n ON n.oid=t.tmplnamespace
  WHERE n.nspname = ANY($1)
UNION ALL SELECT 'statisticsObject', count(*)::int FROM pg_statistic_ext s JOIN pg_namespace n ON n.oid=s.stxnamespace
  WHERE n.nspname = ANY($1)
UNION ALL SELECT 'transform', count(*)::int FROM pg_transform
UNION ALL SELECT 'language', count(*)::int FROM pg_language WHERE lanispl AND lanname <> 'plpgsql'
UNION ALL SELECT 'parameterAcl', count(*)::int FROM pg_parameter_acl
UNION ALL SELECT 'largeObject', count(*)::int FROM pg_largeobject_metadata`;

/** Tier-R kinds are authored, not diffed; only the Tier-U remainder answers to `--strict-unmodeled`. */
const TIER_R_KINDS: ReadonlySet<string> = new Set([
  "view",
  "materializedView",
  "function",
  "procedure",
  "trigger",
  "policy",
  "rule",
]);

/* ------------------------------------------------------------------ */
/* Tier O — observed, never written (design/06 §2.2)                    */
/* ------------------------------------------------------------------ */

/**
 * One query per Tier-O family, each projecting to the same `(kind, name, detail)` shape.
 *
 * They are run OUTSIDE the fact base on purpose (see `ObservedObject`): a grant is not
 * schema state we own, and putting one in the fingerprint would make `GRANT SELECT`
 * indistinguishable from drift.
 *
 * Everything cluster-scoped (`pg_roles`, `pg_auth_members`, subscriptions, event
 * triggers) is read without the schema filter, because it has no schema to filter on —
 * that asymmetry is exactly `06` §3.2's stated Tier-3 shadow constraint.
 */
const OBSERVED_QUERIES: readonly { readonly kind: string; readonly sql: string }[] = [
  {
    kind: "role",
    sql: `SELECT r.rolname AS name,
                 concat_ws(' ', CASE WHEN r.rolsuper THEN 'SUPERUSER' END,
                                CASE WHEN r.rolcreatedb THEN 'CREATEDB' END,
                                CASE WHEN r.rolcreaterole THEN 'CREATEROLE' END,
                                CASE WHEN r.rolcanlogin THEN 'LOGIN' END,
                                CASE WHEN r.rolreplication THEN 'REPLICATION' END) AS detail
          FROM pg_roles r WHERE r.rolname NOT LIKE 'pg\\_%'`,
  },
  {
    kind: "membership",
    sql: `SELECT m.rolname AS name, g.rolname AS detail
          FROM pg_auth_members am
          JOIN pg_roles m ON m.oid = am.member
          JOIN pg_roles g ON g.oid = am.roleid
          WHERE g.rolname NOT LIKE 'pg\\_%'`,
  },
  {
    kind: "acl",
    sql: `SELECT n.nspname AS name, array_to_string(n.nspacl, ',') AS detail
          FROM pg_namespace n WHERE n.nspname = ANY($1) AND n.nspacl IS NOT NULL
        UNION ALL
          SELECT n.nspname || '.' || c.relname, array_to_string(c.relacl, ',')
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1) AND c.relacl IS NOT NULL
        UNION ALL
          SELECT n.nspname || '.' || p.proname, array_to_string(p.proacl, ',')
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = ANY($1) AND p.proacl IS NOT NULL`,
  },
  {
    kind: "defaultPrivilege",
    sql: `SELECT coalesce(n.nspname, '-') || ':' || coalesce(r.rolname, '-') || ':' || d.defaclobjtype::text AS name,
                 array_to_string(d.defaclacl, ',') AS detail
          FROM pg_default_acl d
          LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
          LEFT JOIN pg_roles r ON r.oid = d.defaclrole`,
  },
  {
    kind: "securityLabel",
    sql: `SELECT s.provider AS name, s.label AS detail FROM pg_seclabel s`,
  },
  {
    kind: "publication",
    sql: `SELECT p.pubname AS name,
                 concat_ws(' ', CASE WHEN p.puballtables THEN 'ALL TABLES' END,
                                CASE WHEN p.pubinsert THEN 'insert' END,
                                CASE WHEN p.pubupdate THEN 'update' END,
                                CASE WHEN p.pubdelete THEN 'delete' END,
                                CASE WHEN p.pubtruncate THEN 'truncate' END) AS detail
          FROM pg_publication p`,
  },
  {
    kind: "publicationRel",
    sql: `SELECT p.pubname || ':' || n.nspname || '.' || c.relname AS name, '' AS detail
          FROM pg_publication_rel pr
          JOIN pg_publication p ON p.oid = pr.prpubid
          JOIN pg_class c ON c.oid = pr.prrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace`,
  },
  {
    kind: "publicationSchema",
    sql: `SELECT p.pubname || ':' || n.nspname AS name, '' AS detail
          FROM pg_publication_namespace pn
          JOIN pg_publication p ON p.oid = pn.pnpubid
          JOIN pg_namespace n ON n.oid = pn.pnnspid`,
  },
  {
    kind: "subscription",
    sql: `SELECT s.subname AS name, CASE WHEN s.subenabled THEN 'enabled' ELSE 'disabled' END AS detail
          FROM pg_subscription s`,
  },
  {
    kind: "fdw",
    sql: `SELECT w.fdwname AS name, '' AS detail FROM pg_foreign_data_wrapper w`,
  },
  {
    kind: "server",
    sql: `SELECT s.srvname AS name, w.fdwname AS detail
          FROM pg_foreign_server s JOIN pg_foreign_data_wrapper w ON w.oid = s.srvfdw`,
  },
  {
    kind: "userMapping",
    sql: `SELECT coalesce(r.rolname, 'PUBLIC') || '@' || s.srvname AS name, '' AS detail
          FROM pg_user_mapping u
          JOIN pg_foreign_server s ON s.oid = u.umserver
          LEFT JOIN pg_roles r ON r.oid = u.umuser`,
  },
  {
    kind: "foreignTable",
    sql: `SELECT n.nspname || '.' || c.relname AS name, s.srvname AS detail
          FROM pg_foreign_table ft
          JOIN pg_class c ON c.oid = ft.ftrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_foreign_server s ON s.oid = ft.ftserver
          WHERE n.nspname = ANY($1)`,
  },
  {
    kind: "eventTrigger",
    sql: `SELECT e.evtname AS name, e.evtevent AS detail FROM pg_event_trigger e`,
  },
  {
    kind: "collation",
    sql: `SELECT n.nspname || '.' || c.collname AS name, c.collprovider::text AS detail
          FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace
          WHERE n.nspname = ANY($1)`,
  },
  {
    kind: "aggregate",
    sql: `SELECT n.nspname || '.' || p.proname AS name, pg_get_function_identity_arguments(p.oid) AS detail
          FROM pg_aggregate a JOIN pg_proc p ON p.oid = a.aggfnoid
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = ANY($1)`,
  },
];

const str = (v: unknown): string => String(v);
const bool = (v: unknown): boolean => v === true || v === "t" || v === "true";
const nstr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Strip a trailing ` NOT VALID` so validation state is an orthogonal axis. */
function splitNotValid(def: string): { definition: string; suffixed: boolean } {
  const m = /\s+NOT VALID$/.exec(def);
  return m ? { definition: def.slice(0, m.index), suffixed: true } : { definition: def, suffixed: false };
}

/** Replace the index's own name with `%ID%` so the payload stays identity-free (I1). */
const INDEXDEF_NAME = /^(CREATE (?:UNIQUE )?INDEX )(?:"(?:[^"]|"")*"|\S+)( ON )/;
/**
 * `pg_get_indexdef` on a PARTITIONED index says `ON ONLY <parent>`, because that is how
 * pg_dump builds one: create the parent index detached, create each partition's index,
 * then `ALTER INDEX … ATTACH PARTITION`. Replaying `ON ONLY` verbatim creates a parent
 * index with no children, which PostgreSQL marks `indisvalid = false` — so the plan
 * applies and then fails its own proof on `valid`.
 *
 * Dropping the `ONLY` is what a human writes and what propagates: one `CREATE INDEX` on
 * the parent builds every partition's index, under the names `ChooseRelationName` gives
 * them — the same names the desired database's own `CREATE INDEX` produced. Normalised on
 * BOTH sides, so it is a spelling choice rather than a lost attribute.
 */
const INDEXDEF_ONLY = /^(CREATE (?:UNIQUE )?INDEX %ID% ON )ONLY /;
function templatizeIndexDef(def: string): string {
  const out = def.replace(INDEXDEF_NAME, "$1%ID%$2");
  if (out === def) throw new Error(`could not templatize index definition: ${def}`);
  return out.replace(INDEXDEF_ONLY, "$1");
}

export async function extractCatalog(
  client: CatalogClient,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const schemas = [...(options.schemas ?? ["public"])].sort();
  const prov = options.provenance ?? CATALOG_PROVENANCE;
  const facts: Fact[] = [];
  const edges: DependencyEdge[] = [];
  const diagnostics: Diagnostic[] = [];
  const observed: ObservedObject[] = [];

  // One snapshot-bound transaction. REPEATABLE READ is not optional: without it
  // a concurrent DDL produces an IR describing a schema that never existed.
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  let pgVersionNum = 0;
  try {
    await client.query("SET LOCAL search_path = pg_catalog");
    // `SET LOCAL x = '<option>'` cannot take a bind, so the option used to be
    // string-interpolated straight from caller input. `set_config` is the same
    // GUC write with a real parameter.
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      options.statementTimeout ?? "30s",
    ]);
    const ver = await client.query("SHOW server_version_num");
    pgVersionNum = Number(Object.values(ver.rows[0] ?? {})[0] ?? 0);

    // One family per round trip, serially: `pg` forbids concurrent queries on a
    // single connection, and the whole point of the snapshot-bound transaction
    // is that these all see one moment in database time anyway.
    const p = [schemas];
    const rSchemas = await client.query(Q_SCHEMAS, p);
    const rTables = await client.query(Q_TABLES, p);
    const rColumns = await client.query(Q_COLUMNS, p);
    const rConstraints = await client.query(Q_CONSTRAINTS, p);
    const rIndexes = await client.query(Q_INDEXES, p);
    const rTypes = await client.query(Q_TYPES, p);
    const rLabels = await client.query(Q_ENUM_LABELS, p);
    const rDomainChecks = await client.query(Q_DOMAIN_CHECKS, p);
    const rTypeAttrs = await client.query(Q_TYPE_ATTRIBUTES, p);
    const rSeqs = await client.query(Q_SEQUENCES, p);
    const rDefaultSeqs = await client.query(Q_DEFAULT_SEQUENCES, p);
    const rExtensions = await client.query(Q_EXTENSIONS, p);
    const rComments = await client.query(Q_COMMENTS, p);
    const rVolatileDefaults = await client.query(Q_VOLATILE_DEFAULTS, p);
    const rInheritance = await client.query(Q_INHERITANCE, p);
    const rUnmodeled = await client.query(Q_UNMODELED, p);
    if (options.observe !== false) {
      observed.push(...(await observe(client, schemas, diagnostics)));
    }

    /* ---- schemas ---- */
    for (const r of rSchemas.rows) {
      const id: StableId = { kind: "schema", schema: str(r["schema"]) };
      facts.push({ id, payload: { kind: "schema" } satisfies SchemaPayload, provenance: prov });
    }

    /* ---- extensions (declare-only, never dropped) ---- */
    for (const r of rExtensions.rows) {
      const id: StableId = { kind: "extension", name: str(r["name"]) };
      facts.push({
        id,
        payload: { kind: "extension", schema: str(r["schema"]) } satisfies ExtensionPayload,
        // An extension's objects belong to the extension, not to us: `origin` says so, and
        // `ownership: "external"` is what stops any future promotion of a member to Tier M.
        provenance: { ...prov, origin: "extension", ownership: "external" },
      });
    }

    /* ---- types: enum + domain + composite ---- */
    /** `schema.type` -> the domain's `<name> <definition>` CHECK list, sorted by name */
    const domainChecks = new Map<string, string[]>();
    for (const r of rDomainChecks.rows) {
      const key = `${str(r["schema"])}.${str(r["type"])}`;
      const entry = `${str(r["name"])} ${str(r["definition"])}`;
      const list = domainChecks.get(key);
      if (list) list.push(entry);
      else domainChecks.set(key, [entry]);
    }
    for (const r of rTypes.rows) {
      const id: StableId = { kind: "type", schema: str(r["schema"]), name: str(r["name"]) };
      const typtype = str(r["typtype"]);
      const checks = domainChecks.get(`${id.schema}.${id.name}`);
      facts.push({
        id,
        parent: { kind: "schema", schema: id.schema },
        payload: {
          kind: "type",
          typtype,
          baseType: nstr(r["base_type"]),
          notNull: typtype === "d" ? bool(r["not_null"]) : null,
          default: nstr(r["default_expr"]),
          collation: nstr(r["collation"]),
          checks: typtype === "d" ? [...(checks ?? [])].sort() : null,
        } satisfies TypePayload,
        provenance: prov,
      });
      edges.push({ from: id, to: { kind: "schema", schema: id.schema }, kind: "owner" });
    }

    /* ---- composite attributes ---- */
    for (const r of rTypeAttrs.rows) {
      const schema = str(r["schema"]);
      const type = str(r["type"]);
      const id: StableId = { kind: "typeAttribute", schema, type, name: str(r["name"]) };
      facts.push({
        id,
        parent: { kind: "type", schema, name: type },
        payload: {
          kind: "typeAttribute",
          type: str(r["type_name"]),
          collation: nstr(r["collation"]),
        } satisfies TypeAttributePayload,
        ordinal: Number(r["attnum"]),
        provenance: prov,
      });
      edges.push({ from: id, to: { kind: "type", schema, name: type }, kind: "owner" });
    }
    /** qualified enum type name -> ordered labels */
    const enumLabels = new Map<string, string[]>();
    for (const r of rLabels.rows) {
      const schema = str(r["schema"]);
      const type = str(r["type"]);
      const label = str(r["label"]);
      const id: StableId = { kind: "enumLabel", schema, type, name: label };
      facts.push({
        id,
        parent: { kind: "type", schema, name: type },
        payload: { kind: "enumLabel" } satisfies EnumLabelPayload,
        ordinal: Number(r["rank"]),
        provenance: prov,
      });
      const key = `${schema}.${type}`;
      const list = enumLabels.get(key);
      if (list) list.push(label);
      else enumLabels.set(key, [label]);
    }

    /* ---- tables, partitioned parents and partitions ---- */
    for (const r of rTables.rows) {
      const id: StableId = { kind: "table", schema: str(r["schema"]), name: str(r["name"]) };
      const parentName = nstr(r["parent_name"]);
      const partitionOf =
        parentName === null
          ? null
          : encodeId({ kind: "table", schema: str(r["parent_schema"]), name: parentName });
      facts.push({
        id,
        parent: { kind: "schema", schema: id.schema },
        payload: {
          kind: "table",
          relkind: str(r["relkind"]) as "r" | "p",
          persistence: str(r["relpersistence"]),
          rowSecurity: bool(r["relrowsecurity"]),
          partitionStrategy: nstr(r["partstrat"]),
          partitionKey: nstr(r["partition_key"]),
          partitionOf,
          partitionBound: nstr(r["partition_bound"]),
        } satisfies TablePayload,
        provenance: prov,
      });
      edges.push({ from: id, to: { kind: "schema", schema: id.schema }, kind: "owner" });
      // A partition cannot be attached before its parent exists, and the ATTACH is what
      // the ordering has to hang on — `pg_depend` records the partition's dependency on
      // the parent's TYPE, which is not an edge the emitter can use.
      if (partitionOf !== null) {
        edges.push({
          from: id,
          to: { kind: "table", schema: str(r["parent_schema"]), name: parentName! },
          kind: "depends",
        });
      }
    }

    /* ---- columns ---- */
    for (const r of rColumns.rows) {
      const schema = str(r["schema"]);
      const table = str(r["table"]);
      const id: StableId = { kind: "column", schema, table, name: str(r["name"]) };
      const defaultExpr = nstr(r["default_expr"]);
      const notNullName = nstr(r["not_null_constraint"]);
      const generated = nstr(r["generated"]);
      facts.push({
        id,
        parent: { kind: "table", schema, name: table },
        payload: {
          kind: "column",
          type: str(r["type"]),
          notNull: bool(r["not_null"]),
          // Fold the server-generated name away rather than storing it (I1): it is a
          // function of the id, so keeping it would give every column of a renamed
          // table a different hash and turn a rename into a phantom alter.
          notNullConstraint:
            notNullName === null
              ? null
              : notNullName === defaultNotNullName(table, id.name)
                ? GENERATED_NAME
                : notNullName,
          // Same catalog gate, same reason: no `contype = 'n'` row means no validity to
          // state, so 15/16/17 and 18 read identically on a validated NOT NULL.
          notNullValidated: notNullName === null ? null : bool(r["not_null_validated"]),
          // A generation expression stays ON the column; a plain DEFAULT becomes a
          // `default` fact below. Both live in `pg_attrdef`, and telling them apart is
          // `attgenerated` — conflating them made `SET DEFAULT` a candidate rewrite.
          generationExpr: generated !== null && defaultExpr !== null ? defaultExpr : null,
          identity: nstr(r["identity"]),
          generated,
          collation: nstr(r["collation"]),
        } satisfies ColumnPayload,
        ordinal: Number(r["attnum"]),
        provenance: prov,
      });
      edges.push({ from: id, to: { kind: "table", schema, name: table }, kind: "owner" });

      /* ---- the DEFAULT, as a fact of its own (design/05 §7.2) ---- */
      if (defaultExpr !== null && generated === null) {
        const did: StableId = { kind: "default", schema, table, name: id.name };
        facts.push({
          id: did,
          parent: id,
          payload: { kind: "default", expression: defaultExpr } satisfies DefaultPayload,
          provenance: prov,
        });
        edges.push({ from: did, to: id, kind: "owner" });
        for (const target of evaluatedEnumLabels(defaultExpr, enumLabels)) {
          edges.push({ from: did, to: target, kind: "evaluates" });
        }
      }

      // column -> user type
      if (r["type_typtype"] === "e" && schemas.includes(str(r["type_schema"]))) {
        edges.push({
          from: id,
          to: { kind: "type", schema: str(r["type_schema"]), name: str(r["type_name"]) },
          kind: "depends",
        });
      }
      // SYNTHESIZED `evaluates` edges: a DEFAULT that names an enum label must
      // not be emitted before that label's ADD VALUE has committed. pg_depend
      // records a dependency on the TYPE, never on the label — this is the
      // structural blind spot that produced pg-delta's ordering bug (§1.3).
      //
      // Carried on the COLUMN as well as on the `default` fact above, deliberately: a
      // fresh table folds its defaults into `CREATE TABLE`, so the boundary has to be
      // reachable from the column too, and a duplicate edge only ever over-orders.
      if (defaultExpr) {
        for (const target of evaluatedEnumLabels(defaultExpr, enumLabels)) {
          edges.push({ from: id, to: target, kind: "evaluates" });
        }
      }
    }

    /* ---- constraints ---- */
    for (const r of rConstraints.rows) {
      const schema = str(r["schema"]);
      const table = str(r["table"]);
      const id: StableId = { kind: "constraint", schema, table, name: str(r["name"]) };
      const { definition } = splitNotValid(str(r["definition"]));
      facts.push({
        id,
        parent: { kind: "table", schema, name: table },
        payload: {
          kind: "constraint",
          contype: str(r["contype"]),
          definition,
          validated: bool(r["convalidated"]),
          deferrable: bool(r["condeferrable"]),
        } satisfies ConstraintPayload,
        provenance: prov,
      });
      edges.push({ from: id, to: { kind: "table", schema, name: table }, kind: "owner" });
      if (r["ref_table"] !== null && r["ref_table"] !== undefined) {
        edges.push({
          from: id,
          to: { kind: "table", schema: str(r["ref_schema"]), name: str(r["ref_table"]) },
          kind: "depends",
        });
      }
      for (const target of evaluatedEnumLabels(definition, enumLabels)) {
        edges.push({ from: id, to: target, kind: "evaluates" });
      }
    }

    /* ---- indexes ---- */
    for (const r of rIndexes.rows) {
      const schema = str(r["schema"]);
      const table = str(r["table"]);
      const id: StableId = { kind: "index", schema, name: str(r["name"]) };
      const definition = templatizeIndexDef(str(r["definition"]));
      facts.push({
        id,
        parent: { kind: "table", schema, name: table },
        payload: {
          kind: "index",
          definition,
          unique: bool(r["unique"]),
          valid: bool(r["valid"]),
        } satisfies IndexPayload,
        provenance: prov,
      });
      edges.push({ from: id, to: { kind: "table", schema, name: table }, kind: "depends" });
      if (!bool(r["valid"])) {
        diagnostics.push({
          code: "invalid_index",
          severity: "warning",
          message: `index ${schema}.${str(r["name"])} is INVALID (leftover from a failed CREATE INDEX CONCURRENTLY)`,
          subject: encodeId(id),
        });
      }
      for (const target of evaluatedEnumLabels(definition, enumLabels)) {
        edges.push({ from: id, to: target, kind: "evaluates" });
      }
    }

    /* ---- sequences ---- */
    for (const r of rSeqs.rows) {
      // Identity-owned sequences (deptype 'i') are implied by the column's
      // GENERATED … AS IDENTITY clause; emitting them as facts would generate
      // CREATE SEQUENCE statements PostgreSQL rejects.
      if (r["deptype"] === "i") continue;
      const schema = str(r["schema"]);
      const id: StableId = { kind: "sequence", schema, name: str(r["name"]) };
      const owned =
        r["owned_column"] === null || r["owned_column"] === undefined
          ? null
          : encodeId({
              kind: "column",
              schema: str(r["owned_schema"]),
              table: str(r["owned_table"]),
              name: str(r["owned_column"]),
            });
      facts.push({
        id,
        parent: { kind: "schema", schema },
        payload: {
          kind: "sequence",
          dataType: str(r["data_type"]),
          start: str(r["start"]),
          increment: str(r["increment"]),
          minValue: str(r["min_value"]),
          maxValue: str(r["max_value"]),
          cache: str(r["cache"]),
          cycle: bool(r["cycle"]),
          ownedBy: owned,
        } satisfies SequencePayload,
        provenance: prov,
      });
      edges.push({ from: id, to: { kind: "schema", schema }, kind: "owner" });
    }

    /* ---- serial: column DEFAULT nextval() -> its sequence ---- */
    for (const r of rDefaultSeqs.rows) {
      edges.push({
        from: {
          kind: "column",
          schema: str(r["schema"]),
          table: str(r["table"]),
          name: str(r["column"]),
        },
        to: { kind: "sequence", schema: str(r["seq_schema"]), name: str(r["seq_name"]) },
        kind: "depends",
      });
    }

    /* ---- comments ---- */
    for (const r of rComments.rows) {
      const target = commentTargetId(str(r["target"]), str(r["schema"]), str(r["name1"]), str(r["name2"]));
      if (target === null) continue;
      const id = commentId(target);
      facts.push({
        id,
        parent: target,
        payload: { kind: "comment", text: str(r["description"]) } satisfies CommentPayload,
        provenance: prov,
      });
      edges.push({ from: id, to: target, kind: "owner" });
    }

    /* ---- LK109: which DEFAULTs are not IMMUTABLE ---- */
    for (const r of rVolatileDefaults.rows) {
      const subject = encodeId({
        kind: "default",
        schema: str(r["schema"]),
        table: str(r["table"]),
        name: str(r["column"]),
      });
      diagnostics.push({
        code: "volatile_default",
        severity: "info",
        message:
          `${subject} calls a function with provolatile <> 'i'; adding a column with this ` +
          `default rewrites the table (LK109)`,
        subject,
      });
    }

    /* ---- Tier-M gaps that must not converge silently ---- */
    for (const r of rInheritance.rows) {
      const schema = str(r["schema"]);
      const name = str(r["name"]);
      diagnostics.push({
        code: "unsupported_kind",
        severity: "error",
        message:
          `${schema}.${name} is an ${str(r["kind"])}; classic table INHERITS is not modelled ` +
          `(partitioning is — design/06 §2.2), so it is excluded from the IR rather than ` +
          `diffed as a plain table`,
        subject: encodeId({ kind: "table", schema, name }),
      });
    }

    /* ---- Tier R/U census ---- */
    for (const r of rUnmodeled.rows) {
      const n = Number(r["n"]);
      const kind = str(r["kind"]);
      if (n > 0) {
        diagnostics.push({
          code: "unmodeled_kind",
          severity: "info",
          message: `${n} ${kind} object(s) present and not diffed (${TIER_R_KINDS.has(kind) ? "Tier R" : "Tier U"})`,
          subject: kind,
          count: n,
        });
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }

  const ir = SchemaIR.build(facts, edges);
  for (const orphan of ir.orphans()) {
    diagnostics.push({
      code: "orphan_fact",
      severity: "warning",
      message:
        `${encodeId(orphan.id)} has no parent fact (${encodeId(orphan.parent!)}); its family ` +
        `was extracted with a different exclusion than its parent's`,
      subject: encodeId(orphan.id),
    });
  }
  return { ir, pgVersionNum, diagnostics, observed };
}

/** `Q_COMMENTS`'s flat row back to the StableId of whatever it annotates. */
function commentTargetId(target: string, schema: string, name1: string, name2: string): StableId | null {
  switch (target) {
    case "schema":
      return { kind: "schema", schema };
    case "table":
      return { kind: "table", schema, name: name1 };
    case "column":
      return { kind: "column", schema, table: name1, name: name2 };
    case "constraint":
      return { kind: "constraint", schema, table: name1, name: name2 };
    case "index":
      return { kind: "index", schema, name: name1 };
    case "type":
      return { kind: "type", schema, name: name1 };
    case "sequence":
      return { kind: "sequence", schema, name: name1 };
    default:
      return null;
  }
}

/**
 * Tier O — the observation sweep (design/06 §2.2).
 *
 * Each family runs behind its OWN savepoint. Reading `pg_subscription` or `pg_seclabel`
 * needs privileges an application role does not have, and inside the snapshot-bound
 * `REPEATABLE READ` transaction one `permission denied` aborts the whole extraction —
 * so a Tier-O family that cannot be read degrades to a diagnostic, which is exactly the
 * "cluster-scoped objects are somebody else's" premise the tier is built on.
 */
async function observe(
  client: CatalogClient,
  schemas: readonly string[],
  diagnostics: Diagnostic[],
): Promise<ObservedObject[]> {
  const out: ObservedObject[] = [];
  for (const family of OBSERVED_QUERIES) {
    await client.query("SAVEPOINT pgprime_observe");
    try {
      const rows = await client.query(family.sql, family.sql.includes("$1") ? [schemas] : []);
      await client.query("RELEASE SAVEPOINT pgprime_observe");
      for (const r of rows.rows) {
        out.push({ kind: family.kind, name: str(r["name"]), detail: nstr(r["detail"]) ?? "" });
      }
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT pgprime_observe");
      await client.query("RELEASE SAVEPOINT pgprime_observe");
      diagnostics.push({
        code: "observation_unavailable",
        severity: "info",
        message: `Tier-O ${family.kind} could not be read: ${err instanceof Error ? err.message : String(err)}`,
        subject: family.kind,
      });
    }
  }
  out.sort((a, b) => (a.kind === b.kind ? (a.name < b.name ? -1 : 1) : a.kind < b.kind ? -1 : 1));
  return out;
}

/**
 * The MF family's emptiness probe (design/06 §3.4): "Emptiness is established by a
 * `SELECT EXISTS (SELECT 1 FROM t LIMIT 1)` probe against the target when one is
 * reachable; offline, MF rules stay at `error` and must be acknowledged."
 *
 * Returns the encoded `table` ids that are provably EMPTY. Empty rather than "row count",
 * because the count is a scan and the question is a lookup — and because the answer is
 * only ever used to *suppress* a hazard, so the safe default is "we do not know", which
 * is what an unreachable target and a missing table both produce.
 *
 * Outside the extractor's snapshot transaction on purpose: it reads user tables, and
 * holding a REPEATABLE READ snapshot open across a `LIMIT 1` on every table in the schema
 * is a long-lived transaction on the live target for no benefit — a table that gains its
 * first row between the probe and the apply invalidates the answer either way, which is
 * exactly why MF is a hazard rather than a proof.
 */
export async function probeEmptiness(
  client: CatalogClient,
  tables: readonly StableId[],
): Promise<Set<string>> {
  const empty = new Set<string>();
  for (const t of tables) {
    if (t.kind !== "table") continue;
    try {
      const r = await client.query(
        `SELECT NOT EXISTS (SELECT 1 FROM ${quoteQualified(t.schema, t.name)} LIMIT 1) AS empty`,
      );
      if (bool(r.rows[0]?.["empty"])) empty.add(encodeId(t));
    } catch {
      // A table we cannot read is a table we cannot prove empty. Silence here is the
      // conservative direction: the MF hazard stays and has to be acknowledged.
    }
  }
  return empty;
}

/** Per-kind counts, for the `status` / `doctor` report and for the plan's diagnostics. */
export function observedCounts(observed: readonly ObservedObject[]): { kind: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const o of observed) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
  return [...counts]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => (a.kind < b.kind ? -1 : 1));
}

/** One `info` diagnostic per observed kind — `06` §2.2: reported by `status` and `doctor`. */
export function observationDiagnostics(observed: readonly ObservedObject[]): Diagnostic[] {
  return observedCounts(observed).map(({ kind, count }) => ({
    code: "observed_kind",
    severity: "info" as const,
    message: `${count} ${kind} object(s) observed and never written (Tier O)`,
    subject: kind,
    count,
  }));
}

/**
 * Find the enum labels an expression evaluates at DDL time.
 *
 * Conservative by construction: an expression only earns an `evaluates` edge
 * when it BOTH casts to (or is qualified by) the enum type AND contains the
 * label as a string literal. Over-matching costs a redundant commit boundary;
 * under-matching costs a failed migration — so the bias is deliberate.
 */
export function evaluatedEnumLabels(
  expr: string,
  enumLabels: ReadonlyMap<string, readonly string[]>,
): StableId[] {
  const out: StableId[] = [];
  for (const [qualified, labels] of enumLabels) {
    const dot = qualified.lastIndexOf(".");
    const schema = qualified.slice(0, dot);
    const type = qualified.slice(dot + 1);
    if (!mentionsType(expr, schema, type)) continue;
    for (const label of labels) {
      if (expr.includes(`'${label.replace(/'/g, "''")}'`)) {
        out.push({ kind: "enumLabel", schema, type, name: label });
      }
    }
  }
  return out;
}

/** A bare identifier PostgreSQL will not have quoted in its own output. */
const BARE_IDENT = /^[a-z_][a-z0-9_$]*$/;

/** Both spellings of one identifier part: quoted always, bare only when legal. */
function spellings(part: string): string[] {
  const quoted = `"${part.replace(/"/g, '""')}"`;
  return BARE_IDENT.test(part) ? [part, quoted] : [quoted];
}

/**
 * Does `expr` name this enum type, in ANY spelling PostgreSQL might have emitted?
 *
 * `pg_get_expr` quotes a part only when it has to, so one type has up to four
 * qualified spellings (`s.t`, `"s".t`, `s."t"`, `"s"."t"`). Matching only the two
 * all-bare/all-quoted forms missed `'refunded'::"my schema".order_status` and
 * `::public."OrderStatus"` — and a missed `evaluates` edge is a 55P04
 * "unsafe use of new value" at apply time, which is the whole bug this edge exists
 * to prevent.
 */
function mentionsType(expr: string, schema: string, type: string): boolean {
  for (const t of spellings(type)) {
    if (expr.includes(`::${t}`)) return true;
    for (const sc of spellings(schema)) {
      if (expr.includes(`${sc}.${t}`)) return true;
    }
  }
  return false;
}
