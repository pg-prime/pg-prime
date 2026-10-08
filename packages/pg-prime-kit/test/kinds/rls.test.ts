/**
 * design/20 R3: RLS and the declared lane on the structural side — `readLaneState`, the
 * fingerprint FORCE must not move (D4), `rls.*()` emitting ENABLE, `probeEmptiness` under RLS
 * (D20), RL101/RL102/RL103/RL106 on statements and the `pgprime_set_<col>` trigger pre-drop.
 *
 * Needs a role that can `CREATE ROLE`; without one the file skips loudly.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgTable, rls, updatedAtTrigger } from "pg-prime";
import { extractCatalog, probeEmptiness, readLaneState, type LaneState } from "../../src/catalog/extract.js";
import { buildStatements, type BuildOptions } from "../../src/diff/ddl.js";
import { diffIR } from "../../src/diff/diff.js";
import { orderStatements } from "../../src/diff/order.js";
import { runSqlScript, withClient, type ConnInfo } from "../../src/db/pg.js";
import { emitSchema } from "../../src/schema/emit.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable, withAdmin } from "../support/db.js";

const T = 180_000;
const CUR = "pgprime_r3_rls_cur";
const DES = "pgprime_r3_rls_des";
const EMIT = "pgprime_r3_rls_emit";
const APP = "pgprime_rls_app";
const ADMIN_ROLE = "pgprime_rls_admin";
const OWNER = "pgprime_rls_owner";

const canCreateRoles = await withAdmin(async (c) => {
  const r = await c.query("SELECT rolsuper OR rolcreaterole AS ok FROM pg_roles WHERE rolname = current_user");
  return r.rows[0]?.["ok"] === true;
}).catch(() => false);
if (!canCreateRoles) console.warn("test/kinds/rls.test.ts: SKIPPED — the test role cannot CREATE ROLE");

const BASE = `
CREATE TABLE public.open_data (id int PRIMARY KEY);
CREATE TABLE public.closed (id int PRIMARY KEY);
`;

const CUR_SQL = `
${BASE}
CREATE TABLE public.shares (document_id int, org_id int);
CREATE TABLE public.documents (
  id int PRIMARY KEY, org_id int NOT NULL, archived boolean NOT NULL DEFAULT false, legacy int,
  touched_at timestamptz
);
INSERT INTO public.documents (id, org_id) VALUES (1, 1);
INSERT INTO public.shares VALUES (1, 1);
INSERT INTO public.open_data VALUES (1);
INSERT INTO public.closed VALUES (1);
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.documents OWNER TO ${OWNER};
GRANT SELECT ON public.shares TO ${OWNER};
ALTER TABLE public.closed ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON public.documents TO ${APP} USING (org_id = 1) WITH CHECK (org_id = 1);
CREATE POLICY ro ON public.documents AS RESTRICTIVE FOR UPDATE TO ${APP} USING (NOT archived);
CREATE POLICY shared ON public.documents FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.shares s WHERE s.document_id = documents.id AND s.org_id = documents.legacy));
COMMENT ON POLICY tenant ON public.documents IS 'pg-prime:declared sha256:abc';
CREATE FUNCTION public.pgprime_set_touched_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.touched_at := now(); RETURN NEW; END $$;
CREATE TRIGGER pgprime_set_touched_at BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.pgprime_set_touched_at();
COMMENT ON TRIGGER pgprime_set_touched_at ON public.documents IS 'pg-prime:declared sha256:def';
`;

/**
 * documents loses `legacy` and `touched_at` and retypes `org_id`; shares is dropped; open_data
 * gains RLS, closed loses it.
 */
const DES_SQL = `
${BASE}
CREATE TABLE public.documents (
  id int PRIMARY KEY, org_id bigint NOT NULL, archived boolean NOT NULL DEFAULT false
);
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.open_data ENABLE ROW LEVEL SECURITY;
`;

