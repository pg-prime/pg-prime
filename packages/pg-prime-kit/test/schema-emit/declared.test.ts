/** design/20 §4/§5.2: the declared lane's files, its sync and its conflict scan. No database. */

import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { definePolicy, pgTable, rls, updatedAtTrigger } from "pg-prime";
import { sha256 } from "../../src/ir/hash.js";
import { checkIdempotence, parseDirectives } from "../../src/repeatables/index.js";
import {
  asRepeatable,
  laneConflicts,
  parseAcks,
  POLICIES_DIR,
  PRUNE_FILE,
  renderDeclared,
  scanOrder,
  syncDeclared,
  TRIGGERS_DIR,
} from "../../src/schema/declared.js";
import { splitStatements } from "../../src/sql/statements.js";
import { tempDir } from "../support/migrations.js";
import { APP_ROLE, documents, POLICIES, schemaWith } from "./rls-fixture.js";

const DIRS = [POLICIES_DIR, TRIGGERS_DIR];

describe("renderDeclared", () => {
  const { files, diagnostics } = renderDeclared(schemaWith());

  it("renders design/20 §4's four files, byte for byte", async () => {
    expect(diagnostics).toEqual([]);
    expect(files.map((f) => f.path)).toEqual([
      "050_policies/public__documents.sql",
      "070_triggers/000_functions.sql",
      "070_triggers/public__documents.sql",
      PRUNE_FILE,
    ]);
    for (const f of files) {
      await expect(f.sql).toMatchFileSnapshot(`./golden/declared/${f.path.replaceAll("/", "__")}`);
    }
  });

  it("every file passes TX201 as rendered", () => {
    for (const f of files) expect(checkIdempotence(splitStatements(f.sql)).violations, f.path).toEqual([]);
  });

  it("markers are the sha256 of each CREATE statement, in the header and the COMMENT", () => {
    const policies = files[0]!;
    for (const p of POLICIES) {
      const hash = sha256(p.$.ddl((s) => s ?? "public"));
      expect(policies.sql).toContain(`-- pg-prime:object policy public.documents.${p.name} ${hash}`);
      expect(policies.sql).toContain(`IS 'pg-prime:declared ${hash}';`);
    }
    expect(policies.objects.map((o) => `${o.kind} ${o.identity}`)).toEqual([
      "rls public.documents",
      "policy public.documents.archived_read_only",
      "policy public.documents.shared",
      "policy public.documents.tenant",
    ]);
  });

  it("is stable: same input, same bytes, policies sorted by name", () => {
    const again = renderDeclared(schemaWith([...POLICIES].reverse()));
    expect(again.files.map((f) => f.sql)).toEqual(files.map((f) => f.sql));
  });

  it("renders NO FORCE for rls.enable(), and warns RL104 on a policy without rls.*()", () => {
    const plain = pgTable(
      "notes",
      (t) => ({ id: t.integer() }),
      () => [rls.enable()],
    );
    const open = pgTable("open_notes", (t) => ({ id: t.integer() }));
    const p = definePolicy("all_rows", { on: open, for: "select" });
    const r = renderDeclared(schemaWith([], { plain, open }));
    expect(r.files[0]!.sql).toContain('ALTER TABLE "public"."notes" NO FORCE ROW LEVEL SECURITY;');
    expect(r.files[0]!.sql).toContain("-- pg-prime:object rls public.notes noforce");
    const warned = renderDeclared(schemaWith([p], { open }));
    expect(warned.diagnostics.map((d) => d.code)).toEqual(["RL104"]);
  });

  it("an empty keep-list drops everything marked; nothing declared and no prune file renders nothing", () => {
    expect(renderDeclared(schemaWith([], {})).files).toEqual([]);
    const kept = renderDeclared(schemaWith([], {}), { existingPrune: true });
    expect(kept.files.map((f) => f.path)).toEqual([PRUNE_FILE]);
    expect(kept.files[0]!.sql).not.toContain("NOT IN");
    expect(kept.files[0]!.sql).toContain("EXECUTE format('DROP FUNCTION %I.%I()', r.s, r.o);");
  });

  it("records acknowledgements in the prune header and reads them back", () => {
    const acks = [
      { code: "RL105", subject: "public.documents.archived_read_only", by: "alice", reason: "replaced by app check" },
    ];
    const prune = renderDeclared(schemaWith(), { acks }).files.find((f) => f.path === PRUNE_FILE)!;
    expect(prune.sql).toContain(
      "-- pg-prime:acknowledged RL105 public.documents.archived_read_only by alice: replaced by app check\n",
    );
    expect(parseAcks(parseDirectives(prune.sql))).toEqual(acks);
  });

  it("remaps every schema for a shadow", () => {
    const shadow = renderDeclared(schemaWith(), { schemaOf: (s) => `shadow_${s}` });
    expect(shadow.files[0]!.path).toBe("050_policies/shadow_public__documents.sql");
    expect(shadow.files[0]!.sql).toContain('CREATE POLICY "tenant" ON "shadow_public"."documents"');
    expect(shadow.files[1]!.sql).toContain('"shadow_public"."pgprime_set_updated_at"()');
  });

  it("refuses two policies of one name on one table", () => {
    const twin = definePolicy("tenant", { on: documents, to: [APP_ROLE] });
    expect(renderDeclared(schemaWith([...POLICIES, twin])).diagnostics.map((d) => d.code)).toEqual([
      "declared_conflict",
    ]);
  });

  it("a trigger table with updatedAtTrigger and nothing else renders no policy file", () => {
    const stamped = pgTable(
      "stamped",
      (t) => ({ id: t.integer(), touchedAt: t.timestamptz() }),
      (t) => [updatedAtTrigger(t.touchedAt)],
    );
    const r = renderDeclared(schemaWith([], { stamped }));
    expect(r.files.map((f) => f.path)).toEqual([
      "070_triggers/000_functions.sql",
      "070_triggers/public__stamped.sql",
      PRUNE_FILE,
    ]);
    expect(r.files[0]!.sql).toContain('NEW."touched_at" := now();');
  });
});

