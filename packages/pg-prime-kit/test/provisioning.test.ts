/**
 * Shadow provisioning must never be destructive to something the tool did not create.
 *
 * Two ways it used to be:
 *   - `createDatabase(admin, clone, template)` ran `pg_terminate_backend` over the
 *     TEMPLATE first, and the template is the live migration target — so `generate`
 *     handed an unrelated application `FATAL 57P01 terminating connection due to
 *     administrator command`;
 *   - `cloneName` is a caller input that was dropped `WITH (FORCE)` before creation,
 *     so `cloneName === source.database` destroyed the source.
 */

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCatalog } from "../src/catalog/extract.js";
import { isShadowDatabase, terminateConnections, UnsafeDatabaseNameError, withClient } from "../src/db/pg.js";
import { generateFromDatabases as generate } from "../src/generate.js";
import { proveOnShadowClone, UnsafeCloneNameError } from "../src/prove/prove.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable, withAdmin } from "./support/db.js";

const TARGET = "pgprime_prov_target";
const DESIRED = "pgprime_prov_desired";
const SOURCE_SHADOW = "pgprime_shadow_prov_src";
const T = 180_000;

describe("shadow provisioning never disconnects or destroys what it did not create", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
  }, T);

  afterAll(async () => {
    for (const db of [TARGET, DESIRED, SOURCE_SHADOW]) await destroyDatabase(db).catch(() => undefined);
  }, T);

  it(
    "a bystander stays connected to the target for the whole of generate()",
    async () => {
      const target = await makeDatabase(TARGET, "evolve/current.sql");
      const desired = await makeDatabase(DESIRED, "evolve/desired.sql");

      const bystander = new pg.Client({ ...ADMIN, database: TARGET });
      await bystander.connect();
      // `pg` emits an async 'error' when the server terminates the backend; without a
      // listener that becomes an unhandled rejection instead of a test failure.
      const asyncErrors: unknown[] = [];
      bystander.on("error", (e) => asyncErrors.push(e));
      const pidBefore = String((await bystander.query("SELECT pg_backend_pid() AS pid")).rows[0]?.["pid"]);
      // hold a real transaction open, which is what makes the template unusable
      await bystander.query("BEGIN");
      await bystander.query("SELECT count(*) FROM public.customers");

      try {
        const result = await generate({
          admin: ADMIN,
          target,
          desired,
          schemas: ["public"],
          seq: 1,
          name: "bystander",
        });

        // the exact failure: the backend is gone, or replaced by a new one
        const pidAfter = String((await bystander.query("SELECT pg_backend_pid() AS pid")).rows[0]?.["pid"]);
        expect(asyncErrors).toEqual([]);
        expect(pidAfter).toBe(pidBefore);
        await bystander.query("COMMIT");

        // …and the proof still happened, on the tier that needs no exclusive access
        expect(result.plan.proof.provisioning).toBe("materialized");
        expect(result.plan.proof.status).toBe("passed");
        expect(result.plan.proof.driftDeltas).toBe(0);
      } finally {
        await bystander.end().catch(() => undefined);
      }
    },
    T,
  );

  it(
    "the template tier is still used when nobody is attached to the source",
    async () => {
      const result = await generate({
        admin: ADMIN,
        target: { ...ADMIN, database: TARGET },
        desired: { ...ADMIN, database: DESIRED },
        schemas: ["public"],
        seq: 2,
        name: "idle_source",
      });
      expect(result.plan.proof.provisioning).toBe("template");
      expect(result.plan.proof.status).toBe("passed");
    },
    T,
  );

  it(
    "refuses a clone name it did not mint, and leaves the source intact",
    async () => {
      const source = await makeDatabase(SOURCE_SHADOW, "evolve/current.sql");
      const ir = (await withClient(source, (c) => extractCatalog(c, { schemas: ["public"] }))).ir;
      const base = {
        admin: ADMIN,
        source,
        desired: ir,
        schemas: ["public"] as const,
        statements: [],
        segments: [],
      };

      // not a name this tool mints
      await expect(proveOnShadowClone({ ...base, cloneName: TARGET })).rejects.toBeInstanceOf(
        UnsafeCloneNameError,
      );
      // shadow-prefixed, but it IS the source
      await expect(proveOnShadowClone({ ...base, cloneName: SOURCE_SHADOW })).rejects.toBeInstanceOf(
        UnsafeCloneNameError,
      );

      // the source survived both attempts, tables and all
      const after = await withClient(source, (c) => extractCatalog(c, { schemas: ["public"] }));
      expect(after.ir.has({ kind: "table", schema: "public", name: "customers" })).toBe(true);
      expect(after.ir.fingerprint).toBe(ir.fingerprint);
    },
    T,
  );

  it("terminateConnections refuses any database this tool did not provision", async () => {
    expect(isShadowDatabase("pgprime_shadow_ab12")).toBe(true);
    expect(isShadowDatabase("pgprime_shadow_")).toBe(false);
    expect(isShadowDatabase("postgres")).toBe(false);

    await withAdmin(async (admin) => {
      await expect(terminateConnections(admin, "postgres")).rejects.toBeInstanceOf(UnsafeDatabaseNameError);
      // and it really did not run: the admin session itself is still usable
      const r = await admin.query("SELECT 1 AS ok");
      expect(r.rows[0]?.["ok"]).toBe(1);
    });
  }, T);
});
