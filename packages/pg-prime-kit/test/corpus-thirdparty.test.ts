/**
 * The third-party corpus — `01` §11.6 #5, the correctness gate for the whole engine.
 *
 * "**`migrate verify` must be green on three real third-party schemas** before 1.0 is
 * tagged." Four are committed under `fixtures/corpus/`, fetched from pinned upstream
 * revisions and trimmed to schema-only DDL by `tools/corpus-fetch.mjs`.
 *
 * Per schema, through the **binary**:
 *
 *   1. load `schema.sql` into a fresh database A;
 *   2. `pg-prime migrate baseline` — write `0000_baseline.sql` describing all of A;
 *   3. `pg-prime migrate verify --against target` — replay that file into an empty
 *      database B through the real runner and assert IR(B) == IR(A), **empty diff**;
 *   4. the D10 witness: `pg_dump` A and B and compare as a multiset.
 *
 * Step 4 is where a real schema earns its keep, and it does not pass cleanly — nor should
 * it. `baseline` emits Tier M; views, matviews, functions, triggers and aggregates are
 * **Tier R** (design/06 §2.2, §8: "views stay in Tier R for v1"), so B does not have them.
 * The assertion is therefore stronger than "the dumps differ a bit": every statement
 * missing from B must be classifiable as Tier R, and `extra` must be **empty**. A missing
 * statement that is not Tier R is a Tier-M blind spot and fails the test. That is exactly
 * how the two extractor bugs this corpus found were found:
 *
 *   - an index on a **materialized view** entered the IR as an orphan and was planned as
 *     `CREATE INDEX … ON <matview>` against a database with no matview (Pagila);
 *   - an **extension-owned composite type**'s attributes entered the IR without their
 *     type, and were planned as `ALTER TYPE … ADD ATTRIBUTE` on a type `tablefunc` had
 *     already created (AdventureWorks);
 *   - `pg_index.indisclustered` was not modelled at all, so 68 `ALTER TABLE … CLUSTER ON`
 *     statements were silently dropped (AdventureWorks). That one is Tier M and is now
 *     `TablePayload.clusterOn`.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extractCatalog } from "../src/catalog/extract.js";
import { withClient } from "../src/db/pg.js";
import { compareDumps, dumpSchema, resolvePgDump } from "../src/prove/pg-dump.js";
import { EXIT } from "../src/cli/exit.js";
import { envelopeOf, runCli, urlOf } from "./support/cli.js";
import { ADMIN, dbConn, destroyDatabase, makeDatabase, REPO_ROOT, serverAvailable } from "./support/db.js";
import { tempDir } from "./support/migrations.js";

const T = 600_000;

interface CorpusCase {
  readonly name: string;
  readonly schemas: readonly string[];
  /** tables whose column order no plan can repair (design/06 §3.9) — documented per schema */
  readonly reordered: readonly string[];
}

const CORPUS: readonly CorpusCase[] = [
  { name: "pagila", schemas: ["public"], reordered: [] },
  { name: "northwind", schemas: ["public"], reordered: [] },
  {
    name: "adventureworks",
    schemas: ["public", "person", "humanresources", "production", "purchasing", "sales", "hr", "pe", "pr", "pu", "sa"],
    reordered: [],
  },
  { name: "chinook", schemas: ["public"], reordered: [] },
];

/* -------------------------------------------------------------------------- */

/** `CREATE VIEW`, `CREATE FUNCTION`, … — the verbs design/06 §2.2 puts in Tier R or O. */
const TIER_R_VERB =
  /^(CREATE\s+(OR\s+REPLACE\s+)?(VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|AGGREGATE|TRIGGER|CONSTRAINT\s+TRIGGER|POLICY|RULE|OPERATOR|CAST|TEXT\s+SEARCH\s+\w+)\b|COMMENT\s+ON\s+(VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|AGGREGATE|TRIGGER|POLICY|RULE)\b|ALTER\s+(VIEW|MATERIALIZED\s+VIEW|FUNCTION|AGGREGATE)\b)/i;

/** Everything a statement might be *about*, as `schema.name`, lower-cased. */
function relationsIn(statement: string): string[] {
  const out: string[] = [];
  const re = /\b([a-z_][a-z0-9_$]*|"[^"]+")\.([a-z_][a-z0-9_$]*|"[^"]+")/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(statement)) !== null) {
    const unquote = (s: string): string => (s.startsWith('"') ? s.slice(1, -1) : s.toLowerCase());
    out.push(`${unquote(m[1]!)}.${unquote(m[2]!)}`);
  }
  return out;
}

/**
 * Is this dump statement one the Tier-R lane owns?
 *
 * Either its verb says so, or its subject is a view/matview — which covers the two forms
 * `pg_dump` writes for an index on a matview (`CREATE INDEX … ON <matview>` and
 * `ALTER TABLE <matview> CLUSTER ON …`), where the verb alone gives nothing away.
 */
function isTierR(statement: string, tierRRelations: ReadonlySet<string>): boolean {
  if (TIER_R_VERB.test(statement.trim())) return true;
  return relationsIn(statement).some((r) => tierRRelations.has(r));
}

interface Row {
  readonly name: string;
  readonly schemas: number;
  readonly facts: Record<string, number>;
  readonly statements: number;
  readonly replayMs: number;
  readonly dump: string;
  readonly tierR: number;
}

