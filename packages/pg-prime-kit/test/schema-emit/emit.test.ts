/**
 * `emitSchema` as a pure function: no database, no I/O.
 *
 * The *correctness* of the DDL is proved by `roundtrip.test.ts` against a real PostgreSQL — this
 * file pins the three properties a server cannot check for us: determinism, the exact constraint
 * names (PostgreSQL's own, so the D10 witness sees no drift), and the diagnostics that must stop a
 * load rather than let it write somewhere it should not.
 */

import { describe, expect, it } from "vitest";
import { pgEnum, pgExtension, pgSchema, pgTable, sql, defineSchema, foreignKey, primaryKey } from "pg-prime";
import { emitSchema } from "../../src/schema/emit.js";
import { schema as corpus } from "./fixture.js";

const sqlOf = (result: { sql: readonly string[] }): string => result.sql.join(";\n");

describe("determinism", () => {
  it("two runs over the same registry produce byte-identical SQL", () => {
    expect(sqlOf(emitSchema(corpus))).toBe(sqlOf(emitSchema(corpus)));
  });

  it("the registry's key order does not change the output", () => {
    const forward = emitSchema(corpus);
    const reversed = emitSchema({
      ...corpus,
      tables: Object.fromEntries(Object.entries(corpus.tables).reverse()),
    });
    expect(reversed.sql).toEqual(forward.sql);
  });

  it("puts schemas, types, domains, sequences, tables, FKs, indexes, CLUSTER, OWNED BY, comments", () => {
    const kinds = emitSchema(corpus).sql.map((s) => s.split(" ").slice(0, 3).join(" "));
    const firstOf = (prefix: string): number => kinds.findIndex((k) => k.startsWith(prefix));
    const lastOf = (prefix: string): number => kinds.map((k) => k.startsWith(prefix)).lastIndexOf(true);
    expect(lastOf("CREATE SCHEMA")).toBeLessThan(firstOf("CREATE TYPE"));
    expect(lastOf("CREATE TYPE")).toBeLessThan(firstOf("CREATE DOMAIN"));
    // A domain is a column TYPE and a sequence is a column DEFAULT, so both have to exist
    // before the first `CREATE TABLE` that names one.
    expect(lastOf("CREATE DOMAIN")).toBeLessThan(firstOf("CREATE SEQUENCE"));
    expect(lastOf("CREATE SEQUENCE")).toBeLessThan(firstOf("CREATE TABLE"));
    // The deferred FK — the cycle breaker — comes after every table. `ATTACH PARTITION` is
    // also an `ALTER TABLE` and sits with its child's `CREATE`, so the two are told apart
    // by the whole statement rather than by its first three words.
    const all = emitSchema(corpus).sql;
    const lastCreateTable = all.map((s) => s.startsWith("CREATE TABLE")).lastIndexOf(true);
    expect(lastCreateTable).toBeLessThan(all.findIndex((s) => s.startsWith("ALTER TABLE") && s.includes(" ADD ")));
    expect(lastOf("CREATE INDEX")).toBeLessThan(firstOf("COMMENT ON"));
    // `CLUSTER ON` names an index, and `OWNED BY` names a column, so both come after the
    // objects they name and before the comments.
    expect(firstOf("CREATE INDEX")).toBeLessThan(kinds.findIndex((k) => k.startsWith("ALTER SEQUENCE")));
    expect(kinds.findIndex((k) => k.startsWith("ALTER SEQUENCE"))).toBeLessThan(firstOf("COMMENT ON"));
  });
});

describe("names are PostgreSQL's own (makeObjectName)", () => {
  const single = pgTable("t", (c) => ({
    id: c.uuid().primaryKey(),
    email: c.text().unique(),
    n: c.integer().check(sql`n > 0`),
    other: c.uuid().references(() => target.cols.id),
  }));
  const target = pgTable("target", (c) => ({ id: c.uuid().primaryKey() }));
  const out = sqlOf(emitSchema(defineSchema({ single, target })));

  it("pkey / key / check / fkey, exactly as the server would choose them", () => {
    expect(out).toContain('CONSTRAINT "t_pkey" PRIMARY KEY ("id")');
    expect(out).toContain('CONSTRAINT "t_email_key" UNIQUE');
    expect(out).toContain('CONSTRAINT "t_n_check" CHECK (n > 0)');
    expect(out).toContain('CONSTRAINT "t_other_fkey" FOREIGN KEY ("other")');
  });

  it("joins the columns of a multi-column constraint, as ChooseIndexNameAddition does", () => {
    const t = pgTable(
      "m",
      (c) => ({ a: c.integer(), b: c.integer() }),
      (c) => [primaryKey(c.a, c.b)],
    );
    expect(sqlOf(emitSchema(defineSchema({ t })))).toContain('CONSTRAINT "m_pkey" PRIMARY KEY ("a", "b")');
  });

  it("reports a collision instead of inventing PostgreSQL's uniquifying suffix", () => {
    const t = pgTable("c", (col) => ({
      n: col
        .integer()
        .check(sql`n > 0`, "dup")
        .check(sql`n < 9`, "dup"),
    }));
    const result = emitSchema(defineSchema({ t }));
    expect(result.diagnostics.map((d) => d.code)).toContain("constraint_name_collision");
  });
});

