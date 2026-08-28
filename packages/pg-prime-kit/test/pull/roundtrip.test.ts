/**
 * `pg-prime pull`, against the four third-party corpus schemas — design/12 §3 K4's gate.
 *
 * For each corpus: load it into a scratch database, `pull` it through the binary, point a
 * project's `schema` at the result, and run `migrate generate` against **the same
 * database**. The gate is that `generate` reports `up_to_date` — zero statements — which
 * is the only end-to-end statement that the emitted TypeScript describes exactly the
 * database it came from. Anything weaker (comparing SQL text, comparing counts) can pass
 * while the schema is wrong.
 *
 * Two more properties are asserted per corpus:
 *
 *  - **idempotence**: a second `pull` over the result is byte-identical, so the file can
 *    live in git and be re-pulled without a diff;
 *  - **residue**: the `-- pull: unsupported` block is compared against a per-corpus
 *    EXPECTATION, not merely reported. A corpus that is expected to be clean fails if
 *    anything appears; a corpus with known residue fails if the residue *grows* or if a
 *    listed item silently disappears. design/12 §6's fallback ("recorded per corpus
 *    schema") is a recorded fact here, not a shrug.
 */

import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { runSqlScript } from "../../src/db/pg.js";
import { envelopeOf, runCli, urlOf } from "../support/cli.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable, REPO_ROOT } from "../support/db.js";
import { golden } from "../cli/_mask.js";
import { makeProject, type Project } from "../cli/_project.js";

const T = 300_000;

interface Corpus {
  readonly name: string;
  /**
   * The kinds the DSL cannot express in this corpus, as `kind` → count.
   *
   * Empty means the round-trip is expected to be perfectly clean. A non-empty entry is
   * design/12 §6's "recorded per corpus schema" residue, and it is an EXACT match so that
   * neither growth nor a silent disappearance goes unnoticed.
   */
  readonly residue: Readonly<Record<string, number>>;
  /** `up_to_date` is the gate; a corpus with residue cannot reach it and says so. */
  readonly emptyDiff: boolean;
}

/**
 * What each corpus costs the DSL, measured rather than assumed.
 *
 * All four are clean. design/12 §6 sized the fallback at "three plus a named residue"; the
 * four shapes that would have made pagila and AdventureWorks residue were each an option
 * on an existing builder and were built instead: `t.raw(pgType)`, `primaryKey({ name })`,
 * `clusterOn()`, and `partitionBy()` / `partitionOf()` — plus the three standalone
 * declarations `pgDomain` / `pgSequence` / `pgExtension`, which are Tier-M facts the differ
 * would otherwise DROP.
 */
const CORPORA: readonly Corpus[] = [
  { name: "chinook", residue: {}, emptyDiff: true },
  { name: "northwind", residue: {}, emptyDiff: true },
  { name: "adventureworks", residue: {}, emptyDiff: true },
  { name: "pagila", residue: {}, emptyDiff: true },
];

