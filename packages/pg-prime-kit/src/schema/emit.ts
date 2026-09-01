/**
 * The DSL → DDL emitter (design/11 §1.5, §3 K2a item 2).
 *
 * `emitSchema(schema)` turns a `pg-prime` registry into the SQL text that, loaded into an empty
 * database, produces exactly the schema the TypeScript describes. It is **not** a second model of
 * PostgreSQL: it produces text, the shadow database parses it, and `extractCatalog` reads the
 * result back. There is one extractor and one IR, and `05` §7.2's `schema.$ir()` is deliberately
 * not built (design/11 §1.5).
 *
 * Three properties the round-trip test in `test/schema-emit/` exists to prove:
 *
 *  - **Deterministic.** Sorted wherever order is not semantic (schemas, types, indexes, comments,
 *    constraints within a table); declaration order where it is (columns — `attnum` is observable
 *    through `pg_dump`, and tables, whose order follows the FK graph).
 *  - **Always schema-qualified.** No statement depends on `search_path`, which is what makes the
 *    tier-3 schema map (design/11 §1.6) a pure rename of identifiers rather than a GUC dance.
 *  - **Named with the server's own default names.** `makeObjectName` is a port of PostgreSQL's
 *    own rule, so a constraint we name explicitly and one the server names itself compare equal —
 *    which is what stops the D10 `pg_dump` witness from reporting drift that is not drift.
 */

import type { Diagnostic } from "../catalog/extract.js";
import { makeObjectName, quoteIdent, quoteLiteral, quoteQualified } from "../sql/ident.js";
import type { ColumnDdl, RefRuntime, SchemaLike, TableRuntime } from "./types.js";

export interface EmitOptions {
  /**
   * User schema name → the schema the DDL is actually emitted into (design/11 §1.6).
   * Absent, or missing a key, means "emit into the user's own schema name".
   */
  readonly schemaMap?: ReadonlyMap<string, string>;
  /** Where a table or enum that declares no schema lands. `public`, as design/05 §3.1 says. */
  readonly defaultSchema?: string;
}

export interface EmitResult {
  /** Complete statements, in execution order, without trailing semicolons. */
  readonly sql: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
  /** The schemas the emitted DDL touches, in the caller's (unmapped) names, sorted. */
  readonly schemas: readonly string[];
}

/* ------------------------------------------------------------------ */
/* internal model                                                      */
/* ------------------------------------------------------------------ */

interface EnumDecl {
  readonly schema: string;
  readonly name: string;
  readonly values: readonly string[];
  /** `COMMENT ON TYPE` — only a standalone `pgEnum(...)` declaration carries one. */
  readonly comment: string | undefined;
}

interface FkDecl {
  readonly name: string;
  readonly columns: readonly string[];
  readonly targetSchema: string;
  readonly targetTable: string;
  readonly targetColumns: readonly string[];
  readonly onDelete: string | undefined;
  readonly onUpdate: string | undefined;
  readonly deferrable: boolean;
  readonly initiallyDeferred: boolean;
}

interface IndexDecl {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly unique: boolean;
  readonly columns: readonly string[];
  readonly items: readonly {
    readonly column: string | undefined;
    readonly expression: string | undefined;
    readonly desc: boolean;
    readonly nulls: "first" | "last" | undefined;
    readonly opclass: string | undefined;
  }[];
  readonly using: string | undefined;
  readonly where: string | undefined;
  readonly include: readonly string[];
  readonly nullsNotDistinct: boolean;
  readonly with: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly tablespace: string | undefined;
}

interface CommentDecl {
  readonly target: string;
  readonly sql: string;
}

interface TableDecl {
  readonly schema: string;
  readonly name: string;
  readonly key: string;
  readonly runtime: TableRuntime;
  readonly columnLines: string[];
  /** Table-level constraint clauses (PK / UNIQUE / CHECK), already sorted. */
  readonly constraintLines: string[];
  readonly fks: FkDecl[];
}

const qualify = (schema: string, name: string): string => `${schema}.${name}`;

/* ------------------------------------------------------------------ */
/* literals                                                            */
/* ------------------------------------------------------------------ */

/** `text[][]` → `text`. The element type is what a literal is rendered against. */
function baseType(pgType: string): string {
  return pgType.replace(/(\[\])+$/, "");
}

/**
 * A `DEFAULT` literal, keyed on the column's declared PostgreSQL type.
 *
 * The type is consulted first and the JavaScript value second, because those two disagree exactly
 * where it matters: `jsonb().default('x')` is the JSON document `"x"`, not the SQL string `x`, and
 * a renderer that dispatched on `typeof value` alone would emit `'x'::jsonb` — which PostgreSQL
 * rejects, three steps away from the line that wrote it.
 *
 * Throws {@link EmitError}, which {@link emitSchema} converts into an `error` diagnostic: the
 * emitter is a total function over a registry, and one unrenderable default must not cost the
 * caller the other forty-nine statements' worth of diagnostics.
 */
function renderLiteral(value: unknown, pgType: string, subject: string, typeSql: string): string {
  const base = baseType(pgType).toLowerCase();
  if (base === "json" || base === "jsonb") return quoteLiteral(JSON.stringify(value) ?? "null");
  if (value === null) return "NULL";
  switch (typeof value) {
    case "string":
      return quoteLiteral(value);
    case "bigint":
      return value.toString();
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new EmitError(`${subject}: the default ${String(value)} has no SQL literal form`);
      }
      // Parenthesised so that a negative default inside a larger expression cannot re-associate;
      // `pg_get_expr` prints it back as `'-1'::integer` either way.
      return value < 0 ? `(${String(value)})` : String(value);
    default:
      break;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new EmitError(`${subject}: the default is an Invalid Date`);
    }
    return quoteLiteral(value.toISOString());
  }
  if (Array.isArray(value)) {
    // The cast uses the EMITTED type, not `ColumnDdl.pgType`: for an enum array the latter is the
    // bare `member_role[]`, and `ARRAY[]::member_role[]` fails with `type … does not exist` the
    // moment the enum lives anywhere but `search_path` — which, since the emitter never relies on
    // `search_path`, is always.
    const element = typeSql.replace(/\[\]$/, "");
    const items = (value as readonly unknown[]).map((v) => renderLiteral(v, base, subject, element));
    return `ARRAY[${items.join(", ")}]::${typeSql}`;
  }
  throw new EmitError(
    `${subject}: a default of type ${typeof value} cannot be rendered as a ${pgType} literal. ` +
      `Use .defaultSql('…') for an expression.`,
  );
}

