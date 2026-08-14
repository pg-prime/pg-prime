import pg from "pg";
import type { CatalogClient } from "../catalog/extract.js";

export type { CatalogClient };

/**
 * Spike-level DB access. The real driver seam lives in `pgorm` (design/02);
 * the kit deliberately uses `pg` directly so the two spikes stay independent.
 */
export interface ConnInfo {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export const withDatabase = (c: ConnInfo, database: string): ConnInfo => ({ ...c, database });

export function connectionString(c: ConnInfo): string {
  return `postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${encodeURIComponent(c.database)}`;
}

export async function withClient<T>(c: ConnInfo, fn: (client: pg.Client & CatalogClient) => Promise<T>): Promise<T> {
  const client = new pg.Client({ ...c });
  await client.connect();
  try {
    return await fn(client as pg.Client & CatalogClient);
  } finally {
    await client.end();
  }
}

/**
 * Cluster-wide provisioning lock.
 *
 * `CREATE DATABASE` snapshots its template and fails with SQLSTATE 55006 while
 * any session is attached to it — including a session that another shadow
 * provision is *itself* using. Two concurrent `generate` runs (or two test
 * workers) on one cluster therefore knock each other over intermittently. The
 * key is deliberately fixed: this serializes database provisioning and nothing
 * else, and provisioning is by nature a whole-cluster operation.
 */
const PROVISION_LOCK = "7240101119233003";

async function withProvisionLock<T>(admin: pg.Client, fn: () => Promise<T>): Promise<T> {
  await admin.query("SELECT pg_advisory_lock($1)", [PROVISION_LOCK]);
  try {
    return await fn();
  } finally {
    await admin.query("SELECT pg_advisory_unlock($1)", [PROVISION_LOCK]).catch(() => undefined);
  }
}

/** `CREATE DATABASE … TEMPLATE x` fails with 55006 while any session is attached to x. */
export async function terminateConnections(admin: pg.Client, database: string): Promise<void> {
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [database],
  );
}

export async function dropDatabase(admin: pg.Client, name: string): Promise<void> {
  await withProvisionLock(admin, async () => {
    await terminateConnections(admin, name);
    await admin.query(`DROP DATABASE IF EXISTS "${name.replace(/"/g, '""')}" WITH (FORCE)`);
  });
}

export async function createDatabase(admin: pg.Client, name: string, template?: string): Promise<void> {
  const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  await withProvisionLock(admin, async () => {
    if (template) await terminateConnections(admin, template);
    await admin.query(`CREATE DATABASE ${q(name)}${template ? ` TEMPLATE ${q(template)}` : ""}`);
  });
}

export async function runSqlScript(c: ConnInfo, sql: string): Promise<void> {
  await withClient(c, async (client) => {
    await client.query(sql);
  });
}
