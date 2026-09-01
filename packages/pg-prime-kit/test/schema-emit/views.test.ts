/**
 * Declared views through the `sql/` repeatables lane (design/01 §3 row 58, design/14 W).
 *
 * Three questions, in the order they matter:
 *
 *  1. **What does the lane look like on disk?** The rendered text is the artifact a human reviews
 *     in the pull request, so it is asserted verbatim rather than by regex — including the
 *     `security_invoker = true` D14 default, which is the one line that would be a security bug if
 *     it silently disappeared.
 *  2. **Does the lane stay in sync?** Written on `generate`, pruned when the declaration goes,
 *     reported as stale when `check` finds a lane nobody regenerated.
 *  3. **Does PostgreSQL agree?** The end-to-end case runs `generate` + `apply` against a real
 *     database and then asks the catalog: the view exists, its `security_invoker` is on, the
 *     matview has rows, a second `generate` is `up_to_date`, and the Tier-U census no longer
 *     reports the views the schema declares while it still reports the one it does not.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineSchema, pgMaterializedView, pgTable, pgView, sql } from "pg-prime";
import { extractCatalog } from "../../src/catalog/extract.js";
import { withClient } from "../../src/db/pg.js";
import { generate } from "../../src/generate.js";
import { applyPending } from "../../src/runner/run.js";
import type { SchemaLike } from "../../src/schema/types.js";
import { renderViewRepeatables, syncViewRepeatables, VIEWS_DIR } from "../../src/schema/views.js";
import { ADMIN, dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { tempDir } from "../support/migrations.js";

const T = 180_000;

const widgets = pgTable("widgets", (t) => ({
  id: t.bigint().generatedAlways().primaryKey(),
  name: t.text(),
  active: t.boolean().default(true),
}));

const activeWidgets = pgView("active_widgets")
  .columns((t) => ({ id: t.bigint(), name: t.text() }))
  .comment("the widgets nobody retired")
  .as(sql`select id, name from public.widgets where active`);

/** Depends on the view above, so the topological order is observable in the filenames. */
const activeNames = pgView("active_names")
  .columns((t) => ({ name: t.text() }))
  .dependsOn(activeWidgets)
  .with({ securityInvoker: false, securityBarrier: true })
  .as(sql`select name from public.active_widgets`);

const widgetCount = pgMaterializedView("widget_count")
  .columns((t) => ({ n: t.bigint() }))
  .refreshable()
  .as(sql`select count(*) from public.widgets`);

/** Declared, typed, never emitted — and still silenced in the census. */
const externalView = pgView("dba_owned")
  .columns((t) => ({ id: t.bigint() }))
  .existing();

const schema = {
  ...(defineSchema({ widgets }) as unknown as SchemaLike),
  views: [activeWidgets, activeNames, widgetCount, externalView],
} as unknown as SchemaLike;

