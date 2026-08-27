/**
 * Locating a `pg_dump` for the oracle tests.
 *
 * A developer machine frequently has PostgreSQL only inside a container and no client
 * tools on PATH, so the fallback launches `pg_dump` through `docker exec` against the
 * spike container. Nothing in `src/` knows about Docker - it only knows how to run an
 * argv, which is precisely why the launcher is injectable.
 */

import { resolvePgDump, type PgDumpLauncher } from "../../src/prove/pg-dump.js";
import { ADMIN } from "./db.js";

const CONTAINER = process.env["PG_PRIME_SPIKE_CONTAINER"] ?? "pgorm-spike-diff";

/** `undefined` means "the built-in default already works"; `null` means no pg_dump at all. */
export async function pgDumpLauncher(): Promise<PgDumpLauncher | undefined | null> {
  if (process.env["PG_PRIME_PG_DUMP"]) return undefined; // explicitly configured
  const direct = await resolvePgDump();
  if (!("unavailable" in direct)) return undefined;

  const viaDocker: PgDumpLauncher = {
    // `-e PGPASSWORD` forwards the value from OUR environment (pg-dump.ts puts it
    // there); spelling it `-e PGPASSWORD=<secret>` would publish the password in
    // the docker process's argv, visible to every user on the machine.
    argv: ["docker", "exec", "-e", "PGPASSWORD", "-i", CONTAINER, "pg_dump"],
    // 5432 is the port INSIDE the container; the host-side mapping is irrelevant there.
    uri: (db) => `postgresql://${encodeURIComponent(ADMIN.user)}@127.0.0.1:5432/${encodeURIComponent(db)}`,
  };
  const docker = await resolvePgDump(viaDocker);
  return "unavailable" in docker ? null : viaDocker;
}
