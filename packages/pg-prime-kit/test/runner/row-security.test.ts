/**
 * design/20 D20 + RL107: the runner sets `row_security = off`, so a data migration that RLS
 * would silently filter fails with 42501 instead, and the pre-flight sweep warns first when the
 * runner role cannot bypass RLS.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClient } from "../../src/db/pg.js";
import { applyPendingOn, type ApplyPendingResult } from "../../src/runner/run.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable, withAdmin } from "../support/db.js";
import { tempDir, writeHandMigration } from "../support/migrations.js";

const T = 180_000;
const ROLE = "pgprime_rlsrun_role";

const canCreateRoles = await withAdmin(async (c) => {
  const r = await c.query("SELECT rolsuper OR rolcreaterole AS ok FROM pg_roles WHERE rolname = current_user");
  return r.rows[0]?.["ok"] === true;
}).catch(() => false);
if (!canCreateRoles) console.warn("test/runner/row-security.test.ts: SKIPPED — the test role cannot CREATE ROLE");

const DATA = `-- pg-prime:migration 0001_touch_documents
-- pg-prime:data
UPDATE public.documents SET touched = touched + 1;
`;

describe.skipIf(!canCreateRoles)("row_security = off on the runner session", () => {
  let dir = "";

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    dir = join(await tempDir("pgprime-r3-rowsec"), "migrations");
    await mkdir(dir, { recursive: true });
    await writeHandMigration(dir, "0001_touch_documents.sql", DATA);
    await withAdmin((c) =>
      c.query(`DO $$ BEGIN CREATE ROLE ${ROLE} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`),
    );
  }, T);

  afterAll(async () => {
    for (const db of ["pgprime_r3_rowsec_role", "pgprime_r3_rowsec_super"]) {
      await destroyDatabase(db).catch(() => undefined);
    }
    await withAdmin((c) => c.query(`DROP ROLE IF EXISTS ${ROLE}`)).catch(() => undefined);
  }, T);

  /** A FORCE'd table owned by the runner role, with one row and no policy that lets it in. */
  const run = async (database: string, asRole: boolean): Promise<{ result: ApplyPendingResult; touched: number }> => {
    await makeDatabase(database);
    const conn = dbConn(database);
    await withClient(conn, async (c) => {
      await c.query(`GRANT CREATE ON DATABASE ${database} TO ${ROLE}`);
      await c.query(`CREATE TABLE public.documents (id int PRIMARY KEY, touched int NOT NULL DEFAULT 0)`);
      await c.query(`INSERT INTO public.documents (id) VALUES (1)`);
      await c.query(`ALTER TABLE public.documents OWNER TO ${ROLE}`);
      await c.query(`ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY`);
      await c.query(`ALTER TABLE public.documents FORCE ROW LEVEL SECURITY`);
    });
    const result = await withClient(conn, async (c) => {
      if (asRole) await c.query(`SET ROLE ${ROLE}`);
      // oxlint-disable-next-line typescript/require-await -- implements the async poolerProbe seam
      const r = await applyPendingOn(c, dir, { poolerProbe: async (): Promise<boolean> => false });
      expect((await c.query("SHOW row_security")).rows[0]?.["row_security"]).toBe("off");
      return r;
    });
    const touched = await withClient(conn, async (c) =>
      Number((await c.query("SELECT touched FROM public.documents")).rows[0]?.["touched"]),
    );
    return { result, touched };
  };

  it(
    "a role without BYPASSRLS gets RL107 in the pre-flight and 42501 instead of a silent no-op",
    async () => {
      const { result, touched } = await run("pgprime_r3_rowsec_role", true);
      expect(result.diagnostics.filter((d) => d.code === "RL107").map((d) => d.subject)).toEqual([
        "0001_touch_documents",
      ]);
      expect(result.warnings.some((w) => w.includes("RL107") && w.includes("public.documents"))).toBe(true);
      expect(result.status).toBe("failed");
      expect(result.error?.sqlState).toBe("42501");
      expect(result.error?.message).toMatch(/row-level security/);
      expect(touched).toBe(0);
    },
    T,
  );

  it(
    "a superuser bypasses RLS: no RL107 and the update lands",
    async () => {
      const { result, touched } = await run("pgprime_r3_rowsec_super", false);
      expect(result.diagnostics.filter((d) => d.code === "RL107")).toEqual([]);
      expect(result.status).toBe("applied");
      expect(touched).toBe(1);
    },
    T,
  );
});
