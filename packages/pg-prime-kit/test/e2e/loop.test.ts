/**
 * The v1 loop, end to end, through the binary — design/11 §5's first box.
 *
 *   edit schema → generate → apply → status → edit → generate → apply → verify → check
 *
 * Three properties this test exists to hold, none of which any narrower test can:
 *
 *  1. **It runs as a role with no `CREATEDB`.** That forces shadow tier 3 (a temp schema
 *     inside the target) and, with it, the tier-3 proof — the path a managed PostgreSQL
 *     actually gives you, and the one design/06 §3.2 says Prisma lacks. A green loop on a
 *     superuser proves nothing about Supabase, Neon or a locked-down RDS role.
 *  2. **The second `generate` writes TWO files.** Adding an index to an existing table
 *     takes design/06 §3.5 row 1, which needs `CREATE INDEX CONCURRENTLY`, which cannot
 *     share a transaction with the rest of the plan — so the plan is cut into
 *     `NNNN_x.sql` and `NNNN_x_concurrently.sql`, and `apply` has to run them in that
 *     order off `(seq, name)` alone.
 *  3. **A tampered database is caught.** `status --verify-fingerprint` and `check` both
 *     exit 4 after a column is dropped behind the migration history's back.
 *
 * Everything goes through `dist/cli.js` (R17): the config file is loaded by Node's own
 * type stripping, the schema module is `import()`ed the way a user's is, and the exit
 * codes are the ones an orchestrator sees.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { connectionString, withClient } from "../../src/db/pg.js";
import { envelopeOf, runCli, urlOf } from "../support/cli.js";
import { ADMIN, dbConn, destroyDatabase, serverAvailable, withAdmin } from "../support/db.js";

const T = 300_000;

const here = dirname(fileURLToPath(import.meta.url));
/**
 * The scratch project lives INSIDE the package, not in `os.tmpdir()`.
 *
 * `db/schema.ts` does `import { pgTable } from 'pg-prime'`, and Node resolves that by
 * walking `node_modules` up from the importing file. From `/tmp` there is nothing to
 * find; from here the walk reaches `packages/pg-prime-kit/node_modules/pg-prime`, which
 * is the workspace link — exactly the resolution a real project gets.
 */
const SCRATCH = resolve(here, "../../.e2e");

const ROLE = "pgprime_k2b_loop";
const PASSWORD = "loop";
const DATABASE = "pgprime_k2b_loop_db";

const CONFIG = (url: string): string => `export default {
  url: ${JSON.stringify(url)},
  schema: './db/schema.ts',
  migrations: './migrations',
  repeatables: './sql',
  schemas: ['public'],
}
`;

const SCHEMA_V1 = `import { defineSchema, pgTable } from 'pg-prime'

export const users = pgTable('users', (t) => ({
  id: t.uuid().primaryKey().defaultSql('gen_random_uuid()'),
  email: t.text().unique(),
  fullName: t.text(),
}))

export const posts = pgTable('posts', (t) => ({
  id: t.uuid().primaryKey().defaultSql('gen_random_uuid()'),
  title: t.text(),
}))

export default defineSchema({ users, posts })
`;

/** A rename, a new column, and an index on an existing table — the CIC trigger. */
const SCHEMA_V2 = `import { defineSchema, index, pgTable } from 'pg-prime'

export const users = pgTable(
  'users',
  (t) => ({
    id: t.uuid().primaryKey().defaultSql('gen_random_uuid()'),
    email: t.text().unique(),
    displayName: t.text().renamedFrom('full_name'),
    createdAt: t.timestamptz().nullable(),
  }),
  (t) => [index('users_email_idx').on(t.email)],
)

export const posts = pgTable('posts', (t) => ({
  id: t.uuid().primaryKey().defaultSql('gen_random_uuid()'),
  title: t.text(),
}))

export default defineSchema({ users, posts })
`;