const role = (sql: string): string => `DO $$ BEGIN ${sql}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;

describe.skipIf(!canCreateRoles)("RLS on the structural side", () => {
  let cur: ConnInfo;
  let des: ConnInfo;

  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
    await withAdmin(async (c) => {
      for (const r of [APP, ADMIN_ROLE, OWNER]) await c.query(role(`CREATE ROLE ${r} NOLOGIN`));
      await c.query(`GRANT ${APP} TO ${ADMIN_ROLE}`);
    });
    cur = await makeDatabase(CUR);
    await runSqlScript(cur, CUR_SQL);
    des = await makeDatabase(DES);
    await runSqlScript(des, DES_SQL);
  }, T);

  afterAll(async () => {
    for (const db of [CUR, DES, EMIT]) await destroyDatabase(db).catch(() => undefined);
    await withAdmin(async (c) => {
      for (const r of [ADMIN_ROLE, APP, OWNER]) await c.query(`DROP ROLE IF EXISTS ${r}`);
    }).catch(() => undefined);
  }, T);

  it(
    "readLaneState reads flags, owners, policies, dependencies, marked triggers and membership",
    async () => {
      const s = await withClient(cur, (c) => readLaneState(c, ["public"]));
      expect(s.tables).toEqual([
        { schema: "public", name: "closed", enabled: true, forced: false, owner: "postgres" },
        { schema: "public", name: "documents", enabled: true, forced: true, owner: OWNER },
        { schema: "public", name: "open_data", enabled: false, forced: false, owner: "postgres" },
        { schema: "public", name: "shares", enabled: false, forced: false, owner: "postgres" },
      ]);
      const byName = new Map(s.policies.map((p) => [p.name, p]));
      expect(byName.get("ro")).toMatchObject({
        command: "update",
        permissive: false,
        roles: [APP],
        using: "(NOT archived)",
        withCheck: null,
        marker: null,
      });
      expect(byName.get("tenant")).toMatchObject({
        command: "all",
        permissive: true,
        using: "(org_id = 1)",
        withCheck: "(org_id = 1)",
        marker: "pg-prime:declared sha256:abc",
      });
      expect(byName.get("shared")?.roles).toEqual(["public"]);
      // Qualified by the snapshot's `search_path = pg_catalog`, so the text is stable.
      expect(byName.get("shared")?.using).toContain("public.shares");
      expect(byName.get("shared")?.dependsOn).toEqual(
        expect.arrayContaining([
          "column:public.documents.legacy",
          "column:public.shares.document_id",
          "column:public.shares.org_id",
        ]),
      );
      expect(s.updatedAtTriggers).toEqual([{ schema: "public", table: "documents", column: "touched_at" }]);
      expect(s.memberOf.get(ADMIN_ROLE)).toEqual([ADMIN_ROLE, APP]);
      expect(s.bypass.has("postgres")).toBe(true);
      expect(s.bypass.has(APP)).toBe(false);
    },
    T,
  );

  it(
    "FORCE is not in the IR: forcing a table leaves the fingerprint where it was (D4)",
    async () => {
      const fp = (): Promise<string> =>
        withClient(cur, async (c) => (await extractCatalog(c, { schemas: ["public"], observe: false })).ir.fingerprint);
      const before = await fp();
      await runSqlScript(cur, "ALTER TABLE public.closed FORCE ROW LEVEL SECURITY");
      expect(await fp()).toBe(before);
      await runSqlScript(cur, "ALTER TABLE public.closed NO FORCE ROW LEVEL SECURITY");
    },
    T,
  );

  it(
    "rls.enable()/rls.force() emit ENABLE once; FORCE and updatedAtTrigger are left to the lane",
    async () => {
      const docs = pgTable(
        "docs",
        (t) => ({ id: t.integer().primaryKey(), updatedAt: t.timestamptz() }),
        (t) => [rls.force(), updatedAtTrigger(t.updatedAt)],
      );
      const plain = pgTable(
        "plain",
        (t) => ({ id: t.integer().primaryKey() }),
        () => [rls.enable(), rls.force()],
      );
      const emitted = emitSchema({ tables: { docs, plain } });
      expect(emitted.diagnostics).toEqual([]);
      expect(emitted.sql.filter((s) => s.includes("ROW LEVEL SECURITY"))).toEqual([
        'ALTER TABLE "public"."docs" ENABLE ROW LEVEL SECURITY',
        'ALTER TABLE "public"."plain" ENABLE ROW LEVEL SECURITY',
      ]);

      const conn = await makeDatabase(EMIT);
      await withClient(conn, async (c) => {
        for (const s of emitted.sql) await c.query(s);
      });
      const ir = await withClient(conn, (c) => extractCatalog(c, { schemas: ["public"], observe: false }));
      expect(ir.ir.factsOfKind("table").map((f) => f.payload["rowSecurity"])).toEqual([true, true]);
      const lane = await withClient(conn, (c) => readLaneState(c, ["public"]));
      expect(lane.tables.map((t) => t.forced)).toEqual([false, false]);
      expect(lane.updatedAtTriggers).toEqual([]);
    },
    T,
  );

  it(
    "probeEmptiness under RLS: a FORCE'd table its owner cannot see is not proven empty (D20)",
    async () => {
      const table = { kind: "table", schema: "public", name: "documents" } as const;
      await withClient(cur, async (c) => {
        await c.query(`SET ROLE ${OWNER}`);
        // the control: under RLS the owner sees no row, which a probe would call empty
        expect((await c.query("SELECT count(*)::int AS n FROM public.documents")).rows[0]?.["n"]).toBe(0);
        expect([...(await probeEmptiness(c, [table]))]).toEqual([]);
        expect((await c.query("SHOW row_security")).rows[0]?.["row_security"]).toBe("on");
      });
    },
    T,
  );

  describe("on statements", () => {
    let before: LaneState;
    let build: (lane: BuildOptions["lane"], empty?: string[]) => ReturnType<typeof buildStatements>;

    beforeAll(async () => {
      before = await withClient(cur, (c) => readLaneState(c, ["public"]));
      const current = await withClient(cur, (c) => extractCatalog(c, { schemas: ["public"], observe: false }));
      const desired = await withClient(des, (c) => extractCatalog(c, { schemas: ["public"], observe: false }));
      const diff = diffIR(current.ir, desired.ir);
      build = (lane, empty = []) =>
        buildStatements(diff, desired.ir, { emptyTables: new Set(empty), ...(lane ? { lane } : {}) });
    }, T);

    const enabled = (s: LaneState, extra: LaneState["policies"] = []): LaneState => ({
      ...s,
      tables: s.tables.map((t) => (t.name === "open_data" ? { ...t, enabled: true } : t)),
      policies: [...s.policies, ...extra],
    });
    const openRead = {
      schema: "public",
      table: "open_data",
      name: "open_read",
      command: "select" as const,
      permissive: true,
      roles: [APP],
      using: "true",
      withCheck: null,
      marker: null,
      dependsOn: [],
    };
    const hazards = (r: ReturnType<typeof buildStatements>, needle: string): string[] =>
      r.statements.filter((s) => s.sql.includes(needle)).flatMap((s) => s.hazards);
    const rl101 = (r: ReturnType<typeof buildStatements>): string[] =>
      r.diagnostics.filter((d) => d.code === "RL101").map((d) => d.subject ?? "");

    it(
      "RL101 on ENABLE without a permissive policy, RL102 when the policy only arrives in the lane",
      () => {
        const none = build({ before, after: enabled(before) });
        expect(rl101(none)).toEqual([
          "public.open_data:public:select",
          "public.open_data:public:insert",
          "public.open_data:public:update",
          "public.open_data:public:delete",
        ]);
        expect(hazards(none, '"open_data" ENABLE')).toEqual([]);

        const later = build({ before, after: enabled(before, [openRead]) });
        expect(rl101(later)).toEqual([]);
        expect(hazards(later, '"open_data" ENABLE')).toEqual(["RL102"]);
        // already shipped: no window
        const shipped = { ...before, policies: [...before.policies, openRead] };
        expect(hazards(build({ before: shipped, after: enabled(shipped) }), '"open_data" ENABLE')).toEqual([]);

        const empty = build({ before, after: enabled(before) }, ["table:public.open_data"]);
        expect(rl101(empty)).toEqual([]);
        expect(rl101(build(undefined))).toEqual([]);
      },
      T,
    );

    it(
      "RL103 on DISABLE, with or without the lane",
      () => {
        expect(hazards(build(undefined), '"closed" DISABLE')).toEqual(["RL103"]);
      },
      T,
    );

    it(
      "RL106 on dropping or retyping a column a policy reads, and on dropping a table another policy reads",
      () => {
        const r = build({ before, after: before });
        expect(hazards(r, 'DROP COLUMN IF EXISTS "legacy"')).toContain("RL106");
        expect(hazards(r, 'ALTER COLUMN "org_id" TYPE')).toContain("RL106");
        expect(hazards(r, 'DROP TABLE IF EXISTS "public"."shares"')).toContain("RL106");
        expect(hazards(r, 'DROP COLUMN IF EXISTS "touched_at"')).not.toContain("RL106");
        expect(hazards(build(undefined), 'DROP COLUMN IF EXISTS "legacy"')).not.toContain("RL106");
      },
      T,
    );

    it(
      "a marked updatedAt trigger is dropped before its column goes",
      () => {
        const r = build({ before, after: before });
        const ordered = orderStatements(r.statements).statements.map((s) => s.sql);
        const drop = ordered.indexOf('DROP TRIGGER IF EXISTS "pgprime_set_touched_at" ON "public"."documents"');
        expect(drop).toBeGreaterThanOrEqual(0);
        expect(drop).toBeLessThan(ordered.findIndex((s) => s.includes('DROP COLUMN IF EXISTS "touched_at"')));
        expect(r.diagnostics.map((d) => d.code)).toContain("updated_at_trigger_dropped");
        expect(build(undefined).statements.some((s) => s.sql.startsWith("DROP TRIGGER"))).toBe(false);
      },
      T,
    );
  });
});

describe.skipIf(!canCreateRoles)("the trigger pre-drop keeps UPDATE working across a column rename", () => {
  const A = "pgprime_r3_rls_rename_a";
  const B = "pgprime_r3_rls_rename_b";
  const TRIGGER_SQL = (col: string): string => `
