/**
 * Live-PostgreSQL support for the diff-engine spike.
 *
 * Every test in this package needs a real server: the whole thesis of the
 * design (§3.2, §9) is that a differ which does not round-trip through
 * PostgreSQL manufactures phantom diffs, so there is nothing meaningful to
 * assert against a mock. Bring one up with:
 *
 *   docker run -d --name pgorm-spike-diff -p 54329:5432 \
 *     -e POSTGRES_PASSWORD=postgres postgres:17-alpine
 *
 * Override with PGORM_SPIKE_{HOST,PORT,USER,PASSWORD}.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createDatabase, dropDatabase, runSqlScript, type ConnInfo } from "../../src/db/pg.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../../..");
export const FIXTURES = join(REPO_ROOT, "fixtures", "diff");

export const ADMIN: ConnInfo = {
  host: process.env["PGORM_SPIKE_HOST"] ?? "127.0.0.1",
  port: Number(process.env["PGORM_SPIKE_PORT"] ?? 54329),
  user: process.env["PGORM_SPIKE_USER"] ?? "postgres",
  password: process.env["PGORM_SPIKE_PASSWORD"] ?? "postgres",
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

/** Create a scratch database, optionally seeded from a fixture .sql file. */
export async function makeDatabase(name: string, fixture?: string): Promise<ConnInfo> {
  await withAdmin(async (admin) => {
    await dropDatabase(admin, name);
    await createDatabase(admin, name);
  });
  const conn = dbConn(name);
  if (fixture) await runSqlScript(conn, await readFile(join(FIXTURES, fixture), "utf8"));
  return conn;
}

export async function destroyDatabase(name: string): Promise<void> {
  await withAdmin((admin) => dropDatabase(admin, name));
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
