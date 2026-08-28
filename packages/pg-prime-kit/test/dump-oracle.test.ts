/**
 * The pg_dump equality oracle (design/06 D6 amendment).
 *
 * The point of this file is the `blind spot` test: a difference that our extractor
 * cannot see, our differ therefore does not plan for, and our IR-based proof declares
 * converged - caught by PostgreSQL's own serializer.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compareDumps,
  normalizeDump,
  parseLauncherEnv,
  tableReorderKey,
  type PgDumpLauncher,
} from "../src/prove/pg-dump.js";
import { splitStatements } from "../src/sql/statements.js";
import { generateFromDatabases as generate } from "../src/generate.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "./support/db.js";
import { pgDumpLauncher } from "./support/pgdump.js";

const T = 120_000;

describe("SQL statement splitting", () => {
  it("does not split on a semicolon inside a dollar-quoted body", () => {
    const sql = `CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $body$
      BEGIN
        -- a comment; with a semicolon
        RETURN 1;
      END;
    $body$;
    CREATE TABLE t (id int);`;
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("$body$");
    expect(out[0]).toContain("RETURN 1;"); // body preserved VERBATIM, comment and all
    expect(out[1]).toBe("CREATE TABLE t (id int)");
  });

  it("treats $1 as a bind placeholder, not a dollar quote", () => {
    expect(splitStatements("SELECT $1; SELECT $2;")).toEqual(["SELECT $1", "SELECT $2"]);
  });

  it("ignores a comment marker inside a string literal", () => {
    expect(splitStatements("SELECT '-- not a comment; really';")).toEqual(["SELECT '-- not a comment; really'"]);
  });

  it("handles nested block comments", () => {
    expect(splitStatements("SELECT /* outer /* inner */ still */ 1;")).toEqual(["SELECT 1"]);
  });

  it("respects backslash escapes only in E-strings", () => {
    expect(splitStatements("SELECT E'\\'; still inside'; SELECT 2;")).toHaveLength(2);
  });

  it("collapses whitespace in code but never inside a literal", () => {
    const [stmt] = splitStatements("CREATE  TABLE\n  t (\n  id int DEFAULT 'a   b'\n);");
    expect(stmt).toBe("CREATE TABLE t ( id int DEFAULT 'a   b' )");
  });
});

describe("dump normalization", () => {
  const dump = `--
-- PostgreSQL database dump
--

\\restrict AqXWTt0MFcBef0JHQHcczaP46nO4f0ETSzDyO76d7SeG

-- Dumped from database version 17.11

SET statement_timeout = 0;
SET client_encoding = 'UTF8';
SELECT pg_catalog.set_config('search_path', '', false);

SET default_table_access_method = heap;

CREATE TABLE public.t (
    id integer NOT NULL
);

\\unrestrict AqXWTt0MFcBef0JHQHcczaP46nO4f0ETSzDyO76d7SeG
`;

  it("strips the random-token psql meta-commands", () => {
    // Without this the oracle would report a difference on every single run.
    expect(normalizeDump(dump).join("\n")).not.toContain("restrict");
  });

  it("strips session preamble but keeps schema-bearing SETs", () => {
    const out = normalizeDump(dump);
    expect(out).not.toContain("SET statement_timeout = 0");
    expect(out).not.toContain("SET client_encoding = 'UTF8'");
    expect(out).toContain("SET default_table_access_method = heap");
    expect(out).toContain("CREATE TABLE public.t ( id integer NOT NULL )");
  });

  it("is order-independent but not count-independent", () => {
    expect(
      compareDumps("CREATE TABLE a (x int); CREATE TABLE b (y int);", "CREATE TABLE b (y int); CREATE TABLE a (x int);")
        .equal,
    ).toBe(true);
    const dup = compareDumps("CREATE TABLE a (x int); CREATE TABLE a (x int);", "CREATE TABLE a (x int);");
    expect(dup.equal).toBe(false);
    expect(dup.extra).toHaveLength(1);
  });

  it("reports direction: missing is what the migration failed to create", () => {
    const cmp = compareDumps("CREATE TABLE a (x int);", "CREATE TABLE a (x int); CREATE INDEX i ON a (x);");
    expect(cmp.missing).toEqual(["CREATE INDEX i ON a (x)"]);
    expect(cmp.extra).toEqual([]);
  });

  /**
   * The whole class of drift PostgreSQL 18 opened up: a constraint whose NAME is stale
   * after a rename. Normalising the name away here would make every one of those plans
   * pass, which is precisely the silent semantic loss the oracle exists to prevent — so
   * this is a NEGATIVE test on the oracle itself, and it must stay red-if-relaxed.
   *
   * `\restrict`'s random token IS normalised away, one line above. That is the narrow,
   * verified exception: the token differs between two dumps of the SAME database, so it
   * carries no schema information at all.
   */
  it("never normalises a NOT NULL constraint name away", () => {
    const fresh = "CREATE TABLE public.users ( id bigint NOT NULL, name text NOT NULL );";
    const stale =
      "CREATE TABLE public.users ( id bigint NOT NULL, name text CONSTRAINT users_first_name_not_null NOT NULL );";
    const cmp = compareDumps(stale, fresh);
    expect(cmp.equal).toBe(false);
    // nor is it excused as an unrepairable column reordering
    expect(cmp.reordered).toEqual([]);
    expect(cmp.missing[0]).toContain("name text NOT NULL");
    expect(cmp.extra[0]).toContain("users_first_name_not_null");
  });
});