export class EmitError extends Error {
  readonly code = "PG_PRIME_EMIT";
  constructor(message: string) {
    super(message);
    this.name = "EmitError";
  }
}

/* ------------------------------------------------------------------ */
/* the emitter                                                         */
/* ------------------------------------------------------------------ */

export function emitSchema(schema: SchemaLike, options: EmitOptions = {}): EmitResult {
  const diagnostics: Diagnostic[] = [];
  const defaultSchema = options.defaultSchema ?? "public";
  const map = options.schemaMap;
  const userSchemas = new Set<string>();

  /** User schema name → the name to write. Reports when a map is present and does not cover it. */
  const mapped = (userSchema: string, subject: string): string => {
    userSchemas.add(userSchema);
    if (map === undefined) return userSchema;
    const to = map.get(userSchema);
    if (to !== undefined) return to;
    diagnostics.push({
      code: "shadow_schema_unmapped",
      severity: "error",
      message:
        `schema ${JSON.stringify(userSchema)} is not covered by the shadow schema map ` +
        `(${[...map.keys()].map((k) => JSON.stringify(k)).join(", ") || "empty"}); emitting into ` +
        `it would write to the real database, so the load must not run`,
      subject,
    });
    return userSchema;
  };

  /* ---- 1. collect tables and enums ---- */

  const tables: TableDecl[] = [];
  const byKey = new Map<string, TableDecl>();
  const enums = new Map<string, EnumDecl>();

  const rawTables = Object.values(schema.tables)
    .map((t) => t.$)
    .sort((a, b) => cmp(`${a.schema ?? defaultSchema} ${a.name}`, `${b.schema ?? defaultSchema} ${b.name}`));

  for (const rt of rawTables) {
    const key = qualify(rt.schema ?? defaultSchema, rt.name);
    if (byKey.has(key)) {
      diagnostics.push({
        code: "duplicate_table",
        severity: "error",
        message: `two tables in the registry resolve to ${key}`,
        subject: key,
      });
      continue;
    }
    const decl: TableDecl = {
      schema: rt.schema ?? defaultSchema,
      name: rt.name,
      key,
      runtime: rt,
      columnLines: [],
      constraintLines: [],
      fks: [],
    };
    tables.push(decl);
    byKey.set(key, decl);
    for (const ref of rt.columns) collectEnum(ref, defaultSchema, enums, diagnostics);
  }

  /* ---- 2. build every table's body ---- */

  const rename = (schema: string): string | undefined => map?.get(schema);
  const sequenceNames = new Set((schema.sequences ?? []).map((s) => qualify(s.schema ?? defaultSchema, s.name)));
  const extensionNames = new Set((schema.extensions ?? []).map((x) => x.name));
  for (const decl of tables) {
    buildTable(decl, {
      defaultSchema,
      mapped,
      rename,
      sequences: sequenceNames,
      extensions: extensionNames,
      diagnostics,
      byKey,
    });
  }

  /* ---- 3. emit ---- */

  const sql: string[] = [];

  /* Standalone declarations (design/05 §3.2/§3.3/§3.5/§3.10), collected off the module's
   * exports by `loadSchema`. A `pgEnum` no column uses is emitted too — which is what makes
   * a pulled schema round-trip, because the differ would otherwise plan a `DROP TYPE`. */
  for (const e of schema.enums ?? []) {
    const ns = e.schema ?? defaultSchema;
    const key = qualify(ns, e.name);
    const existing = enums.get(key);
    // A comment lives on the DECLARATION, and `ColumnDdl` carries only the name/labels/schema
    // of the enum a column uses — so an enum discovered through a column is merged with its
    // standalone declaration here rather than replaced by it, which would lose nothing but
    // would make the emitted comment depend on which of the two the emitter saw first.
    enums.set(key, {
      schema: ns,
      name: e.name,
      values: existing?.values ?? [...e.values],
      comment: e.comment,
    });
  }
  const byQualified = <T extends { name: string; schema?: string | undefined }>(a: T, b: T): number =>
    cmp(qualify(a.schema ?? defaultSchema, a.name), qualify(b.schema ?? defaultSchema, b.name));
  const domains = [...(schema.domains ?? [])].sort(byQualified);
  const sequences = [...(schema.sequences ?? [])].sort(byQualified);
  const extensions = [...(schema.extensions ?? [])].sort((a, b) => cmp(a.name, b.name));

  // An extension is declare-only and its member objects live in a fixed schema, which is
  // exactly the case design/06 §3.2 says the tier-3 map cannot express — so it is emitted
  // with the USER's schema name and a diagnostic says so, rather than silently writing a
  // shadow-qualified `CREATE EXTENSION` that no-ops against the already-installed one.
  for (const x of extensions) {
    const where = x.schema === undefined ? "" : ` SCHEMA ${quoteIdent(x.schema)}`;
    sql.push(`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(x.name)}${where}`);
    if (map !== undefined && [...map].some(([from, to]) => from !== to)) {
      diagnostics.push({
        code: "shadow_extension_fixed_schema",
        severity: "warning",
        subject: `extension:${x.name}`,
        message:
          `extension ${JSON.stringify(x.name)} cannot be normalised in a temp-schema shadow (design/06 §3.2): an ` +
          `extension belongs to the DATABASE, its member objects live in a schema the map cannot rename, and the ` +
          `extractor is scoped to the shadow schemas — so the desired IR built here does not contain it. It is ` +
          `emitted into ${x.schema === undefined ? "the current search_path" : JSON.stringify(x.schema)} and ` +
          `degrades to a Tier-O observation, which is exactly the constraint §3.2 states for this tier.`,
      });
    }
  }

  // schemas first: a mapped shadow schema may not exist yet, and `public` always does.
  const emitSchemas = [
    ...new Set([
      ...tables.map((t) => mapped(t.schema, `table ${t.key}`)),
      ...[...enums.values()].map((e) => mapped(e.schema, `type ${qualify(e.schema, e.name)}`)),
      ...domains.map((d) => mapped(d.schema ?? defaultSchema, `domain ${qualify(d.schema ?? defaultSchema, d.name)}`)),
      ...sequences.map((s) =>
        mapped(s.schema ?? defaultSchema, `sequence ${qualify(s.schema ?? defaultSchema, s.name)}`),
      ),
      ...(schema.schemas ?? []).map((s) => mapped(s.name, `schema ${s.name}`)),
    ]),
  ].sort(cmp);
  for (const s of emitSchemas) {
    if (s === "public") continue; // always present, and CREATE needs a privilege tier 3 may lack
    sql.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s)}`);
  }

  for (const e of [...enums.values()].sort((a, b) => cmp(qualify(a.schema, a.name), qualify(b.schema, b.name)))) {
    const target = quoteQualified(mapped(e.schema, `type ${qualify(e.schema, e.name)}`), e.name);
    sql.push(`CREATE TYPE ${target} AS ENUM (${e.values.map(quoteLiteral).join(", ")})`);
  }

  for (const d of domains) {
    const ns = d.schema ?? defaultSchema;
    const target = quoteQualified(mapped(ns, `domain ${qualify(ns, d.name)}`), d.name);
    const bits = [`CREATE DOMAIN ${target} AS ${d.baseType}`];
    if (d.collation !== undefined) bits.push(`COLLATE ${quoteIdent(d.collation)}`);
    if (d.default !== undefined) bits.push(`DEFAULT ${d.default}`);
    if (d.notNull) bits.push("NOT NULL");
    // Sorted by name: a domain's CHECKs are a set, and `pg_get_constraintdef` reads them
    // back in catalog order, so any declaration order but a sorted one is a phantom diff.
    for (const c of [...d.checks].sort((a, b) => cmp(a.name, b.name))) {
      bits.push(`CONSTRAINT ${quoteIdent(c.name)} CHECK (${c.expression})`);
    }
    sql.push(bits.join(" "));
  }

  // Before the tables: a `DEFAULT nextval('s'::regclass)` needs `s` to exist. `OWNED BY`
  // needs the table and is therefore emitted after them.
  for (const s of sequences) {
    const ns = s.schema ?? defaultSchema;
    const target = quoteQualified(mapped(ns, `sequence ${qualify(ns, s.name)}`), s.name);
    const bits = [`CREATE SEQUENCE ${target}`];
    if (s.dataType !== undefined) bits.push(`AS ${s.dataType}`);
    if (s.increment !== undefined) bits.push(`INCREMENT BY ${s.increment}`);
    if (s.minValue !== undefined) bits.push(`MINVALUE ${s.minValue}`);
    if (s.maxValue !== undefined) bits.push(`MAXVALUE ${s.maxValue}`);
    if (s.start !== undefined) bits.push(`START WITH ${s.start}`);
    if (s.cache !== undefined) bits.push(`CACHE ${s.cache}`);
    bits.push(s.cycle ? "CYCLE" : "NO CYCLE");
    sql.push(bits.join(" "));
  }

  const order = topoOrder(tables, byKey);
  const deferred: { decl: TableDecl; fk: FkDecl }[] = [];
  const created = new Set<string>();

  for (const decl of order) {
    const body = [...decl.columnLines];
    for (const fk of decl.fks) {
      const targetKey = qualify(fk.targetSchema, fk.targetTable);
      // Inline whenever the target already exists — a self-reference always does, PostgreSQL
      // accepts one inside its own CREATE TABLE — and defer only what genuinely cannot: the first
      // table of a cycle, whose target is created after it.
      if (targetKey === decl.key || created.has(targetKey)) body.push(fkClause(fk, mapped));
      else deferred.push({ decl, fk });
    }
    body.push(...decl.constraintLines);
    created.add(decl.key);
    const target = quoteQualified(mapped(decl.schema, `table ${decl.key}`), decl.name);

    const by = decl.runtime.extras.find((e) => e.node === "partitionBy");
    const partitionBy =
      by !== undefined && by.node === "partitionBy" ? ` PARTITION BY ${by.strategy.toUpperCase()} (${by.key})` : "";
    sql.push(`CREATE TABLE ${target} (\n  ${body.join(",\n  ")}\n)${partitionBy}`);

    /* A partition CHILD is created standalone and then ATTACHed, which is what `pg_dump`
     * emits and — on PostgreSQL 18 — the only form that round-trips. `CREATE TABLE …
     * PARTITION OF …` CLONES the parent's constraints, including the names: PG 18
     * catalogues NOT NULL as a `pg_constraint` row, so the child ends up with the parent's
     * `payment_amount_not_null` where a standalone child has its own
     * `payment_p2022_01_amount_not_null`, and the next `generate` plans a rename of an
     * inherited constraint, which PostgreSQL refuses. Found by pagila on PG 18. */
    const child = decl.runtime.extras.find((e) => e.node === "partitionOf");
    if (child !== undefined && child.node === "partitionOf") {
      const parentSchema = child.parentSchema ?? decl.schema;
      const parent = quoteQualified(mapped(parentSchema, `table ${qualify(parentSchema, child.parent)}`), child.parent);
      sql.push(`ALTER TABLE ${parent} ATTACH PARTITION ${target} ${child.bound}`);
    }
  }

  // The cycle breaker (design/11 §3 K2a: "deferred FKs for cycles").
  for (const { decl, fk } of deferred) {
    const target = quoteQualified(mapped(decl.schema, `table ${decl.key}`), decl.name);
    sql.push(`ALTER TABLE ${target} ADD ${fkClause(fk, mapped)}`);
  }

  const indexes: IndexDecl[] = [];
  const comments: CommentDecl[] = [];
  // Types first in the comment block (`0 …`), for the same reason the statements are sorted at
  // all: two runs over one registry must produce byte-identical SQL. `COMMENT ON TYPE` covers a
  // domain too — PostgreSQL resolves a domain name through the same `pg_type` lookup, and the
  // catalog side (`diff/ddl.ts` `commentTarget`) says `TYPE` for both, so the two renderers can
  // be compared statement for statement.
  for (const e of [...enums.values()].sort((a, b) => cmp(qualify(a.schema, a.name), qualify(b.schema, b.name)))) {
    if (e.comment === undefined) continue;
    const target = quoteQualified(mapped(e.schema, `type ${qualify(e.schema, e.name)}`), e.name);
    comments.push({
      target: `0 ${qualify(e.schema, e.name)}`,
      sql: `COMMENT ON TYPE ${target} IS ${quoteLiteral(e.comment)}`,
    });
  }
  for (const d of domains) {
    if (d.comment === undefined) continue;
    const ns = d.schema ?? defaultSchema;
    const target = quoteQualified(mapped(ns, `domain ${qualify(ns, d.name)}`), d.name);
    comments.push({
      target: `0 ${qualify(ns, d.name)}`,
      sql: `COMMENT ON TYPE ${target} IS ${quoteLiteral(d.comment)}`,
    });
  }
  for (const decl of tables) collectIndexesAndComments(decl, indexes, comments, mapped);

  for (const ix of indexes.sort((a, b) => cmp(qualify(a.schema, a.name), qualify(b.schema, b.name)))) {
    const target = quoteQualified(mapped(ix.schema, `index ${qualify(ix.schema, ix.name)}`), ix.table);
    sql.push(indexStatement(ix, target));
  }

  // `CLUSTER ON` after the indexes, because the index it names has to exist — and it is
  // very often a constraint's backing index, which `CREATE TABLE` already made.
  for (const decl of tables) {
    for (const extra of decl.runtime.extras) {
      if (extra.node !== "clusterOn") continue;
      const target = quoteQualified(mapped(decl.schema, `table ${decl.key}`), decl.name);
      sql.push(`ALTER TABLE ${target} CLUSTER ON ${quoteIdent(extra.index)}`);
    }
  }

  // `ALTER SEQUENCE … OWNED BY` last of the DDL: the column has to exist, and the ownership
  // is what makes a `serial`'s sequence die with its table instead of outliving it.
  for (const s of sequences) {
    if (s.ownedBy === undefined) continue;
    const ns = s.schema ?? defaultSchema;
    const ownerNs = s.ownedBy.schema ?? defaultSchema;
    const target = quoteQualified(mapped(ns, `sequence ${qualify(ns, s.name)}`), s.name);
    const owner = quoteQualified(mapped(ownerNs, `table ${qualify(ownerNs, s.ownedBy.table)}`), s.ownedBy.table);
    sql.push(`ALTER SEQUENCE ${target} OWNED BY ${owner}.${quoteIdent(s.ownedBy.column)}`);
  }

  for (const c of comments.sort((a, b) => cmp(a.target, b.target))) sql.push(c.sql);

  return { sql, diagnostics, schemas: [...userSchemas].sort(cmp) };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `CREATE [UNIQUE] INDEX n ON t [USING m] (cols) [INCLUDE (…)] [NULLS NOT DISTINCT] [WHERE …]`
 *
 * The clause order is PostgreSQL's own grammar, not a preference: `INCLUDE` before
 * `NULLS NOT DISTINCT` before `WHERE`, and the per-column `opclass ASC|DESC NULLS …`
 * order inside the parentheses. Getting it wrong is a syntax error on the shadow load,
 * which is the cheapest possible place to find out — but only if the order is right in
 * the first place for every combination, and `pg_get_indexdef` is what the round-trip
 * compares against.
 */
function indexStatement(ix: IndexDecl, target: string): string {
  const columns = ix.items
    .map((i) => {
      // An expression key is always parenthesised. PostgreSQL's grammar requires it for
      // anything but a bare column, and `pg_get_indexdef` drops the parentheses again for
      // an expression that looks like a function call — so the shadow, not this text, is
      // what the round-trip compares.
      const bits = [i.expression === undefined ? quoteIdent(i.column ?? "") : `(${i.expression})`];
      if (i.opclass !== undefined) bits.push(i.opclass);
      if (i.desc) bits.push("DESC");
      if (i.nulls !== undefined) bits.push(i.nulls === "first" ? "NULLS FIRST" : "NULLS LAST");
      return bits.join(" ");
    })
    .join(", ");
  const parts = [
    `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${quoteIdent(ix.name)} ON ${target}`,
    ...(ix.using === undefined ? [] : [`USING ${quoteIdent(ix.using)}`]),
    `(${columns})`,
    ...(ix.include.length === 0 ? [] : [`INCLUDE (${ix.include.map(quoteIdent).join(", ")})`]),
    ...(ix.nullsNotDistinct ? ["NULLS NOT DISTINCT"] : []),
    ...(ix.with === undefined ? [] : [`WITH (${storageParameters(ix.with)})`]),
    ...(ix.tablespace === undefined ? [] : [`TABLESPACE ${quoteIdent(ix.tablespace)}`]),
    ...(ix.where === undefined ? [] : [`WHERE (${ix.where})`]),
  ];
  return parts.join(" ");
}

/**
 * `WITH (fastupdate = false, fillfactor = 70)` — sorted by key, text values quoted.
 *
 * Sorted because a `Record`'s iteration order is the order the keys were WRITTEN, which makes
 * the emitted DDL depend on how the schema file happens to be typed; quoted because a
 * reloption's value is a string as far as the catalog is concerned (`pg_get_indexdef` prints
 * every one of them back as `k='v'`), and an unquoted value that is not a bare number or
 * boolean is a syntax error.
 */
function storageParameters(params: Readonly<Record<string, string | number | boolean>>): string {
  return Object.keys(params)
    .sort(cmp)
    .map((key) => {
      const value = params[key]!;
      const text = typeof value === "string" ? quoteLiteral(value) : String(value);
      return `${quoteIdent(key)} = ${text}`;
    })
    .join(", ");
}

function collectEnum(
  ref: RefRuntime,
  defaultSchema: string,
  enums: Map<string, EnumDecl>,
  diagnostics: Diagnostic[],
): void {
  const ddl = ref.column.ddl;
  if (ddl.enumName === undefined || ddl.enumValues === undefined) return;
  const schema = ddl.enumSchema ?? defaultSchema;
  const key = qualify(schema, ddl.enumName);
  const existing = enums.get(key);
  if (existing === undefined) {
    enums.set(key, { schema, name: ddl.enumName, values: [...ddl.enumValues], comment: undefined });
    return;
  }
  // Two `pgEnum` values with one name: the first wins and the disagreement is reported, because
  // silently picking either makes the emitted DDL depend on registry iteration order.
  if (existing.values.join(" ") !== ddl.enumValues.join(" ")) {
    diagnostics.push({
      code: "enum_conflict",
      severity: "error",
      message:
        `two enum declarations named ${key} disagree on their labels ` +
        `([${existing.values.join(", ")}] vs [${ddl.enumValues.join(", ")}])`,
      subject: key,
    });
  }
}

interface BuildContext {
  readonly defaultSchema: string;
  readonly mapped: (schema: string, subject: string) => string;
  /** the shadow map, WITHOUT the unmapped-schema diagnostic — see {@link remapTypeQualifier} */
  readonly rename: (schema: string) => string | undefined;
  /** every declared sequence, `schema.name`, for {@link remapNextval} */
  readonly sequences: ReadonlySet<string>;
  /** every `pgExtension(...)` the registry declares, by bare name, for `exclude().requires()` */
  readonly extensions: ReadonlySet<string>;
  readonly diagnostics: Diagnostic[];
  readonly byKey: ReadonlyMap<string, TableDecl>;
}

function buildTable(decl: TableDecl, ctx: BuildContext): void {
  const { runtime } = decl;
  /** Every constraint name this table hands out, so a collision is reported rather than executed. */
  const names = new Map<string, string>();
  const claim = (name: string, what: string): string => {
    const taken = names.get(name);
    if (taken !== undefined) {
      ctx.diagnostics.push({
        code: "constraint_name_collision",
        severity: "error",
        message:
          `${decl.key} names two constraints ${JSON.stringify(name)} (${taken} and ${what}). ` +
          `PostgreSQL would pick a uniquifying suffix; the emitter refuses to guess it.`,
        subject: decl.key,
      });
    } else {
      names.set(name, what);
    }
    return name;
  };

  const inlinePk: string[] = [];
  for (const ref of runtime.columns) {
    const ddl = ref.column.ddl;
    const typeSql = columnType(ddl, ctx, decl);
    const bits: string[] = [quoteIdent(ref.dbName), typeSql];

    if (ddl.generatedAs !== undefined) {
      // Opaque text, exactly like `defaultSql`: the tier-3 schema map is NOT applied to it
      // (design/11 K2b's rule), because a whole-identifier substitution cannot tell a schema
      // qualifier from a string literal, and a generation expression can contain both.
      bits.push(`GENERATED ALWAYS AS (${ddl.generatedAs}) STORED`);
    } else if (ddl.generatedAsFrom !== undefined) {
      ctx.diagnostics.push({
        code: "unresolved_generated",
        severity: "error",
        message:
          `${decl.key}.${ref.dbName}: .generatedAlwaysAs((cols) => …) was never resolved. ` +
          `pgTable() resolves it the moment the table's column names are known, so this column ` +
          `did not come from a pgTable(...) declaration.`,
        subject: decl.key,
      });
    } else if (ddl.identity !== undefined) {
      bits.push(`GENERATED ${ddl.identity === "always" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`);
    } else if (ddl.default !== undefined) {
      const subject = `${decl.key}.${ref.dbName}`;
      try {
        const text =
          ddl.default.kind === "expr"
            ? remapNextval(ddl.default.expr, ctx.rename, ctx.sequences, ctx.defaultSchema)
            : renderLiteral(ddl.default.value, ddl.pgType, subject, typeSql);
        bits.push(`DEFAULT ${text}`);
      } catch (err) {
        if (!(err instanceof EmitError)) throw err;
        ctx.diagnostics.push({
          code: "unrenderable_default",
          severity: "error",
          message: err.message,
          subject: decl.key,
        });
      }
    }
    if (ddl.notNull) bits.push("NOT NULL");

    if (ddl.primaryKey) inlinePk.push(ref.dbName);
    if (ddl.unique) {
      const name = claim(
        ddl.uniqueSpec?.name ?? makeObjectName(decl.name, ref.dbName, "key"),
        `unique on ${ref.dbName}`,
      );
      bits.push(
        `CONSTRAINT ${quoteIdent(name)} UNIQUE${ddl.uniqueSpec?.nullsNotDistinct ? " NULLS NOT DISTINCT" : ""}`,
      );
    }
    for (const [i, chk] of ddl.checks.entries()) {
      const name = claim(chk.name ?? makeObjectName(decl.name, ref.dbName, "check"), `check #${i} on ${ref.dbName}`);
      bits.push(`CONSTRAINT ${quoteIdent(name)} CHECK (${chk.expression})`);
    }
    if (ddl.references !== undefined) {
      const targets = ddl.references.target();
      const fk = resolveFk(
        {
          name: ddl.references.name ?? makeObjectName(decl.name, ref.dbName, "fkey"),
          columns: [ref.dbName],
          targets,
          onDelete: ddl.references.onDelete,
          onUpdate: ddl.references.onUpdate,
          deferrable: ddl.references.deferrable,
          initiallyDeferred: ddl.references.initiallyDeferred,
        },
        decl,
        ctx,
      );
      if (fk) decl.fks.push({ ...fk, name: claim(fk.name, `references on ${ref.dbName}`) });
    }

    decl.columnLines.push(bits.join(" "));
  }

  /* ---- table-level nodes ---- */

  const pkColumns: string[] = [...inlinePk];
  const constraints: { sort: string; text: string }[] = [];

  for (const extra of runtime.extras) {
    switch (extra.node) {
      case "primaryKey": {
        if (pkColumns.length > 0) {
          ctx.diagnostics.push({
            code: "duplicate_primary_key",
            severity: "error",
            message: `${decl.key} declares a primary key twice (a column .primaryKey() and a primaryKey() extra)`,
            subject: decl.key,
          });
          break;
        }
        pkColumns.push(...extra.columns);
        break;
      }
      case "unique": {
        const name = claim(
          extra.name ?? makeObjectName(decl.name, extra.columns.join("_"), "key"),
          `unique on (${extra.columns.join(", ")})`,
        );
        constraints.push({
          sort: `2 ${name}`,
          text:
            `CONSTRAINT ${quoteIdent(name)} UNIQUE${extra.nullsNotDistinct ? " NULLS NOT DISTINCT" : ""} ` +
            `(${extra.columns.map(quoteIdent).join(", ")})`,
        });
        break;
      }
      case "check": {
        const name = claim(extra.name, `check ${extra.name}`);
        constraints.push({
          sort: `3 ${name}`,
          text: `CONSTRAINT ${quoteIdent(name)} CHECK (${extra.expression})`,
        });
        break;
      }
      case "foreignKey": {
        const fk = resolveFk(
          {
            name: extra.name ?? makeObjectName(decl.name, extra.columns.join("_"), "fkey"),
            columns: extra.columns,
            targets: extra.references(),
            onDelete: extra.onDelete,
            onUpdate: extra.onUpdate,
            deferrable: extra.deferrable,
            initiallyDeferred: extra.initiallyDeferred,
          },
          decl,
          ctx,
        );
        if (fk) decl.fks.push({ ...fk, name: claim(fk.name, `foreignKey on (${extra.columns.join(", ")})`) });
        break;
      }
      case "exclude": {
        const name = claim(extra.name, `exclude ${extra.name}`);
        if (extra.items.length === 0) {
          ctx.diagnostics.push({
            code: "empty_exclude",
            severity: "error",
            message: `${decl.key}: exclude("${extra.name}") has no elements`,
            subject: decl.key,
          });
          break;
        }
        if (extra.requires !== undefined && !ctx.extensions.has(extra.requires)) {
          ctx.diagnostics.push({
            code: "missing_required_extension",
            severity: "error",
            message:
              `${decl.key}: exclude("${extra.name}").requires("${extra.requires}") names an extension ` +
              `this schema does not declare. Add pgExtension("${extra.requires}") and export it, or the ` +
              `CREATE EXTENSION never runs and the operator class resolves to a 42704 on the shadow.`,
            subject: decl.key,
          });
          break;
        }
        // PostgreSQL's own clause order: USING, the element list, WHERE, then deferrability.
        const bits = [`CONSTRAINT ${quoteIdent(name)} EXCLUDE`];
        if (extra.using !== undefined) bits.push(`USING ${quoteIdent(extra.using)}`);
        bits.push(`(${extra.items.map((i) => `${i.element} WITH ${i.operator}`).join(", ")})`);
        if (extra.where !== undefined) bits.push(`WHERE (${extra.where})`);
        if (extra.deferrable) {
          bits.push(extra.initiallyDeferred ? "DEFERRABLE INITIALLY DEFERRED" : "DEFERRABLE");
        }
        constraints.push({ sort: `4 ${name}`, text: bits.join(" ") });
        break;
      }
      // `index` / `uniqueIndex` / `clusterOn` are separate statements; `comment` and
      // `renamedFrom` are not DDL of the table itself; `partitionBy` / `partitionOf` are
      // read directly off the runtime when the CREATE TABLE is assembled. All are handled
      // after every table exists.
      case "index":
      case "comment":
      case "renamedFrom":
      case "clusterOn":
      case "partitionBy":
      case "partitionOf":
        break;
      default:
        ctx.diagnostics.push({
          code: "unsupported_extra",
          severity: "warning",
          message: `${decl.key}: table node '${(extra as { node: string }).node}' is not emitted yet`,
          subject: decl.key,
        });
    }
  }

  if (pkColumns.length > 0) {
    // The declared name when there is one (design/05 §2.4's `{ name, columns }` form),
    // otherwise the server's own `<table>_pkey`. An adopted database names its primary
    // keys whatever the tool that created them chose, and `pull` has to be able to say so.
    const declaredPkName = runtime.extras.find((e) => e.node === "primaryKey" && e.name !== undefined);
    const name = claim(
      (declaredPkName as { name?: string } | undefined)?.name ?? makeObjectName(decl.name, null, "pkey"),
      "primary key",
    );
    constraints.push({
      sort: `1 ${name}`,
      text: `CONSTRAINT ${quoteIdent(name)} PRIMARY KEY (${pkColumns.map(quoteIdent).join(", ")})`,
    });
  }

  constraints.sort((a, b) => cmp(a.sort, b.sort));
  decl.constraintLines.push(...constraints.map((c) => c.text));
  decl.fks.sort((a, b) => cmp(a.name, b.name));
}