CREATE FUNCTION public.pgprime_set_${col}() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.${col} := now(); RETURN NEW; END $$;
CREATE TRIGGER pgprime_set_${col} BEFORE UPDATE ON public.items
  FOR EACH ROW EXECUTE FUNCTION public.pgprime_set_${col}();
COMMENT ON TRIGGER pgprime_set_${col} ON public.items IS 'pg-prime:declared sha256:00';`;

  afterAll(async () => {
    for (const db of [A, B, `${A}_x`]) await destroyDatabase(db).catch(() => undefined);
  }, T);

  const renamed = async (database: string, lane: boolean): Promise<unknown> => {
    const conn = await makeDatabase(database);
    await runSqlScript(
      conn,
      `CREATE TABLE public.items (id int PRIMARY KEY, name text, edited_at timestamptz);
       INSERT INTO public.items (id, name) VALUES (1, 'a');
       ${TRIGGER_SQL("edited_at")}`,
    );
    const desired = await makeDatabase(B);
    await runSqlScript(desired, "CREATE TABLE public.items (id int PRIMARY KEY, name text, modified_at timestamptz)");
    const current = await withClient(conn, (c) => extractCatalog(c, { schemas: ["public"], observe: false }));
    const want = await withClient(desired, (c) => extractCatalog(c, { schemas: ["public"], observe: false }));
    const before = await withClient(conn, (c) => readLaneState(c, ["public"]));
    const diff = diffIR(current.ir, want.ir, {
      renameHints: [
        {
          from: { kind: "column", schema: "public", table: "items", name: "edited_at" },
          to: { kind: "column", schema: "public", table: "items", name: "modified_at" },
        },
      ],
    });
    const built = buildStatements(diff, want.ir, lane ? { lane: { before, after: before } } : {});
    return withClient(conn, async (c) => {
      for (const s of orderStatements(built.statements).statements) await c.query(s.sql);
      return c.query("UPDATE public.items SET name = 'b'").then(
        () => "ok",
        (err: { code?: string }) => err.code,
      );
    });
  };

  it(
    "with the lane state the trigger goes first; without it every UPDATE fails with 42703",
    async () => {
      expect(await renamed(A, true)).toBe("ok");
      expect(await renamed(`${A}_x`, false)).toBe("42703");
    },
    T,
  );
});