const REPORT: Row[] = [];

describe("third-party corpus: baseline → verify → pg_dump witness (01 §11.6 #5)", () => {
  afterAll(() => {
    if (REPORT.length === 0) return;
    const lines = REPORT.map(
      (r) =>
        `  ${r.name.padEnd(16)} ${String(r.schemas).padStart(2)} schemas  ` +
        `${String(r.statements).padStart(5)} statements  ${String(r.replayMs).padStart(6)} ms replay  ` +
        `witness ${r.dump}  (${String(r.tierR)} Tier-R statements not reproduced)\n` +
        `${" ".repeat(20)}${Object.entries(r.facts)
          .map(([k, v]) => `${String(v)} ${k}`)
          .join(", ")}`,
    );
    console.log(`\nthird-party corpus\n${lines.join("\n")}\n`);
  });

  for (const c of CORPUS) {
    it(
      c.name,
      async () => {
        expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
        const source = `pgprime_k2b_corpus_${c.name}`;
        let replica: string | null = null;
        const dir = join(await tempDir(`pgprime-k2b-${c.name}`), "migrations");

        try {
          /* 1. a fresh database A, loaded from the committed, trimmed upstream. */
          await makeDatabase(source);
          const sql = await readFile(join(REPO_ROOT, "fixtures", "corpus", c.name, "schema.sql"), "utf8");
          await withClient(dbConn(source), async (client) => {
            await client.query(sql);
          });
          const url = urlOf(dbConn(source));
          const schemaFlags = c.schemas.flatMap((s) => ["--schema", s]);

          /* 2. baseline, through the binary. */
          const baseline = await runCli([
            "migrate",
            "baseline",
            "--url",
            url,
            "--migrations",
            dir,
            ...schemaFlags,
            "--output",
            "json",
          ]);
          expect(baseline.code, baseline.stdout + baseline.stderr).toBe(EXIT.ok);
          const b = envelopeOf(baseline);
          expect(b["status"]).toBe("baselined");
          // Nothing the extractor could not place. An orphan here is a family-level filter
          // that is not applied uniformly, and it becomes an apply-time failure below.
          expect(b["warnings"], JSON.stringify(b["warnings"])).toEqual([]);
          const statements = (b["migration"] as { statements: number }).statements;

          /* 3. verify: replay 0000_baseline from empty and diff against A. */
          const started = Date.now();
          const verify = await runCli([
            "migrate",
            "verify",
            "--url",
            url,
            "--migrations",
            dir,
            ...schemaFlags,
            "--against",
            "target",
            "--keep",
            "--output",
            "json",
          ]);
          const replayMs = Date.now() - started;
          const v = envelopeOf(verify);
          expect(v["deltas"], JSON.stringify(v["deltas"])).toEqual([]);
          expect(verify.code, verify.stdout + verify.stderr).toBe(EXIT.ok);
          expect(v["status"]).toBe("verified");
          replica = (v["ephemeral"] as { database: string }).database;
          const fingerprints = v["fingerprint"] as { replayed: string; desired: string };
          expect(fingerprints.replayed).toBe(fingerprints.desired);

          /* 4. D10 — PostgreSQL's own serializer, on both databases. */
          const pgDump = await resolvePgDump();
          expect("unavailable" in pgDump ? pgDump.unavailable : "", "the corpus gate needs pg_dump").toBe("");
          if ("unavailable" in pgDump) return;
          const [dumpA, dumpB] = await Promise.all([
            dumpSchema({ pgDump, conn: ADMIN, database: source, schemas: c.schemas }),
            dumpSchema({ pgDump, conn: ADMIN, database: replica, schemas: c.schemas }),
          ]);
          const cmp = compareDumps(dumpB, dumpA);

          const tierRRelations = await withClient(dbConn(source), async (client) => {
            const r = await client.query(
              `SELECT n.nspname || '.' || c.relname AS name
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('v','m') AND n.nspname = ANY($1)`,
              [[...c.schemas]],
            );
            return new Set(r.rows.map((x) => String(x["name"]).toLowerCase()));
          });

          // The whole point: nothing UNEXPECTED is missing, and nothing at all is extra.
          const unexplained = cmp.missing.filter((s) => !isTierR(s, tierRRelations));
          expect(unexplained, `Tier-M statements missing from the replay:\n${unexplained.join("\n\n")}`).toEqual([]);
          expect(cmp.extra, `statements the replay invented:\n${cmp.extra.join("\n\n")}`).toEqual([]);
          expect(cmp.reordered).toEqual([...c.reordered]);

          const extracted = await withClient(dbConn(source), (client) =>
            extractCatalog(client, { schemas: c.schemas, observe: false }),
          );
          const facts: Record<string, number> = {};
          for (const f of extracted.ir.facts()) facts[f.id.kind] = (facts[f.id.kind] ?? 0) + 1;
          REPORT.push({
            name: c.name,
            schemas: c.schemas.length,
            facts,
            statements,
            replayMs,
            dump: cmp.equal ? "equal" : `${String(cmp.missing.length)} Tier-R only`,
            tierR: cmp.missing.length,
          });
        } finally {
          if (replica !== null) await destroyDatabase(replica).catch(() => undefined);
          await destroyDatabase(source).catch(() => undefined);
        }
      },
      T,
    );
  }
});