/**
 * `public.money_amount` → `pgprime_shadow_ab12_public.money_amount` under the tier-3 map.
 *
 * `t.raw('public.money_amount')` and `pgDomain(…, 'public.other_domain')` are the two places
 * a user type's SCHEMA reaches the emitter as text rather than as a field, and design/11
 * §1.6's rule — "the emitter is always schema-qualified, so the map is applied at emit
 * time" — has to hold for them too, or a project with a single domain cannot use shadow
 * tier 3 at all. This is the one whole-identifier substitution that is safe to do on text:
 * the string is a **type reference** and nothing else, so there is no literal for a
 * qualifier to hide in. `numeric(12,2)` and `character varying(40)` have no qualifier and
 * come back untouched.
 */
export function remapTypeQualifier(type: string, rename: (schema: string) => string | undefined): string {
  const m = /^\s*(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*))\s*\.\s*(.+)$/s.exec(type);
  if (m === null) return type;
  const schema = m[1] === undefined ? m[2]! : m[1].replace(/""/g, '"');
  // An UNMAPPED schema keeps its own name — a type in a schema outside the managed set
  // (`extensions.citext`) is not the emitter's to move — but the qualifier is quoted either
  // way, so the mapped and unmapped emits differ in the schema NAME and nothing else.
  // `emit.test.ts` unmaps the tier-3 output and compares it to the tier-1 one, and that
  // comparison is only meaningful if the two spellings are otherwise identical.
  return `${quoteIdent(rename(schema) ?? schema)}.${m[3]!}`;
}

