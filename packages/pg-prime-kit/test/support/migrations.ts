/**
 * Building a real `migrations/` directory for the runner tests.
 *
 * The runner needs *proven artifacts on disk*, and the only honest way to get them is the
 * generator: `generate({ …, outDir })` against the fixture corpus. Writing plans by hand
 * would test the runner against a shape the generator does not produce.
 *
 * Two deliberate choices:
 *
 *  - `prove: false` + `allowUnproven: true`. The shadow-clone proof and the `pg_dump`
 *    witness are `test/corpus.test.ts`'s job and cost seconds per case; the runner tests
 *    ask a different question ("does applying this file put the objects in the catalog
 *    and the row in the history table") and re-proving here would only make them slow.
 *  - The chain is advanced with **`applySegments`**, not with `applyPending`. The fixture
 *    builder must not be the code under test.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractCatalog } from "../../src/catalog/extract.js";
import { withClient, type ConnInfo } from "../../src/db/pg.js";
import { generate } from "../../src/generate.js";
import type { Plan } from "../../src/plan/plan.js";
import { applySegments } from "../../src/runner/apply.js";
import { ADMIN, dbConn, destroyDatabase, makeDatabase } from "./db.js";

export interface ChainStep {
  /** the migration's slug; becomes `NNNN_<name>.sql` */
  readonly name: string;
  /** a path under `fixtures/diff`, or null for "converge to empty" */
  readonly fixture: string | null;
}

export interface Chain {
  readonly dir: string;
  readonly plans: readonly Plan[];
  readonly finalFingerprint: string;
  readonly dispose: () => Promise<void>;
}

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

/**
 * Generate a chain of migrations: step *i* diffs the state after step *i-1* against
 * `steps[i].fixture`. Returns the directory holding `NNNN_name.sql` + `.plan.json`.
 */
export async function generateChain(
  slug: string,
  steps: readonly ChainStep[],
  schemas: readonly string[] = ["public"],
): Promise<Chain> {
  const dir = join(await tempDir(`pgprime-k1-${slug}`), "migrations");
  await mkdir(dir, { recursive: true });
  const scratch = `pgprime_k1_${slug}_gen`;
  await makeDatabase(scratch);
  const plans: Plan[] = [];
  let finalFingerprint = "";

  try {
    for (const [i, step] of steps.entries()) {
      const desired = `pgprime_k1_${slug}_d${String(i)}`;
      await makeDatabase(desired, step.fixture ?? undefined);
      try {
        const result = await generate({
          admin: ADMIN,
          target: dbConn(scratch),
          desired: dbConn(desired),
          schemas,
          seq: i + 1,
          name: step.name,
          outDir: dir,
          prove: false,
          allowUnproven: true,
          // `evolve` drops columns; `writePlan` refuses an unacknowledged destructive
          // change (design/06 §3.6), which is the right default and the wrong one for a
          // fixture builder. The acknowledgement is recorded in the plan, so the runner
          // tests read exactly the artifact a real `--allow-data-loss` run produces.
          acknowledge: { allowDataLoss: true, by: "k1-fixture", reason: "runner test fixture" },
        });
        if (result.writeRefusal) throw new Error(`generate refused to write ${step.name}: ${result.writeRefusal}`);
        plans.push(result.plan);
        finalFingerprint = result.plan.to.fingerprint;
        await withClient(dbConn(scratch), (c) => applySegments(c, result.plan.statements, result.plan.segments));
      } finally {
        await destroyDatabase(desired).catch(() => undefined);
      }
    }
  } finally {
    await destroyDatabase(scratch).catch(() => undefined);
  }

  return {
    dir,
    plans,
    finalFingerprint,
    dispose: async (): Promise<void> => {
      await rm(join(dir, ".."), { recursive: true, force: true });
    },
  };
}

/** A hand-written migration: no `.plan.json`, directives and `-- pg-prime:stmt` markers only. */
export async function writeHandMigration(dir: string, filename: string, body: string): Promise<string> {
  const path = join(dir, filename);
  await writeFile(path, body, "utf8");
  return path;
}

export async function fingerprintOf(conn: ConnInfo, schemas: readonly string[] = ["public"]): Promise<string> {
  const result = await withClient(conn, (c) => extractCatalog(c, { schemas }));
  return result.ir.fingerprint;
}

/** `SELECT` one scalar. Used by tests that assert on `pg_catalog` directly (R14). */
export async function scalar(conn: ConnInfo, sql: string, values: unknown[] = []): Promise<unknown> {
  return withClient(conn, async (c) => {
    const r = await c.query(sql, values);
    const row = r.rows[0];
    return row === undefined ? undefined : Object.values(row)[0];
  });
}
