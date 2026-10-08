/**
 * design/20 §5.3–§5.4 end to end: generate renders the declared lane, apply runs it, the prune
 * removes what is no longer declared, the runner self-heals (D24), and the lane hazards refuse
 * before anything is written (D23).
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { definePolicy, eq, pgTable, rls, updatedAtTrigger } from "pg-prime";
import { withClient } from "../../src/db/pg.js";
import { generate, LaneRefusedError, type GenerateInput } from "../../src/generate.js";
import { createRepeatablesPass, scanRepeatables } from "../../src/repeatables/index.js";
import { applyPending } from "../../src/runner/run.js";
import { declaredCensus, PRUNE_FILE, readMarks } from "../../src/schema/declared.js";
import type { SchemaLike } from "../../src/schema/types.js";
import { ADMIN, dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { tempDir } from "../support/migrations.js";
import { canCreateRoles, documents, orgId, policiesFor, schemaWith, withRole } from "../schema-emit/rls-fixture.js";

const T = 240_000;
const OWNER = "pgprime_r2_owner";
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

const ok = (await serverAvailable()) && (await canCreateRoles());
const POLICIES = policiesFor("public");
if (!ok) console.warn("declared-rls: skipped, the test role cannot CREATE ROLE");

interface Lane {
  readonly db: string;
  readonly migrations: string;
  readonly sql: string;
  gen(schema: SchemaLike, extra?: Partial<GenerateInput>, write?: boolean): ReturnType<typeof generate>;
  apply(): ReturnType<typeof applyPending>;
  query(text: string): Promise<Record<string, unknown>[]>;
}

async function lane(db: string): Promise<Lane> {
  await makeDatabase(db);
  const root = await tempDir(`pgprime-r2-${db}`);
  const migrations = join(root, "migrations");
  const sql = join(root, "sql");
  await mkdir(migrations, { recursive: true });
  await mkdir(sql, { recursive: true });
  let seq = 1;
  return {
    db,
    migrations,
    sql,
    gen: (schema, extra = {}, write = true) =>
      generate({
        admin: ADMIN,
        target: dbConn(db),
        schema,
        repeatablesDir: sql,
        schemas: ["public"],
        seq: seq++,
        name: "step",
        ...(write ? { outDir: migrations } : {}),
        prove: false,
        ...extra,
      }),
    apply: () =>
      applyPending(dbConn(db), migrations, {
        schemas: ["public"],
        repeatablesDir: sql,
        repeatables: createRepeatablesPass(),
      }),
    query: (text) => withClient(dbConn(db), async (c) => (await c.query(text)).rows),
  };
}

const registry = (tables: Record<string, unknown>, policies: readonly unknown[]): SchemaLike =>
  schemaWith(policies, tables);

const names = (rows: Record<string, unknown>[]): string[] => rows.map((r) => String(r["name"]));
const policyNames = (l: Lane, table: string): Promise<string[]> =>
  l.query(`SELECT polname AS name FROM pg_policy WHERE polrelid = 'public.${table}'::regclass ORDER BY 1`).then(names);

describe.skipIf(!ok)("the declared lane: generate → apply → change → prune → heal", () => {
  const audit = pgTable(
    "audit_log",
    (t) => ({ id: t.integer().primaryKey(), changedAt: t.timestamptz() }),
    (t) => [updatedAtTrigger(t.changedAt)],
  );
  const auditPlain = pgTable("audit_log", (t) => ({ id: t.integer().primaryKey(), changedAt: t.timestamptz() }));
  const shares = pgTable(
    "document_shares",
    (t) => ({ documentId: t.uuid(), orgId: t.uuid() }),
    () => [rls.enable()],
  );
  const sharesTenant = definePolicy("shares_tenant", {
    on: shares,
    to: ["public"],
    using: (t) => eq(t.orgId, orgId.current()),
  });
  const sharesOrg = definePolicy("shares_org", {
    on: shares,
    to: ["public"],
    using: (t) => eq(t.orgId, orgId.current()),
  });
  const tables = { documents, document_shares: shares, audit_log: audit };
  const base = registry(tables, [...POLICIES, sharesTenant]);
  let l: Lane;

  beforeAll(async () => {
    l = await lane("pgprime_r2_lane");
  }, T);
  afterAll(async () => {
    await destroyDatabase(l.db).catch(() => undefined);
  }, T);

  const census = async (): Promise<string[]> =>
    withClient(dbConn(l.db), async (c) =>
      (await declaredCensus(c, await scanRepeatables(l.sql), ["public"])).findings.map(
        (d) => `${d.code} ${d.subject ?? ""}`,
      ),
    );

  it(
    "renders, applies, filters rows by the setting and stamps updated_at",
    async () => {
      const first = await l.gen(base);
      expect(first.status, JSON.stringify(first.diagnostics)).toBe("generated");
      expect((await readdir(l.sql, { recursive: true })).filter((f) => f.endsWith(".sql")).sort()).toEqual([
        "050_policies/public__document_shares.sql",
        "050_policies/public__documents.sql",
        "070_triggers/000_functions.sql",
        "070_triggers/public__audit_log.sql",
        "070_triggers/public__documents.sql",
        PRUNE_FILE,
      ]);
      const applied = await l.apply();
      expect(applied.status, applied.error?.message).toBe("applied");
      expect(await census()).toEqual([]);

      await l.query(
        `INSERT INTO documents (org_id, updated_at) VALUES ('${A}', '2000-01-01'), ('${A}', '2000-01-01'), ('${B}', '2000-01-01')`,
      );
      const count = (org: string | null): Promise<number> =>
        withClient(dbConn(l.db), async (c) => {
          // A role created inside the transaction never becomes visible to another session.
          await c.query("BEGIN");
          await c.query("CREATE ROLE pgprime_r2_reader NOLOGIN");
          await c.query("GRANT SELECT ON documents, document_shares TO pgprime_r2_reader");
          await c.query("SET LOCAL ROLE pgprime_r2_reader");
          if (org !== null) await c.query("SELECT set_config('app.org_id', $1, true)", [org]);
          const r = await c.query("SELECT count(*)::int AS n FROM documents");
          await c.query("ROLLBACK");
          return Number(r.rows[0]?.["n"]);
        });
      expect([await count(A), await count(B), await count(null)]).toEqual([2, 1, 0]);

      await l.query(`UPDATE documents SET archived = true WHERE org_id = '${B}'`);
      const stamped = await l.query("SELECT updated_at > '2001-01-01' AS fresh FROM documents WHERE archived");
      expect(stamped).toEqual([{ fresh: true }]);

      const again = await l.gen(base);
      expect(again.status).toBe("up_to_date");
      expect((await l.apply()).repeatables.applied).toEqual([]);
    },
    T,
  );

  it(
    "an edited policy re-applies only its table's file; a renamed one is pruned in the same run",
    async () => {
      const edited = definePolicy("shares_tenant", {
        on: shares,
        to: ["public"],
        for: "select",
        using: (t) => eq(t.orgId, orgId.current()),
      });
      expect((await l.gen(registry(tables, [...POLICIES, edited]))).status).toBe("up_to_date");
      expect((await l.apply()).repeatables.applied).toEqual(["sql/050_policies/public__document_shares.sql"]);

      expect((await l.gen(registry(tables, [...POLICIES, sharesOrg]))).status).toBe("up_to_date");
      expect((await l.apply()).repeatables.applied).toEqual([
        "sql/050_policies/public__document_shares.sql",
        `sql/${PRUNE_FILE}`,
      ]);
      expect(await policyNames(l, "document_shares")).toEqual(["shares_org"]);
      expect(await census()).toEqual([]);
    },
    T,
  );

  it(
    "a manual DROP POLICY is recreated by the next apply (D24)",
    async () => {
      await l.query("DROP POLICY tenant ON documents");
      expect(await census()).toEqual(["declared_missing public.documents.tenant"]);
      expect((await l.apply()).repeatables.applied).toEqual(["sql/050_policies/public__documents.sql"]);
      expect(await policyNames(l, "documents")).toContain("tenant");
    },
    T,
  );

  it(
    "remove → apply → restore → apply recreates a declaration whose bytes match its orphaned row (D24)",
    async () => {
      const current = registry(tables, [...POLICIES, sharesOrg]);
      const removed = registry({ ...tables, audit_log: auditPlain }, [...POLICIES, sharesOrg]);
      expect((await l.gen(removed)).status).toBe("up_to_date");
      expect(await readdir(join(l.sql, "070_triggers"))).not.toContain("public__audit_log.sql");
      await l.apply();
      expect(
        await l.query("SELECT tgname AS name FROM pg_trigger WHERE tgrelid = 'public.audit_log'::regclass"),
      ).toEqual([]);

      expect((await l.gen(current)).status).toBe("up_to_date");
      const healed = await l.apply();
      expect(healed.repeatables.applied).toContain("sql/070_triggers/public__audit_log.sql");
      expect(
        names(await l.query("SELECT tgname AS name FROM pg_trigger WHERE tgrelid = 'public.audit_log'::regclass")),
      ).toEqual(["pgprime_set_changed_at"]);
      expect(await census()).toEqual([]);
    },
    T,
  );

  it(
    "dropping a restrictive policy is RL105: refused, then acknowledged into the prune header",
    async () => {
      const without = registry(tables, [POLICIES[0], POLICIES[2], sharesOrg]);
      const refused = await l.gen(without).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(LaneRefusedError);
      expect((refused as LaneRefusedError).hazards.map((h) => `${h.code} ${h.subject}`)).toEqual([
        "RL105 public.documents.archived_read_only",
      ]);
      const before = await readFile(join(l.sql, PRUNE_FILE), "utf8");
      expect(before).not.toContain("acknowledged");

      const acked = await l.gen(without, {
        acknowledge: { allowDataLoss: true, by: "alice", reason: "replaced by an app check" },
      });
      expect(acked.status).toBe("up_to_date");
      expect(acked.laneHazards.map((h) => h.acknowledged)).toEqual([true]);
      expect(await readFile(join(l.sql, PRUNE_FILE), "utf8")).toContain(
        "-- pg-prime:acknowledged RL105 public.documents.archived_read_only by alice: replaced by an app check",
      );
      // The header carries the acknowledgement: a re-run before apply is not refused again.
      expect((await l.gen(without)).status).toBe("up_to_date");
      await l.apply();
      expect(await policyNames(l, "documents")).toEqual(["shared", "tenant"]);
    },
    T,
  );

  it(
    "a tier-3 generate leaves the target's policies and markers untouched",
    async () => {
      const marks = (): Promise<unknown> => withClient(dbConn(l.db), (c) => readMarks(c, ["public"], []));
      const before = await marks();
      const r = await l.gen(registry(tables, [POLICIES[0], POLICIES[2], sharesOrg]), { shadow: "temp-schema" }, false);
      expect(r.shadow.tier).toBe(3);
      expect(await marks()).toEqual(before);
      expect(await census()).toEqual([]);
    },
    T,
  );

  it(
    "removing every declaration keeps the prune file, which drops policies, triggers and functions",
    async () => {
      const bare = registry(
        {
          documents: pgTable(
            "documents",
            (t) => ({
              id: t.uuid().primaryKey().defaultSql("gen_random_uuid()"),
              orgId: t.uuid(),
              archived: t.boolean().default(false),
              updatedAt: t.timestamptz().defaultSql("now()"),
            }),
            () => [rls.force()],
          ),
          document_shares: pgTable(
            "document_shares",
            (t) => ({ documentId: t.uuid(), orgId: t.uuid() }),
            () => [rls.enable()],
          ),
          audit_log: auditPlain,
        },
        [],
      );
      const r = await l.gen(bare, { acknowledge: { allowDataLoss: true, reason: "lane removed" } });
      expect(r.status).toBe("up_to_date");
      expect((await readdir(l.sql, { recursive: true })).filter((f) => f.endsWith(".sql")).sort()).toEqual([
        "050_policies/public__document_shares.sql",
        "050_policies/public__documents.sql",
        PRUNE_FILE,
      ]);
      await l.apply();
      expect(await l.query("SELECT polname FROM pg_policy")).toEqual([]);
      expect(await l.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal")).toEqual([]);
      expect(await l.query("SELECT proname FROM pg_proc WHERE proname LIKE 'pgprime_set_%'")).toEqual([]);
    },
    T,
  );
});

describe.skipIf(!ok)("lane hazards on the full before/after state (D25)", () => {
  let l: Lane;
  const items = pgTable(
    "items",
    (t) => ({ id: t.integer().primaryKey() }),
    () => [rls.enable()],
  );
  const itemsForced = pgTable(
    "items",
    (t) => ({ id: t.integer().primaryKey() }),
    () => [rls.force()],
  );
  const things = pgTable(
    "things",
    (t) => ({ id: t.integer().primaryKey() }),
    () => [rls.enable()],
  );
  const docs = pgTable(
    "docs",
    (t) => ({ id: t.integer().primaryKey() }),
    () => [rls.force()],
  );
  const docsUnforced = pgTable(
    "docs",
    (t) => ({ id: t.integer().primaryKey() }),
    () => [rls.enable()],
  );
  const sel = definePolicy("items_select", { on: items, for: "select", to: ["public"] });
  const ins = definePolicy("items_insert", { on: items, for: "insert", to: ["public"] });
  const thingsAll = definePolicy("things_all", { on: things, to: ["public"] });
  const split = (["select", "insert", "update", "delete"] as const).map((c) =>
    definePolicy(`things_${c}`, { on: things, for: c, to: ["public"] }),
  );
  const docsAll = definePolicy("docs_all", { on: docs, to: ["public"] });
  const tables = { items, things, docs };
  const refusal = (p: Promise<unknown>): Promise<string[]> =>
    p.then(
      () => [],
      (e: unknown) =>
        (e as LaneRefusedError).hazards.filter((h) => !h.acknowledged).map((h) => `${h.code} ${h.subject}`),
    );

  beforeAll(async () => {
    l = await lane("pgprime_r2_hazards");
    expect((await l.gen(registry(tables, [sel, ins, thingsAll, docsAll]))).status).toBe("generated");
    expect((await l.apply()).status).toBe("applied");
    await l.query("INSERT INTO items VALUES (1); INSERT INTO things VALUES (1); INSERT INTO docs VALUES (1)");
  }, T);
  afterAll(async () => {
    await destroyDatabase(l.db).catch(() => undefined);
  }, T);

  it(
    "RL101 per command: removing only the SELECT policy is flagged, ALL split into four is not",
    async () => {
      expect(await refusal(l.gen(registry(tables, [ins, thingsAll, docsAll])))).toEqual([
        "RL101 public.items:public:select",
      ]);
      expect(await refusal(l.gen(registry(tables, [sel, ins, ...split, docsAll]), {}, false))).toEqual([]);
    },
    T,
  );

  it(
    "a hand-written sql/ policy and an unmanaged target policy count as coverage",
    async () => {
      await writeFile(
        join(l.sql, "045_hand.sql"),
        `DROP POLICY IF EXISTS items_hand ON public.items;\nCREATE POLICY items_hand ON public.items FOR SELECT USING (true);\n`,
      );
      expect(await refusal(l.gen(registry(tables, [ins, thingsAll, docsAll]), {}, false))).toEqual([]);
      await writeFile(join(l.sql, "045_hand.sql"), "SELECT 1;\n");
      await l.query("CREATE POLICY items_dba ON items FOR SELECT USING (true)");
      expect(await refusal(l.gen(registry(tables, [ins, thingsAll, docsAll]), {}, false))).toEqual([]);
      await l.query("DROP POLICY items_dba ON items");
    },
    T,
  );

  it(
    "RL103: NO FORCE on a FORCE'd table is refused",
    async () => {
      expect(await refusal(l.gen(registry({ ...tables, docs: docsUnforced }, [sel, ins, thingsAll, docsAll])))).toEqual(
        ["RL103 public.docs"],
      );
    },
    T,
  );

  it(
    "RL108: FORCE filters a non-superuser owner for every command no policy grants it",
    async () => {
      await withRole(OWNER, "NOLOGIN", async () => {
        await l.query(`ALTER TABLE items OWNER TO ${OWNER}`);
        try {
          expect(
            await refusal(l.gen(registry({ ...tables, items: itemsForced }, [sel, ins, thingsAll, docsAll]))),
          ).toEqual(["update", "delete"].map((c) => `RL108 public.items:${OWNER}:${c}`));
        } finally {
          await l.query("ALTER TABLE items OWNER TO CURRENT_USER");
        }
      });
    },
    T,
  );

  it(
    "a refused run writes nothing: no lane file, no migration",
    async () => {
      const before = await readdir(l.sql, { recursive: true });
      const migrations = await readdir(l.migrations);
      await refusal(l.gen(registry({ ...tables, docs: docsUnforced }, [sel, thingsAll, docsAll])));
      expect(await readdir(l.sql, { recursive: true })).toEqual(before);
      expect(await readdir(l.migrations)).toEqual(migrations);
    },
    T,
  );

  it(
    "policy_unknown_role refuses before the shadow exists",
    async () => {
      const ghost = definePolicy("ghost", { on: things, to: ["pgprime_r2_nobody"] });
      const e = await l.gen(registry(tables, [sel, ins, thingsAll, docsAll, ghost])).catch((x: unknown) => x);
      expect((e as LaneRefusedError).diagnostics.map((d) => `${d.code} ${d.subject ?? ""}`)).toEqual([
        "policy_unknown_role pgprime_r2_nobody",
      ]);
    },
    T,
  );
});