/**
 * `nextval('public.tickets_no_seq'::regclass)` → the shadow's own sequence, under tier 3.
 *
 * `defaultSql` is opaque text and the emitter does NOT rewrite it — design/11 K2b's rule,
 * because a whole-identifier substitution cannot tell `public` the schema from `'public'`
 * inside a string literal. This is the one exception, and it is narrow enough to be safe:
 * the rewritten thing is a `regclass` literal, its content is *parsed* as a qualified name
 * rather than string-matched, and it is only touched when that name is a sequence THIS
 * REGISTRY declares. Without it a `serial`-shaped column in a temp-schema shadow points at
 * the real database's sequence and the desired IR silently loses the `column → sequence`
 * dependency edge — a fingerprint difference with no visible delta, which is the worst kind.
 */
export function remapNextval(
  expr: string,
  rename: (schema: string) => string | undefined,
  declared: ReadonlySet<string>,
  defaultSchema: string,
): string {
  return expr.replace(
    /nextval\(\s*'((?:[^']|'')*)'(\s*::\s*regclass)?\s*\)/gi,
    (whole: string, literal: string, cast?: string) => {
      const name = literal.replace(/''/g, "'");
      const parts =
        /^(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*))(?:\s*\.\s*(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*)))?$/.exec(
          name,
        );
      if (parts === null) return whole;
      const first = parts[1] === undefined ? parts[2]! : parts[1].replace(/""/g, '"');
      const second = parts[3] === undefined ? parts[4] : parts[3].replace(/""/g, '"');
      const schema = second === undefined ? defaultSchema : first;
      const sequence = second ?? first;
      if (!declared.has(`${schema}.${sequence}`)) return whole;
      // Quoted and qualified whether or not the schema moves, for `remapTypeQualifier`'s reason.
      return `nextval('${quoteQualified(rename(schema) ?? schema, sequence).replace(/'/g, "''")}'${cast ?? "::regclass"})`;
    },
  );
}

