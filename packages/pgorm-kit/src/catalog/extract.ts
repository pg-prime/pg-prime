import {
  CATALOG_PROVENANCE,
  SchemaIR,
  type DependencyEdge,
  type Fact,
  type Provenance,
} from "../ir/fact.js";
import { encodeId, type StableId } from "../ir/stable-id.js";
import type {
  ColumnPayload,
  ConstraintPayload,
  EnumLabelPayload,
  IndexPayload,
  SchemaPayload,
  SequencePayload,
  TablePayload,
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
}

export interface ExtractResult {
  readonly ir: SchemaIR;
  readonly pgVersionNum: number;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ExtractOptions {
  readonly schemas?: readonly string[];
  readonly provenance?: Provenance;
  readonly statementTimeout?: string;
}

/* ------------------------------------------------------------------ */
/* pg_catalog only. `information_schema` is never queried (design §3.1) */
/* ------------------------------------------------------------------ */

const Q_SCHEMAS = `
SELECT n.nspname AS schema
FROM pg_namespace n
WHERE n.nspname = ANY($1)`;

const Q_TABLES = `
SELECT n.nspname AS schema, c.relname AS name, c.relkind, c.relpersistence, c.relrowsecurity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p') AND n.nspname = ANY($1)
  AND c.oid NOT IN (SELECT d.objid FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.deptype = 'e')`;

const Q_COLUMNS = `
SELECT n.nspname AS schema, c.relname AS "table", a.attname AS name, a.attnum,
       format_type(a.atttypid, a.atttypmod) AS type,
       a.attnotnull AS not_null,
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
WHERE a.attnum > 0 AND NOT a.attisdropped
  AND c.relkind IN ('r','p') AND n.nspname = ANY($1)
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
  AND con.coninhcount = 0`;

/** Constraint-backing indexes are implied by their constraint and are never their own fact. */
const Q_INDEXES = `
SELECT n.nspname AS schema, ic.relname AS name, c.relname AS "table",
       pg_get_indexdef(i.indexrelid) AS definition,
       i.indisunique AS unique, i.indisprimary AS primary, i.indisvalid AS valid
FROM pg_index i
JOIN pg_class ic ON ic.oid = i.indexrelid
JOIN pg_class c ON c.oid = i.indrelid
JOIN pg_namespace n ON n.oid = ic.relnamespace
WHERE n.nspname = ANY($1)
  AND NOT EXISTS (SELECT 1 FROM pg_constraint con
                  WHERE con.conindid = i.indexrelid AND con.contype IN ('p','u','x'))`;

const Q_ENUM_TYPES = `
SELECT n.nspname AS schema, t.typname AS name, t.typtype
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE t.typtype = 'e' AND n.nspname = ANY($1)`;

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
WHERE c.relkind = 'S' AND n.nspname = ANY($1)`;

/** The completeness rule (design/06 §2.2): enumerate, subtract, report the remainder. */
const Q_UNMODELED = `
SELECT 'view' AS kind, count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind='v' AND n.nspname = ANY($1)
UNION ALL SELECT 'materializedView', count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind='m' AND n.nspname = ANY($1)
UNION ALL SELECT 'function', count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname = ANY($1)
UNION ALL SELECT 'trigger', count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = ANY($1)
UNION ALL SELECT 'policy', count(*)::int FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname = ANY($1)
UNION ALL SELECT 'domainOrComposite', count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
  WHERE t.typtype IN ('d') AND n.nspname = ANY($1)`;

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
function templatizeIndexDef(def: string): string {
  const out = def.replace(INDEXDEF_NAME, "$1%ID%$2");
  if (out === def) throw new Error(`could not templatize index definition: ${def}`);
  return out;
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

  // One snapshot-bound transaction. REPEATABLE READ is not optional: without it
  // a concurrent DDL produces an IR describing a schema that never existed.
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  let pgVersionNum = 0;
  try {
    await client.query("SET LOCAL search_path = pg_catalog");
    await client.query(`SET LOCAL statement_timeout = '${options.statementTimeout ?? "30s"}'`);
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
    const rEnums = await client.query(Q_ENUM_TYPES, p);
    const rLabels = await client.query(Q_ENUM_LABELS, p);
    const rSeqs = await client.query(Q_SEQUENCES, p);
    const rUnmodeled = await client.query(Q_UNMODELED, p);

    /* ---- schemas ---- */
    for (const r of rSchemas.rows) {
      const id: StableId = { kind: "schema", schema: str(r["schema"]) };
      facts.push({ id, payload: { kind: "schema" } satisfies SchemaPayload, provenance: prov });
    }

    /* ---- enum types + labels ---- */
    for (const r of rEnums.rows) {
      const id: StableId = { kind: "type", schema: str(r["schema"]), name: str(r["name"]) };
      facts.push({
        id,
        parent: { kind: "schema", schema: id.schema },
        payload: { kind: "type", typtype: str(r["typtype"]) } satisfies TypePayload,
        provenance: prov,
      });
      edges.push({ from: id, to: { kind: "schema", schema: id.schema }, kind: "owner" });
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

    /* ---- tables ---- */
    for (const r of rTables.rows) {
      const id: StableId = { kind: "table", schema: str(r["schema"]), name: str(r["name"]) };
      facts.push({
        id,
        parent: { kind: "schema", schema: id.schema },
        payload: {
          kind: "table",
          relkind: str(r["relkind"]) as "r" | "p",
          persistence: str(r["relpersistence"]),
          rowSecurity: bool(r["relrowsecurity"]),
        } satisfies TablePayload,
        provenance: prov,
      });
      edges.push({ from: id, to: { kind: "schema", schema: id.schema }, kind: "owner" });
    }

    /* ---- columns ---- */
    for (const r of rColumns.rows) {
      const schema = str(r["schema"]);
      const table = str(r["table"]);
      const id: StableId = { kind: "column", schema, table, name: str(r["name"]) };
      const defaultExpr = nstr(r["default_expr"]);
      facts.push({
        id,
        parent: { kind: "table", schema, name: table },
        payload: {
          kind: "column",
          type: str(r["type"]),
          notNull: bool(r["not_null"]),
          default: defaultExpr,
          identity: nstr(r["identity"]),
          generated: nstr(r["generated"]),
          collation: nstr(r["collation"]),
        } satisfies ColumnPayload,
        ordinal: Number(r["attnum"]),
        provenance: prov,
      });
      edges.push({ from: id, to: { kind: "table", schema, name: table }, kind: "owner" });

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
          primary: bool(r["primary"]),
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

    /* ---- Tier U census ---- */
    for (const r of rUnmodeled.rows) {
      const n = Number(r["n"]);
      if (n > 0) {
        diagnostics.push({
          code: "unmodeled_kind",
          severity: "info",
          message: `${n} ${str(r["kind"])} object(s) present and not diffed (Tier R/U)`,
          subject: str(r["kind"]),
        });
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }

  return { ir: SchemaIR.build(facts, edges), pgVersionNum, diagnostics };
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
    const mentionsType =
      expr.includes(qualified) ||
      expr.includes(`"${schema}"."${type}"`) ||
      expr.includes(`::${type}`) ||
      expr.includes(`::"${type}"`);
    if (!mentionsType) continue;
    for (const label of labels) {
      if (expr.includes(`'${label.replace(/'/g, "''")}'`)) {
        out.push({ kind: "enumLabel", schema, type, name: label });
      }
    }
  }
  return out;
}