describe("laneConflicts", () => {
  const declared = renderDeclared(schemaWith()).files;
  const hand = (path: string, sql: string) => asRepeatable("/p/sql", { path, sql });

  it("flags a hand file that creates a declared policy, trigger or function", () => {
    const found = laneConflicts(
      [
        hand("040_mine.sql", "create policy tenant on documents using (true);"),
        hand(
          "060_trg.sql",
          "CREATE OR REPLACE TRIGGER pgprime_set_updated_at BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION f();",
        ),
        hand(
          "010_fn.sql",
          "CREATE FUNCTION public.pgprime_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;",
        ),
        hand("011_ok.sql", "DO $$ BEGIN EXECUTE 'CREATE POLICY tenant ON documents'; END $$;"),
      ],
      declared,
    );
    expect(found.map((d) => `${d.code} ${d.subject ?? ""}`)).toEqual([
      "declared_conflict sql/040_mine.sql",
      "declared_conflict sql/060_trg.sql",
      "declared_conflict sql/010_fn.sql",
    ]);
  });

  it("flags a pulled -- pg-prime:object file and a hand file at a declared path", () => {
    const found = laneConflicts(
      [
        hand(
          "050_policies/public__documents__tenant.sql",
          "-- pg-prime:object policy public.documents.tenant\nSELECT 1;",
        ),
        hand("050_policies/public__documents.sql", "SELECT 1;"),
      ],
      declared,
    );
    expect(found.map((d) => d.code)).toEqual(["declared_conflict", "declared_conflict"]);
  });

  it("warns rls_declared_twice on a hand ENABLE of a table with rls.*()", () => {
    const found = laneConflicts(
      [hand("040_rls/x.sql", 'ALTER TABLE "public"."documents" ENABLE ROW LEVEL SECURITY;')],
      declared,
    );
    expect(found.map((d) => `${d.code} ${d.severity}`)).toEqual(["rls_declared_twice warning"]);
  });
});