/** The declared PostgreSQL type of a column, schema-qualified when it is a user type. */
function columnType(ddl: ColumnDdl, ctx: BuildContext, decl: TableDecl): string {
  if (ddl.enumName === undefined) return remapTypeQualifier(ddl.pgType, ctx.rename);
  const schema = ctx.mapped(
    ddl.enumSchema ?? ctx.defaultSchema,
    `type ${qualify(ddl.enumSchema ?? ctx.defaultSchema, ddl.enumName)} used by ${decl.key}`,
  );
  return `${quoteQualified(schema, ddl.enumName)}${"[]".repeat(ddl.arrayDim)}`;
}

interface FkInput {
  readonly name: string;
  readonly columns: readonly string[];
  readonly targets: readonly {
    readonly $: { readonly table: string; readonly schema: string | undefined; readonly dbName: string };
  }[];
  readonly onDelete: string | undefined;
  readonly onUpdate: string | undefined;
  readonly deferrable: boolean;
  readonly initiallyDeferred: boolean;
}

function resolveFk(input: FkInput, decl: TableDecl, ctx: BuildContext): FkDecl | undefined {
  const targets = input.targets;
  if (targets.length === 0) {
    ctx.diagnostics.push({
      code: "foreign_key_unresolved",
      severity: "error",
      message: `${decl.key}: the references thunk of ${input.name} returned no columns`,
      subject: decl.key,
    });
    return undefined;
  }
  if (targets.length !== input.columns.length) {
    ctx.diagnostics.push({
      code: "foreign_key_arity",
      severity: "error",
      message:
        `${decl.key}: ${input.name} has ${input.columns.length} local column(s) and ` +
        `${targets.length} referenced column(s); a foreign key pairs them positionally`,
      subject: decl.key,
    });
    return undefined;
  }
  const first = targets[0]!.$;
  const targetSchema = first.schema ?? ctx.defaultSchema;
  for (const t of targets) {
    if (t.$.table !== first.table || (t.$.schema ?? ctx.defaultSchema) !== targetSchema) {
      ctx.diagnostics.push({
        code: "foreign_key_split",
        severity: "error",
        message: `${decl.key}: ${input.name} references columns of more than one table`,
        subject: decl.key,
      });
      return undefined;
    }
  }
  if (!ctx.byKey.has(qualify(targetSchema, first.table))) {
    // A thunk that resolves to a table outside the registry cannot be emitted: under the tier-3
    // schema map its schema is rewritten too, so the reference would name a table that does not
    // exist in the shadow. The registry is the whole desired state (design/05 D11).
    ctx.diagnostics.push({
      code: "foreign_key_target_unknown",
      severity: "error",
      message:
        `${decl.key}: ${input.name} references ${qualify(targetSchema, first.table)}, which is not ` +
        `in the schema registry`,
      subject: decl.key,
    });
    return undefined;
  }
  return {
    name: input.name,
    columns: input.columns,
    targetSchema,
    targetTable: first.table,
    targetColumns: targets.map((t) => t.$.dbName),
    onDelete: input.onDelete,
    onUpdate: input.onUpdate,
    deferrable: input.deferrable,
    initiallyDeferred: input.initiallyDeferred,
  };
}