describe("DEFAULT literals are keyed on the column's pg type", () => {
  const t = pgTable("d", (c) => ({
    s: c.text().default("it's"),
    n: c.integer().default(-1),
    big: c.bigint().default(7n),
    b: c.boolean().default(false),
    at: c.timestamptz().default(new Date("2020-03-04T05:06:07.000Z")),
    j: c.jsonb().default({ a: 1 }),
    // a STRING default on a jsonb column is the JSON document "x", not the SQL string x
    js: c.jsonb().default("x"),
    arr: c.text().array().default(["a", "b"]),
    empty: c.text().array().default([]),
    expr: c.timestamptz().defaultSql("now()"),
  }));
  const out = sqlOf(emitSchema(defineSchema({ t })));

  it("renders each one the way PostgreSQL parses it back", () => {
    expect(out).toContain(`DEFAULT 'it''s'`);
    expect(out).toContain("DEFAULT (-1)");
    expect(out).toContain("DEFAULT 7");
    expect(out).toContain("DEFAULT false");
    expect(out).toContain(`DEFAULT '2020-03-04T05:06:07.000Z'`);
    expect(out).toContain(`DEFAULT '{"a":1}'`);
    expect(out).toContain(`DEFAULT '"x"'`);
    expect(out).toContain(`DEFAULT ARRAY['a', 'b']::text[]`);
    expect(out).toContain("DEFAULT ARRAY[]::text[]");
    expect(out).toContain("DEFAULT now()");
  });

  it("never emits a `$`-prefixed modifier ($ law, design/05 D4)", () => {
    const ts = pgTable("ts", (c) => ({
      a: c.text().$default(() => "x"),
      b: c.text().$onUpdate(() => "y"),
    }));
    const emitted = sqlOf(emitSchema(defineSchema({ ts })));
    expect(emitted).not.toContain("DEFAULT");
    expect(emitted).toContain('CREATE TABLE "public"."ts"');
  });
});

