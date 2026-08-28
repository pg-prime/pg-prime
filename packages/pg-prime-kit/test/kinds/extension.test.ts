/**
 * Extensions are declare-only (design/06 §2.2): "created if absent, **never dropped**,
 * members projected out".
 *
 * Two halves, and the second is the one that bites. Never dropping is easy; never
 * dropping *and still converging* is not — a differ that merely omits the DROP leaves the
 * surviving extension as a residual delta, the shadow proof reports drift, and every plan
 * that stopped declaring one is refused. So the fact is skipped on both sides of the diff
 * and the retention is reported instead.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCatalog } from "../../src/catalog/extract.js";
import { buildStatements } from "../../src/diff/ddl.js";
import { diffIR } from "../../src/diff/diff.js";
import { runSqlScript, withClient } from "../../src/db/pg.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";

const WITH_EXT = "pgprime_k3_ext_with";
const WITHOUT_EXT = "pgprime_k3_ext_without";
const T = 180_000;

describe("extension: created if absent, never dropped", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
    const a = await makeDatabase(WITH_EXT);
    await runSqlScript(a, `CREATE EXTENSION hstore; CREATE TABLE public.t (id bigint PRIMARY KEY);`);
    const b = await makeDatabase(WITHOUT_EXT);
    await runSqlScript(b, `CREATE TABLE public.t (id bigint PRIMARY KEY);`);
  }, T);

  afterAll(async () => {
    for (const db of [WITH_EXT, WITHOUT_EXT]) await destroyDatabase(db).catch(() => undefined);
  }, T);

  it(
    "an undeclared extension yields no DROP, no delta, and one info diagnostic",
    async () => {
      const current = await withClient({ ...ADMIN, database: WITH_EXT }, (c) =>
        extractCatalog(c, { schemas: ["public"] }),
      );
      const desired = await withClient({ ...ADMIN, database: WITHOUT_EXT }, (c) =>
        extractCatalog(c, { schemas: ["public"] }),
      );

      const diff = diffIR(current.ir, desired.ir);
      // Not "no DROP statement" — no DELTA at all. The distinction is the convergence
      // one: a delta with no statement is drift the proof would refuse.
      expect(diff.deltas).toEqual([]);
      expect(buildStatements(diff, desired.ir).statements).toEqual([]);

      const retained = diff.diagnostics.filter((d) => d.code === "extension_retained");
      expect(retained.map((d) => d.subject)).toEqual(["extension:hstore"]);
      expect(retained[0]?.severity).toBe("info");
    },
    T,
  );

  it(
    "a newly declared extension is created with IF NOT EXISTS, before anything that uses it",
    async () => {
      const current = await withClient({ ...ADMIN, database: WITHOUT_EXT }, (c) =>
        extractCatalog(c, { schemas: ["public"] }),
      );
      const desired = await withClient({ ...ADMIN, database: WITH_EXT }, (c) =>
        extractCatalog(c, { schemas: ["public"] }),
      );
      const sql = buildStatements(diffIR(current.ir, desired.ir), desired.ir).statements;
      expect(sql.map((s) => s.sql)).toEqual([
        `CREATE EXTENSION IF NOT EXISTS "hstore" SCHEMA "public"`,
      ]);
      // `IF NOT EXISTS` is not politeness: an extension installed out of band by a DBA is
      // the common case, and failing on it is refusing to adopt the database.
      expect(sql[0]?.idempotent).toBe(true);
    },
    T,
  );
});