function fkClause(fk: FkDecl, mapped: (s: string, subject: string) => string): string {
  const target = quoteQualified(
    mapped(fk.targetSchema, `table ${qualify(fk.targetSchema, fk.targetTable)}`),
    fk.targetTable,
  );
  const bits = [
    `CONSTRAINT ${quoteIdent(fk.name)} FOREIGN KEY (${fk.columns.map(quoteIdent).join(", ")})`,
    `REFERENCES ${target} (${fk.targetColumns.map(quoteIdent).join(", ")})`,
  ];
  if (fk.onUpdate !== undefined) bits.push(`ON UPDATE ${fk.onUpdate.toUpperCase()}`);
  if (fk.onDelete !== undefined) bits.push(`ON DELETE ${fk.onDelete.toUpperCase()}`);
  if (fk.deferrable) bits.push(fk.initiallyDeferred ? "DEFERRABLE INITIALLY DEFERRED" : "DEFERRABLE");
  return bits.join(" ");
}

function collectIndexesAndComments(
  decl: TableDecl,
  indexes: IndexDecl[],
  comments: CommentDecl[],
  mapped: (schema: string, subject: string) => string,
): void {
  // Sorted on the USER's schema names, so the statement order does not change when the tier does;
  // the identifier that is WRITTEN is the mapped one, because a COMMENT that missed the map would
  // document a table in the real database.
  const target = `${decl.schema}.${decl.name}`;
  const qualified = quoteQualified(mapped(decl.schema, `table ${decl.key}`), decl.name);
  for (const extra of decl.runtime.extras) {
    if (extra.node === "index") {
      indexes.push({
        schema: decl.schema,
        table: decl.name,
        name: extra.name,
        unique: extra.unique,
        columns: extra.columns,
        // `items` is absent on an extras array built before the options landed (a hand-made
        // `{ node: 'index', … }` in a test, or an older `pg-prime` on the peer range), so
        // the plain column list is the fallback rather than a crash.
        items:
          extra.items ??
          extra.columns.map((column) => ({
            column,
            expression: undefined,
            desc: false,
            nulls: undefined,
            opclass: undefined,
          })),
        using: extra.using,
        where: extra.where,
        include: extra.include ?? [],
        nullsNotDistinct: extra.nullsNotDistinct === true,
        with: extra.with,
        tablespace: extra.tablespace,
      });
    } else if (extra.node === "comment") {
      comments.push({
        target: `1 ${target}`,
        sql: `COMMENT ON TABLE ${qualified} IS ${quoteLiteral(extra.text)}`,
      });
    }
  }
  for (const ref of decl.runtime.columns) {
    const text = ref.column.ddl.comment;
    if (text === undefined) continue;
    comments.push({
      target: `2 ${target} ${ref.dbName}`,
      sql: `COMMENT ON COLUMN ${qualified}.${quoteIdent(ref.dbName)} IS ${quoteLiteral(text)}`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* dependency order                                                    */
/* ------------------------------------------------------------------ */

/**
 * Tarjan's SCC, iterative.
 *
 * Tarjan emits a component only once every component reachable from it has already been emitted,
 * so its output order *is* the dependency order — no second topological pass. Roots are visited in
 * sorted key order and each component's members are sorted, so two runs over the same registry
 * produce byte-identical SQL whatever order the registry object was built in.
 */
function topoOrder(tables: readonly TableDecl[], byKey: ReadonlyMap<string, TableDecl>): TableDecl[] {
  const keys = tables.map((t) => t.key);
  const succ = new Map<string, string[]>();
  for (const t of tables) {
    const out = new Set<string>();
    for (const fk of t.fks) {
      const target = qualify(fk.targetSchema, fk.targetTable);
      if (target !== t.key && byKey.has(target)) out.add(target);
    }
    // A partition child depends on its parent absolutely — `CREATE TABLE … PARTITION OF`
    // is not deferrable the way an FK is, so this edge is not optional.
    const child = t.runtime.extras.find((e) => e.node === "partitionOf");
    if (child !== undefined && child.node === "partitionOf") {
      const parent = qualify(child.parentSchema ?? t.schema, child.parent);
      if (parent !== t.key && byKey.has(parent)) out.add(parent);
    }
    succ.set(t.key, [...out].sort(cmp));
  }

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const order: TableDecl[] = [];
  let counter = 0;

  for (const root of keys) {
    if (index.has(root)) continue;
    // Explicit work stack: a 5 000-table registry must not depend on the JS call stack.
    const work: { node: string; edge: number }[] = [{ node: root, edge: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const edges = succ.get(frame.node) ?? [];
      if (frame.edge < edges.length) {
        const next = edges[frame.edge]!;
        frame.edge += 1;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, edge: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const members: string[] = [];
        for (;;) {
          const m = stack.pop()!;
          onStack.delete(m);
          members.push(m);
          if (m === frame.node) break;
        }
        members.sort(cmp);
        for (const m of members) order.push(byKey.get(m)!);
      }
    }
  }

  return order;
}
