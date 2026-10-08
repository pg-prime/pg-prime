/**
 * design/20 §5.6 / D18: `pull` writes RLS flags and every policy as DSL (raw `pg_get_expr` text,
 * omitted clauses kept omitted) and a marked `pgprime_set_<col>` trigger on a timestamptz column
 * as `updatedAtTrigger`; everything else stays in `sql/`.
 *
 * The emitted file is imported and its policies applied to a fresh database: the policies read
 * back identical, which is the lossless claim without the declared lane (R2's round trip).
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readLaneState, type PolicyState } from "../../src/catalog/extract.js";
import { runSqlScript, withClient, type ConnInfo } from "../../src/db/pg.js";
import { pullSchema } from "../../src/pull/pull.js";
import { emitSchema } from "../../src/schema/emit.js";
import type { TableLike } from "../../src/schema/types.js";
import { destroyDatabase, makeDatabase, serverAvailable, withAdmin } from "../support/db.js";

const T = 180_000;
const A = "pgprime_r3_pull_rls_a";
const B = "pgprime_r3_pull_rls_b";
const APP = "pgprime_rlspull_app";
const ADMIN_ROLE = "pgprime_rlspull_admin";

const canCreateRoles = await withAdmin(async (c) => {
  const r = await c.query("SELECT rolsuper OR rolcreaterole AS ok FROM pg_roles WHERE rolname = current_user");
  return r.rows[0]?.["ok"] === true;
}).catch(() => false);
if (!canCreateRoles) console.warn("test/pull/rls.test.ts: SKIPPED — the test role cannot CREATE ROLE");

const marked = (table: string, col: string, type: string): string => `
CREATE FUNCTION public.pgprime_set_${col}() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.${col} := now(); RETURN NEW; END $$;
COMMENT ON FUNCTION public.pgprime_set_${col}() IS 'pg-prime:declared sha256:${type}1';
CREATE TRIGGER pgprime_set_${col} BEFORE UPDATE ON public.${table}
  FOR EACH ROW EXECUTE FUNCTION public.pgprime_set_${col}();
COMMENT ON TRIGGER pgprime_set_${col} ON public.${table} IS 'pg-prime:declared sha256:${type}2';`;

const FIXTURE = `
CREATE TABLE public.documents (
  id int PRIMARY KEY, org_id int NOT NULL, archived boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.notes (id int PRIMARY KEY, body text, edited_at timestamp);
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON public.documents TO ${APP}
  USING (org_id = nullif(current_setting('app.org_id', true), '')::int)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::int);
CREATE POLICY archived_read_only ON public.documents AS RESTRICTIVE FOR UPDATE TO ${APP} USING (NOT archived);
CREATE POLICY insert_only ON public.documents FOR INSERT TO ${APP}, ${ADMIN_ROLE} WITH CHECK (org_id > 0);
CREATE POLICY nothing ON public.notes;
CREATE POLICY shared ON public.notes FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.documents d WHERE d.id = notes.id));
COMMENT ON POLICY tenant ON public.documents IS 'pg-prime:declared sha256:aa';
${marked("documents", "updated_at", "a")}
${marked("notes", "edited_at", "b")}
CREATE FUNCTION public.touch_note() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER notes_touch BEFORE INSERT ON public.notes FOR EACH ROW EXECUTE FUNCTION public.touch_note();
`;

const comparable = (ps: readonly PolicyState[]): unknown[] => ps.map(({ marker: _marker, ...p }) => p);

describe.skipIf(!canCreateRoles)("pull writes policies, RLS flags and updatedAt triggers as DSL", () => {
  let a: ConnInfo;
  let dir = "";

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    await withAdmin(async (c) => {
      for (const r of [APP, ADMIN_ROLE]) {
        await c.query(`DO $$ BEGIN CREATE ROLE ${r} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
      }
    });
    a = await makeDatabase(A);
    await runSqlScript(a, FIXTURE);
    dir = await mkdtemp(join(tmpdir(), "pgprime-r3-pull-rls-"));
  }, T);

  afterAll(async () => {
    for (const db of [A, B]) await destroyDatabase(db).catch(() => undefined);
    await withAdmin(async (c) => {
      for (const r of [APP, ADMIN_ROLE]) await c.query(`DROP ROLE IF EXISTS ${r}`);
    }).catch(() => undefined);
  }, T);

  const pull = (): ReturnType<typeof pullSchema> =>
    pullSchema({ connection: a, schemas: ["public"], out: join(dir, "schema.ts"), sqlDir: join(dir, "sql") });

  it(
    "emits rls.force()/rls.enable(), updatedAtTrigger and one definePolicy per policy",
    async () => {
      const r = await pull();
      expect(r.ts).toContain("import { definePolicy, defineSchema, pgTable, primaryKey, rls, updatedAtTrigger }");
      expect(r.ts).toMatch(
        /export const documents = pgTable\([^]*rls\.force\(\),\n {2}updatedAtTrigger\(t\.updatedAt\),\n\]\)/,
      );
      expect(r.ts).toMatch(/export const notes = pgTable\([^]*rls\.enable\(\),\n\]\)/);
      expect(r.ts).toContain(
        [
          'export const documentsArchivedReadOnly = definePolicy("archived_read_only", {',
          "  on: documents,",
          '  for: "update",',
          '  as: "restrictive",',
          `  to: ["${APP}"],`,
          '  using: () => sql.unsafeRaw("(NOT archived)"),',
          "})",
        ].join("\n"),
      );
      expect(r.ts).toContain(
        [
          'export const documentsInsertOnly = definePolicy("insert_only", {',
          "  on: documents,",
          '  for: "insert",',
          `  to: ["${ADMIN_ROLE}", "${APP}"],`,
          '  withCheck: () => sql.unsafeRaw("(org_id > 0)"),',
          "})",
        ].join("\n"),
      );
      expect(r.ts).toContain('export const notesNothing = definePolicy("nothing", {\n  on: notes,\n})');
      expect(r.counts["policy"]).toBe(5);
      expect(r.unsupported).toEqual([]);
      expect((await pull()).ts).toBe(r.ts);
    },
    T,
  );

  it(
    "leaves 040_rls/050_policies and the converted trigger and function out of sql/, and keeps the rest",
    async () => {
      const r = await pull();
      const kept = r.repeatables.map((o) => `${o.kind} ${o.identity}`);
      expect(r.repeatables.some((o) => /\/0[45]0_/.test(o.path))).toBe(false);
      expect(kept).not.toContain("trigger public.documents.pgprime_set_updated_at");
      expect(kept).not.toContain("function public.pgprime_set_updated_at()");
      // `timestamp` without a time zone has no DSL builder, so it stays a hand repeatable
      expect(kept).toEqual(
        expect.arrayContaining([
          "trigger public.notes.pgprime_set_edited_at",
          "function public.pgprime_set_edited_at()",
          "trigger public.notes.notes_touch",
          "function public.touch_note()",
        ]),
      );
    },
    T,
  );

  it(
    "the emitted file re-creates the same policies on a fresh database",
    async () => {
      const r = await pull();
      const file = join(dir, "pulled.ts");
      await writeFile(file, r.ts, "utf8");
      const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      const policies = Object.values(mod).filter(
        (v): v is { kind: "policy"; $: { ddl: (s: (x: string | undefined) => string) => string } } =>
          (v as { kind?: unknown } | null)?.kind === "policy",
      );
      const tables = mod["default"] as { tables: Record<string, TableLike> };
      expect(policies).toHaveLength(5);

      const b = await makeDatabase(B);
      await withClient(b, async (c) => {
        for (const s of emitSchema({ tables: tables.tables }).sql) await c.query(s);
        for (const p of policies) await c.query(p.$.ddl((s) => s ?? "public"));
      });
      const want = await withClient(a, (c) => readLaneState(c, ["public"]));
      const got = await withClient(b, (c) => readLaneState(c, ["public"]));
      expect(comparable(got.policies)).toEqual(comparable(want.policies));
      expect(got.tables.map((t) => [t.name, t.enabled])).toEqual(want.tables.map((t) => [t.name, t.enabled]));
      expect(tables.tables["documents"]?.$.extras).toContainEqual({ node: "rls", force: true });
    },
    T,
  );
});
