import pg from "pg";
import type { CatalogClient } from "../catalog/extract.js";

export type { CatalogClient };

/**
 * Spike-level DB access. The real driver seam lives in `pg-prime` (design/02);
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
  // An IPv6 literal MUST be bracketed or the first `:` of the address terminates
  // the host and the rest is parsed as a (non-numeric) port.
  const host = c.host.includes(":") ? `[${c.host}]` : c.host;
  return `postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${host}:${c.port}/${encodeURIComponent(c.database)}`;
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

/**
 * The prefix that authorises destruction.
 *
 * Two operations in this file can destroy work that is not ours:
 * `pg_terminate_backend` and `DROP DATABASE … WITH (FORCE)` (which terminates
 * other backends itself). Both are gated on this prefix, which only
 * `proveOnShadowClone` mints. A database the tool did not create therefore
 * cannot have its sessions killed, whatever the caller passes — an unrelated
 * client on the migration target used to get `FATAL 57P01` out of `generate`.
 */
export const SHADOW_PREFIX = "pgprime_shadow_";

export function isShadowDatabase(name: string): boolean {
  return name.startsWith(SHADOW_PREFIX) && name.length > SHADOW_PREFIX.length;
}

export class UnsafeDatabaseNameError extends Error {
  readonly code = "PG_PRIME_UNSAFE_DATABASE_NAME";
  constructor(
    readonly database: string,
    readonly operation: string,
  ) {
    super(
      `refusing to ${operation} ${JSON.stringify(database)}: only databases this tool ` +
        `provisions (named ${JSON.stringify(`${SHADOW_PREFIX}…`)}) may be terminated or force-dropped`,
    );
    this.name = "UnsafeDatabaseNameError";
  }
}

/** `object_in_use` — `CREATE DATABASE … TEMPLATE x` while a session is attached to x. */
export const SQLSTATE_OBJECT_IN_USE = "55006";

export function isObjectInUse(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === SQLSTATE_OBJECT_IN_USE;
}

const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/**
 * Kill every other session on a shadow database this tool owns.
 *
 * Deliberately NOT a way to make `CREATE DATABASE … TEMPLATE` succeed: the
 * template is a live database belonging to someone else.
 */
export async function terminateConnections(admin: pg.Client, database: string): Promise<void> {
  if (!isShadowDatabase(database)) throw new UnsafeDatabaseNameError(database, "terminate sessions on");
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [database],
  );
}

export async function dropDatabase(admin: pg.Client, name: string): Promise<void> {
  const ours = isShadowDatabase(name);
  await withProvisionLock(admin, async () => {
    if (ours) await terminateConnections(admin, name);
    // `WITH (FORCE)` terminates other backends, so it is reserved for our own
    // shadows. Anything else is dropped plainly and fails loudly (55006) if
    // somebody is connected, which is the correct outcome.
    await admin.query(`DROP DATABASE IF EXISTS ${q(name)}${ours ? " WITH (FORCE)" : ""}`);
  });
}

/**
 * Never terminates anything. A `TEMPLATE` clone that collides with a live
 * session raises SQLSTATE 55006 and it is the CALLER's job to fall back to a
 * tier that does not need exclusive access (design/06 §3.2).
 */
export async function createDatabase(admin: pg.Client, name: string, template?: string): Promise<void> {
  await withProvisionLock(admin, async () => {
    await admin.query(`CREATE DATABASE ${q(name)}${template ? ` TEMPLATE ${q(template)}` : ""}`);
  });
}

export async function runSqlScript(c: ConnInfo, sql: string): Promise<void> {
  await withClient(c, async (client) => {
    await client.query(sql);
  });
}