describe("dependency order", () => {
  it("creates a referenced table before its referrer", () => {
    const child = pgTable("child", (c) => ({
      id: c.uuid().primaryKey(),
      parentId: c.uuid().references(() => parent.cols.id),
    }));
    const parent = pgTable("parent", (c) => ({ id: c.uuid().primaryKey() }));
    const out = emitSchema(defineSchema({ child, parent })).sql;
    const at = (needle: string): number => out.findIndex((s) => s.includes(needle));
    expect(at('CREATE TABLE "public"."parent"')).toBeLessThan(at('CREATE TABLE "public"."child"'));
    // …and the FK is inline, because by then the target exists
    expect(out.some((s) => s.startsWith("ALTER TABLE"))).toBe(false);
  });

  /**
   * The index options of design/05 §2.4, as TEXT.
   *
   * The round-trip test cannot see these: it builds database B from database A's extracted
   * IR, so an option the emitter drops is missing from both sides and `pg_dump` agrees with
   * itself. The clause ORDER is PostgreSQL's grammar and getting it wrong is a syntax
   * error, which the round-trip would catch — but a silently dropped `DESC` is not, and
   * that is what this pins.
   */
  it("writes every index option, in PostgreSQL's own clause order", () => {
    const out = emitSchema(corpus).sql;
    const index = (name: string): string => out.find((s) => s.includes(`INDEX "${name}"`)) ?? `<no ${name}>`;
    expect(index("tickets_label_pattern_idx")).toBe(
      'CREATE INDEX "tickets_label_pattern_idx" ON "public"."tickets" ("label" text_pattern_ops)',
    );
    expect(index("tickets_created_desc_idx")).toBe(
      'CREATE INDEX "tickets_created_desc_idx" ON "public"."tickets" ("created_at" DESC NULLS LAST)',
    );
    expect(index("tickets_doc_idx")).toBe(
      'CREATE INDEX "tickets_doc_idx" ON "public"."tickets" USING "gin" ("doc" jsonb_path_ops)',
    );
    expect(index("tickets_open_idx")).toBe(
      'CREATE INDEX "tickets_open_idx" ON "public"."tickets" ("org_id") INCLUDE ("label") WHERE ("amount" IS NULL)',
    );
    expect(index("tickets_org_label_key")).toBe(
      'CREATE UNIQUE INDEX "tickets_org_label_key" ON "public"."tickets" ("org_id", "label") NULLS NOT DISTINCT',
    );
    // …and the three table nodes an adopted database needs.
    expect(out).toContain('ALTER TABLE "public"."tickets" CLUSTER ON "PK_Tickets"');
    expect(out.find((s) => s.startsWith('CREATE TABLE "public"."readings" '))).toContain("PARTITION BY RANGE (at)");
    expect(out).toContain(
      `ALTER TABLE "public"."readings" ATTACH PARTITION "public"."readings_2024" ` +
        `FOR VALUES FROM ('2024-01-01 00:00:00+00') TO ('2025-01-01 00:00:00+00')`,
    );
    expect(out).toContain('ALTER SEQUENCE "public"."tickets_no_seq" OWNED BY "public"."tickets"."no"');
  });

  /**
   * `pgExtension` is not in the shared fixture — an extension belongs to the DATABASE and
   * tier 3 cannot normalise one (design/06 §3.2), so declaring it there would make two true
   * properties of `test/shadow/ladder.test.ts` false. Its emitter path is asserted here, and
   * end to end by AdventureWorks' two extensions in `test/pull/roundtrip.test.ts`.
   */
  it("emits an extension first, declare-only, and warns that tier 3 cannot normalise it", () => {
    const t = pgTable("x", (c) => ({ id: c.uuid().primaryKey() }));
    const registry = { ...defineSchema({ t }), extensions: [pgExtension("uuid-ossp", { schema: "public" })] };
    const plain = emitSchema(registry);
    expect(plain.sql[0]).toBe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA "public"');
    expect(plain.diagnostics).toEqual([]);

    const mapped = emitSchema(registry, { schemaMap: new Map([["public", "pgprime_shadow_dead_public"]]) });
    const note = mapped.diagnostics.find((d) => d.code === "shadow_extension_fixed_schema");
    expect(note?.severity).toBe("warning");
    expect(note?.message).toContain("design/06 §3.2");
    // …and the statement still names the REAL schema, because that is where it has to go.
    expect(mapped.sql[0]).toBe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA "public"');
  });

  it("breaks a cycle with ALTER TABLE … ADD CONSTRAINT, one statement, not two", () => {
    const alters = emitSchema(corpus).sql.filter((s) => s.startsWith("ALTER TABLE") && s.includes(" ADD "));
    expect(alters).toHaveLength(1);
    expect(alters[0]).toMatch(/ALTER TABLE "public"\."(orgs|users)"/);
    expect(alters[0]).toContain("FOREIGN KEY");
  });

  it("keeps a self-reference inline", () => {
    const out = emitSchema(corpus).sql;
    const nodes = out.find((s) => s.includes('CREATE TABLE "public"."nodes"'));
    expect(nodes).toContain('CONSTRAINT "nodes_parent_id_fkey" FOREIGN KEY ("parent_id")');
    expect(nodes).toContain('REFERENCES "public"."nodes" ("id")');
    expect(nodes).toContain("DEFERRABLE");
  });

  it("orders a cross-schema referrer after its target", () => {
    const out = emitSchema(corpus).sql;
    const at = (needle: string): number => out.findIndex((s) => s.includes(needle));
    expect(at('CREATE TABLE "public"."orgs"')).toBeLessThan(at('CREATE TABLE "audit"."events"'));
  });
});

describe("enums", () => {
  it("emits one CREATE TYPE for an enum two tables share, qualified by its own schema", () => {
    const out = emitSchema(corpus).sql;
    const types = out.filter((s) => s.startsWith("CREATE TYPE"));
    expect(types).toEqual([
      `CREATE TYPE "audit"."event_kind" AS ENUM ('created', 'updated', 'deleted')`,
      `CREATE TYPE "public"."member_role" AS ENUM ('owner', 'admin', 'member')`,
    ]);
    // the public enum is used from `audit.events` too, still qualified `public`
    expect(out.find((s) => s.includes('"audit"."events"'))).toContain(`"public"."member_role"`);
  });

  it("renders an enum array as a qualified type with a [] suffix", () => {
    expect(sqlOf(emitSchema(corpus))).toContain(`"roles" "public"."member_role"[]`);
  });

  it("reports two enums of one name that disagree, rather than picking one", () => {
    const a = pgEnum("mood", ["ok"]);
    const b = pgEnum("mood", ["ok", "bad"]);
    const t1 = pgTable("t1", (c) => ({ m: c.enum(a) }));
    const t2 = pgTable("t2", (c) => ({ m: c.enum(b) }));
    expect(emitSchema(defineSchema({ t1, t2 })).diagnostics.map((d) => d.code)).toContain("enum_conflict");
  });
});

