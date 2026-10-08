/**
 * design/20 §8: RLS through `pull` and back, witnessed by the pg_dump oracle. The declared-lane
 * marker COMMENTs are stripped before every comparison: a pulled policy renders its clauses from
 * `pg_get_expr`, so its CREATE text, and therefore its hash, differs from the original's.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSchema } from "../../src/config/load.js";
import { runSqlScript, withClient } from "../../src/db/pg.js";
import { generate } from "../../src/generate.js";
import { compareDumps, dumpSchema, resolvePgDump, type ResolvedPgDump } from "../../src/prove/pg-dump.js";
import { pullSchema } from "../../src/pull/pull.js";
import { createRepeatablesPass, scanRepeatables } from "../../src/repeatables/index.js";
import { applyPending } from "../../src/runner/run.js";
import { declaredCensus } from "../../src/schema/declared.js";
import type { SchemaLike } from "../../src/schema/types.js";
import { ADMIN, dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { tempDir } from "../support/migrations.js";
import { policiesFor, schemaWith } from "../schema-emit/rls-fixture.js";

const T = 300_000;
const A = "pgprime_r2_rt_a";
const B = "pgprime_r2_rt_b";
const C = "pgprime_r2_rt_c";
const SCHEMAS = ["public"];

const resolved = (await serverAvailable()) ? await resolvePgDump() : { unavailable: "no server" };
const pgDump: ResolvedPgDump | null = "unavailable" in resolved ? null : resolved;
if (pgDump === null) console.warn(`rls-roundtrip: skipped, ${"unavailable" in resolved ? resolved.unavailable : ""}`);

const tenant = (role: string): string => `
CREATE POLICY tenant ON public.documents TO ${role}
  USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);`;

/** The §3.3 example as a person would write it in SQL. */
const REFERENCE = `
CREATE TABLE public.documents (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL,
  archived boolean DEFAULT false NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT documents_pkey PRIMARY KEY (id)
);
CREATE TABLE public.document_shares (document_id uuid NOT NULL, org_id uuid NOT NULL);
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;
CREATE POLICY archived_read_only ON public.documents AS RESTRICTIVE FOR UPDATE TO PUBLIC
  USING (archived = false);
CREATE POLICY shared ON public.documents FOR SELECT TO PUBLIC
  USING (EXISTS (SELECT 1 FROM document_shares s
                 WHERE s.document_id = documents.id
                   AND s.org_id = nullif(current_setting('app.org_id', true), '')::uuid));
${tenant("PUBLIC")}
CREATE FUNCTION public.pgprime_set_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW."updated_at" := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER pgprime_set_updated_at BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.pgprime_set_updated_at();
`;

const MARKER_COMMENT = /^COMMENT ON (POLICY|TRIGGER|FUNCTION) .* IS 'pg-prime:declared sha256:[0-9a-f]+';$/gm;
const dump = async (database: string): Promise<string> =>
  (await dumpSchema({ pgDump: pgDump!, conn: ADMIN, database, schemas: SCHEMAS })).replace(MARKER_COMMENT, "");

describe.skipIf(pgDump === null)("RLS round trip through pull, witnessed by pg_dump", () => {
  let root = "";

  const lane = async (database: string, schema: SchemaLike, sql: string): Promise<void> => {
    const migrations = join(root, `${database}_migrations`);
    await mkdir(migrations, { recursive: true });
    const g = await generate({
      admin: ADMIN,
      target: dbConn(database),
      schema,
      repeatablesDir: sql,
      schemas: SCHEMAS,
      seq: 0,
      name: "init",
      outDir: migrations,
      prove: false,
    });
    expect(g.status, JSON.stringify(g.diagnostics)).toBe("generated");
    const applied = await applyPending(dbConn(database), migrations, {
      schemas: SCHEMAS,
      repeatablesDir: sql,
      repeatables: createRepeatablesPass(),
    });
    expect(applied.status, applied.error?.message).toBe("applied");
  };
  const census = (database: string, sql: string): Promise<string[]> =>
    withClient(dbConn(database), async (c) =>
      (await declaredCensus(c, await scanRepeatables(sql), SCHEMAS)).findings.map(
        (d) => `${d.code} ${d.subject ?? ""}`,
      ),
    );

  beforeAll(async () => {
    root = await tempDir("pgprime-r2-roundtrip");
    for (const db of [A, B, C]) await makeDatabase(db);
    await lane(A, schemaWith(policiesFor("public")), join(root, "a_sql"));
  }, T);

  afterAll(async () => {
    for (const db of [A, B, C]) await destroyDatabase(db).catch(() => undefined);
  }, T);

  it(
    "A → pull → generate + apply into a fresh B: the dumps agree and each lane's census is green",
    async () => {
      const out = join(root, "pulled", "schema.ts");
      const sql = join(root, "pulled", "sql");
      const pulled = await pullSchema({ connection: dbConn(A), schemas: SCHEMAS, out, sqlDir: sql });
      expect(pulled.unsupported).toEqual([]);
      await mkdir(join(root, "pulled"), { recursive: true });
      await writeFile(out, pulled.ts, "utf8");
      const schema = (await loadSchema(out, root)).schema as unknown as SchemaLike;
      expect(schema.policies?.map((p) => p.name).sort()).toEqual(["archived_read_only", "shared", "tenant"]);

      await lane(B, schema, sql);
      const cmp = compareDumps(await dump(B), await dump(A));
      expect({ missing: cmp.missing, extra: cmp.extra }).toEqual({ missing: [], extra: [] });
      expect(await census(A, join(root, "a_sql"))).toEqual([]);
      expect(await census(B, sql)).toEqual([]);
    },
    T,
  );

  it(
    "a hand-written reference SQL fixture dumps the same as A, and one changed policy role is reported",
    async () => {
      await runSqlScript(dbConn(C), REFERENCE);
      const same = compareDumps(await dump(C), await dump(A));
      expect({ missing: same.missing, extra: same.extra }).toEqual({ missing: [], extra: [] });

      await runSqlScript(dbConn(C), `DROP POLICY tenant ON public.documents;${tenant("CURRENT_USER")}`);
      const changed = compareDumps(await dump(C), await dump(A));
      expect(changed.equal).toBe(false);
      expect([...changed.missing, ...changed.extra].join("\n")).toContain("CREATE POLICY tenant");
    },
    T,
  );
});
