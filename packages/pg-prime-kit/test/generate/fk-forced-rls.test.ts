/** RL109 end to end: generate an FK between two FORCE'd tables, apply it as their owner without BYPASSRLS. */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defineSchema, pgTable, rls } from "pg-prime";
import { withClient } from "../../src/db/pg.js";
import { generate } from "../../src/generate.js";
import { createRepeatablesPass } from "../../src/repeatables/index.js";
import { applyPendingOn } from "../../src/runner/run.js";
import type { SchemaLike } from "../../src/schema/types.js";
import { ADMIN, dbConn, destroyDatabase, makeDatabase, serverAvailable, withAdmin } from "../support/db.js";
import { tempDir } from "../support/migrations.js";

const T = 240_000;
const ROLE = "pgprime_rl109_owner";

const canCreateRoles = await withAdmin(async (c) => {
  const r = await c.query("SELECT rolsuper OR rolcreaterole AS ok FROM pg_roles WHERE rolname = current_user");
  return r.rows[0]?.["ok"] === true;
}).catch(() => false);

const documents = pgTable(
  "documents",
  (t) => ({ id: t.integer().primaryKey() }),
  () => [rls.enable(), rls.force()],
);
const refs = pgTable(
  "refs",
  (t) => ({ id: t.integer().primaryKey(), doc: t.integer().references(() => documents.cols.id) }),
  () => [rls.enable(), rls.force()],
);
const schema = defineSchema({ documents, refs }) as unknown as SchemaLike;

describe.skipIf(!canCreateRoles)("RL109: an FK between two FORCE'd tables, as their owner", () => {
  const databases: string[] = [];
  afterAll(async () => {
    for (const db of databases) await destroyDatabase(db).catch(() => undefined);
    await withAdmin((c) => c.query(`DROP ROLE IF EXISTS ${ROLE}`)).catch(() => undefined);
  }, T);

  const run = async (database: string, doc: number) => {
    expect(await serverAvailable()).toBe(true);
    databases.push(database);
    await withAdmin((c) =>
      c.query(`DO $$ BEGIN CREATE ROLE ${ROLE} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`),
    );
    await makeDatabase(database);
    const conn = dbConn(database);
    await withClient(conn, async (c) => {
      await c.query(`GRANT CREATE ON DATABASE ${database} TO ${ROLE}`);
      await c.query(`GRANT CREATE ON SCHEMA public TO ${ROLE}`);
      await c.query(`CREATE TABLE public.documents (id integer PRIMARY KEY)`);
      await c.query(`CREATE TABLE public.refs (id integer PRIMARY KEY, doc integer)`);
      await c.query(`INSERT INTO public.documents VALUES (1)`);
      await c.query(`INSERT INTO public.refs VALUES (1, ${doc})`);
      for (const t of ["documents", "refs"]) {
        await c.query(`ALTER TABLE public.${t} OWNER TO ${ROLE}`);
        await c.query(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
        await c.query(`ALTER TABLE public.${t} FORCE ROW LEVEL SECURITY`);
      }
    });
    const root = await tempDir(`pgprime-${database}`);
    const [migrations, sql] = [join(root, "migrations"), join(root, "sql")];
    await mkdir(migrations, { recursive: true });
    await mkdir(sql, { recursive: true });
    const g = await generate({
      admin: ADMIN,
      target: conn,
      schema,
      repeatablesDir: sql,
      schemas: ["public"],
      seq: 1,
      name: "fk",
      outDir: migrations,
      prove: false,
      acknowledge: { allowDataLoss: true, reason: "test" },
    });
    expect(g.status).toBe("generated");
    const result = await withClient(conn, async (c) => {
      await c.query(`SET ROLE ${ROLE}`);
      return applyPendingOn(c, migrations, {
        schemas: ["public"],
        repeatablesDir: sql,
        repeatables: createRepeatablesPass(),
        // oxlint-disable-next-line typescript/require-await -- implements the async poolerProbe seam
        poolerProbe: async (): Promise<boolean> => false,
      });
    });
    const forced = await withClient(conn, async (c) =>
      (
        await c.query(
          "SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE oid IN ('public.documents'::regclass, 'public.refs'::regclass)",
        )
      ).rows.every((r) => r["f"] === true),
    );
    return { sql: g.files.flatMap((f) => f.plan?.statements.map((s) => s.sql) ?? []), result, forced };
  };

  it(
    "lifts FORCE from both tables, so a good reference applies and both are forced again",
    async () => {
      const { sql, result, forced } = await run("pgprime_rl109_ok", 1);
      expect(
        sql.some((s) => s.includes('"public"."documents" NO FORCE') && s.includes('"public"."refs" NO FORCE')),
      ).toBe(true);
      expect(result.status, result.error?.message).toBe("applied");
      expect(forced).toBe(true);
    },
    T,
  );

  it(
    "and a dangling reference still fails with 23503",
    async () => {
      const { result, forced } = await run("pgprime_rl109_bad", 2);
      expect(result.status).toBe("failed");
      expect(result.error?.sqlState).toBe("23503");
      expect(forced).toBe(true);
    },
    T,
  );
});
