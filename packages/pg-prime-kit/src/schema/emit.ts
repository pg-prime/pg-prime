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
    .sort((a, b) =>
      cmp(`${a.schema ?? defaultSchema} ${a.name}`, `${b.schema ?? defaultSchema} ${b.name}`),
    );

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

  for (const decl of tables) buildTable(decl, { defaultSchema, mapped, diagnostics, byKey });

  /* ---- 3. emit ---- */

  const sql: string[] = [];

  // schemas first: a mapped shadow schema may not exist yet, and `public` always does.
  const emitSchemas = [
    ...new Set([
      ...tables.map((t) => mapped(t.schema, `table ${t.key}`)),
      ...[...enums.values()].map((e) => mapped(e.schema, `type ${qualify(e.schema, e.name)}`)),
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
    sql.push(`CREATE TABLE ${target} (\n  ${body.join(",\n  ")}\n)`);
  }

  // The cycle breaker (design/11 §3 K2a: "deferred FKs for cycles").
  for (const { decl, fk } of deferred) {
    const target = quoteQualified(mapped(decl.schema, `table ${decl.key}`), decl.name);
    sql.push(`ALTER TABLE ${target} ADD ${fkClause(fk, mapped)}`);
  }

  const indexes: IndexDecl[] = [];
  const comments: CommentDecl[] = [];
  for (const decl of tables) collectIndexesAndComments(decl, indexes, comments, mapped);

  for (const ix of indexes.sort((a, b) => cmp(qualify(a.schema, a.name), qualify(b.schema, b.name)))) {
    const target = quoteQualified(mapped(ix.schema, `index ${qualify(ix.schema, ix.name)}`), ix.table);
    sql.push(
      `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${quoteIdent(ix.name)} ON ${target} ` +
        `(${ix.columns.map(quoteIdent).join(", ")})`,
    );
  }

  for (const c of comments.sort((a, b) => cmp(a.target, b.target))) sql.push(c.sql);

  return { sql, diagnostics, schemas: [...userSchemas].sort(cmp) };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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
    enums.set(key, { schema, name: ddl.enumName, values: [...ddl.enumValues] });
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

    if (ddl.identity !== undefined) {
      bits.push(`GENERATED ${ddl.identity === "always" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`);
    } else if (ddl.default !== undefined) {
      const subject = `${decl.key}.${ref.dbName}`;
      try {
        const text =
          ddl.default.kind === "expr"
            ? ddl.default.expr
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
      const name = claim(
        chk.name ?? makeObjectName(decl.name, ref.dbName, "check"),
        `check #${i} on ${ref.dbName}`,
      );
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
      // `index` / `uniqueIndex` are separate statements; `comment` and `renamedFrom` are not DDL
      // of the table itself. Both are collected after every table exists.
      case "index":
      case "comment":
      case "renamedFrom":
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
    const name = claim(makeObjectName(decl.name, null, "pkey"), "primary key");
    constraints.push({
      sort: `1 ${name}`,
      text: `CONSTRAINT ${quoteIdent(name)} PRIMARY KEY (${pkColumns.map(quoteIdent).join(", ")})`,
    });
  }

  constraints.sort((a, b) => cmp(a.sort, b.sort));
  decl.constraintLines.push(...constraints.map((c) => c.text));
  decl.fks.sort((a, b) => cmp(a.name, b.name));
}

/** The declared PostgreSQL type of a column, schema-qualified when it is a user type. */
function columnType(ddl: ColumnDdl, ctx: BuildContext, decl: TableDecl): string {
  if (ddl.enumName === undefined) return ddl.pgType;
  const schema = ctx.mapped(
    ddl.enumSchema ?? ctx.defaultSchema,
    `type ${qualify(ddl.enumSchema ?? ctx.defaultSchema, ddl.enumName)} used by ${decl.key}`,
  );
  return `${quoteQualified(schema, ddl.enumName)}${"[]".repeat(ddl.arrayDim)}`;
}

interface FkInput {
  readonly name: string;
  readonly columns: readonly string[];
  readonly targets: readonly { readonly $: { readonly table: string; readonly schema: string | undefined; readonly dbName: string } }[];
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
function topoOrder(
  tables: readonly TableDecl[],
  byKey: ReadonlyMap<string, TableDecl>,
): TableDecl[] {
  const keys = tables.map((t) => t.key);
  const succ = new Map<string, string[]>();
  for (const t of tables) {
    const out = new Set<string>();
    for (const fk of t.fks) {
      const target = qualify(fk.targetSchema, fk.targetTable);
      if (target !== t.key && byKey.has(target)) out.add(target);
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