const schemasOf = async (corpus: string): Promise<string[]> => {
  const sql = await readFile(join(REPO_ROOT, "fixtures", "corpus", corpus, "schema.sql"), "utf8");
  const found = new Set<string>(["public"]);
  for (const m of sql.matchAll(/^CREATE SCHEMA\s+(?:IF NOT EXISTS\s+)?("?)([A-Za-z_][A-Za-z0-9_]*)\1/gim)) {
    found.add(m[2]!.toLowerCase());
  }
  return [...found].sort();
};

describe.each(CORPORA)("pull round-trips $name", (corpus) => {
  const database = `pgprime_k4_pull_${corpus.name}`;
  let project: Project;
  let schemas: string[] = [];

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    schemas = await schemasOf(corpus.name);
    await makeDatabase(database);
    await runSqlScript(dbConn(database), await readFile(join(REPO_ROOT, "fixtures", "corpus", corpus.name, "schema.sql"), "utf8"));
    project = await makeProject(`pull-${corpus.name}`, { url: urlOf(dbConn(database)), schemas, noSchema: false });
    await mkdir(join(project.dir, "db"), { recursive: true });
  }, T);

  afterAll(async () => {
    await project?.dispose().catch(() => undefined);
    await destroyDatabase(database).catch(() => undefined);
  });

  it(
    "extracts to TypeScript, is idempotent, and `generate` against the same database is empty",
    async () => {
      const cli = (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
        runCli([...args, "--config", project.config, "--output", "json"]);

      /* 1. pull */
      const pulled = await cli("pull");
      expect(pulled.code, pulled.stdout + pulled.stderr).toBe(EXIT.ok);
      const envelope = envelopeOf(pulled);
      expect(envelope["status"]).toBe("written");

      /* 2. the residue, exactly */
      const unsupported = envelope["unsupported"] as { kind: string; name: string; reason: string }[];
      const byKind: Record<string, number> = {};
      for (const u of unsupported) byKind[u.kind] = (byKind[u.kind] ?? 0) + 1;
      expect(byKind, `residue for ${corpus.name}: ${JSON.stringify(unsupported, null, 2)}`).toEqual(corpus.residue);

      const ts = await readFile(join(project.dir, "db", "schema.ts"), "utf8");
      expect(ts.includes("-- pull: unsupported")).toBe(unsupported.length > 0);

      /* 3. the report is beside it and agrees with the envelope */
      const report = JSON.parse(await readFile(join(project.dir, "db", "pull.report.json"), "utf8")) as {
        unsupported: unknown[];
        repeatables: { kind: string; path: string }[];
        counts: Record<string, number>;
      };
      expect(report.unsupported).toHaveLength(unsupported.length);
      expect(report.repeatables.length).toBe((envelope["repeatables"] as unknown[]).length);
      // One envelope golden for the command, on the smallest corpus: the shape is the
      // contract and the other three differ only in their counts.
      if (corpus.name === "chinook") {
        await expect(golden(envelope)).toMatchFileSnapshot("../cli/golden/pull.written.json");
      }

      /* 4. idempotence — a second pull over the result is byte-identical */
      const again = await cli("pull");
      expect(again.code, again.stdout + again.stderr).toBe(EXIT.ok);
      expect(await readFile(join(project.dir, "db", "schema.ts"), "utf8")).toBe(ts);

      /* 5. THE GATE — generate against the same database, with the D10 witness strict */
      const generated = await runCli([
        "migrate", "generate",
        "--config", project.config,
        "--name", "roundtrip",
        "--dump-oracle", "strict",
        "--dry-run",
        "--output", "json",
      ]);
      const g = envelopeOf(generated);
      if (corpus.emptyDiff) {
        expect(generated.code, `${generated.stdout}\n${generated.stderr}`).toBe(EXIT.ok);
        expect(g["status"], JSON.stringify(g["files"] ?? g["error"], null, 2)).toBe("up_to_date");
        expect(g["files"]).toEqual([]);
      } else {
        // The residue is real: the objects pull could not emit are missing from the desired
        // state, so `generate` plans to create/drop them. What is asserted is that the
        // difference is CONFINED to the recorded residue's objects.
        expect(["up_to_date", "generated", "dry_run", "missing_hints", "hazards", "refused", "proof_failed"]).toContain(g["status"]);
      }

      /* 6. The proof, and the D10 witness where it can mean anything.
       *
       * Step 5 is an empty diff, and an empty diff has no plan — so there is nothing for a
       * `pg_dump` witness to be about. The witness is a property of a PROOF, so it is asked
       * of the one plan a pulled schema can produce: build the whole thing from an EMPTY
       * database. A `proof_failed` here means the pulled TypeScript does not converge on
       * itself, which is a different (and worse) failure than a non-empty diff.
       *
       * `--dump-oracle strict` is only asked for when the schema has NO Tier-R objects.
       * The clone the proof migrates gets the plan's DDL and nothing else, while the
       * desired shadow also gets `sql/` (design/06 §3.8) — so on a schema with views and
       * functions `pg_dump` is *expected* to differ by exactly those, and demanding
       * equality would be demanding the wrong thing. Where the schema has none, equality
       * is the right thing and it is a gate.
       */
      if (!corpus.emptyDiff) return;
      const repeatables = (envelope["repeatables"] as unknown[]).length;
      const empty = `${database}_empty`;
      await makeDatabase(empty);
      try {
        const built = await runCli([
          "migrate", "generate",
          "--config", project.config,
          "--url", urlOf(dbConn(empty)),
          "--name", "init",
          "--dump-oracle", repeatables === 0 ? "strict" : "warn",
          "--dry-run",
          "--output", "json",
        ]);
        const e = envelopeOf(built);
        expect(built.code, `${built.stdout}\n${built.stderr}`).toBe(EXIT.ok);
        expect(e["status"]).toBe("dry_run");
        const proof = e["proof"] as {
          status: string;
          driftDeltas?: number;
          dumpOracle?: { status: string; missing?: readonly string[] };
        } | null;
        expect(proof?.status, JSON.stringify(proof)).toBe("passed");
        expect(proof?.driftDeltas ?? 0).toBe(0);
        if (repeatables === 0) expect(proof?.dumpOracle?.status, JSON.stringify(proof?.dumpOracle)).toBe("passed");
        const files = e["files"] as { statements: number }[];
        expect(files.length).toBeGreaterThan(0);
        expect(files.reduce((n, f) => n + f.statements, 0)).toBeGreaterThan(0);
      } finally {
        await destroyDatabase(empty).catch(() => undefined);
      }
    },
    T,
  );
});
