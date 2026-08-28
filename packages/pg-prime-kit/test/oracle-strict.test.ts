/**
 * The pg_dump witness has to be able to say NO.
 *
 * Every one of these was a silent green gate: `--schema App` is an unquoted PATTERN, so
 * pg_dump case-folded it, matched nothing, exited 1 — and the oracle called that
 * `skipped`, which never blocks even under `strict`. Every other dump error (refused
 * connection, permission denied, timeout) landed in the same bucket, and a pg_dump older
 * than the server produced an empty dump on both sides that compared EQUAL.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCatalog } from "../src/catalog/extract.js";
import { runSqlScript, withClient } from "../src/db/pg.js";
import { generateFromDatabases as generate } from "../src/generate.js";
import { parseLauncherEnv, resolvePgDump, schemaPattern, type PgDumpLauncher } from "../src/prove/pg-dump.js";
import { proveOnShadowClone } from "../src/prove/prove.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "./support/db.js";

const CUR = "pgprime_oracle_cur";
const DES = "pgprime_oracle_des";
const T = 180_000;

/** The launcher the suite is already configured with (PATH or `docker exec`). */
async function workingLauncher(): Promise<PgDumpLauncher> {
  const resolved = await resolvePgDump();
  if ("unavailable" in resolved) throw new Error(`no usable pg_dump: ${resolved.unavailable}`);
  return { argv: resolved.argv, ...(resolved.uri ? { uri: resolved.uri } : {}) };
}

describe("pg_dump oracle: patterns, classification and strict gating", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
  }, T);

  afterAll(async () => {
    for (const db of [CUR, DES]) await destroyDatabase(db).catch(() => undefined);
  }, T);

  it("quotes the --schema pattern rather than handing pg_dump a glob", () => {
    // hand-written oracle: this is psql's `\dt "App".*` spelling, not an echo of ours
    expect(schemaPattern("App")).toBe('"App"');
    expect(schemaPattern("public")).toBe('"public"');
    expect(schemaPattern('we"ird')).toBe('"we""ird"');
    expect(schemaPattern("a.b*c?")).toBe('"a.b*c?"');
  });

  it("rejects a malformed PG_PRIME_PG_DUMP instead of throwing out of the oracle", () => {
    expect(parseLauncherEnv('["docker","exec","pg_dump"]')).toEqual(["docker", "exec", "pg_dump"]);
    expect(parseLauncherEnv("pg_dump")).toEqual(["pg_dump"]);
    expect(parseLauncherEnv("[not json")).toBeNull();
    expect(parseLauncherEnv('["pg_dump", 7]')).toBeNull();
    expect(parseLauncherEnv("[]")).toBeNull();
    expect(parseLauncherEnv("   ")).toBeNull();
  });

  it(
    "actually witnesses a MIXED-CASE schema instead of skipping it",
    async () => {
      await makeDatabase(CUR);
      await makeDatabase(DES);
      await runSqlScript({ ...ADMIN, database: CUR }, 'CREATE SCHEMA "App"');
      await runSqlScript(
        { ...ADMIN, database: DES },
        'CREATE SCHEMA "App"; CREATE TABLE "App".widgets (id bigint PRIMARY KEY, label text NOT NULL);',
      );

      const result = await generate({
        admin: ADMIN,
        target: { ...ADMIN, database: CUR },
        desired: { ...ADMIN, database: DES },
        schemas: ["App"],
        seq: 1,
        name: "mixed_case",
        dumpOracle: "strict",
      });

      const oracle = result.plan.proof.dumpOracle;
      expect(oracle?.reason).toBeUndefined();
      expect(oracle?.status).toBe("passed");
      // it really dumped something: a skipped-and-empty comparison is trivially equal
      expect(oracle?.statementCount ?? 0).toBeGreaterThan(0);
      expect(result.plan.proof.status).toBe("passed");
    },
    T,
  );

  it(
    "a dump that RAN and failed is `failed`, not `skipped`",
    async () => {
      const base = await workingLauncher();
      const source = { ...ADMIN, database: DES };
      const ir = (await withClient(source, (c) => extractCatalog(c, { schemas: ["App"] }))).ir;
      const proof = await proveOnShadowClone({
        admin: ADMIN,
        source,
        desired: ir,
        schemas: ["App"],
        statements: [],
        segments: [],
        desiredConn: source,
        dumpOracle: "strict",
        pgDump: { argv: base.argv, uri: () => "postgresql://nobody@127.0.0.1:1/nothing" },
      });
      expect(proof.dumpOracle?.status).toBe("failed");
      expect(proof.status).toBe("failed");
    },
    T,
  );

  it(
    "a pg_dump older than the server is skipped, not silently equal",
    async () => {
      const source = { ...ADMIN, database: DES };
      const ir = (await withClient(source, (c) => extractCatalog(c, { schemas: ["App"] }))).ir;
      const proof = await proveOnShadowClone({
        admin: ADMIN,
        source,
        desired: ir,
        schemas: ["App"],
        statements: [],
        segments: [],
        desiredConn: source,
        dumpOracle: "warn",
        // reports a PG 9.6 client; two empty dumps from it used to compare EQUAL
        pgDump: { argv: ["sh", "-c", "echo 'pg_dump (PostgreSQL) 9.6.24'"] },
      });
      expect(proof.dumpOracle?.status).toBe("skipped");
      expect(proof.dumpOracle?.reason).toMatch(/older than the server/);
    },
    T,
  );

  it(
    "strict blocks a plan the oracle could not witness, unless told otherwise",
    async () => {
      const source = { ...ADMIN, database: DES };
      const ir = (await withClient(source, (c) => extractCatalog(c, { schemas: ["App"] }))).ir;
      const common = {
        admin: ADMIN,
        source,
        desired: ir,
        schemas: ["App"],
        statements: [],
        segments: [],
        dumpOracle: "strict" as const,
      };

      // no desiredConn => the oracle cannot run at all
      const blocked = await proveOnShadowClone(common);
      expect(blocked.dumpOracle?.status).toBe("skipped");
      expect(blocked.status).toBe("failed");
      expect(blocked.error).toMatch(/could not run under strict mode/);

      const allowed = await proveOnShadowClone({ ...common, allowSkippedOracle: true });
      expect(allowed.dumpOracle?.status).toBe("skipped");
      expect(allowed.status).toBe("passed");
    },
    T,
  );
});
