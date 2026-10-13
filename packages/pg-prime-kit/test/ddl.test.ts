/**
 * Emission and ordering, at the level where the bug is visible in the SQL text.
 *
 *  - `CREATE SEQUENCE … OWNED BY t.id` consumes the column the CREATE TABLE produces, so
 *    a `serial` table was ordered BEFORE the sequence its own DEFAULT calls;
 *  - the index emitter substituted `%ID%` with a replacement STRING, so an index named
 *    `idx$&x` expanded the match instead of inserting the name;
 *  - a DROP of a PK/UNIQUE was not ordered after the FKs that bind to it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildStatements } from "../src/diff/ddl.js";
import { diffIR } from "../src/diff/diff.js";
import { generateFromDatabases as generate } from "../src/generate.js";
import { CATALOG_PROVENANCE, SchemaIR, type Fact } from "../src/ir/fact.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "./support/db.js";

const SER = "pgprime_ddl_serial";
const UNI_CUR = "pgprime_ddl_uni_cur";
const UNI_DES = "pgprime_ddl_uni_des";
const EMPTY = "pgprime_ddl_empty";
const T = 180_000;

/** A one-index schema, so the golden below is the whole emitted statement. */
function irWithIndex(indexName: string): SchemaIR {
  const facts: Fact[] = [
    { id: { kind: "schema", schema: "public" }, payload: { kind: "schema" }, provenance: CATALOG_PROVENANCE },
    {
      id: { kind: "table", schema: "public", name: "t" },
      parent: { kind: "schema", schema: "public" },
      payload: {
        kind: "table",
        relkind: "r",
        persistence: "p",
        rowSecurity: false,
        partitionStrategy: null,
        partitionKey: null,
        partitionOf: null,
        partitionBound: null,
      },
      provenance: CATALOG_PROVENANCE,
    },
    {
      id: { kind: "index", schema: "public", name: indexName },
      parent: { kind: "table", schema: "public", name: "t" },
      payload: {
        kind: "index",
        definition: "CREATE INDEX %ID% ON public.t USING btree (a)",
        unique: false,
        valid: true,
      },
      provenance: CATALOG_PROVENANCE,
    },
  ];
  return SchemaIR.build(facts, [
    {
      from: { kind: "index", schema: "public", name: indexName },
      to: { kind: "table", schema: "public", name: "t" },
      kind: "depends",
    },
  ]);
}

const indexSql = (name: string): string => {
  const desired = irWithIndex(name);
  const built = buildStatements(diffIR(SchemaIR.build([], []), desired), desired);
  return built.statements.find((s) => s.kind === "index")?.sql ?? "";
};

describe("index names containing $ are inserted, not expanded", () => {
  it("byte-exact goldens for every String.replace replacement pattern", () => {
    expect(indexSql("plain_idx")).toBe('CREATE INDEX "plain_idx" ON public.t USING btree (a)');
    expect(indexSql("idx$&x")).toBe('CREATE INDEX "idx$&x" ON public.t USING btree (a)');
    expect(indexSql("idx$$z")).toBe('CREATE INDEX "idx$$z" ON public.t USING btree (a)');
    expect(indexSql("idx$'q")).toBe(`CREATE INDEX "idx$'q" ON public.t USING btree (a)`);
    expect(indexSql("idx$`w")).toBe('CREATE INDEX "idx$`w" ON public.t USING btree (a)');
    expect(indexSql("idx$1n")).toBe('CREATE INDEX "idx$1n" ON public.t USING btree (a)');
    // a name that itself contains the placeholder must not re-substitute
    expect(indexSql("x%ID%y")).toBe('CREATE INDEX "x%ID%y" ON public.t USING btree (a)');
  });
});

describe("a table this plan creates skips the lock-safe rewrites", () => {
  const check: Fact = {
    id: { kind: "constraint", schema: "public", table: "t", name: "t_a_ck" },
    parent: { kind: "table", schema: "public", name: "t" },
    payload: { kind: "constraint", contype: "c", definition: "CHECK ((a > 0))", validated: true, deferrable: false },
    provenance: CATALOG_PROVENANCE,
  };
  const desired = (): SchemaIR => {
    const base = irWithIndex("t_a_idx");
    return SchemaIR.build([...base.facts(), check], base.edges());
  };
  const plan = (current: SchemaIR) => buildStatements(diffIR(current, desired()), desired()).statements;

  it("a CHECK is one literal ADD, and the index carries no LK101", () => {
    const s = plan(SchemaIR.build([], [])).filter((x) => x.kind === "constraint" || x.kind === "index");
    expect(s.map((x) => x.sql)).toEqual([
      'ALTER TABLE "public"."t" ADD CONSTRAINT "t_a_ck" CHECK ((a > 0))',
      'CREATE INDEX "t_a_idx" ON public.t USING btree (a)',
    ]);
    expect(s.flatMap((x) => x.hazards)).toEqual([]);
  });

  it("an existing table still gets NOT VALID + VALIDATE, and LK101", () => {
    const table = desired()
      .facts()
      .filter((f) => f.id.kind === "schema" || f.id.kind === "table");
    const s = plan(SchemaIR.build(table, []));
    expect(s.map((x) => x.sql)).toContain('ALTER TABLE "public"."t" VALIDATE CONSTRAINT "t_a_ck"');
    expect(s.find((x) => x.kind === "index")?.hazards).toContain("LK101");
  });
});

