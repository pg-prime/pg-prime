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
import { runSqlScript, withClient } from "../src/db/pg.js";
import { definitionsAgreeUnderRename, tokenizeDefinition } from "../src/diff/rename.js";
import { generate } from "../src/generate.js";
import { applySegments } from "../src/runner/apply.js";
import {
  ADMIN,
  catalogsNotNullConstraints,
  destroyDatabase,
  makeDatabase,
  serverAvailable,
} from "./support/db.js";

const COL_CUR = "pgprime_ren_col_cur";
const COL_DES = "pgprime_ren_col_des";
const TBL_CUR = "pgprime_ren_tbl_cur";
const TBL_DES = "pgprime_ren_tbl_des";
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
      // PG >= 18 gave NOT NULL a pg_constraint row, so `first_name`'s auto-named one is
      // a THIRD dependent the rename has to carry (see the dedicated describe below).
      expect(result.diff.renames.map((r) => [r.kind, r.from, r.to, r.source])).toEqual([
        ["column", "column:public.users.first_name", "column:public.users.name", "annotation"],
        ["index", "index:public.users_first_name_idx", "index:public.users_name_idx", "cascade"],
        ...((await catalogsNotNullConstraints())
          ? [
              [
                "constraint",
                "constraint:public.users.users_first_name_not_null",
                "constraint:public.users.users_name_not_null",
                "cascade",
              ],
            ]
          : []),
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

/**
 * PostgreSQL 18 catalogues NOT NULL as a real `pg_constraint` row (`contype = 'n'`) with
 * an auto-generated name, and — like every other auto-named dependent — declines to
 * rename it when you rename the column or the table. `pg_dump` 18 then prints
 * `CONSTRAINT users_first_name_not_null NOT NULL` on a column called `name`, so the
 * migrated database is distinguishable from a fresh create and D6 says the plan is not
 * proven. Everything here is skipped on a server that has no such row to rename.
 */
describe("PostgreSQL 18 named NOT NULL, so a rename has to carry that name too", () => {
  const dbs = [
    COL_CUR,
    COL_DES,
    TBL_CUR,
    TBL_DES,
    "pgprime_nn_named_cur",
    "pgprime_nn_named_des",
    "pgprime_nn_long_cur",
    "pgprime_nn_long_des",
    "pgprime_nn_rename_cur",
    "pgprime_nn_rename_des",
  ];

  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
  }, T);

  afterAll(async () => {
    for (const db of dbs) await destroyDatabase(db).catch(() => undefined);
  }, T);

  it(
    "a column rename renames the auto-named NOT NULL constraint",
    async () => {
      if (!(await catalogsNotNullConstraints())) return;
      const target = await makeDatabase(COL_CUR, "rename-column/current.sql");
      const desired = await makeDatabase(COL_DES, "rename-column/desired.sql");

      const result = await generate({
        admin: ADMIN,
        target,
        desired,
        schemas: ["public"],
        seq: 1,
        name: "nn_column",
        dumpOracle: "strict",
        renameHints: [{ from: "column:public.users.first_name", to: "column:public.users.name" }],
      });

      const sql = result.plan.statements.map((s) => s.sql);
      expect(sql).toContain(
        'ALTER TABLE "public"."users" RENAME CONSTRAINT "users_first_name_not_null" TO "users_name_not_null"',
      );
      // a RENAME, never the DROP + re-verify that `SET NOT NULL` would cost
      expect(sql.filter((s) => /NOT NULL/.test(s) && !/RENAME CONSTRAINT/.test(s))).toEqual([]);
      expect(result.plan.proof.status).toBe("passed");

      await withClient(target, (c) => applySegments(c, result.plan.statements, result.plan.segments));
      expect(await notNullNames(target.database)).toEqual([
        "users.id -> users_id_not_null",
        "users.name -> users_name_not_null",
      ]);
    },
    T,
  );

  it(
    "a table rename renames every column's auto-named NOT NULL constraint",
    async () => {
      if (!(await catalogsNotNullConstraints())) return;
      const target = await makeDatabase(TBL_CUR, "rename-table/current.sql");
      const desired = await makeDatabase(TBL_DES, "rename-table/desired.sql");

      const result = await generate({
        admin: ADMIN,
        target,
        desired,
        schemas: ["public"],
        seq: 1,
        name: "nn_table",
        dumpOracle: "strict",
        renameHints: [{ from: "table:public.tenants", to: "table:public.accounts" }],
      });

      expect(result.plan.statements.map((s) => s.sql)).toContain(
        'ALTER TABLE "public"."accounts" RENAME CONSTRAINT "tenants_id_not_null" TO "accounts_id_not_null"',
      );
      // `sites` was not renamed, so its NOT NULL names are nobody's business
      expect(
        result.diff.renames.filter((r) => /sites/.test(r.from) || /sites/.test(r.to)),
      ).toEqual([]);
      expect(result.plan.proof.status).toBe("passed");

      await withClient(target, (c) => applySegments(c, result.plan.statements, result.plan.segments));
      expect(await notNullNames(target.database)).toEqual([
        "accounts.id -> accounts_id_not_null",
        "sites.id -> sites_id_not_null",
        "sites.tenant_id -> sites_tenant_id_not_null",
      ]);
    },
    T,
  );

  it(
    "the cascade computes the TRUNCATED name the server would have chosen",
    async () => {
      if (!(await catalogsNotNullConstraints())) return;
      // 30 + 30 characters do not fit in NAMEDATALEN once `_not_null` is added, so the
      // server shortens the LONGER piece one byte at a time: 27 + 26, not a right-cut of
      // the concatenation. A template string here would rename to a name no fresh
      // CREATE TABLE ever produces, and the dump oracle below is what says so.
      const a = "a".repeat(30);
      const b = "b".repeat(30);
      const c = "c".repeat(30);
      const target = await makeDatabase("pgprime_nn_long_cur");
      const desired = await makeDatabase("pgprime_nn_long_des");
      await runSqlScript(target, `CREATE TABLE public.${a} (${b} int NOT NULL);`);
      await runSqlScript(desired, `CREATE TABLE public.${a} (${c} int NOT NULL);`);

      const result = await generate({
        admin: ADMIN,
        target,
        desired,
        schemas: ["public"],
        seq: 1,
        name: "nn_long",
        dumpOracle: "strict",
        renameHints: [{ from: `column:public.${a}.${b}`, to: `column:public.${a}.${c}` }],
      });

      expect(result.plan.statements.map((s) => s.sql)).toContain(
        `ALTER TABLE "public"."${a}" RENAME CONSTRAINT ` +
          `"${"a".repeat(27)}_${"b".repeat(26)}_not_null" TO "${"a".repeat(27)}_${"c".repeat(26)}_not_null"`,
      );
      expect(result.plan.proof.status).toBe("passed");
    },
    T,
  );

  it(
    "a NOT NULL the user named keeps its name through a rename, and is never dropped",
    async () => {
      if (!(await catalogsNotNullConstraints())) return;
      const target = await makeDatabase("pgprime_nn_named_cur");
      const desired = await makeDatabase("pgprime_nn_named_des");
      await runSqlScript(
        target,
        `CREATE TABLE public.users (first_name text CONSTRAINT first_name_required NOT NULL);`,
      );
      await runSqlScript(
        desired,
        `CREATE TABLE public.users (name text CONSTRAINT first_name_required NOT NULL);`,
      );

      const result = await generate({
        admin: ADMIN,
        target,
        desired,
        schemas: ["public"],
        seq: 1,
        name: "nn_named",
        dumpOracle: "strict",
        renameHints: [{ from: "column:public.users.first_name", to: "column:public.users.name" }],
      });

      const sql = result.plan.statements.map((s) => s.sql);
      expect(sql).toEqual(['ALTER TABLE "public"."users" RENAME COLUMN "first_name" TO "name"']);
      expect(result.plan.proof.status).toBe("passed");
      // the name is the USER's; a rename is not permission to regenerate it
      expect(await notNullNames(target.database)).toEqual(["users.first_name -> first_name_required"]);
    },
    T,
  );

  it(
    "a user-named NOT NULL round-trips through CREATE TABLE and is re-named, not re-added",
    async () => {
      if (!(await catalogsNotNullConstraints())) return;
      const target = await makeDatabase("pgprime_nn_rename_cur");
      const desired = await makeDatabase("pgprime_nn_rename_des");
      await runSqlScript(desired, `CREATE TABLE public.t (a int CONSTRAINT a_is_required NOT NULL);`);

      const created = await generate({
        admin: ADMIN,
        target,
        desired,
        schemas: ["public"],
        seq: 1,
        name: "nn_create",
        dumpOracle: "strict",
      });
      // the name is carried INTO the column clause, not bolted on with a second statement
      expect(created.plan.statements.map((s) => s.sql)).toEqual([
        'CREATE TABLE "public"."t" (\n  "a" integer CONSTRAINT "a_is_required" NOT NULL\n)',
      ]);
      expect(created.plan.proof.status).toBe("passed");
      await withClient(target, (c) => applySegments(c, created.plan.statements, created.plan.segments));

      // now change only the NAME: a catalog-only rename, never DROP/SET NOT NULL
      await runSqlScript(desired, `ALTER TABLE public.t RENAME CONSTRAINT a_is_required TO a_required;`);
      const renamed = await generate({
        admin: ADMIN,
        target,
        desired,
        schemas: ["public"],
        seq: 2,
        name: "nn_rename",
        dumpOracle: "strict",
      });
      expect(renamed.plan.statements.map((s) => s.sql)).toEqual([
        'ALTER TABLE "public"."t" RENAME CONSTRAINT "a_is_required" TO "a_required"',
      ]);
      expect(renamed.plan.proof.status).toBe("passed");
    },
    T,
  );
});

/** `table.column -> constraint name`, for every catalogued NOT NULL in `public`. */
async function notNullNames(database: string): Promise<string[]> {
  return withClient({ ...ADMIN, database }, async (c) => {
    const r = await c.query(
      `SELECT cl.relname || '.' || a.attname || ' -> ' || con.conname AS row
         FROM pg_constraint con
         JOIN pg_class cl ON cl.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
         JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = con.conkey[1]
        WHERE n.nspname = 'public' AND con.contype = 'n'
        ORDER BY 1`,
    );
    return r.rows.map((x) => String(x["row"]));
  });
}
