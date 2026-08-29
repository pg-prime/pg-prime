/**
 * Locating a `pg_dump` for the oracle tests.
 *
 * A developer machine frequently has PostgreSQL only inside a container and no client
 * tools on PATH, so the fallback launches `pg_dump` through `docker exec` against the
 * spike container. Nothing in `src/` knows about Docker - it only knows how to run an
 * argv, which is precisely why the launcher is injectable.
 *
 * ⚠️ **The container is `PG_PRIME_SPIKE_CONTAINER`, and its default is stale.**
 * `pgorm-spike-diff` is a container from the spike phase that no longer fronts anything. Point
 * `PG_PRIME_TEST_URL` at any other server without setting `PG_PRIME_SPIKE_CONTAINER` to match and
 * the dump runs inside the WRONG database — 41 tests then fail with `role "…" does not exist` or
 * `database "…" does not exist`, which reads like a provisioning bug and is not one. Two people
 * lost an hour to it (design/13 §5). CI never sees it, because CI installs `postgresql-client-N`
 * and the direct `pg_dump` is found first.
 */

import { resolvePgDump, type PgDumpLauncher } from "../../src/prove/pg-dump.js";
import { ADMIN } from "./db.js";

const CONTAINER_ENV = "PG_PRIME_SPIKE_CONTAINER";
const DEFAULT_CONTAINER = "pgorm-spike-diff";
const CONTAINER = process.env[CONTAINER_ENV] ?? DEFAULT_CONTAINER;

/** Named in the skip/failure message, so "which container?" is answered where it is asked. */
export const PG_DUMP_HINT =
  `no pg_dump: none on PATH, and \`docker exec ${CONTAINER} pg_dump\` did not answer either. ` +
  `Install the client tools, or set ${CONTAINER_ENV} to the container that fronts ` +
  `PG_PRIME_TEST_URL (default ${DEFAULT_CONTAINER}, which is a stale spike container).`;

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
  if ("unavailable" in docker) return null;
  // Say which container the dumps are going through: it is the difference between "the oracle
  // ran" and "the oracle ran somewhere else", and the two look identical in a green run.
  process.stderr.write(`[kit] pg_dump via \`docker exec ${CONTAINER}\` (${CONTAINER_ENV})\n`);
  return viaDocker;
}