describe("column-order classification", () => {
  const a = "CREATE TABLE public.t ( id bigint NOT NULL, full_name text, email text NOT NULL )";
  const b = "CREATE TABLE public.t ( id bigint NOT NULL, email text NOT NULL, full_name text )";

  it("pairs tables that differ only in column order", () => {
    const cmp = compareDumps(`${b};`, `${a};`);
    expect(cmp.missing).toEqual([]);
    expect(cmp.extra).toEqual([]);
    expect(cmp.reordered).toEqual(["public.t"]);
    // Not a failure: PostgreSQL has no ADD COLUMN ... BEFORE, so no plan can converge.
    expect(cmp.equal).toBe(true);
  });

  it("does not confuse a storage parameter for a reordering", () => {
    const plain = "CREATE TABLE public.t ( id integer NOT NULL )";
    const withFf = "CREATE TABLE public.t ( id integer NOT NULL ) WITH (fillfactor='70')";
    const cmp = compareDumps(`${plain};`, `${withFf};`);
    expect(cmp.equal).toBe(false);
    expect(cmp.reordered).toEqual([]);
    expect(cmp.missing[0]).toContain("fillfactor");
  });

  it("still reports a genuinely different column", () => {
    const changed = "CREATE TABLE public.t ( id bigint NOT NULL, email text, full_name text )";
    const cmp = compareDumps(`${changed};`, `${a};`);
    expect(cmp.equal).toBe(false);
    expect(cmp.reordered).toEqual([]);
  });

  it("does not split on a comma inside a type modifier or a literal", () => {
    const key = tableReorderKey(
      "CREATE TABLE public.t ( total numeric(12,2) NOT NULL, note text DEFAULT 'a,b'::text )",
    );
    expect(key?.table).toBe("public.t");
    expect(key?.key).toContain("numeric(12,2)");
    expect(key?.key).toContain("'a,b'");
  });
});

describe("launcher configuration", () => {
  it("accepts JSON argv and whitespace forms", () => {
    expect(parseLauncherEnv('["docker","exec","-i","c","pg_dump"]')).toEqual(["docker", "exec", "-i", "c", "pg_dump"]);
    expect(parseLauncherEnv("  /usr/bin/pg_dump  ")).toEqual(["/usr/bin/pg_dump"]);
  });
});

