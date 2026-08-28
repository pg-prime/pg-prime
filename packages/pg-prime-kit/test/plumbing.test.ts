/**
 * Small, load-bearing plumbing.
 *
 *  - `SchemaIR.toJSON(pgMajor)` collided with `JSON.stringify`'s `toJSON(key)` protocol,
 *    so `JSON.stringify({ ir })` produced a checkpoint stamped `pgMajor: "ir"`;
 *  - `connectionString` did not bracket an IPv6 host, so the first `:` of the address
 *    terminated the host and the rest was parsed as a port;
 *  - `PG_PRIME_PG_DUMP_URI`'s `{db}` substitution was not URL-encoded;
 *  - the runner pinned no `search_path`, and a bare (`txmode none`) segment ran with no
 *    `lock_timeout` at all.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCatalog } from "../src/catalog/extract.js";
import { connectionString, runSqlScript, withClient } from "../src/db/pg.js";
import { resolvePgDump } from "../src/prove/pg-dump.js";
import { applySegments } from "../src/runner/apply.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "./support/db.js";
import type { PlanStatement } from "../src/plan/plan.js";

const DB = "pgprime_plumbing";
const T = 180_000;

const stmt = (index: number, sql: string): PlanStatement => ({
  index,
  sql,
  verb: "alter",
  kind: "probe",
  produces: [],
  consumes: [],
  destroys: [],
  releases: [],
  transactionality: "transactional",
  lockClass: "none",
  idempotent: true,
  timeouts: { lock: "3s", statement: "30s" },
  dataLoss: "none",
  rewrite: false,
  hazards: [],
});

describe("connection strings", () => {
  it("brackets an IPv6 literal", () => {
    expect(connectionString({ host: "::1", port: 5432, user: "u", password: "p", database: "d" })).toBe(
      "postgresql://u:p@[::1]:5432/d",
    );
    expect(connectionString({ host: "2001:db8::1", port: 6543, user: "u", password: "p", database: "d" })).toBe(
      "postgresql://u:p@[2001:db8::1]:6543/d",
    );
    // an ordinary host is untouched, and every user-controlled part is encoded
    expect(connectionString({ host: "db.local", port: 5432, user: "a b", password: "p@ss", database: "x/y" })).toBe(
      "postgresql://a%20b:p%40ss@db.local:5432/x%2Fy",
    );
  });
});

describe("PG_PRIME_PG_DUMP_URI", () => {
  it("URL-encodes the database it substitutes", async () => {
    const saved = { argv: process.env["PG_PRIME_PG_DUMP"], uri: process.env["PG_PRIME_PG_DUMP_URI"] };
    try {
      process.env["PG_PRIME_PG_DUMP"] = JSON.stringify(["sh", "-c", "echo 'pg_dump (PostgreSQL) 17.11'"]);
      process.env["PG_PRIME_PG_DUMP_URI"] = "postgresql://u@h:5432/{db}";
      const resolved = await resolvePgDump();
      expect("unavailable" in resolved).toBe(false);
      if ("unavailable" in resolved) return;
      expect(resolved.uri?.("plain")).toBe("postgresql://u@h:5432/plain");
      expect(resolved.uri?.("a/b?c")).toBe("postgresql://u@h:5432/a%2Fb%3Fc");
      expect(resolved.major).toBe(17);
    } finally {
      if (saved.argv === undefined) delete process.env["PG_PRIME_PG_DUMP"];
      else process.env["PG_PRIME_PG_DUMP"] = saved.argv;
      if (saved.uri === undefined) delete process.env["PG_PRIME_PG_DUMP_URI"];
      else process.env["PG_PRIME_PG_DUMP_URI"] = saved.uri;
    }
  });
});

describe("the IR checkpoint is not JSON.stringify's protocol", () => {
  it(
    "does not fire on JSON.stringify, and stamps the major it is given",
    async () => {
      expect(await serverAvailable()).toBe(true);
      const conn = await makeDatabase(DB);
      try {
        const { ir } = await withClient(conn, (c) => extractCatalog(c, { schemas: ["public"] }));
        const checkpoint = ir.toCheckpoint(17) as { pgMajor: unknown; formatVersion: unknown };
        expect(checkpoint.pgMajor).toBe(17);
        expect(checkpoint.formatVersion).toBe(1);
        // the exact failure: a stray stringify used to emit a checkpoint keyed "ir"
        expect(JSON.parse(JSON.stringify({ ir })) as unknown).toEqual({ ir: {} });
      } finally {
        await destroyDatabase(DB).catch(() => undefined);
      }
    },
    T,
  );
});

describe("the runner pins the session it runs in", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
    await makeDatabase(DB);
  }, T);

  afterAll(async () => {
    await destroyDatabase(DB).catch(() => undefined);
  }, T);

  it(
    "a transactional segment runs under search_path = pg_catalog",
    async () => {
      // A rogue schema earlier on the path is exactly what pinning defends against.
      await runSqlScript({ ...ADMIN, database: DB }, "CREATE SCHEMA rogue");
      const observed = await withClient({ ...ADMIN, database: DB }, async (client) => {
        const report = await applySegments(
          client,
          [stmt(0, "SELECT set_config('pgprime.seen_path', current_setting('search_path'), false)")],
          [{ index: 0, transactional: true, statements: [0] }],
        );
        expect(report.status).toBe("applied");
        const r = await client.query("SELECT current_setting('pgprime.seen_path') AS v");
        return String(r.rows[0]?.["v"]);
      });
      expect(observed).toBe("pg_catalog");
    },
    T,
  );

  it(
    "a bare segment still gets a lock_timeout, and resets it afterwards",
    async () => {
      const { seen, after } = await withClient({ ...ADMIN, database: DB }, async (client) => {
        const bare = {
          ...stmt(0, "SELECT set_config('pgprime.seen_lock', current_setting('lock_timeout'), false)"),
          transactionality: "nonTransactional" as const,
        };
        const report = await applySegments(client, [bare], [{ index: 0, transactional: false, statements: [0] }], {
          lockTimeout: "7s",
        });
        expect(report.status).toBe("applied");
        const a = await client.query("SELECT current_setting('pgprime.seen_lock') AS v");
        const b = await client.query("SELECT current_setting('lock_timeout') AS v");
        return { seen: String(a.rows[0]?.["v"]), after: String(b.rows[0]?.["v"]) };
      });
      // the exact gap: a txmode-none file used to run with lock_timeout = 0
      expect(seen).toBe("7s");
      expect(after).toBe("0"); // reset once the bare segment finished
    },
    T,
  );
});