describe("the v1 loop, through the binary, as a role without CREATEDB", () => {
  let project = "";
  let url = "";
  let superUrl = "";

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    await withAdmin(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
      await admin.query(`CREATE ROLE ${ROLE} WITH LOGIN NOCREATEDB NOSUPERUSER PASSWORD '${PASSWORD}'`);
      await admin.query(`CREATE DATABASE ${DATABASE} OWNER ${ROLE}`);
    });
    url = connectionString({ ...ADMIN, user: ROLE, password: PASSWORD, database: DATABASE });
    superUrl = urlOf(dbConn(DATABASE));

    await mkdir(SCRATCH, { recursive: true });
    project = await mkdtemp(join(SCRATCH, "loop-"));
    await mkdir(join(project, "db"), { recursive: true });
    await writeFile(join(project, "pg-prime.config.ts"), CONFIG(url), "utf8");
    await writeFile(join(project, "db", "schema.ts"), SCHEMA_V1, "utf8");
  }, T);

  afterAll(async () => {
    if (project) await rm(project, { recursive: true, force: true }).catch(() => undefined);
    await destroyDatabase(DATABASE).catch(() => undefined);
    await withAdmin(async (admin) => {
      await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
    }).catch(() => undefined);
  });

  const cli = (...args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    runCli(["migrate", ...args, "--config", join(project, "pg-prime.config.ts"), "--output", "json"]);

  it(
    "generate → apply → status, from an empty database",
    async () => {
      const gen = await cli("generate", "--name", "init");
      expect(gen.code, gen.stdout + gen.stderr).toBe(EXIT.ok);
      const g = envelopeOf(gen);
      expect(g["status"]).toBe("generated");
      // The property that makes this loop worth testing at all.
      expect((g["shadow"] as { tier: number }).tier).toBe(3);
      expect((g["proof"] as { status: string }).status).toBe("passed");
      const files = g["files"] as { id: string; stage: string; written: string | null }[];
      expect(files).toHaveLength(1);
      expect(files[0]!.id).toBe("0000_init");
      expect(files[0]!.stage).toBe("main");

      const applied = await cli("apply");
      expect(applied.code, applied.stdout + applied.stderr).toBe(EXIT.ok);
      expect(envelopeOf(applied)["status"]).toBe("applied");

      const status = await cli("status");
      expect(status.code, status.stdout + status.stderr).toBe(EXIT.ok);
      expect(envelopeOf(status)["status"]).toBe("up_to_date");

      // R14: the catalog, not the report.
      const columns = await withClient(dbConn(DATABASE), async (client) => {
        const r = await client.query(
          "SELECT attname FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum",
        );
        return r.rows.map((x) => String(x["attname"]));
      });
      expect(columns).toEqual(["id", "email", "full_name"]);
    },
    T,
  );

  it(
    "an edit that renames a column and adds an index generates TWO files",
    async () => {
      await writeFile(join(project, "db", "schema.ts"), SCHEMA_V2, "utf8");

      const gen = await cli("generate", "--name", "evolve");
      expect(gen.code, gen.stdout + gen.stderr).toBe(EXIT.ok);
      const g = envelopeOf(gen);
      expect(g["status"]).toBe("generated");
      const files = g["files"] as { id: string; stage: string; txmode: string; from: string; to: string }[];
      expect(files.map((f) => `${f.id}:${f.stage}:${f.txmode}`)).toEqual([
        "0001_evolve:main:transactional",
        "0001_evolve_concurrently:concurrent:none",
      ]);
      // design/06 §4.1's chain: the second file starts where the first one ended, and that
      // value is MEASURED on the clone (Proof.stageFingerprints), not predicted.
      expect(files[1]!.from).toBe(files[0]!.to);
      // The rename came from `.renamedFrom('full_name')`, not from a guess.
      const renames = g["renames"] as { from: string; to: string; source: string }[];
      expect(renames).toContainEqual(
        expect.objectContaining({ from: "column:public.users.full_name", to: "column:public.users.display_name", source: "annotation" }),
      );
      // Exactly one ANNOTATION. On PostgreSQL 18 there is a second entry with
      // `source: "cascade"` — the auto-named NOT NULL constraint `RENAME COLUMN` does not
      // carry along (design/06 §3.3 AS BUILT) — and on 15-17 there is not, because the
      // server does not catalogue NOT NULL as a constraint there at all.
      expect(renames.filter((r) => r.source === "annotation")).toHaveLength(1);
      expect(renames.every((r) => r.source === "annotation" || r.source === "cascade")).toBe(true);

      const applied = await cli("apply");
      expect(applied.code, applied.stdout + applied.stderr).toBe(EXIT.ok);
      const a = envelopeOf(applied);
      expect((a["applied"] as { id: string }[]).map((x) => x.id)).toEqual(["0001_evolve", "0001_evolve_concurrently"]);

      const catalog = await withClient(dbConn(DATABASE), async (client) => {
        const cols = await client.query(
          "SELECT attname FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum",
        );
        const idx = await client.query(
          "SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'users_email_idx'",
        );
        return { columns: cols.rows.map((x) => String(x["attname"])), index: idx.rows[0] };
      });
      expect(catalog.columns).toEqual(["id", "email", "display_name", "created_at"]);
      expect(catalog.index?.["indisvalid"]).toBe(true);

      const status = await cli("status");
      expect(status.code, status.stdout + status.stderr).toBe(EXIT.ok);
    },
    T,
  );

  it(
    "verify replays the whole repository from empty, and check is green",
    async () => {
      // `verify` needs an ephemeral DATABASE, which the loop role cannot create; the
      // superuser url is what a CI job would use for this step (design/06 §10.2).
      const verify = await runCli([
        "migrate", "verify", "--config", join(project, "pg-prime.config.ts"), "--url", superUrl, "--output", "json",
      ]);
      expect(verify.code, verify.stdout + verify.stderr).toBe(EXIT.ok);
      const v = envelopeOf(verify);
      expect(v["status"]).toBe("verified");
      expect(v["deltas"]).toEqual([]);
      expect((v["replay"] as { applied: string[] }).applied).toEqual([
        "0000_init",
        "0001_evolve",
        "0001_evolve_concurrently",
      ]);

      const check = await cli("check");
      expect(check.code, check.stdout + check.stderr).toBe(EXIT.ok);
      expect(envelopeOf(check)["status"]).toBe("ok");
    },
    T,
  );

  it(
    "a database tampered with behind the history's back is caught by status and by check",
    async () => {
      await withClient(dbConn(DATABASE), async (client) => {
        await client.query("ALTER TABLE public.posts DROP COLUMN title");
      });

      const status = await cli("status", "--verify-fingerprint");
      expect(status.code, status.stdout + status.stderr).toBe(EXIT.drift);
      const s = envelopeOf(status);
      expect(s["status"]).toBe("drift");
      expect(s["fingerprintDrift"]).toBe(true);

      const check = await cli("check");
      expect(check.code, check.stdout + check.stderr).toBe(EXIT.drift);
      const c = envelopeOf(check);
      expect(c["status"]).toBe("drift");
      expect((c["schemaDrift"] as string[]).join("\n")).toContain("ADD COLUMN");
    },
    T,
  );

  const pooler = process.env["PG_PRIME_TEST_PGBOUNCER_URL"];
  it.runIf(pooler !== undefined)(
    "apply through a transaction pooler refuses with exit 1 and names the direct port",
    async () => {
      const r = await runCli([
        "migrate", "apply", "--config", join(project, "pg-prime.config.ts"), "--url", pooler!, "--output", "json",
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.error);
      const e = envelopeOf(r);
      expect(e["status"]).toBe("refused");
      const error = e["error"] as { code: string; message: string };
      expect(error.code).toBe("transaction_pooler");
      expect(error.message).toContain("direct PostgreSQL port");
    },
    T,
  );
});