describe("pg_dump oracle against live PostgreSQL", () => {
  let pgDump: PgDumpLauncher | undefined;

  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
    const found = await pgDumpLauncher();
    expect(found, "no pg_dump available (install client tools or start the spike container)").not.toBeNull();
    pgDump = found ?? undefined;
  }, T);

  describe("a converged plan also dumps identically", () => {
    const DESIRED = "pgprime_dump_acc_desired";
    const TARGET = "pgprime_dump_acc_target";

    beforeAll(async () => {
      await makeDatabase(DESIRED, "acceptance/desired.sql");
      await makeDatabase(TARGET);
    }, T);
    afterAll(async () => {
      await destroyDatabase(DESIRED).catch(() => undefined);
      await destroyDatabase(TARGET).catch(() => undefined);
    }, T);

    it(
      "passes the oracle in strict mode",
      async () => {
        const result = await generate({
          admin: ADMIN,
          target: { ...ADMIN, database: TARGET },
          desired: { ...ADMIN, database: DESIRED },
          schemas: ["public"],
          seq: 1,
          name: "acceptance",
          dumpOracle: "strict",
          ...(pgDump ? { pgDump } : {}),
        });

        const oracle = result.plan.proof.dumpOracle;
        expect(oracle?.reason).toBeUndefined();
        expect(oracle?.status, JSON.stringify(oracle, null, 2)).toBe("passed");
        expect(oracle?.statementCount).toBeGreaterThan(10);
        expect(result.plan.proof.status).toBe("passed");
      },
      T,
    );
  });

  describe("column order on a live migration", () => {
    const CURRENT = "pgprime_dump_evolve_current";
    const DESIRED = "pgprime_dump_evolve_desired";

    beforeAll(async () => {
      await makeDatabase(CURRENT, "evolve/current.sql");
      await makeDatabase(DESIRED, "evolve/desired.sql");
    }, T);
    afterAll(async () => {
      await destroyDatabase(CURRENT).catch(() => undefined);
      await destroyDatabase(DESIRED).catch(() => undefined);
    }, T);

    it(
      "reports the ADD COLUMN reordering without failing the plan",
      async () => {
        const result = await generate({
          admin: ADMIN,
          target: { ...ADMIN, database: CURRENT },
          desired: { ...ADMIN, database: DESIRED },
          schemas: ["public"],
          seq: 1,
          name: "evolve",
          dumpOracle: "strict",
          ...(pgDump ? { pgDump } : {}),
        });
        const oracle = result.plan.proof.dumpOracle;
        // `full_name` is declared 4th but ADD COLUMN can only append it.
        expect(oracle?.reordered).toEqual(["public.customers"]);
        expect(oracle?.status).toBe("passed");
        expect(result.plan.proof.status).toBe("passed");
      },
      T,
    );
  });

  describe("blind spot: a difference the IR cannot represent", () => {
    const CURRENT = "pgprime_dump_blind_current";
    const DESIRED = "pgprime_dump_blind_desired";

    beforeAll(async () => {
      await makeDatabase(CURRENT, "unmodeled/current.sql");
      await makeDatabase(DESIRED, "unmodeled/desired.sql");
    }, T);
    afterAll(async () => {
      await destroyDatabase(CURRENT).catch(() => undefined);
      await destroyDatabase(DESIRED).catch(() => undefined);
    }, T);

    it(
      "the differ sees nothing, the IR proof converges, and the oracle still catches it",
      async () => {
        const result = await generate({
          admin: ADMIN,
          target: { ...ADMIN, database: CURRENT },
          desired: { ...ADMIN, database: DESIRED },
          schemas: ["public"],
          seq: 1,
          name: "unmodeled",
          dumpOracle: "strict",
          ...(pgDump ? { pgDump } : {}),
        });

        // 1. Our differ is blind to storage parameters: no delta, no statement.
        expect(result.diff.deltas).toHaveLength(0);
        expect(result.plan.statements).toHaveLength(0);

        // 2. The IR-based proof is therefore satisfied - this is the silent pass.
        expect(result.plan.proof.driftDeltas).toBe(0);

        // 3. PostgreSQL's serializer disagrees, and says exactly why.
        const oracle = result.plan.proof.dumpOracle;
        expect(oracle?.status).toBe("failed");
        expect(oracle?.missingCount).toBe(1);
        expect(JSON.stringify(oracle?.missing)).toContain("fillfactor");

        // 4. In strict mode that failure propagates to the proof itself.
        expect(result.plan.proof.status).toBe("failed");
      },
      T,
    );

    it(
      "warn mode records the same difference without blocking the plan",
      async () => {
        const result = await generate({
          admin: ADMIN,
          target: { ...ADMIN, database: CURRENT },
          desired: { ...ADMIN, database: DESIRED },
          schemas: ["public"],
          seq: 2,
          name: "unmodeled_warn",
          dumpOracle: "warn",
          ...(pgDump ? { pgDump } : {}),
        });
        expect(result.plan.proof.dumpOracle?.status).toBe("failed");
        expect(result.plan.proof.status).toBe("passed");
      },
      T,
    );
  });
});
