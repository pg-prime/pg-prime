/**
 * IR → a TypeScript schema file, in the DSL's own spelling — design/06 §6.2's twelfth
 * command, design/12 decision 15.
 *
 * Three properties this file exists to guarantee, all three checked by
 * `test/pull/roundtrip.test.ts` rather than asserted here:
 *
 *  1. **Deterministic.** Every list is sorted on something that is a property of the
 *     schema, never of the extraction: schemas, types, sequences and extensions by
 *     qualified name; tables in FK dependency order with ties broken by name; columns by
 *     `attnum` (which is observable through `pg_dump`, so it is semantic); extras by kind
 *     then name. A second `pull` over the result is byte-identical.
 *  2. **Round-tripping.** What comes out, loaded through `loadSchema` and emitted by
 *     `schema/emit.ts`, produces the same IR — so `generate` against the same database
 *     reports an empty diff. Where that cannot be guaranteed, the object goes into
 *     `unsupported` instead of being emitted approximately. An approximate emission is
 *     worse than an honest gap: it produces a migration that silently changes the object.
 *  3. **Explicit.** Every column carries its DB name as an argument
 *     (`t.text('last_name')`), never as something inferred from the TS key by a casing
 *     strategy — the TS key is an alias `pull` invented and the DB name is data.
 *
 * The type mapping is an EXACT-MATCH table and nothing else. `format_type` output that is
 * not one of eleven strings becomes `t.raw('<the exact text>')`, which the emitter writes
 * verbatim and PostgreSQL parses back to the same type. Guessing that `character
 * varying(40)` is "a varchar, near enough" is how a pull silently drops a length limit.
 */

import type {
  ColumnPayload,
  ConstraintPayload,
  DefaultPayload,
  ExtensionPayload,
  IndexPayload,
  SequencePayload,
  TablePayload,
  TypePayload,
} from "../catalog/payloads.js";
import type { Fact, SchemaIR } from "../ir/fact.js";
import { encodeId, idName, parseId, type StableId } from "../ir/stable-id.js";
import { splitIdentifierList, parseConstraintDef, parseIndexDef, type IndexItemSpec } from "./parse.js";

export interface UnsupportedItem {
  readonly kind: string;
  readonly name: string;
  readonly reason: string;
}

export interface EmitTsResult {
  readonly ts: string;
  readonly unsupported: readonly UnsupportedItem[];
  readonly counts: Readonly<Record<string, number>>;
}

export interface EmitTsOptions {
  readonly schemas: readonly string[];
  /** relative POSIX path from the emitted file to the `sql/` directory, for the header note */
  readonly sqlDir?: string;
  /** how many Tier-R objects went to `sql/`, for the header note */
  readonly repeatableCount?: number;
  /**
   * Residue the caller found that the IR cannot show — a Tier-R object with nowhere to go
   * because `--sql-dir` was absent.
   *
   * Passed IN rather than appended to the result, because the `-- pull: unsupported` block
   * is part of the emitted file: a residue discovered afterwards and stapled onto the
   * report only would make the file and the report disagree, and the file is the thing a
   * reviewer reads.
   */
  readonly extraUnsupported?: readonly UnsupportedItem[];
}

/* ------------------------------ identifiers ------------------------------- */

const RESERVED = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "let",
  "static",
  "yield",
  "await",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "as",
  "any",
  "boolean",
  "constructor",
  "declare",
  "get",
  "module",
  "require",
  "number",
  "set",
  "string",
  "symbol",
  "type",
  "from",
  "of",
]);

/** `film_actor` → `filmActor`, `"Order Details"` → `orderDetails`, `2fast` → `_2fast`. */
export function camel(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter((p) => p !== "");
  if (parts.length === 0) return "_";
  const head = parts[0]!;
  // An already-camelCased or PascalCased source is left alone apart from its first letter:
  // `BusinessEntityID` must not become `businessentityid`.
  const first = /[a-z]/.test(head) ? `${head.charAt(0).toLowerCase()}${head.slice(1)}` : head.toLowerCase();
  const rest = parts
    .slice(1)
    .map((p) => `${p.charAt(0).toUpperCase()}${/[a-z]/.test(p) ? p.slice(1) : p.slice(1).toLowerCase()}`);
  const out = [first, ...rest].join("");
  return /^[0-9]/.test(out) ? `_${out}` : out;
}

