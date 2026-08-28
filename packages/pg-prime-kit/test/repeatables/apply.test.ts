/**
 * The repeatables pass against a real server, because the two things it promises are both
 * server behaviour and neither can be faked:
 *
 *   - the objects the files describe actually exist afterwards;
 *   - a failure anywhere in the pass leaves NOTHING behind — not even the files that already
 *     succeeded. Per-file transactions would leave a database no revision of the tree
 *     describes, and the caller would then record `pgprime.repeatables` rows for objects that
 *     no longer exist, so the next deploy would skip them as unchanged.
 *
 * `loadRepeatables` gets its own test because it deliberately breaks the "changed only" rule:
 * during `generate` the shadow is empty, and a repeatable skipped as unchanged is a repeatable
 * whose breakage is not proven against the new schema (design/06 §3.8).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClient, type ConnInfo } from "../../src/db/pg.js";
import { RepeatableApplyError, applyRepeatables, loadRepeatables } from "../../src/repeatables/apply.js";
import { planRepeatables } from "../../src/repeatables/plan.js";
import { scanRepeatables } from "../../src/repeatables/scan.js";
import { destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";

const APPLY_DB = "pgprime_k3_rep_apply";
const TX_DB = "pgprime_k3_rep_tx";
const LOAD_DB = "pgprime_k3_rep_load";
const T = 180_000;

let tmp = "";

/** A `sql/` tree written from a { relative path: contents } map. */
async function tree(name: string, files: Record<string, string>): Promise<string> {
  const root = join(tmp, name, "sql");
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text, "utf8");
  }
  return root;
}

const count = (conn: ConnInfo, sql: string): Promise<number> =>
  withClient(conn, async (c) => {
    const r = await c.query(sql);
    return Number(r.rows[0]?.["n"] ?? -1);
  });

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pgprime-k3-rep-apply-"));
});

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("applyRepeatables", () => {
  it(
    "creates what the files describe, in file order, and reports a row per file",
    async () => {
      expect(await serverAvailable()).toBe(true);
      const conn = await makeDatabase(APPLY_DB);
      try {
        const dir = await tree("ok", {
          "020_functions/bump.sql": `-- pg-prime:owner platform
CREATE OR REPLACE FUNCTION public.bump(n integer) RETURNS integer LANGUAGE plpgsql AS $$
BEGIN
  -- a semicolon and a comment inside the body; the splitter must not cut here
  RETURN n + 1;
END;
$$;`,
          "030_views/active_users.sql": `CREATE OR REPLACE VIEW public.active_users AS SELECT public.bump(1) AS n;`,
        });

        const files = await scanRepeatables(dir);
        expect(files.map((f) => f.path)).toEqual(["sql/020_functions/bump.sql", "sql/030_views/active_users.sql"]);

        const applied = await withClient(conn, (c) => applyRepeatables(c, files));
        // exactly the rows the caller writes into pgprime.repeatables
        expect(applied.map((a) => a.path)).toEqual(files.map((f) => f.path));
        expect(applied.map((a) => a.sha256)).toEqual(files.map((f) => f.sha256));
        expect(applied.every((a) => Number.isInteger(a.durationMs) && a.durationMs >= 0)).toBe(true);

        expect(await count(conn, "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'bump'")).toBe(1);
        expect(
          await count(conn, "SELECT count(*)::int AS n FROM pg_class WHERE relname = 'active_users' AND relkind = 'v'"),
        ).toBe(1);
        // the view depends on the function: it only exists because the order was respected
      } finally {
        await destroyDatabase(APPLY_DB);
      }
    },
    T,
  );

  it(
    "a failure in the second file rolls back the first one too",
    async () => {
      expect(await serverAvailable()).toBe(true);
      const conn = await makeDatabase(TX_DB);
      try {
        const dir = await tree("boom", {
          "010_first/first.sql": `CREATE OR REPLACE FUNCTION public.first_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`,
          "020_second/second.sql": `CREATE OR REPLACE FUNCTION public.second_fn() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;
CREATE OR REPLACE VIEW public.broken AS SELECT * FROM public.no_such_table;`,
        });
        const files = await scanRepeatables(dir);

        const outcome = await withClient(conn, async (c) => {
          let caught: unknown = null;
          try {
            await applyRepeatables(c, files);
          } catch (err) {
            caught = err;
          }
          // Asked on the SAME connection on purpose: had the pass left the aborted
          // transaction open, this would raise 25P02 instead of answering.
          const r = await c.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('first_fn', 'second_fn')");
          return { caught, functions: Number(r.rows[0]?.["n"] ?? -1) };
        });

        expect(outcome.caught).toBeInstanceOf(RepeatableApplyError);
        const err = outcome.caught as RepeatableApplyError;
        expect(err.code).toBe("PG_PRIME_REPEATABLE_FAILED");
        expect(err.path).toBe("sql/020_second/second.sql");
        expect(err.statementIndex).toBe(1);
        expect(err.sql).toContain("no_such_table");
        expect(err.message).toContain("sql/020_second/second.sql");
        // the server's own error survives as the cause — 42P01, undefined_table
        expect(err.cause).toMatchObject({ code: "42P01" });

        // neither file's function survived: one transaction, not one per file
        expect(outcome.functions).toBe(0);
      } finally {
        await destroyDatabase(TX_DB);
      }
    },
    T,
  );

  it(
    "nothing to apply opens no transaction",
    async () => {
      // A BEGIN/COMMIT pair for zero statements is noise in every log and in
      // pg_stat_activity; asserted through a recording client rather than a server.
      const seen: string[] = [];
      const applied = await applyRepeatables(
        {
          // oxlint-disable-next-line typescript/require-await -- implements the async CatalogClient seam
          query: async (text: string) => {
            seen.push(text);
            return undefined;
          },
        },
        [],
      );
      expect(applied).toEqual([]);
      expect(seen).toEqual([]);
    },
    T,
  );
});

describe("loadRepeatables", () => {
  it(
    "applies unchanged files too — the shadow has never seen them",
    async () => {
      expect(await serverAvailable()).toBe(true);
      const conn = await makeDatabase(LOAD_DB);
      try {
        const dir = await tree("load", {
          "020_functions/reload.sql": `CREATE OR REPLACE FUNCTION public.reload_fn() RETURNS int LANGUAGE sql AS $$ SELECT 7 $$;`,
        });

        const first = await withClient(conn, (c) => loadRepeatables(c, dir));
        expect(first.map((f) => f.path)).toEqual(["sql/020_functions/reload.sql"]);
        expect(await count(conn, "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'reload_fn'")).toBe(1);

        // the runner's pass would now skip this file…
        const history = new Map(first.map((f) => [f.path, f.sha256]));
        const plan = await planRepeatables(dir, history);
        expect(plan.toApply).toEqual([]);
        expect(plan.unchanged.map((f) => f.path)).toEqual(["sql/020_functions/reload.sql"]);

        // …but the shadow load does not, which is the difference under test
        await withClient(conn, (c) => c.query("DROP FUNCTION public.reload_fn()"));
        expect(await count(conn, "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'reload_fn'")).toBe(0);

        await withClient(conn, (c) => loadRepeatables(c, dir));
        expect(await count(conn, "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'reload_fn'")).toBe(1);
      } finally {
        await destroyDatabase(LOAD_DB);
      }
    },
    T,
  );
});