describe("the tier-3 schema map (design/11 §1.6)", () => {
  const map = new Map([
    ["public", "pgprime_shadow_dead_public"],
    ["audit", "pgprime_shadow_dead_audit"],
  ]);
  const mapped = emitSchema(corpus, { schemaMap: map });

  it("rewrites every schema identifier, including enum types and cross-schema FK targets", () => {
    const text = sqlOf(mapped);
    expect(text).not.toContain('"public"');
    expect(text).not.toContain('"audit"');
    expect(text).toContain('CREATE SCHEMA IF NOT EXISTS "pgprime_shadow_dead_public"');
    expect(text).toContain('CREATE SCHEMA IF NOT EXISTS "pgprime_shadow_dead_audit"');
    expect(text).toContain(`CREATE TYPE "pgprime_shadow_dead_public"."member_role"`);
    expect(text).toContain(`REFERENCES "pgprime_shadow_dead_public"."orgs" ("id")`);
    expect(text).toContain(`COMMENT ON TABLE "pgprime_shadow_dead_audit"."events"`);
  });

  it("changes nothing else: unmapping the text reproduces the unmapped emit", () => {
    // …apart from the one statement that is genuinely different — the shadow schema for `public`
    // has to be created, and the real `public` never does.
    const unmap = (s: string): string =>
      s.replaceAll("pgprime_shadow_dead_public", "public").replaceAll("pgprime_shadow_dead_audit", "audit");
    const noSchemas = (out: readonly string[]): string[] =>
      out.filter((s) => !s.startsWith("CREATE SCHEMA")).map(unmap);
    expect(noSchemas(mapped.sql)).toEqual(noSchemas(emitSchema(corpus).sql));
  });

  it("reports an error for a schema the map does not cover, so the load can refuse", () => {
    const partial = new Map([["public", "pgprime_shadow_dead_public"]]);
    const result = emitSchema(corpus, { schemaMap: partial });
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    expect(errors.map((d) => d.code)).toContain("shadow_schema_unmapped");
    expect(errors[0]?.message).toContain('"audit"');
  });
});

describe("diagnostics that stop a load", () => {
  it("an FK whose thunk leaves the registry", () => {
    const outside = pgTable("outside", (c) => ({ id: c.uuid().primaryKey() }));
    const t = pgTable("t", (c) => ({
      id: c.uuid().primaryKey(),
      o: c.uuid().references(() => outside.cols.id),
    }));
    const result = emitSchema(defineSchema({ t }));
    expect(result.diagnostics.map((d) => d.code)).toContain("foreign_key_target_unknown");
  });

  it("an FK whose local and referenced column counts disagree", () => {
    const target = pgTable("target", (c) => ({ a: c.integer(), b: c.integer() }));
    const t = pgTable(
      "t",
      (c) => ({ a: c.integer() }),
      (c) => [foreignKey({ columns: [c.a], references: () => [target.cols.a, target.cols.b] })],
    );
    expect(emitSchema(defineSchema({ t, target })).diagnostics.map((d) => d.code)).toContain("foreign_key_arity");
  });

  it("two tables that resolve to the same schema-qualified name", () => {
    const a = pgTable("dup", (c) => ({ id: c.integer() }));
    const b = pgTable("dup", (c) => ({ id: c.integer() }));
    expect(emitSchema({ tables: { a, b } }).diagnostics.map((d) => d.code)).toContain("duplicate_table");
  });

  it("a default no literal renderer can produce, reported instead of thrown", () => {
    const t = pgTable("t", (c) => ({ n: c.integer().default(Number.NaN) }));
    const result = emitSchema(defineSchema({ t }));
    expect(result.diagnostics.map((d) => d.code)).toContain("unrenderable_default");
    // …and the rest of the table is still emitted, which is why this is a diagnostic
    expect(result.sql.join("")).toContain('CREATE TABLE "public"."t"');
    expect(result.sql.join("")).not.toContain("DEFAULT");
  });

  it("a primary key declared twice", () => {
    const t = pgTable(
      "t",
      (c) => ({ a: c.integer().primaryKey(), b: c.integer() }),
      (c) => [primaryKey(c.b)],
    );
    expect(emitSchema(defineSchema({ t })).diagnostics.map((d) => d.code)).toContain("duplicate_primary_key");
  });
});

describe("pgSchema", () => {
  it("emits CREATE SCHEMA for a non-public schema and never for public", () => {
    const other = pgSchema("other");
    const t = other.table("t", (c) => ({ id: c.integer() }));
    const out = emitSchema(defineSchema({ t })).sql;
    expect(out[0]).toBe('CREATE SCHEMA IF NOT EXISTS "other"');
    expect(out.filter((s) => s.includes("public"))).toEqual([]);
  });
});
