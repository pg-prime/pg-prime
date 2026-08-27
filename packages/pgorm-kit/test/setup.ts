/**
 * Make the pg_dump oracle available to EVERY test in this package, not just its own
 * suite, so the whole fixture corpus is checked against PostgreSQL's serializer.
 *
 * This configures it the way a CI job would - through the environment - rather than by
 * threading a launcher into each call site. If a usable pg_dump is already on PATH,
 * nothing is set and the built-in default is used.
 */

import { resolvePgDump } from "../src/prove/pg-dump.js";
import { ADMIN } from "./support/db.js";

// The container to `docker exec pg_dump` in, when no usable pg_dump is on PATH. If you point
// PGORM_TEST_URL at a different server, point this at that server's container (or install a
// client >= its version) — see test/support/db.ts.
const CONTAINER = process.env["PGORM_SPIKE_CONTAINER"] ?? "pgorm-spike-diff";

if (!process.env["PGORM_PG_DUMP"]) {
  const direct = await resolvePgDump();
  if ("unavailable" in direct) {
    process.env["PGORM_PG_DUMP"] = JSON.stringify([
      "docker",
      "exec",
      // forwarded from the environment pg-dump.ts sets, never spelled out in argv
      "-e",
      "PGPASSWORD",
      "-i",
      CONTAINER,
      "pg_dump",
    ]);
    process.env["PGORM_PG_DUMP_URI"] = `postgresql://${encodeURIComponent(ADMIN.user)}@127.0.0.1:5432/{db}`;
  }
}