/** A unique, legal JS identifier for a top-level `export const`. */
class Names {
  readonly #taken = new Set<string>();
  claim(preferred: string): string {
    let base = camel(preferred);
    if (base.startsWith("$") || base === "") base = `_${base}`;
    if (RESERVED.has(base)) base = `${base}_`;
    let name = base;
    let n = 2;
    while (this.#taken.has(name)) name = `${base}${String(n++)}`;
    this.#taken.add(name);
    return name;
  }
}

const lit = (s: string): string => JSON.stringify(s);

/* ------------------------------ type mapping ------------------------------ */

/**
 * `format_type` output → the builder that emits EXACTLY that type back.
 *
 * Exact strings only. `character varying(40)` is deliberately absent: it is not
 * `t.varchar()`, and pretending otherwise loses the length.
 */
const BUILDERS: ReadonlyMap<string, string> = new Map([
  ["uuid", "uuid"],
  ["text", "text"],
  ["character varying", "varchar"],
  ["integer", "integer"],
  ["smallint", "smallint"],
  ["bigint", "bigint"],
  ["boolean", "boolean"],
  ["timestamp with time zone", "timestamptz"],
  ["date", "date"],
  ["numeric", "numeric"],
  ["jsonb", "jsonb"],
]);

/* --------------------------------- the emit -------------------------------- */

interface TableCtx {
  readonly schema: string;
  readonly name: string;
  readonly constName: string;
  /** db column name → TS key */
  readonly keys: ReadonlyMap<string, string>;
}

export function emitTypeScript(ir: SchemaIR, options: EmitTsOptions): EmitTsResult {
  const unsupported: UnsupportedItem[] = [...(options.extraUnsupported ?? [])];
  const names = new Names();
  /** Set when a `sql.unsafeRaw(...)` reaches the output, so the import is only there if used. */
  let needsSql = false;
  /** Set when a cross-table FK thunk needs its return type stated (design/05 §2.3). */
  let needsRefLike = false;
  const counts: Record<string, number> = {};
  const bump = (kind: string): void => void (counts[kind] = (counts[kind] ?? 0) + 1);
  const drop = (kind: string, name: string, reason: string): void => {
    unsupported.push({ kind, name, reason });
  };

  const payload = <T>(f: Fact): T => f.payload as unknown as T;
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const qualified = (id: StableId): string => `${(id as { schema: string }).schema}.${idName(id)}`;

  /* ---- comments, indexed by encoded target ---- */
  const comments = new Map<string, string>();
  for (const f of ir.factsOfKind("comment")) {
    if (f.id.kind !== "comment") continue;
    comments.set(f.id.target, (f.payload as unknown as { text: string }).text);
  }

  /* ---- schemas ---- */
  const schemaFacts = ir
    .factsOfKind("schema")
    .filter((f) => idName(f.id) !== "public")
    .sort((a, b) => cmp(idName(a.id), idName(b.id)));
  const schemaConst = new Map<string, string>();
  for (const f of schemaFacts) schemaConst.set(idName(f.id), names.claim(idName(f.id)));

  /* ---- extensions ---- */
  const extensions = ir.factsOfKind("extension").sort((a, b) => cmp(idName(a.id), idName(b.id)));

  /* ---- types: enum, domain, composite ---- */
  const enumConst = new Map<string, string>();
  const enumFacts: Fact[] = [];
  const domainFacts: Fact[] = [];
  for (const f of ir.factsOfKind("type").sort((a, b) => cmp(qualified(a.id), qualified(b.id)))) {
    const p = payload<TypePayload>(f);
    if (p.typtype === "e") enumFacts.push(f);
    else if (p.typtype === "d") domainFacts.push(f);
    else {
      drop("composite type", qualified(f.id), "the DSL has no `pgCompositeType` (design/05 §3.4 is not built)");
    }
  }
  for (const f of enumFacts) enumConst.set(qualified(f.id), names.claim(idName(f.id)));
  const domainConst = new Map<string, string>();
  for (const f of domainFacts) domainConst.set(qualified(f.id), names.claim(idName(f.id)));

  /* ---- sequences ---- */
  const sequenceFacts = ir.factsOfKind("sequence").sort((a, b) => cmp(qualified(a.id), qualified(b.id)));
  const sequenceConst = new Map<string, string>();
  for (const f of sequenceFacts) sequenceConst.set(qualified(f.id), names.claim(idName(f.id)));

  /* ---- tables ---- */
  const tableFacts = ir.factsOfKind("table").sort((a, b) => cmp(qualified(a.id), qualified(b.id)));
  const emittable: Fact[] = [];
  for (const f of tableFacts) {
    const p = payload<TablePayload>(f);
    const name = qualified(f.id);
    if (p.relkind === "p" && p.partitionKey === null) {
      drop("partitioned table", name, "pg_get_partkeydef returned nothing for a partitioned parent");
      continue;
    }
    if (p.persistence !== "p") {
      drop("table", name, `relpersistence '${p.persistence}' — the DSL has no \`unlogged()\``);
      continue;
    }
    if (p.partitionOf !== null && p.partitionBound === null) {
      drop("partition", name, "the catalog gives no partition bound for a relation marked as a partition");
      continue;
    }
    if (p.rowSecurity) {
      // Not a reason to drop the table: RLS enablement is written to `sql/` as a Tier-R
      // repeatable, so the desired state still has it.
      bump("rlsTable");
    }
    emittable.push(f);
  }
  const tableConst = new Map<string, string>();
  for (const f of emittable) tableConst.set(qualified(f.id), names.claim(idName(f.id)));

  /* ---- dependency order over the emittable tables ---- */
  const ordered = dependencyOrder(ir, emittable, cmp);

  /* ---- render ---- */
  const needs = new Set<string>(["defineSchema", "pgTable"]);
  const body: string[] = [];

  for (const f of schemaFacts) {
    needs.add("pgSchema");
    body.push(`export const ${schemaConst.get(idName(f.id))!} = pgSchema(${lit(idName(f.id))})`);
    bump("schema");
  }
  if (schemaFacts.length > 0) body.push("");

  for (const f of extensions) {
    needs.add("pgExtension");
    const p = payload<ExtensionPayload>(f);
    body.push(
      `export const ${names.claim(`ext_${idName(f.id)}`)} = pgExtension(${lit(idName(f.id))}, { schema: ${lit(p.schema)} })`,
    );
    bump("extension");
  }
  if (extensions.length > 0) body.push("");

  for (const f of enumFacts) {
    needs.add("pgEnum");
    const labels = ir
      .childrenOf(f.id)
      .filter((c) => c.id.kind === "enumLabel")
      .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
      .map((c) => lit(idName(c.id)));
    const schema = (f.id as { schema: string }).schema;
    const enumOpts: string[] = [];
    if (schema !== "public") enumOpts.push(`schema: ${lit(schema)}`);
    const enumComment = comments.get(encodeId(f.id));
    if (enumComment !== undefined) enumOpts.push(`comment: ${lit(enumComment)}`);
    const opts = enumOpts.length === 0 ? "" : `, { ${enumOpts.join(", ")} }`;
    body.push(
      `export const ${enumConst.get(qualified(f.id))!} = pgEnum(${lit(idName(f.id))}, [${labels.join(", ")}]${opts})`,
    );
    bump("enum");
  }
  if (enumFacts.length > 0) body.push("");

  for (const f of domainFacts) {
    needs.add("pgDomain");
    const p = payload<TypePayload>(f);
    const schema = (f.id as { schema: string }).schema;
    const opts: string[] = [];
    if (schema !== "public") opts.push(`schema: ${lit(schema)}`);
    if (p.notNull === true) opts.push("notNull: true");
    if (p.default !== null) opts.push(`default: ${lit(p.default)}`);
    if (p.collation !== null) opts.push(`collation: ${lit(p.collation)}`);
    const domainComment = comments.get(encodeId(f.id));
    if (domainComment !== undefined) opts.push(`comment: ${lit(domainComment)}`);
    // `TypePayload.checks` holds `<name> <pg_get_constraintdef>` pairs, and the
    // constraintdef is the whole `CHECK ((VALUE > 0))`. The DSL takes the EXPRESSION and
    // writes the `CHECK (…)` itself, so the wrapper is unwrapped here — with the same
    // recogniser the table constraints use, not a regex that would eat a `)` in a literal.
    const checks: { name: string; expression: string }[] = [];
    for (const c of p.checks ?? []) {
      const space = c.indexOf(" ");
      const name = space === -1 ? c : c.slice(0, space);
      const rest = space === -1 ? "" : c.slice(space + 1);
      const parsed = parseConstraintDef("c", rest);
      if (parsed === null || parsed.kind !== "check") {
        drop(
          "domain check",
          `${qualified(f.id)}.${name}`,
          `pg_get_constraintdef could not be mapped to the DSL: ${rest}`,
        );
        continue;
      }
      checks.push({ name, expression: parsed.expression });
    }
    if (checks.length > 0) {
      opts.push(
        `checks: [${checks.map((c) => `{ name: ${lit(c.name)}, expression: ${lit(c.expression)} }`).join(", ")}]`,
      );
    }
    body.push(
      `export const ${domainConst.get(qualified(f.id))!} = pgDomain(${lit(idName(f.id))}, ${lit(p.baseType ?? "text")}` +
        `${opts.length === 0 ? "" : `, { ${opts.join(", ")} }`})`,
    );
    bump("domain");
  }
  if (domainFacts.length > 0) body.push("");

  for (const f of sequenceFacts) {
    needs.add("pgSequence");
    const p = payload<SequencePayload>(f);
    const schema = (f.id as { schema: string }).schema;
    const opts: string[] = [];
    if (schema !== "public") opts.push(`schema: ${lit(schema)}`);
    opts.push(`dataType: ${lit(p.dataType)}`);
    opts.push(`start: ${lit(p.start)}`, `increment: ${lit(p.increment)}`);
    opts.push(`minValue: ${lit(p.minValue)}`, `maxValue: ${lit(p.maxValue)}`, `cache: ${lit(p.cache)}`);
    if (p.cycle) opts.push("cycle: true");
    if (p.ownedBy !== null) {
      const owner = parseId(p.ownedBy);
      if (owner.kind === "column") {
        const bits = [
          ...(owner.schema === "public" ? [] : [`schema: ${lit(owner.schema)}`]),
          `table: ${lit(owner.table)}`,
          `column: ${lit(owner.name)}`,
        ];
        opts.push(`ownedBy: { ${bits.join(", ")} }`);
      }
    }
    body.push(
      `export const ${sequenceConst.get(qualified(f.id))!} = pgSequence(${lit(idName(f.id))}, { ${opts.join(", ")} })`,
    );
    bump("sequence");
  }
  if (sequenceFacts.length > 0) body.push("");

  for (const f of ordered) {
    const rendered = renderTable(f);
    body.push(rendered, "");
    bump("table");
  }

  body.push(
    `export default defineSchema({\n${ordered.map((f) => `  ${tableConst.get(qualified(f.id))!},`).join("\n")}\n})`,
  );

  /* ---- header ---- */
  const header = [
    "/**",
    " * Generated by `pg-prime pull` — design/06 §6.2.",
    " *",
    ` * Managed schemas: ${options.schemas.join(", ")}.`,
    ...(options.repeatableCount === undefined || options.repeatableCount === 0
      ? []
      : [
          ` * ${String(options.repeatableCount)} Tier-R object(s) — views, functions, triggers, policies,`,
          ` * matviews, aggregates — were written to \`${options.sqlDir ?? "sql"}/\` as repeatables instead:`,
          " * they are re-applied by hash rather than diffed (design/06 §3.8).",
        ]),
    " *",
    " * This file is meant to be edited. It is the DSL's spelling of what the database",
    " * currently contains, so `pg-prime migrate generate` against that same database",
    " * reports an empty diff until you change something.",
    " */",
    "",
  ];

  const unsupportedBlock = renderUnsupported(unsupported);
  const imports = [`import { ${[...needs].sort().join(", ")} } from 'pg-prime/schema'`];
  if (needsRefLike) imports.push("import type { RefLike } from 'pg-prime/schema'");
  if (needsSql) imports.push("import { sql } from 'pg-prime/sql'");

  return {
    ts: [...header, ...unsupportedBlock, ...imports, "", ...body]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\n+$/, "\n"),
    unsupported,
    counts,
  };