describe("syncDeclared", () => {
  const files = renderDeclared(schemaWith()).files;

  it("writes, is idempotent, deletes what is no longer declared and never deletes the prune file", async () => {
    const dir = join(await tempDir("pgprime-r2-sync"), "sql");
    expect((await syncDeclared(dir, files, { write: true, dirs: DIRS })).written).toHaveLength(4);
    expect((await syncDeclared(dir, files, { write: true, dirs: DIRS })).written).toEqual([]);

    const none = renderDeclared(schemaWith([], {}), { existingPrune: true }).files;
    const shrunk = await syncDeclared(dir, none, { write: true, dirs: DIRS });
    expect(shrunk.pruned.toSorted()).toEqual([
      "050_policies/public__documents.sql",
      "070_triggers/000_functions.sql",
      "070_triggers/public__documents.sql",
    ]);
    expect(await readdir(dir)).toContain(PRUNE_FILE);
    expect((await syncDeclared(dir, [], { write: true, dirs: DIRS })).pruned).toEqual([]);
  });

  // root ignores the directory mode
  it.skipIf(process.getuid?.() === 0)("a file it cannot delete is an error, not a pruned path", async () => {
    const dir = join(await tempDir("pgprime-r2-locked"), "sql");
    await syncDeclared(dir, files, { write: true, dirs: DIRS });
    await chmod(join(dir, POLICIES_DIR), 0o555);
    try {
      const none = renderDeclared(schemaWith([], {}), { existingPrune: true }).files;
      await expect(syncDeclared(dir, none, { write: true, dirs: DIRS })).rejects.toThrow(/EACCES|EPERM/);
    } finally {
      await chmod(join(dir, POLICIES_DIR), 0o755);
    }
  });

  it("with write: false reports declared_lane_stale and writes nothing", async () => {
    const dir = join(await tempDir("pgprime-r2-stale"), "sql");
    const r = await syncDeclared(dir, files, { write: false, dirs: DIRS });
    expect(r.diagnostics.map((d) => `${d.code} ${d.severity} ${String(d.count)}`)).toEqual([
      "declared_lane_stale warning 4",
    ]);
    await expect(readdir(dir)).rejects.toThrow();
  });

  it("refuses to overwrite a hand file at a declared path, and writes nothing at all", async () => {
    const dir = join(await tempDir("pgprime-r2-conflict"), "sql");
    await mkdir(join(dir, POLICIES_DIR), { recursive: true });
    await writeFile(join(dir, POLICIES_DIR, "public__documents.sql"), "SELECT 1;\n");
    const r = await syncDeclared(dir, files, { write: true, dirs: DIRS });
    expect(r.diagnostics.map((d) => d.code)).toEqual(["declared_conflict"]);
    expect(r.written).toEqual([]);
    expect(await readFile(join(dir, POLICIES_DIR, "public__documents.sql"), "utf8")).toBe("SELECT 1;\n");
    expect(await readdir(dir)).toEqual([POLICIES_DIR]);
  });
});

it("scanOrder is the scanner's per-directory sort", () => {
  const paths = [
    "sql/a_b.sql",
    "sql/a/x.sql",
    "sql/a-b.sql",
    "sql/990_declared_prune.sql",
    "sql/070_triggers/000_functions.sql",
  ];
  expect(
    paths
      .map((path) => ({ path }))
      .sort(scanOrder)
      .map((p) => p.path),
  ).toEqual([
    "sql/070_triggers/000_functions.sql",
    "sql/990_declared_prune.sql",
    "sql/a/x.sql",
    "sql/a-b.sql",
    "sql/a_b.sql",
  ]);
});
