/**
 * `pg-prime db seed` — design/06 §7 lane 3, through the binary (R17).
 *
 * The three claims §7 makes, each asserted against the database rather than the report:
 * seeds run in filename order, each in its own transaction; nothing is recorded in
 * `pgprime.migrations` (in fact the history schema is never created); and a
 * production-tagged environment is refused without `--force`.
 *
 * The `.ts` seed is the point of the lane — "`.ts` seeds get the typed query builder,
 * because that is the whole point of having one" — so it uses `db.insertInto(db.h.…)` and
 * the row it writes is read back out of the table.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { withClient } from "../../src/db/pg.js";
import { historyPresent } from "../../src/history/schema.js";
import { envelopeOf, runCli, urlOf } from "../support/cli.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { golden } from "../cli/_mask.js";
import { makeProject, BASE_SCHEMA, type Project } from "../cli/_project.js";

const T = 180_000;
const DATABASE = "pgprime_k4_seed";

const expectGolden = async (name: string, envelope: unknown): Promise<void> => {
  await expect(golden(envelope)).toMatchFileSnapshot(`../cli/golden/${name}.json`);
};

/** The base set: always runs. */
const BASE_SQL = `-- seeds are re-runnable, so they are written idempotent (design/06 §7).
INSERT INTO public.widgets (name) VALUES ('base-a') ON CONFLICT (name) DO NOTHING;
INSERT INTO public.widgets (name) VALUES ('base-b') ON CONFLICT (name) DO NOTHING;
`;

/** A `.ts` seed: the typed builder, through a real `Db` (design/12 decision 12). */
const TS_SEED = `export default async ({ db, set, env }) => {
  await db
    .insertInto(db.h.widgets)
    .values({ name: 'typed-' + String(set) + '-' + String(env) })
    .onConflict((c) => c.doNothing())
    .execute()
}
`;

/** Only under \`--set demo\`. */
const DEMO_SQL = `INSERT INTO public.widgets (name) VALUES ('demo-only') ON CONFLICT (name) DO NOTHING;\n`;

async function names(): Promise<string[]> {
  return withClient(dbConn(DATABASE), async (c) => {
    const r = await c.query("SELECT name FROM public.widgets ORDER BY name");
    return r.rows.map((row) => String(row["name"]));
  });
}