  /* -------------------------------------------------------------------- */

  function renderUnsupported(items: readonly UnsupportedItem[]): string[] {
    if (items.length === 0) return [];
    const sorted = [...items].sort((a, b) => cmp(`${a.kind} ${a.name}`, `${b.kind} ${b.name}`));
    return [
      "// -- pull: unsupported",
      "//",
      "// The database contains objects this DSL cannot express. They are NOT in the schema",
      "// below, so `migrate generate` against this file would plan to DROP them. Keep them out",
      "// of the managed schema set, or write them by hand in a migration, until the DSL grows",
      `// the spelling. The same list is in pull.report.json. (${String(sorted.length)} object(s).)`,
      ...sorted.map((i) => `//   ${i.kind}  ${i.name}  — ${i.reason}`),
      "// -- end pull: unsupported",
      "",
    ];
  }

  function renderTable(fact: Fact): string {
    const schema = (fact.id as { schema: string }).schema;
    const table = idName(fact.id);
    const constName = tableConst.get(qualified(fact.id))!;
    const columns = ir
      .childrenOf(fact.id)
      .filter((c) => c.id.kind === "column")
      .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));

    const keys = new Map<string, string>();
    const used = new Set<string>();
    for (const c of columns) {
      let key = camel(idName(c.id));
      if (key.startsWith("$")) key = `_${key}`;
      let n = 2;
      let candidate = key;
      while (used.has(candidate)) candidate = `${key}${String(n++)}`;
      used.add(candidate);
      keys.set(idName(c.id), candidate);
    }
    const ctx: TableCtx = { schema, name: table, constName, keys };

    const columnLines = columns.map((c) => `  ${keys.get(idName(c.id))!}: ${renderColumn(c, ctx)},`);
    const extras = renderExtras(fact, ctx);
    const factory = schema === "public" ? "pgTable" : `${schemaConst.get(schema) ?? "pgTable"}.table`;
    if (schema !== "public" && !schemaConst.has(schema)) needs.add("pgTable");

    const p = payload<TablePayload>(fact);
    if (p.partitionOf !== null && p.partitionBound !== null) {
      const parent = parseId(p.partitionOf);
      needs.add("partitionOf");
      const parentSchema = (parent as { schema: string }).schema;
      const opts = parentSchema === schema ? "" : `, { schema: ${lit(parentSchema)} }`;
      extras.unshift(`partitionOf(${lit(idName(parent))}, ${lit(p.partitionBound)}${opts})`);
    } else if (p.relkind === "p" && p.partitionKey !== null && p.partitionStrategy !== null) {
      needs.add("partitionBy");
      const strategy = p.partitionStrategy === "r" ? "range" : p.partitionStrategy === "l" ? "list" : "hash";
      // `pg_get_partkeydef` prints `RANGE (payment_date)`; the DSL takes the key alone.
      const key = /^\s*[A-Z]+\s*\((.*)\)\s*$/s.exec(p.partitionKey)?.[1] ?? p.partitionKey;
      extras.unshift(`partitionBy(${lit(strategy)}, ${lit(key)})`);
    }
    if (p.clusterOn !== null) {
      needs.add("clusterOn");
      extras.push(`clusterOn(${lit(p.clusterOn)})`);
    }

    const comment = comments.get(encodeId(fact.id));
    if (comment !== undefined) {
      needs.add("comment");
      extras.unshift(`comment(${lit(comment)})`);
    }

    const extrasArg = extras.length === 0 ? "" : `, (t) => [\n${extras.map((e) => `  ${e},`).join("\n")}\n]`;
    return `export const ${constName} = ${factory}(${lit(table)}, (t) => ({\n${columnLines.join("\n")}\n})${extrasArg})`;
  }

  function renderColumn(fact: Fact, ctx: TableCtx): string {
    const p = payload<ColumnPayload>(fact);
    const dbName = idName(fact.id);
    const chain: string[] = [];

    /* the builder */
    const arrayMatch = /^(.*)\[\]$/.exec(p.type);
    const base = arrayMatch === null ? p.type : arrayMatch[1]!;
    const enumName = enumConst.get(base);
    let head: string;
    if (enumName !== undefined) {
      // `t.enum` comes off the column kit the `pgTable` callback is given, so there is
      // nothing to import — only the `pgEnum` const it names, which is already declared.
      head = `t.enum(${enumName}, ${lit(dbName)})`;
    } else {
      const builder = BUILDERS.get(base);
      head = builder === undefined ? `t.raw(${lit(base)}, ${lit(dbName)})` : `t.${builder}(${lit(dbName)})`;
    }
    if (arrayMatch !== null) chain.push(".array()");

    /* modifiers, in the order the DSL's own gates accept them */
    if (p.identity === "a") chain.push(".generatedAlways()");
    else if (p.identity === "d") chain.push(".generatedByDefault()");
    if (!p.notNull) chain.push(".nullable()");

    const def = ir.get({ kind: "default", schema: ctx.schema, table: ctx.name, name: dbName });
    if (def !== undefined && p.identity === null) {
      chain.push(`.defaultSql(${lit(payload<DefaultPayload>(def).expression)})`);
    }

    if (p.generated === "s" && p.generationExpr !== null) {
      // After `.nullable()`, because `ro: true` closes `.nullable()` at the type level — a
      // stored generated column MAY be nullable, and the DSL's order is the one that says so.
      needsSql = true;
      chain.push(`.generatedAlwaysAs(sql.unsafeRaw(${lit(p.generationExpr)}))`);
    } else if (p.generated !== null) {
      drop(
        "generated column",
        `${ctx.schema}.${ctx.name}.${dbName}`,
        p.generated === "v"
          ? "attgenerated = 'v' (PG 18 VIRTUAL) — pg-prime emits STORED only, because a generated " +
              "column cannot be converted in place in either direction"
          : `attgenerated = '${p.generated}' with no generation expression in pg_attrdef`,
      );
    }
    if (p.collation !== null) {
      drop(
        "column collation",
        `${ctx.schema}.${ctx.name}.${dbName}`,
        `COLLATE ${p.collation} — the DSL has no \`.collate()\``,
      );
    }
    if (p.notNullValidated === false) {
      drop(
        "NOT NULL NOT VALID",
        `${ctx.schema}.${ctx.name}.${dbName}`,
        "the DSL has no `.notValid()` on NOT NULL (PG 18)",
      );
    }

    const comment = comments.get(encodeId(fact.id));
    if (comment !== undefined) chain.push(`.comment(${lit(comment)})`);

    return head + chain.join("");
  }

  function renderExtras(fact: Fact, ctx: TableCtx): string[] {
    const ref = (column: string): string => {
      const key = ctx.keys.get(column);
      return key === undefined ? `/* unknown column ${column} */` : `t.${key}`;
    };
    const pk: string[] = [];
    const uniques: string[] = [];
    const checks: string[] = [];
    const excludes: string[] = [];
    const fks: string[] = [];

    for (const c of ir
      .childrenOf(fact.id)
      .filter((x) => x.id.kind === "constraint")
      .sort((a, b) => cmp(idName(a.id), idName(b.id)))) {
      const p = payload<ConstraintPayload>(c);
      const name = idName(c.id);
      const subject = `${ctx.schema}.${ctx.name}.${name}`;
      if (!p.validated) {
        drop("NOT VALID constraint", subject, "the DSL has no `.notValid()` (design/05 §2.4 row is not built)");
        continue;
      }
      const parsed = parseConstraintDef(p.contype, p.definition);
      if (parsed === null) {
        drop(
          `${p.contype} constraint`,
          subject,
          `pg_get_constraintdef could not be mapped to the DSL: ${p.definition}`,
        );
        continue;
      }
      switch (parsed.kind) {
        case "primaryKey": {
          needs.add("primaryKey");
          pk.push(`primaryKey({ name: ${lit(name)}, columns: [${parsed.columns.map(ref).join(", ")}] })`);
          break;
        }
        case "unique": {
          needs.add("unique");
          const nnd = parsed.nullsNotDistinct ? ".nullsNotDistinct()" : "";
          uniques.push(`unique(${lit(name)})${nnd}.on(${parsed.columns.map(ref).join(", ")})`);
          break;
        }
        case "check": {
          needs.add("check");
          needsSql = true;
          checks.push(`check(${lit(name)}, sql.unsafeRaw(${lit(parsed.expression)}))`);
          break;
        }
        case "exclude": {
          needs.add("exclude");
          const chain: string[] = [];
          if (parsed.using !== null) chain.push(`.using(${lit(parsed.using)})`);
          if (parsed.where !== null) {
            needsSql = true;
            chain.push(`.where(sql.unsafeRaw(${lit(parsed.where)}))`);
          }
          if (parsed.initiallyDeferred) chain.push(".initiallyDeferred()");
          else if (parsed.deferrable) chain.push(".deferrable()");
          const pairs = parsed.items.map((i) => {
            if (i.expression === null) return `[${ref(i.column ?? "")}, ${lit(i.operator)}]`;
            needsSql = true;
            return `[sql.unsafeRaw(${lit(i.expression)}), ${lit(i.operator)}]`;
          });
          // `.requires()` is deliberately NOT emitted: it is a claim about the schema file's
          // own `pgExtension` declarations, and `pull` already emits every extension the
          // database has — re-stating the dependency here would be inventing a fact the
          // catalog does not record (`pg_depend` ties the constraint to the operator class,
          // not to the extension the user would name).
          excludes.push(`exclude(${lit(name)})${chain.join("")}.on(${pairs.join(", ")})`);
          break;
        }
        case "foreignKey": {
          needs.add("foreignKey");
          const target = tableConst.get(`${parsed.targetSchema}.${parsed.targetTable}`);
          if (target === undefined) {
            drop(
              "foreign key",
              subject,
              `it references ${parsed.targetSchema}.${parsed.targetTable}, which is not in the managed schema set ` +
                `(or is a shape pull could not emit)`,
            );
            break;
          }
          // A SELF-reference is written against the extras callback's own parameter, not
          // against the table's `const`: `() => [employee.cols.id]` inside `employee`'s own
          // initializer is TS7022 (design/05 §2.3's first circularity note), and `t.id` is
          // the spelling that exists to avoid it.
          const selfRef = parsed.targetSchema === ctx.schema && parsed.targetTable === ctx.name;
          const targetRefs = parsed.targetColumns.map((col) =>
            selfRef ? ref(col) : `${target}.cols.${camelOf(parsed.targetSchema, parsed.targetTable, col)}`,
          );
          // The thunk's return type is stated for the same reason design/05 §2.3's second
          // circularity note states it: a MUTUALLY referencing pair is TS7024 without it,
          // and stating it always costs one import and never has to be reasoned about.
          if (!selfRef) needsRefLike = true;
          const opts = [
            `name: ${lit(name)}`,
            `columns: [${parsed.columns.map(ref).join(", ")}]`,
            `references: ()${selfRef ? "" : ": readonly RefLike[]"} => [${targetRefs.join(", ")}]`,
            ...(parsed.onDelete === undefined ? [] : [`onDelete: ${lit(parsed.onDelete)}`]),
            ...(parsed.onUpdate === undefined ? [] : [`onUpdate: ${lit(parsed.onUpdate)}`]),
            ...(parsed.deferrable ? ["deferrable: true"] : []),
            ...(parsed.initiallyDeferred ? ["initiallyDeferred: true"] : []),
          ];
          fks.push(`foreignKey({ ${opts.join(", ")} })`);
          break;
        }
        default:
          break;
      }
    }

    /* indexes live on the SCHEMA, not on the table, so they are found by name */
    const indexes: string[] = [];
    for (const f of ir
      .factsOfKind("index")
      .filter((f2) => (f2.id as { schema: string }).schema === ctx.schema)
      .sort((a, b) => cmp(idName(a.id), idName(b.id)))) {
      const p = payload<IndexPayload>(f);
      const parsed = parseIndexDef(p.definition, idName(f.id));
      if (parsed === null || parsed.table !== ctx.name || parsed.schema !== ctx.schema) {
        if (parsed === null && indexBelongsHere(p.definition, ctx)) {
          drop(
            "index",
            `${ctx.schema}.${idName(f.id)}`,
            `pg_get_indexdef could not be mapped to the DSL: ${p.definition}`,
          );
        }
        continue;
      }
      if (!p.valid) {
        drop(
          "index",
          `${ctx.schema}.${idName(f.id)}`,
          "the index is INVALID in the catalog; fix or drop it before pulling",
        );
        continue;
      }
      needs.add(p.unique ? "uniqueIndex" : "index");
      if (parsed.items.some((i) => i.expression !== null)) needsSql = true;
      const items = parsed.items.map((i) => renderIndexItem(i, ref)).join(", ");
      const chain: string[] = [];
      if (parsed.using !== null && parsed.using !== "btree") chain.push(`.using(${lit(parsed.using)})`);
      if (parsed.include.length > 0) chain.push(`.include(${parsed.include.map(ref).join(", ")})`);
      if (parsed.nullsNotDistinct) chain.push(".nullsNotDistinct()");
      if (parsed.with !== null) {
        // Every reloption comes out of `pg_get_indexdef` as a STRING, and it goes back in as
        // one: `.with({ fillfactor: '70' })` and `.with({ fillfactor: 70 })` produce the same
        // catalog row, and re-typing the value here would be a guess about which options are
        // numeric that goes stale on the next access method.
        const entries = Object.keys(parsed.with)
          .sort(cmp)
          .map((k) => `${JSON.stringify(k)}: ${lit(parsed.with![k]!)}`);
        chain.push(`.with({ ${entries.join(", ")} })`);
      }
      if (parsed.tablespace !== null) chain.push(`.tablespace(${lit(parsed.tablespace)})`);
      if (parsed.where !== null) {
        needsSql = true;
        chain.push(`.where(sql.unsafeRaw(${lit(parsed.where)}))`);
      }
      indexes.push(`${p.unique ? "uniqueIndex" : "index"}(${lit(idName(f.id))})${chain.join("")}.on(${items})`);
    }

    return [...pk, ...uniques, ...checks, ...excludes, ...fks, ...indexes];
  }

  function renderIndexItem(item: IndexItemSpec, ref: (c: string) => string): string {
    // An expression key goes back out as the text PostgreSQL printed, through
    // `sql.unsafeRaw`: the shadow re-parses and re-prints it, so the round-trip is settled by
    // the server rather than by this string being spelled the way a human would have.
    const key = item.expression === null ? ref(item.column ?? "") : `sql.unsafeRaw(${lit(item.expression)})`;
    if (!item.desc && item.nulls === null && item.opclass === null) return key;
    const bits = [`${item.expression === null ? "column" : "expression"}: ${key}`];
    if (item.desc) bits.push("desc: true");
    if (item.nulls !== null) bits.push(`nulls: ${lit(item.nulls)}`);
    if (item.opclass !== null) bits.push(`opclass: ${lit(item.opclass)}`);
    return `{ ${bits.join(", ")} }`;
  }

  /** The TS key a table's column got, for a cross-table `.cols.<key>` reference. */
  function camelOf(schema: string, table: string, column: string): string {
    const fact = ir.get({ kind: "table", schema, name: table });
    if (fact === undefined) return camel(column);
    const columns = ir
      .childrenOf(fact.id)
      .filter((c) => c.id.kind === "column")
      .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    const used = new Set<string>();
    for (const c of columns) {
      let key = camel(idName(c.id));
      if (key.startsWith("$")) key = `_${key}`;
      let n = 2;
      let candidate = key;
      while (used.has(candidate)) candidate = `${key}${String(n++)}`;
      used.add(candidate);
      if (idName(c.id) === column) return candidate;
    }
    return camel(column);
  }

  function indexBelongsHere(definition: string, ctx: TableCtx): boolean {
    return definition.includes(`.${ctx.name} `) || definition.includes(`."${ctx.name}" `);
  }
}