describe("renderViewRepeatables", () => {
  it("orders by dependsOn and bakes the rank into the filename", () => {
    const { files, diagnostics } = renderViewRepeatables(schema);
    expect(diagnostics).toEqual([]);
    // `.existing()` renders nothing at all — that is what "never emitted" means.
    expect(files.map((f) => f.path)).toEqual([
      `${VIEWS_DIR}/010_public__active_widgets.sql`,
      `${VIEWS_DIR}/020_public__active_names.sql`,
      `${VIEWS_DIR}/030_public__widget_count.sql`,
    ]);
    expect(files.map((f) => f.identity)).toEqual([
      "public.active_widgets",
      "public.active_names",
      "public.widget_count",
    ]);
  });

  it("renders a view with the D14 default and its comment", () => {
    const file = renderViewRepeatables(schema).files[0]!;
    expect(file.sql).toContain("-- pg-prime:declared view public.active_widgets");
    expect(file.sql).toContain("-- pg-prime:tier R");
    expect(file.sql).toContain(
      'CREATE OR REPLACE VIEW "public"."active_widgets" ("id", "name") WITH (security_invoker = true) AS',
    );
    expect(file.sql).toContain("select id, name from public.widgets where active;");
    expect(file.sql).toContain(`COMMENT ON VIEW "public"."active_widgets" IS 'the widgets nobody retired';`);
  });

  it("carries an explicit opt-out and the other two reloptions", () => {
    const file = renderViewRepeatables(schema).files[1]!;
    expect(file.sql).toContain("WITH (security_invoker = false, security_barrier = true)");
  });

  it("a matview is DROP + CREATE, never CASCADE, and says why in the file", () => {
    const file = renderViewRepeatables(schema).files[2]!;
    expect(file.sql).toContain('DROP MATERIALIZED VIEW IF EXISTS "public"."widget_count";');
    expect(file.sql).not.toContain("CASCADE;");
    expect(file.sql).toContain('CREATE MATERIALIZED VIEW "public"."widget_count" ("n") AS');
    expect(file.sql).toContain("WITH DATA;");
    expect(file.sql).toContain("no CREATE OR REPLACE for a materialized view");
  });

  it("`.withNoData()` reaches the DDL", () => {
    const empty = pgMaterializedView("m")
      .columns((t) => ({ n: t.bigint() }))
      .withNoData()
      .as(sql`select 1`);
    const { files } = renderViewRepeatables({ tables: {}, views: [empty] } as unknown as SchemaLike);
    expect(files[0]!.sql).toContain("WITH NO DATA;");
  });

  it("reports a dependsOn cycle instead of emitting a silent order", () => {
    const a = pgView("a")
      .columns((t) => ({ x: t.bigint() }))
      .dependsOn("public.b")
      .as(sql`select 1`);
    const b = pgView("b")
      .columns((t) => ({ x: t.bigint() }))
      .dependsOn("public.a")
      .as(sql`select 1`);
    const { files, diagnostics } = renderViewRepeatables({
      tables: {},
      views: [a, b],
    } as unknown as SchemaLike);
    expect(diagnostics.map((d) => d.code)).toEqual(["view_dependency_cycle"]);
    // The other N-1 views are still emitted: hiding them behind the cycle helps nobody.
    expect(files).toHaveLength(2);
  });

  it("reports two declarations of one name", () => {
    const a = pgView("dup")
      .columns((t) => ({ x: t.bigint() }))
      .as(sql`select 1`);
    const b = pgView("dup")
      .columns((t) => ({ x: t.bigint() }))
      .as(sql`select 2`);
    const { diagnostics } = renderViewRepeatables({
      tables: {},
      views: [a, b],
    } as unknown as SchemaLike);
    expect(diagnostics.map((d) => d.code)).toEqual(["view_conflict"]);
  });
});

describe("syncViewRepeatables", () => {
  it("writes, is idempotent, prunes what the schema no longer declares, and never touches a hand-written file", async () => {
    const dir = join(await tempDir("pgprime-w-views"), "sql");
    await mkdir(join(dir, VIEWS_DIR), { recursive: true });
    const handWritten = join(dir, VIEWS_DIR, "999_by_hand.sql");
    await writeFile(handWritten, "-- pg-prime:object view public.by_hand\nCREATE VIEW public.by_hand AS SELECT 1;\n");

    const first = await syncViewRepeatables(schema, dir, { write: true });
    expect(first.written).toHaveLength(3);
    expect(first.pruned).toEqual([]);

    const second = await syncViewRepeatables(schema, dir, { write: true });
    expect(second.written).toEqual([]);
    expect(second.pruned).toEqual([]);

    const shrunk = { ...schema, views: [activeWidgets] } as unknown as SchemaLike;
    const third = await syncViewRepeatables(shrunk, dir, { write: true });
    expect(third.written).toEqual([]);
    expect([...third.pruned].sort()).toEqual([
      `${VIEWS_DIR}/020_public__active_names.sql`,
      `${VIEWS_DIR}/030_public__widget_count.sql`,
    ]);

    // The file we did not write is still there. Pruning keys on `-- pg-prime:declared`.
    expect(await readFile(handWritten, "utf8")).toContain("by_hand");
    expect((await readdir(join(dir, VIEWS_DIR))).sort()).toEqual(["010_public__active_widgets.sql", "999_by_hand.sql"]);
  });

  it("with `write: false` it reports the drift instead of repairing it", async () => {
    const dir = join(await tempDir("pgprime-w-views-ro"), "sql");
    const dry = await syncViewRepeatables(schema, dir, { write: false });
    expect(dry.written).toEqual([]);
    expect(dry.pruned).toEqual([]);
    const stale = dry.diagnostics.find((d) => d.code === "declared_views_stale");
    expect(stale?.count).toBe(3);
    expect(stale?.message).toContain("migrate generate");
    // Nothing reached the disk.
    await expect(readdir(join(dir, VIEWS_DIR))).rejects.toThrow();
  });
});

