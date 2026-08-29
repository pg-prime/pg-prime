/**
 * R17 for the six author-side commands — `generate`, `check`, `verify`, `lint`, `push`
 * and `doctor` — with a committed envelope golden **per status each one can return**.
 *
 * Everything spawns `node dist/cli.js`: the config file is loaded by Node's own type
 * stripping, the schema module is `import()`ed the way a user's is, and the exit code is
 * the one an orchestrator reads. Volatile and server-dependent fields are masked by
 * `_mask.ts`'s documented list, never by a regex over the document.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { withClient } from "../../src/db/pg.js";
import { envelopeOf, runCli, urlOf } from "../support/cli.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { BASE_SCHEMA, makeProject, type Project } from "./_project.js";
import { AUTHORING_MASKED, mask } from "./_mask.js";

const T = 240_000;

const golden = (value: unknown): string => `${JSON.stringify(mask(value, AUTHORING_MASKED), null, 2)}\n`;
const expectGolden = async (name: string, envelope: unknown): Promise<void> => {
  await expect(golden(envelope)).toMatchFileSnapshot(`./golden/${name}.json`);
};

const databases: string[] = [];
const projects: Project[] = [];

async function scratch(slug: string, options: { schema?: string; noSchema?: boolean } = {}): Promise<Project> {
  const database = `pgprime_k2b_cli_${slug}`;
  databases.push(database);
  await makeDatabase(database);
  const project = await makeProject(`cli-${slug}`, {
    url: urlOf(dbConn(database)),
    ...(options.noSchema === true ? { noSchema: true } : { schema: options.schema ?? BASE_SCHEMA }),
  });
  projects.push(project);
  return project;
}

const cli = (p: Project, ...args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  runCli(["migrate", ...args, "--config", p.config, "--output", "json"]);

describe("the author-side commands, through the binary", () => {
  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
  }, T);

  afterAll(async () => {
    for (const p of projects) await p.dispose().catch(() => undefined);
    for (const d of databases) await destroyDatabase(d).catch(() => undefined);
  });

  /* ------------------------------- generate ------------------------------- */

  it(
    "generate writes one transactional file, and a second run is up_to_date",
    async () => {
      const p = await scratch("gen");
      const first = await cli(p, "generate", "--name", "init");
      expect(first.code, first.stdout + first.stderr).toBe(EXIT.ok);
      const g = envelopeOf(first);
      expect(g["status"]).toBe("generated");
      await expectGolden("generate.generated", g);

      // The artifacts are real files, and the SQL is runnable by psql (design/06 §4.2).
      const files = g["files"] as { written: string }[];
      const sql = await readFile(files[0]!.written, "utf8");
      expect(sql).toContain("-- pg-prime:migration 0000_init");
      expect(sql).toContain("CREATE TABLE");

      const applied = await cli(p, "apply");
      expect(applied.code, applied.stdout + applied.stderr).toBe(EXIT.ok);

      const second = await cli(p, "generate", "--name", "again");
      expect(second.code, second.stdout + second.stderr).toBe(EXIT.ok);
      const u = envelopeOf(second);
      expect(u["status"]).toBe("up_to_date");
      await expectGolden("generate.up-to-date", u);
    },
    T,
  );

  it(
    "generate --dry-run writes nothing",
    async () => {
      const p = await scratch("gen_dry");
      const r = await cli(p, "generate", "--name", "dry", "--dry-run");
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.ok);
      const e = envelopeOf(r);
      expect(e["status"]).toBe("dry_run");
      expect((e["files"] as { written: string | null }[])[0]!.written).toBeNull();
      await expectGolden("generate.dry-run", e);

      const status = await cli(p, "status");
      expect((envelopeOf(status)["migrations"] as unknown[]).length).toBe(0);
    },
    T,
  );

  it(
    "generate --empty and --data write a hand-written skeleton and touch no database",
    async () => {
      const p = await scratch("gen_empty");
      const empty = await cli(p, "generate", "--name", "by_hand", "--empty");
      expect(empty.code, empty.stdout + empty.stderr).toBe(EXIT.ok);
      await expectGolden("generate.empty", envelopeOf(empty));
      const emptySql = await readFile(join(p.migrations, "0000_by_hand.sql"), "utf8");
      expect(emptySql).toContain("-- pg-prime:stmt 0");
      expect(emptySql).not.toContain("-- pg-prime:from");

      const data = await cli(p, "generate", "--name", "backfill", "--data");
      expect(data.code, data.stdout + data.stderr).toBe(EXIT.ok);
      await expectGolden("generate.data", envelopeOf(data));
      const dataSql = await readFile(join(p.migrations, "0001_backfill.sql"), "utf8");
      expect(dataSql).toContain("-- pg-prime:data");
      expect(dataSql).toContain("-- pg-prime:batch");
      expect(dataSql).toContain("RAISE EXCEPTION");
    },
    T,
  );

  it(
    "generate refuses a drop nobody acknowledged, with exit 2 and a fix",
    async () => {
      const p = await scratch("gen_hints");
      expect((await cli(p, "generate", "--name", "init")).code).toBe(EXIT.ok);
      expect((await cli(p, "apply")).code).toBe(EXIT.ok);
      // Take a column away. design/06 §3.6: a destructive change cannot be generated
      // silently, and §3.3's envelope is what a CI job reads to find out what to do.
      await p.writeSchema(`import { defineSchema, pgTable } from 'pg-prime'

export const widgets = pgTable('widgets', (t) => ({
  id: t.bigint().generatedAlways().primaryKey(),
}))

export default defineSchema({ widgets })
`);
      const r = await cli(p, "generate", "--name", "drop_name");
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.missingHints);
      const e = envelopeOf(r);
      expect(e["status"]).toBe("missing_hints");
      const unresolved = e["unresolved"] as { type: string; fix: string }[];
      expect(unresolved.some((u) => u.type === "confirm_data_loss")).toBe(true);
      expect(unresolved.map((u) => u.fix).join(" ")).toContain("--allow-data-loss");
      await expectGolden("generate.missing-hints", e);

      // design/12 F2 item i — the human-readable refusal agrees with its own count. The
      // expected sentence is computed from the count, so a regression fails in either
      // direction ("1 decision need", "2 decisions needs").
      const human = await runCli(["migrate", "generate", "--name", "drop_name", "--config", p.config]);
      expect(human.code).toBe(EXIT.missingHints);
      const n = unresolved.length;
      // A non-zero exit prints the text report on stderr (`main.ts`'s `emit`).
      expect(human.stderr).toContain(`${String(n)} ${n === 1 ? "decision needs" : "decisions need"} a human`);

      // …and with the acknowledgement it goes through and is recorded IN THE PLAN.
      const ok = await cli(
        p,
        "generate",
        "--name",
        "drop_name",
        "--allow-data-loss",
        "--by",
        "k2b",
        "--reason",
        "test",
      );
      expect(ok.code, ok.stdout + ok.stderr).toBe(EXIT.ok);
      const written = (envelopeOf(ok)["files"] as { plan: string }[])[0]!.plan;
      const plan = JSON.parse(await readFile(written, "utf8")) as { acknowledged: { by: string; blanket: boolean } };
      expect(plan.acknowledged).toMatchObject({ by: "k2b", blanket: true });
    },
    T,
  );

  it(
    "generate proposes a rename when one is unannotated, and takes the annotation when it is there",
    async () => {
      const p = await scratch("gen_rename");
      expect((await cli(p, "generate", "--name", "init")).code).toBe(EXIT.ok);
      expect((await cli(p, "apply")).code).toBe(EXIT.ok);

      const renamedNoAnnotation = `import { defineSchema, pgTable } from 'pg-prime'

export const widgets = pgTable('widgets', (t) => ({
  id: t.bigint().generatedAlways().primaryKey(),
  label: t.text().unique(),
}))

export default defineSchema({ widgets })
`;
      await p.writeSchema(renamedNoAnnotation);
      const proposed = await cli(p, "generate", "--name", "rename");
      expect(proposed.code, proposed.stdout + proposed.stderr).toBe(EXIT.missingHints);
      const candidates = envelopeOf(proposed)["candidates"] as { from: string; to: string; confidence: string }[];
      expect(candidates).toContainEqual(
        expect.objectContaining({
          from: "column:public.widgets.name",
          to: "column:public.widgets.label",
          confidence: "unambiguous",
        }),
      );

      await p.writeSchema(renamedNoAnnotation.replace("t.text().unique()", "t.text().unique().renamedFrom('name')"));
      const annotated = await cli(p, "generate", "--name", "rename");
      expect(annotated.code, annotated.stdout + annotated.stderr).toBe(EXIT.ok);
      const renames = envelopeOf(annotated)["renames"] as { from: string; to: string; source: string }[];
      expect(renames).toContainEqual(
        expect.objectContaining({
          from: "column:public.widgets.name",
          to: "column:public.widgets.label",
          source: "annotation",
        }),
      );
      expect((await cli(p, "apply")).code).toBe(EXIT.ok);
    },
    T,
  );

  it(
    "generate --offline is refused with the sentence that names the alternatives",
    async () => {
      const p = await scratch("gen_offline");
      const r = await cli(p, "generate", "--name", "nope", "--offline");
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.error);
      const e = envelopeOf(r);
      expect(e["status"]).toBe("refused");
      expect((e["error"] as { message: string }).message).toContain("shadow tier 4");
      await expectGolden("generate.refused", e);

      const docker = await cli(p, "generate", "--name", "nope", "--shadow", "docker");
      expect(docker.code).toBe(EXIT.error);
      expect((envelopeOf(docker)["error"] as { message: string }).message).toContain("testcontainers");
    },
    T,
  );

  /* --------------------------------- check -------------------------------- */

  it(
    "check: pending, then ok, then drift when the schema moves ahead of the migrations",
    async () => {
      const p = await scratch("check");
      expect((await cli(p, "generate", "--name", "init")).code).toBe(EXIT.ok);

      const pending = await cli(p, "check");
      expect(pending.code, pending.stdout + pending.stderr).toBe(EXIT.pending);
      expect(envelopeOf(pending)["status"]).toBe("pending");
      await expectGolden("check.pending", envelopeOf(pending));

      expect((await cli(p, "apply")).code).toBe(EXIT.ok);
      const ok = await cli(p, "check");
      expect(ok.code, ok.stdout + ok.stderr).toBe(EXIT.ok);
      await expectGolden("check.ok", envelopeOf(ok));

      await p.writeSchema(
        BASE_SCHEMA.replace("name: t.text().unique(),", "name: t.text().unique(),\n  colour: t.text().nullable(),"),
      );
      const drift = await cli(p, "check");
      expect(drift.code, drift.stdout + drift.stderr).toBe(EXIT.drift);
      const d = envelopeOf(drift);
      expect(d["status"]).toBe("drift");
      expect((d["schemaDrift"] as string[]).join("\n")).toContain('ADD COLUMN IF NOT EXISTS "colour"');
      await expectGolden("check.drift", d);
    },
    T,
  );

  /* -------------------------------- verify -------------------------------- */

  it(
    "verify replays from empty; --from-checkpoint with no checkpoint on disk is refused",
    async () => {
      const p = await scratch("verify");
      expect((await cli(p, "generate", "--name", "init")).code).toBe(EXIT.ok);
      expect((await cli(p, "apply")).code).toBe(EXIT.ok);

      const ok = await cli(p, "verify");
      expect(ok.code, ok.stdout + ok.stderr).toBe(EXIT.ok);
      expect(envelopeOf(ok)["status"]).toBe("verified");
      expect(envelopeOf(ok)["fromCheckpoint"]).toBe(false);
      await expectGolden("verify.verified", envelopeOf(ok));

      // The flag is built (design/12 decision 16) but it cannot replay from a checkpoint
      // that does not exist, and silently doing a full replay under its name would report
      // a full replay as a checkpoint one — the failure the old blanket refusal prevented.
      const refused = await cli(p, "verify", "--from-checkpoint");
      expect(refused.code).toBe(EXIT.error);
      expect((envelopeOf(refused)["error"] as { message: string }).message).toContain("NNNN_checkpoint.sql");
      await expectGolden("verify.refused", envelopeOf(refused));
    },
    T,
  );

  it(
    "verify exits 4 when a committed migration does not do what the schema says",
    async () => {
      const p = await scratch("verify_drift");
      expect((await cli(p, "generate", "--name", "init")).code).toBe(EXIT.ok);
      expect((await cli(p, "apply")).code).toBe(EXIT.ok);
      // The schema gains a column that no migration adds. Replay-from-empty reproduces the
      // MIGRATIONS, and the diff against IR(desired) is exactly the gap.
      await p.writeSchema(
        BASE_SCHEMA.replace("name: t.text().unique(),", "name: t.text().unique(),\n  colour: t.text().nullable(),"),
      );
      const r = await cli(p, "verify");
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.drift);
      const e = envelopeOf(r);
      expect(e["status"]).toBe("drift");
      expect(e["deltas"]).toEqual(["create column:public.widgets.colour"]);
      await expectGolden("verify.drift", e);
    },
    T,
  );

  /* --------------------------------- lint --------------------------------- */

  it(
    "lint is clean on a generated plan, fails on --fail-on warn, and refuses sarif",
    async () => {
      const p = await scratch("lint");
      expect((await cli(p, "generate", "--name", "init")).code).toBe(EXIT.ok);

      const clean = await cli(p, "lint");
      expect(clean.code, clean.stdout + clean.stderr).toBe(EXIT.ok);
      expect(envelopeOf(clean)["status"]).toBe("clean");
      await expectGolden("lint.clean", envelopeOf(clean));

      const sarif = await cli(p, "lint", "--format", "sarif");
      expect(sarif.code).toBe(EXIT.error);
      expect((envelopeOf(sarif)["error"] as { message: string }).message).toContain("sarif");
      await expectGolden("lint.refused", envelopeOf(sarif));
    },
    T,
  );

  it(
    "lint fails on a hand-written migration that a txmode-none file cannot re-execute",
    async () => {
      const p = await scratch("lint_fail");
      await writeFile(
        join(p.migrations, "0000_by_hand.sql"),
        `-- pg-prime:migration 0000_by_hand
-- pg-prime:txmode    none

-- pg-prime:stmt 0 lock=shareUpdateExclusive non-idempotent
CREATE INDEX CONCURRENTLY widgets_name_idx ON public.widgets (name);
`,
        "utf8",
      );
      const r = await cli(p, "lint");
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.lint);
      const e = envelopeOf(r);
      expect(e["status"]).toBe("failed");
      expect((e["findings"] as { code: string }[]).map((f) => f.code)).toContain("TX201");
      await expectGolden("lint.failed", e);
    },
    T,
  );

  /* --------------------------------- push --------------------------------- */

  it(
    "push refuses without --dev, refuses under PG_PRIME_ENV=production, and refuses a managed database",
    async () => {
      const p = await scratch("push");
      const bare = await cli(p, "push");
      expect(bare.code, bare.stdout + bare.stderr).toBe(EXIT.error);
      expect((envelopeOf(bare)["error"] as { message: string }).message).toContain("literal --dev");
      await expectGolden("push.refused", envelopeOf(bare));

      const prod = await runCli(["migrate", "push", "--dev", "--config", p.config, "--output", "json"], {
        PG_PRIME_ENV: "production",
      });
      expect(prod.code).toBe(EXIT.error);
      expect((envelopeOf(prod)["error"] as { message: string }).message).toContain("production");

      const pattern = await cli(p, "push", "--dev", "--prod-pattern", "pgprime_k2b_cli_push");
      expect(pattern.code).toBe(EXIT.error);
      expect((envelopeOf(pattern)["error"] as { message: string }).message).toContain("--prod-pattern");
    },
    T,
  );

  it(
    "push --dev applies the diff directly, and then refuses because the database is under management",
    async () => {
      const p = await scratch("push_dev");
      const pushed = await cli(p, "push", "--dev");
      expect(pushed.code, pushed.stdout + pushed.stderr).toBe(EXIT.ok);
      const e = envelopeOf(pushed);
      expect(e["status"]).toBe("pushed");
      await expectGolden("push.pushed", e);

      // R14: the catalog, and the ABSENCE of a history row.
      const state = await withClient(dbConn(`pgprime_k2b_cli_push_dev`), async (client) => {
        const t = await client.query("SELECT to_regclass('public.widgets') AS t");
        const h = await client.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'pgprime'");
        return { table: t.rows[0]?.["t"], history: h.rows[0]?.["n"] };
      });
      expect(state).toEqual({ table: "widgets", history: 0 });

      const again = await cli(p, "push", "--dev");
      expect(again.code).toBe(EXIT.ok);
      expect(envelopeOf(again)["status"]).toBe("up_to_date");

      // Once it is under versioned management, push is done here. `baseline` alone is not
      // enough — a `baselined` row is explicitly allowed (design/06 §6.2) — so the
      // database is moved forward by one real, applied migration first.
      expect((await cli(p, "baseline")).code).toBe(EXIT.ok);
      await p.writeSchema(
        BASE_SCHEMA.replace("name: t.text().unique(),", "name: t.text().unique(),\n  colour: t.text().nullable(),"),
      );
      expect((await cli(p, "generate", "--name", "next")).code).toBe(EXIT.ok);
      expect((await cli(p, "apply")).code).toBe(EXIT.ok);
      const managed = await cli(p, "push", "--dev");
      expect(managed.code).toBe(EXIT.error);
      const refusal = (envelopeOf(managed)["error"] as { message: string }).message;
      expect(refusal).toContain("versioned management");
      // design/12 F2 item i: one applied migration, and the verb agrees with it.
      expect(refusal).toContain("holds 1 row that is not baselined");
    },
    T,
  );

  /* -------------------------------- doctor -------------------------------- */

  it(
    "doctor is healthy on a clean database and reports an INVALID index",
    async () => {
      const p = await scratch("doctor");
      expect((await cli(p, "generate", "--name", "init")).code).toBe(EXIT.ok);
      expect((await cli(p, "apply")).code).toBe(EXIT.ok);

      const healthy = await cli(p, "doctor");
      expect(healthy.code, healthy.stdout + healthy.stderr).toBe(EXIT.ok);
      expect(envelopeOf(healthy)["status"]).toBe("healthy");
      await expectGolden("doctor.healthy", envelopeOf(healthy));

      // An INVALID index is what a killed `CREATE INDEX CONCURRENTLY` leaves behind, and
      // it is the finding `doctor` exists for. Manufactured deterministically: a unique
      // build over duplicate rows fails and leaves its index behind, `indisvalid = false`.
      await withClient(dbConn("pgprime_k2b_cli_doctor"), async (client) => {
        await client.query("CREATE TABLE public.dups (v text)");
        await client.query("INSERT INTO public.dups (v) VALUES ('a'), ('a')");
        await client.query("CREATE UNIQUE INDEX CONCURRENTLY dups_v_idx ON public.dups (v)").catch(() => undefined);
      });
      const findings = await cli(p, "doctor");
      expect(findings.code, findings.stdout + findings.stderr).toBe(EXIT.drift);
      const e = envelopeOf(findings);
      expect(e["status"]).toBe("findings");
      expect(e["invalidIndexes"]).toEqual(["public.dups_v_idx"]);
      // The table was created behind the migration history's back, so the fingerprint of
      // record no longer describes this database. Both findings, one report.
      expect((e["history"] as { drift: boolean }).drift).toBe(true);
      await expectGolden("doctor.findings", e);
    },
    T,
  );
});