/**
 * FK dependency order, ties broken by qualified name.
 *
 * A table must be declared before another table's `references: () => [other.cols.x]`
 * evaluates it — the thunk defers the *value*, but a plain `const` reference still needs
 * the binding initialised, and a `pull` output is read top to bottom by Node. A cycle is
 * broken at its lexicographically smallest member and the thunk carries it, which is
 * exactly what the thunk is for (design/11 §1.7).
 */
function dependencyOrder(ir: SchemaIR, tables: readonly Fact[], cmp: (a: string, b: string) => number): Fact[] {
  const key = (f: Fact): string => `${(f.id as { schema: string }).schema}.${idName(f.id)}`;
  const byKey = new Map(tables.map((f) => [key(f), f]));
  const deps = new Map<string, string[]>();
  for (const f of tables) {
    const out = new Set<string>();
    for (const c of ir.childrenOf(f.id)) {
      if (c.id.kind !== "constraint") continue;
      const p = c.payload as unknown as ConstraintPayload;
      if (p.contype !== "f") continue;
      const parsed = parseConstraintDef("f", p.definition);
      if (parsed === null || parsed.kind !== "foreignKey") continue;
      const target = `${parsed.targetSchema}.${parsed.targetTable}`;
      if (target !== key(f) && byKey.has(target)) out.add(target);
    }
    // A partition child's `const` names its parent's, so the parent has to be declared
    // first — and unlike an FK the reference is not inside a thunk.
    const parentId = (f.payload as unknown as TablePayload).partitionOf;
    if (parentId !== null) {
      const parent = parseId(parentId);
      const target = `${(parent as { schema: string }).schema}.${idName(parent)}`;
      if (target !== key(f) && byKey.has(target)) out.add(target);
    }
    deps.set(key(f), [...out].sort(cmp));
  }

  const order: Fact[] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const roots = [...byKey.keys()].sort(cmp);
  for (const root of roots) {
    if (state.get(root) === 2) continue;
    const stack: { node: string; edge: number }[] = [{ node: root, edge: 0 }];
    state.set(root, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const edges = deps.get(frame.node) ?? [];
      if (frame.edge < edges.length) {
        const next = edges[frame.edge]!;
        frame.edge += 1;
        const s = state.get(next);
        if (s === undefined) {
          state.set(next, 1);
          stack.push({ node: next, edge: 0 });
        }
        // `s === 1` is a cycle; the thunk handles it, so nothing to do.
        continue;
      }
      stack.pop();
      state.set(frame.node, 2);
      order.push(byKey.get(frame.node)!);
    }
  }
  return order;
}

export { splitIdentifierList };
