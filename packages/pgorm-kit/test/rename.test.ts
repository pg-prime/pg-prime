/**
 * D5 renames, and what they must NOT drag along.
 *
 * The old implementation rewrote stored definition text with regexes. It always emitted
 * the quoted form while `pg_get_indexdef` emits a bare name, so the hashes still
 * differed and every dependent index and constraint was planned as a DROP + CREATE — an
 * FK re-added `NOT VALID` plus a full-table `VALIDATE`, and a PK drop that PostgreSQL
 * refuses outright while a dependent exists. It also substituted inside string literals,
 * and it never looked at FKs on other tables.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCatalog } from "../src/catalog/extract.js";
import { withClient } from "../src/db/pg.js";
import { definitionsAgreeUnderRename, tokenizeDefinition } from "../src/diff/rename.js";
import { generate } from "../src/generate.js";
import { applySegments } from "../src/runner/apply.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "./support/db.js";

const COL_CUR = "pgorm_ren_col_cur";
const COL_DES = "pgorm_ren_col_des";
const TBL_CUR = "pgorm_ren_tbl_cur";
const TBL_DES = "pgorm_ren_tbl_des";
const T = 180_000;

describe("definition agreement is decided on tokens, not on text", () => {
  const map = new Map([["first_name", "name"]]);

  it("bridges bare vs quoted spellings of the same identifier", () => {
    expect(
      definitionsAgreeUnderRename(
        "CREATE INDEX %ID% ON public.users USING btree (first_name)",
        'CREATE INDEX %ID% ON public.users USING btree ("name")',
        map,
      ),
    ).toBe(true);
  });

  it("never treats a string literal as a name", () => {
    expect(
      definitionsAgreeUnderRename(
        "CHECK ((first_name <> 'first_name'::text))",
        "CHECK ((name <> 'first_name'::text))",
        map,
      ),
    ).toBe(true);
    // negative control: the LITERAL changing is a real difference
    expect(
      definitionsAgreeUnderRename(
        "CHECK ((first_name <> 'first_name'::text))",
        "CHECK ((name <> 'name'::text))",
        map,
      ),
    ).toBe(false);
  });

  it("negative control: an unrelated change is still a change", () => {
    expect(
      definitionsAgreeUnderRename(
        "CREATE INDEX %ID% ON public.users USING btree (first_name)",
        "CREATE UNIQUE INDEX %ID% ON public.users USING btree (name)",
        map,
      ),
    ).toBe(false);
    expect(
      definitionsAgreeUnderRename("FOREIGN KEY (a) REFERENCES public.x(id)", "FOREIGN KEY (a) REFERENCES public.y(id)", map),
    ).toBe(false);
  });

  it("tokenizes a quoted identifier as the same token as its bare spelling", () => {
    expect(tokenizeDefinition('a."B"')).toEqual([{ ident: "a" }, { text: "." }, { ident: "B" }]);
    expect(tokenizeDefinition("'lit'")).toEqual([{ text: "'lit'" }]);
  });
});

describe("a rename renames its dependents instead of recreating them", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
  }, T);

  afterAll(async () => {
    for (const db of [COL_CUR, COL_DES, TBL_CUR, TBL_DES]) {
      await destroyDatabase(db).catch(() => undefined);
    }
  }, T);

  it(
    "column rename: the index is RENAMED, the CHECK is untouched, nothing is dropped",
    async () => {
      const target = await makeDatabase(COL_CUR, "rename-column/current.sql");
      const desired = await makeDatabase(COL_DES, "rename-column/desired.sql");

      const result = await generate({
        admin: ADMIN,
        target,
        desired,
        schemas: ["public"],
        seq: 1,
        name: "rename_column",
        dumpOracle: "strict",
        renameHints: [{ from: "column:public.users.first_name", to: "column:public.users.name" }],
      });

      const sql = result.plan.statements.map((s) => s.sql);
      expect(sql).toContain('ALTER TABLE "public"."users" RENAME COLUMN "first_name" TO "name"');
      expect(sql).toContain('ALTER INDEX "public"."users_first_name_idx" RENAME TO "users_name_idx"');
      // THE regression: no phantom drop+recreate of the dependents
      expect(sql.filter((s) => /DROP INDEX|DROP CONSTRAINT|ADD CONSTRAINT|VALIDATE CONSTRAINT/.test(s))).toEqual([]);
      expect(result.diff.renames.map((r) => [r.kind, r.from, r.to, r.source])).toEqual([
        ["column", "column:public.users.first_name", "column:public.users.name", "annotation"],
        ["index", "index:public.users_first_name_idx", "index:public.users_name_idx", "cascade"],
      ]);
      expect(result.plan.proof.status).toBe("passed");

      // apply for real and check the literal survived
      const report = await withClient(target, (c) =>
        applySegments(c, result.plan.statements, result.plan.segments),
      );
      expect(report.error).toBeUndefined();
      const after = await withClient(target, (c) => extractCatalog(c, { schemas: ["public"] }));
      expect(after.ir.fingerprint).toBe(result.desiredIR.fingerprint);
      const ck = after.ir.get({ kind: "constraint", schema: "public", table: "users", name: "users_name_ck" });
      expect(String(ck?.payload["definition"])).toContain("'first_name'");
    },
    T,
  );

  it(
    "table rename: the FK on ANOTHER table follows, and the auto-named PK is renamed",
    async () => {
      const target = await makeDatabase(TBL_CUR, "rename-table/current.sql");
      const desired = await makeDatabase(TBL_DES, "rename-table/desired.sql");

      const result = await generate({
        admin: ADMIN,
        target,
        desired,
        schemas: ["public"],
        seq: 1,
        name: "rename_table",
        dumpOracle: "strict",
        renameHints: [{ from: "table:public.tenants", to: "table:public.accounts" }],
      });

      const sql = result.plan.statements.map((s) => s.sql);
      expect(sql).toContain('ALTER TABLE "public"."tenants" RENAME TO "accounts"');
      expect(sql).toContain(
        'ALTER TABLE "public"."accounts" RENAME CONSTRAINT "tenants_pkey" TO "accounts_pkey"',
      );
      // the FK in `sites` is not even mentioned: it changed only in the referenced NAME
      expect(sql.filter((s) => /sites_tenant_fkey/.test(s))).toEqual([]);
      expect(sql.filter((s) => /DROP CONSTRAINT|ADD CONSTRAINT|VALIDATE CONSTRAINT|DROP TABLE/.test(s))).toEqual([]);
      expect(result.plan.proof.status).toBe("passed");

      const report = await withClient(target, (c) =>
        applySegments(c, result.plan.statements, result.plan.segments),
      );
      expect(report.error).toBeUndefined();
      const after = await withClient(target, (c) => extractCatalog(c, { schemas: ["public"] }));
      expect(after.ir.fingerprint).toBe(result.desiredIR.fingerprint);
    },
    T,
  );
});
