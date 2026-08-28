/**
 * Live-PostgreSQL support for the diff engine.
 *
 * Every test in this package needs a real server, and specifically a real *server* rather than
 * PGlite: it creates and drops databases and shells out to `pg_dump`, neither of which the
 * embedded build offers. That is why `@pg-prime/kit` keeps its own admin harness while `pg-prime`
 * runs tier 1 on PGlite (design/09 §2.2).
 *
 * It reads the same **one env var** as the rest of the repo:
 *
 *   PG_PRIME_TEST_URL=postgres://user:pass@host:port/db   (the database part is ignored; it connects
 *                                                       to `postgres` and creates scratch ones)
 *
 * Unset, it falls back to the spike container:
 *
 *   docker run -d --name pgorm-spike-diff -p 54329:5432 \
 *     -e POSTGRES_PASSWORD=postgres postgres:17-alpine
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createDatabase, dropDatabase, runSqlScript, type ConnInfo } from "../../src/db/pg.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../../..");
export const FIXTURES = join(REPO_ROOT, "fixtures", "diff");

function fromUrl(url: string): Omit<ConnInfo, "database"> {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username) || "postgres",
    password: decodeURIComponent(u.password),
  };
}

const TEST_URL = process.env["PG_PRIME_TEST_URL"];

export const ADMIN: ConnInfo = {
  ...(TEST_URL ? fromUrl(TEST_URL) : { host: "127.0.0.1", port: 54329, user: "postgres", password: "postgres" }),
  database: "postgres",
};

export const dbConn = (database: string): ConnInfo => ({ ...ADMIN, database });

export async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ ...ADMIN });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Drop a scratch database this SUITE owns.
 *
 * `src/db/pg.ts` deliberately refuses to terminate sessions on, or force-drop, anything
 * that is not a `pgprime_shadow_*` database it provisioned itself — that gate is the fix
 * for `generate` killing an unrelated client on the live target. The test harness owns
 * its own `pgprime_*` scratch databases and may reclaim one a previous run left a socket
 * on, so it does that here, explicitly, and only as a FALLBACK after the plain drop has
 * already failed.
 */
async function reclaimScratchDatabase(admin: pg.Client, name: string): Promise<void> {
  if (!name.startsWith("pgprime_")) throw new Error(`refusing to reclaim ${name}: not a scratch database`);
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [name],
  );
  await admin.query(`DROP DATABASE IF EXISTS "${name.replace(/"/g, '""')}"`);
}

async function dropScratch(admin: pg.Client, name: string): Promise<void> {
  try {
    await dropDatabase(admin, name);
  } catch {
    await reclaimScratchDatabase(admin, name);
  }
}

/** Create a scratch database, optionally seeded from a fixture .sql file. */
export async function makeDatabase(name: string, fixture?: string): Promise<ConnInfo> {
  await withAdmin(async (admin) => {
    await dropScratch(admin, name);
    await createDatabase(admin, name);
  });
  const conn = dbConn(name);
  if (fixture) await runSqlScript(conn, await readFile(join(FIXTURES, fixture), "utf8"));
  return conn;
}

export async function destroyDatabase(name: string): Promise<void> {
  await withAdmin((admin) => dropScratch(admin, name));
}

/**
 * Does this server catalogue NOT NULL as a `pg_constraint` row (PostgreSQL >= 18)?
 *
 * Asked of the CATALOG rather than of `server_version_num`, for the same reason
 * `Q_COLUMNS` gates that way: the behaviour under test is "is there a row", and a server
 * that back-ported the feature should take the 18 branch. Memoised because every test
 * that branches on it would otherwise open a connection to ask again.
 */
let notNullProbe: Promise<boolean> | null = null;
export function catalogsNotNullConstraints(): Promise<boolean> {
  notNullProbe ??= withAdmin(async (c) => {
    // A temp table dies with this connection, so nothing is left in the database.
    await c.query("CREATE TEMP TABLE pgprime_not_null_probe (a int NOT NULL)");
    const r = await c.query(
      "SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'pgprime_not_null_probe'::regclass AND contype = 'n'",
    );
    return Number(r.rows[0]?.["n"] ?? 0) > 0;
  });
  return notNullProbe;
}

export async function serverAvailable(): Promise<boolean> {
  try {
    await withAdmin(async (c) => {
      await c.query("SELECT 1");
    });
    return true;
  } catch {
    return false;
  }
}