describe("end to end: generate writes the lane, apply runs it, the census stops counting", () => {
  const database = "pgprime_w_views";
  let migrations: string;
  let repeatables: string;

  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
    await makeDatabase(database);
    const root = await tempDir("pgprime-w-e2e");
    migrations = join(root, "migrations");
    repeatables = join(root, "sql");
    await mkdir(migrations, { recursive: true });
    await mkdir(repeatables, { recursive: true });
  }, T);

  afterAll(async () => {
    await destroyDatabase(database).catch(() => undefined);
  }, T);

  it(
    "puts the views in the catalog and leaves a second generate up to date",
    async () => {
      const first = await generate({
        admin: ADMIN,
        target: dbConn(database),
        schema,
        repeatablesDir: repeatables,
        schemas: ["public"],
        seq: 1,
        name: "widgets",
        outDir: migrations,
        prove: false,
      });
      expect(first.status, JSON.stringify(first.diagnostics)).toBe("generated");
      // The lane is on disk before the shadow ever loaded it, so `generate` itself proved the
      // bodies parse against the tables it is about to create.
      expect((await readdir(join(repeatables, VIEWS_DIR))).sort()).toEqual([
        "010_public__active_widgets.sql",
        "020_public__active_names.sql",
        "030_public__widget_count.sql",
      ]);
      expect(first.repeatables.map((r) => r.path).toSorted()).toEqual([
        "sql/020_views/010_public__active_widgets.sql",
        "sql/020_views/020_public__active_names.sql",
        "sql/020_views/030_public__widget_count.sql",
      ]);

      const applied = await applyPending(dbConn(database), migrations, {
        schemas: ["public"],
        repeatablesDir: repeatables,
        repeatables: (await import("../../src/repeatables/index.js")).createRepeatablesPass(),
      });
      expect(applied.status, applied.error?.message).toBe("applied");

      await withClient(dbConn(database), async (client) => {
        const views = await client.query("select viewname from pg_views where schemaname = 'public' order by 1");
        expect((views.rows as { viewname: string }[]).map((r) => r.viewname)).toEqual([
          "active_names",
          "active_widgets",
        ]);
        const opts = await client.query("select reloptions from pg_class where relname = 'active_widgets'");
        expect((opts.rows as { reloptions: string[] | null }[])[0]?.reloptions).toContain("security_invoker=true");
        const mv = await client.query("select n from public.widget_count");
        expect((mv.rows as { n: string }[])[0]?.n).toBe("0");
      });

      const second = await generate({
        admin: ADMIN,
        target: dbConn(database),
        schema,
        repeatablesDir: repeatables,
        schemas: ["public"],
        seq: 2,
        name: "again",
        outDir: migrations,
        prove: false,
      });
      expect(second.status).toBe("up_to_date");
      // The Tier-U census: three views exist and three are declared, so nothing is reported.
      // The `.existing()` one is declared too, which is what makes it silent.
      const census = second.diagnostics.filter(
        (d) => d.code === "unmodeled_kind" && (d.subject === "view" || d.subject === "materializedView"),
      );
      expect(census).toEqual([]);
    },
    T,
  );

  it(
    "still counts a view the schema does not declare",
    async () => {
      await withClient(dbConn(database), async (client) => {
        await client.query("CREATE VIEW public.undeclared AS SELECT id FROM public.widgets");
      });
      const result = await generate({
        admin: ADMIN,
        target: dbConn(database),
        schema,
        repeatablesDir: repeatables,
        schemas: ["public"],
        seq: 3,
        name: "census",
        outDir: migrations,
        prove: false,
      });
      const census = result.diagnostics.find((d) => d.code === "unmodeled_kind" && d.subject === "view");
      expect(census?.count).toBe(1);
      expect(census?.message).toContain("Tier R");

      // and the extractor on its own is unchanged: the subtraction is generate's, not the
      // catalog reader's, so `doctor` still reports what is actually in the database.
      const raw = await withClient(dbConn(database), (c) => extractCatalog(c, { schemas: ["public"] }));
      expect(raw.diagnostics.find((d) => d.code === "unmodeled_kind" && d.subject === "view")?.count).toBe(3);
    },
    T,
  );
});