describe("db seed", () => {
  let project: Project;

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    await makeDatabase(DATABASE);
    project = await makeProject("seed", { url: urlOf(dbConn(DATABASE)), schema: BASE_SCHEMA });
    // The table the seeds write into, created directly: `db seed` is not `migrate apply`
    // and must not need a migration history to exist.
    await withClient(dbConn(DATABASE), async (c) => {
      await c.query(
        "CREATE TABLE public.widgets (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL UNIQUE)",
      );
    });
    await mkdir(join(project.dir, "seeds", "demo"), { recursive: true });
    await writeFile(join(project.dir, "seeds", "010_base.sql"), BASE_SQL, "utf8");
    await writeFile(join(project.dir, "seeds", "020_typed.ts"), TS_SEED, "utf8");
    await writeFile(join(project.dir, "seeds", "demo", "010_demo.sql"), DEMO_SQL, "utf8");
  }, T);

  afterAll(async () => {
    await project?.dispose().catch(() => undefined);
    await destroyDatabase(DATABASE).catch(() => undefined);
  });

  const cli = (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    runCli(["db", "seed", ...args, "--config", project.config, "--output", "json"]);

  it(
    "--list names the sets and the files, and runs nothing",
    async () => {
      const r = await cli("--list");
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.ok);
      const e = envelopeOf(r);
      expect(e["sets"]).toEqual(["demo"]);
      expect((e["files"] as { path: string }[]).map((f) => f.path)).toEqual([
        "seeds/010_base.sql",
        "seeds/020_typed.ts",
      ]);
      expect(await names()).toEqual([]);
    },
    T,
  );

  it(
    "runs the base set in filename order; the .ts seed uses the builder and inserts",
    async () => {
      const r = await cli();
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.ok);
      const e = envelopeOf(r);
      expect(e["status"]).toBe("seeded");
      expect((e["applied"] as { path: string; kind: string }[]).map((a) => [a.path, a.kind])).toEqual([
        ["seeds/010_base.sql", "sql"],
        ["seeds/020_typed.ts", "ts"],
      ]);
      // R14's shape: the table, not the report. `typed-null-null` is the `.ts` seed's own
      // interpolation of `set` (the base set) and `env` (PG_PRIME_ENV unset).
      expect(await names()).toEqual(["base-a", "base-b", "typed-null-null"]);
      await expectGolden("seed.seeded", e);
    },
    T,
  );

  it(
    "is re-runnable, and records NOTHING — the history schema is never created",
    async () => {
      const again = await cli();
      expect(again.code).toBe(EXIT.ok);
      expect(await names()).toEqual(["base-a", "base-b", "typed-null-null"]);
      // design/06 §7: "Never recorded in pgprime.migrations". Stronger than "no row":
      // a seeded database that has never been migrated must not acquire a history schema
      // as a side effect, or `migrate baseline` refuses it afterwards.
      expect(await withClient(dbConn(DATABASE), historyPresent)).toBe(false);
    },
    T,
  );

  it(
    "--set adds a set on top of the base one; an unknown set is refused rather than silently empty",
    async () => {
      const demo = await cli("--set", "demo");
      expect(demo.code, demo.stdout + demo.stderr).toBe(EXIT.ok);
      expect((envelopeOf(demo)["applied"] as { path: string }[]).map((a) => a.path)).toEqual([
        "seeds/010_base.sql",
        "seeds/020_typed.ts",
        "seeds/demo/010_demo.sql",
      ]);
      expect(await names()).toContain("demo-only");

      const unknown = await cli("--set", "staging");
      expect(unknown.code).toBe(EXIT.error);
      const e = envelopeOf(unknown);
      expect(e["status"]).toBe("refused");
      const message = (e["error"] as { message: string }).message;
      expect(message).toContain("staging");
      expect(message).toContain("Sets on disk: demo");
    },
    T,
  );

  it(
    "refuses a production-tagged environment, and --force overrides it",
    async () => {
      const refused = await runCli(["db", "seed", "--config", project.config, "--output", "json"], {
        PG_PRIME_ENV: "production",
      });
      expect(refused.code).toBe(EXIT.error);
      const e = envelopeOf(refused);
      expect(e["status"]).toBe("refused");
      expect((e["error"] as { code: string }).code).toBe("production");
      expect((e["error"] as { message: string }).message).toContain("--force");
      await expectGolden("seed.refused", e);

      const forced = await runCli(["db", "seed", "--config", project.config, "--force", "--output", "json"], {
        PG_PRIME_ENV: "production",
      });
      expect(forced.code, forced.stdout + forced.stderr).toBe(EXIT.ok);
      expect(envelopeOf(forced)["status"]).toBe("seeded");
      // …and the `.ts` seed saw the environment it ran in.
      expect(await names()).toContain("typed-null-production");
    },
    T,
  );

  it(
    "refuses a --prod-pattern match against host:port/database",
    async () => {
      const r = await cli("--prod-pattern", "pgprime_k4_seed");
      expect(r.code).toBe(EXIT.error);
      const message = (envelopeOf(r)["error"] as { message: string }).message;
      expect(message).toContain("--prod-pattern");
      expect(message).toContain(DATABASE);
    },
    T,
  );

  it(
    "a failing seed stops the run, names the file, and leaves the earlier ones committed",
    async () => {
      await writeFile(join(project.dir, "seeds", "030_boom.sql"), "SELECT 1/0;\n", "utf8");
      await writeFile(
        join(project.dir, "seeds", "040_never.sql"),
        "INSERT INTO public.widgets (name) VALUES ('never') ON CONFLICT (name) DO NOTHING;\n",
        "utf8",
      );
      try {
        const r = await cli();
        expect(r.code).toBe(EXIT.error);
        const e = envelopeOf(r);
        expect(e["status"]).toBe("failed");
        expect((e["error"] as { file: string }).file).toBe("seeds/030_boom.sql");
        expect(e["skipped"]).toEqual(["seeds/040_never.sql"]);
        // One transaction per FILE, not per run: the two before it stayed.
        expect(await names()).toContain("base-a");
        expect(await names()).not.toContain("never");
      } finally {
        await writeFile(join(project.dir, "seeds", "030_boom.sql"), "", "utf8");
        await writeFile(join(project.dir, "seeds", "040_never.sql"), "", "utf8");
      }
    },
    T,
  );

  it(
    "an empty seeds directory is `nothing_to_do`, not a failure",
    async () => {
      const other = await makeProject("seed-empty", { url: urlOf(dbConn(DATABASE)), noSchema: true });
      try {
        const r = await runCli(["db", "seed", "--config", other.config, "--output", "json"]);
        expect(r.code).toBe(EXIT.ok);
        expect(envelopeOf(r)["status"]).toBe("nothing_to_do");
      } finally {
        await other.dispose();
      }
    },
    T,
  );
});
