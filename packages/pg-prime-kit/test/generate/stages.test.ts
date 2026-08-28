/**
 * `splitStages` and the managed schema set — the two seams between a multi-file plan and
 * the runner that has to apply it.
 *
 * Both are pure enough to test without a server except the last one, which is the point of
 * design/11 K1's open item (a): the set scopes the diff, the fingerprint AND the advisory
 * lock key, so a runner pointed at a different one has to say so in those words rather than
 * report a hash mismatch.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineSchema, pgTable } from "pg-prime";
import { PHASE, type Statement } from "../../src/diff/statement.js";
import { splitStages } from "../../src/diff/order.js";
import { withClient } from "../../src/db/pg.js";
import { generate } from "../../src/generate.js";
import { applyPending } from "../../src/runner/run.js";
import type { SchemaLike } from "../../src/schema/types.js";
import { ADMIN, dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { tempDir } from "../support/migrations.js";

const T = 180_000;

const stmt = (o: Partial<Statement> & { sql: string }): Statement => ({
  verb: "create",
  kind: "test",
  produces: [],
  consumes: [],
  destroys: [],
  releases: [],
  transactionality: "transactional",
  lockClass: "accessExclusive",
  idempotent: false,
  dataLoss: "none",
  rewrite: false,
  hazards: [],
  phase: PHASE.createTable,
  ...o,
});

describe("splitStages", () => {
  it("leaves a plan with no staged statement exactly as `orderStatements` had it", () => {
    const result = splitStages([stmt({ sql: "a" }), stmt({ sql: "b" })]);
    expect(result.declined).toBeNull();
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.stage).toBe("main");
    expect(result.files[0]!.segments).toEqual([{ index: 0, transactional: true, statements: [0, 1] }]);
  });

  it("cuts the ordered stream into the transactional file and the concurrent one", () => {
    const result = splitStages([
      stmt({ sql: "cic", stage: "concurrent", transactionality: "nonTransactional", phase: PHASE.createIndex }),
      stmt({ sql: "create table", produces: ["table:x"] }),
      stmt({ sql: "add column", consumes: ["table:x"], phase: PHASE.addColumn }),
    ]);
    expect(result.declined).toBeNull();
    expect(result.files.map((f) => [f.stage, f.statements.map((s) => s.sql)])).toEqual([
      ["main", ["create table", "add column"]],
      ["concurrent", ["cic"]],
    ]);
    // Each file's segments describe THAT file, and the bare one is bare.
    expect(result.files[0]!.segments).toEqual([{ index: 0, transactional: true, statements: [0, 1] }]);
    expect(result.files[1]!.segments).toEqual([{ index: 0, transactional: false, statements: [0] }]);
  });

  it("DECLINES the split when a transactional statement has to follow a concurrent one", () => {
    // `NNNN_x.sql` always applies before `NNNN_x_concurrently.sql`, so this order cannot be
    // expressed by two files at all. The caller re-builds with `multiFile` off.
    const result = splitStages([
      stmt({ sql: "cuic", stage: "concurrent", transactionality: "nonTransactional", produces: ["index:i"] }),
      stmt({ sql: "add constraint using index", consumes: ["index:i"] }),
    ]);
    expect(result.files).toEqual([]);
    expect(result.declined).toContain("add constraint using index");
    expect(result.declined).toContain("applies first");
  });
});

describe("the managed schema set travels in the plan (design/11 K1 open item a)", () => {
  it(
    "apply refuses a set the migration was not generated for, and names both",
    async () => {
      expect(await serverAvailable()).toBe(true);
      const database = "pgprime_k2b_schemaset";
      await makeDatabase(database);
      const dir = join(await tempDir("pgprime-k2b-schemaset"), "migrations");
      await mkdir(dir, { recursive: true });
      try {
        await withClient(dbConn(database), async (client) => {
          await client.query("CREATE SCHEMA app");
        });
        const schema = defineSchema({
          widgets: pgTable("widgets", (t) => ({
            id: t.bigint().generatedAlways().primaryKey(),
          })),
        }) as unknown as SchemaLike;
        const generated = await generate({
          admin: ADMIN,
          target: dbConn(database),
          schema,
          schemas: ["public"],
          seq: 1,
          name: "one_schema",
          outDir: dir,
        });
        expect(generated.status).toBe("generated");
        expect(generated.files[0]!.plan!.schemas).toEqual(["public"]);

        const wrong = await applyPending(dbConn(database), dir, { schemas: ["public", "app"] });
        expect(wrong.status).toBe("drift");
        const message = wrong.error?.message ?? "";
        expect(message).toContain("[public]");
        expect(message).toContain("[app, public]");
        expect(message).toContain("advisory lock key");

        const right = await applyPending(dbConn(database), dir, { schemas: ["public"] });
        expect(right.status, right.error?.message).toBe("applied");
      } finally {
        await destroyDatabase(database).catch(() => undefined);
      }
    },
    T,
  );
});