describe("an FK onto a FORCE'd table lifts FORCE while it checks (RL109)", () => {
  const table = (name: string): Fact => ({
    id: { kind: "table", schema: "public", name },
    parent: { kind: "schema", schema: "public" },
    payload: {
      kind: "table",
      relkind: "r",
      persistence: "p",
      rowSecurity: true,
      partitionStrategy: null,
      partitionKey: null,
      partitionOf: null,
      partitionBound: null,
    },
    provenance: CATALOG_PROVENANCE,
  });
  const fk: Fact = {
    id: { kind: "constraint", schema: "public", table: "refs", name: "refs_doc_fkey" },
    parent: { kind: "table", schema: "public", name: "refs" },
    payload: {
      kind: "constraint",
      contype: "f",
      definition: "FOREIGN KEY (doc) REFERENCES public.documents(id)",
      validated: true,
      deferrable: false,
    },
    provenance: CATALOG_PROVENANCE,
  };
  const schema: Fact = {
    id: { kind: "schema", schema: "public" },
    payload: { kind: "schema" },
    provenance: CATALOG_PROVENANCE,
  };
  const edge = (from: Fact, name: string) => ({
    from: from.id,
    to: { kind: "table" as const, schema: "public", name },
    kind: "depends" as const,
  });
  const current = SchemaIR.build([schema, table("documents"), table("refs")], []);
  const desired = SchemaIR.build(
    [schema, table("documents"), table("refs"), fk],
    [edge(fk, "refs"), edge(fk, "documents")],
  );
  const lane = (owner: string, bypass: string[]) => {
    const state = {
      tables: [{ schema: "public", name: "documents", enabled: true, forced: true, owner }],
      policies: [],
      updatedAtTriggers: [],
      memberOf: new Map<string, readonly string[]>(),
      bypass: new Set(bypass),
    };
    return { before: state, after: state };
  };
  const validate = (owner: string, bypass: string[]) =>
    buildStatements(diffIR(current, desired), desired, { lane: lane(owner, bypass) }).statements.find((s) =>
      s.sql.includes("VALIDATE CONSTRAINT"),
    );

  it("wraps the VALIDATE in a DO block that lifts and restores FORCE only where it is set", () => {
    const s = validate("app", []);
    expect(s?.sql).toContain('IF forced THEN ALTER TABLE "public"."documents" NO FORCE ROW LEVEL SECURITY; END IF;');
    expect(s?.sql).toContain('ALTER TABLE "public"."refs" VALIDATE CONSTRAINT "refs_doc_fkey";');
    expect(s?.sql).toContain('IF forced THEN ALTER TABLE "public"."documents" FORCE ROW LEVEL SECURITY; END IF;');
    expect(s?.hazards).toEqual(["RL109"]);
    expect(s?.lockClass).toBe("accessExclusive");
  });

  it("leaves it alone when the owner bypasses RLS", () => {
    const s = validate("app", ["app"]);
    expect(s?.sql).toBe('ALTER TABLE "public"."refs" VALIDATE CONSTRAINT "refs_doc_fkey"');
    expect(s?.hazards).toEqual([]);
  });
});

describe("ordering, end to end", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
    await makeDatabase(EMPTY);
  }, T);

  afterAll(async () => {
    for (const db of [SER, UNI_CUR, UNI_DES, EMPTY]) await destroyDatabase(db).catch(() => undefined);
  }, T);

  it(
    "a serial column: CREATE SEQUENCE carries no OWNED BY, and precedes its table",
    async () => {
      const desired = await makeDatabase(SER, "serial/desired.sql");
      const result = await generate({
        admin: ADMIN,
        target: { ...ADMIN, database: EMPTY },
        desired,
        schemas: ["public"],
        seq: 1,
        name: "serial",
        dumpOracle: "strict",
      });

      const sql = result.plan.statements.map((s) => s.sql);
      const at = (re: RegExp): number => sql.findIndex((s) => re.test(s));

      const createSeq = at(/^CREATE SEQUENCE IF NOT EXISTS "public"\."tickets_id_seq"/);
      const createTbl = at(/^CREATE TABLE "public"\."tickets"/);
      const ownSeq = at(/^ALTER SEQUENCE "public"\."tickets_id_seq" OWNED BY/);
      expect(createSeq).toBeGreaterThanOrEqual(0);
      expect(ownSeq).toBeGreaterThanOrEqual(0);
      // the exact failure: the table's DEFAULT nextval() needs the sequence first
      expect(createSeq).toBeLessThan(createTbl);
      // …and ownership needs the column, so it comes after
      expect(ownSeq).toBeGreaterThan(createTbl);
      expect(sql[createSeq]).not.toMatch(/OWNED BY/);

      expect(result.plan.proof.status, JSON.stringify(result.plan.proof, null, 2)).toBe("passed");
      expect(result.plan.proof.dumpOracle?.status).toBe("passed");
    },
    T,
  );

  it(
    "dropping a UNIQUE happens after dropping the FK that binds to it",
    async () => {
      const target = await makeDatabase(UNI_CUR, "uniqueness/current.sql");
      const desired = await makeDatabase(UNI_DES, "uniqueness/desired.sql");
      const result = await generate({
        admin: ADMIN,
        target,
        desired,
        schemas: ["public"],
        seq: 1,
        name: "uniqueness",
        dumpOracle: "strict",
      });

      const sql = result.plan.statements.map((s) => s.sql);
      const dropFk = sql.findIndex((s) => /DROP CONSTRAINT IF EXISTS "zones_account_fkey"/.test(s));
      const dropUnique = sql.findIndex((s) => /DROP CONSTRAINT IF EXISTS "accounts_slug_key"/.test(s));
      expect(dropFk).toBeGreaterThanOrEqual(0);
      expect(dropUnique).toBeGreaterThanOrEqual(0);
      // 2BP01 "cannot drop constraint … because other objects depend on it"
      expect(dropFk).toBeLessThan(dropUnique);
      expect(result.plan.proof.status).toBe("passed");
    },
    T,
  );
});
