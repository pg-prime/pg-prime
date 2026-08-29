/**
 * Tier R through the binary — design/06 §3.8, §5.1 step 8, and design/11 K1's open item (b).
 *
 * K1 left `NO_REPEATABLES` bound into `apply` and `status` as a seam and K3 shipped the
 * pass; the wire is `createRepeatablesPass()` in both commands. This is the test that says
 * the wire is connected, and it asserts on the three places the answer shows up: the
 * catalog, `pgprime.repeatables`, and the envelope.
 *
 * The other half is `generate`: a repeatable is loaded into the shadow, so a view over a
 * column the plan is about to drop fails the **proof**, at author time, on a throwaway
 * database. That is the whole reason there is one IR for both lanes.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { withClient } from "../../src/db/pg.js";
import { envelopeOf, runCli, urlOf } from "../support/cli.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { BASE_SCHEMA, makeProject, type Project } from "./_project.js";

const T = 240_000;

const VIEW = `-- pg-prime:tier R
CREATE OR REPLACE VIEW public.widget_names AS SELECT id, name FROM public.widgets;
`;

const VIEW_V2 = `-- pg-prime:tier R
CREATE OR REPLACE VIEW public.widget_names AS SELECT id, upper(name) AS name FROM public.widgets;
`;

describe("Tier R: the repeatables pass, through the binary", () => {
  const database = "pgprime_k2b_tierr";
  let p: Project;

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    await makeDatabase(database);
    p = await makeProject("cli-tierr", { url: urlOf(dbConn(database)), schema: BASE_SCHEMA });
    await p.writeRepeatable("030_widget_names.sql", VIEW);
  }, T);

  afterAll(async () => {
    if (p) await p.dispose().catch(() => undefined);
    await destroyDatabase(database).catch(() => undefined);
  }, T);

  const cli = (...args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    runCli(["migrate", ...args, "--config", p.config, "--output", "json"]);

  it(
    "status reports a repeatable as drift before it is applied, and apply applies it",
    async () => {
      expect((await cli("generate", "--name", "init")).code).toBe(EXIT.ok);

      const before = await cli("status");
      const s = envelopeOf(before);
      // Before any apply, every `sql/` file is drift: nothing is recorded for it.
      expect(s["repeatables"] as { drift: string[]; passImplemented: boolean }).toMatchObject({
        drift: ["sql/030_widget_names.sql"],
        passImplemented: true,
      });

      const applied = await cli("apply");
      expect(applied.code, applied.stdout + applied.stderr).toBe(EXIT.ok);
      expect((envelopeOf(applied)["repeatables"] as { applied: string[] }).applied).toEqual([
        "sql/030_widget_names.sql",
      ]);

      const state = await withClient(dbConn(database), async (client) => {
        const view = await client.query("SELECT to_regclass('public.widget_names') AS v");
        const rows = await client.query("SELECT path, checksum FROM pgprime.repeatables ORDER BY path");
        return { view: view.rows[0]?.["v"], rows: rows.rows };
      });
      expect(state.view).toBe("widget_names");
      expect(state.rows).toHaveLength(1);

      // Unchanged bytes: skipped, not re-applied.
      const again = await cli("apply");
      expect(again.code).toBe(EXIT.ok);
      const r = envelopeOf(again)["repeatables"] as { applied: string[]; unchanged: string[] };
      expect(r.applied).toEqual([]);
      expect(r.unchanged).toEqual(["sql/030_widget_names.sql"]);
      expect((envelopeOf(await cli("status"))["repeatables"] as { drift: string[] }).drift).toEqual([]);
    },
    T,
  );

  it(
    "a changed repeatable is re-applied on the next apply",
    async () => {
      await p.writeRepeatable("030_widget_names.sql", VIEW_V2);
      const status = await cli("status");
      expect(status.code).toBe(EXIT.ok);
      expect((envelopeOf(status)["repeatables"] as { drift: string[] }).drift).toEqual(["sql/030_widget_names.sql"]);

      const applied = await cli("apply");
      expect(applied.code, applied.stdout + applied.stderr).toBe(EXIT.ok);
      expect((envelopeOf(applied)["repeatables"] as { applied: string[] }).applied).toEqual([
        "sql/030_widget_names.sql",
      ]);
      const definition = await withClient(dbConn(database), async (client) => {
        const r = await client.query("SELECT pg_get_viewdef('public.widget_names'::regclass) AS d");
        return String(r.rows[0]?.["d"]);
      });
      expect(definition).toContain("upper(");
    },
    T,
  );

  it(
    "a repeatable that references a column the schema drops fails at GENERATE time",
    async () => {
      // The view above selects `name`. Take `name` out of the schema: the plan is legal
      // against the IR (a view is not a fact) and illegal against the database, and the
      // only place that shows up before production is the shadow load — which is exactly
      // why design/06 §3.8 loads Tier R into the shadow beside the desired schema.
      await p.writeSchema(`import { defineSchema, pgTable } from 'pg-prime'

export const widgets = pgTable('widgets', (t) => ({
  id: t.bigint().generatedAlways().primaryKey(),
}))

export default defineSchema({ widgets })
`);
      const r = await cli("generate", "--name", "drop_name", "--allow-data-loss");
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.error);
      const e = envelopeOf(r);
      expect(e["status"]).toBe("refused");
      const error = e["error"] as { code: string; message: string };
      expect(error.code).toBe("repeatable_failed");
      expect(error.message).toContain("sql/030_widget_names.sql");
      expect(error.message).toContain("author time");
      expect(e["files"]).toEqual([]);
    },
    T,
  );

  it(
    "doctor names a repeatable that is recorded but gone from disk",
    async () => {
      await rm(join(p.repeatables, "030_widget_names.sql"), { force: true });
      const r = await cli("doctor");
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.drift);
      const e = envelopeOf(r);
      expect((e["repeatables"] as { orphaned: string[] }).orphaned).toEqual(["sql/030_widget_names.sql"]);
      expect((e["findings"] as string[]).join("\n")).toContain("STILL in the database");
    },
    T,
  );
});
