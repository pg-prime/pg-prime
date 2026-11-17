/**
 * A sequence's counter is data: dropping it, or dropping and recreating it under a new
 * name, restarts the numbering and hands out keys that already exist. So `DROP SEQUENCE`
 * is DS107, gated like every other destructive change, and a renamed sequence is a rename
 * question rather than a silent drop + create.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renameCandidates } from "../../src/diff/candidates.js";
import { runSqlScript } from "../../src/db/pg.js";
import { generateFromDatabases as generate } from "../../src/generate.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";

const CUR = "pgprime_seq_cur";
const DES = "pgprime_seq_des";
const T = 180_000;

describe("sequences are gated and renameable", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
  }, T);
  afterAll(async () => {
    for (const db of [CUR, DES]) await destroyDatabase(db).catch(() => undefined);
  }, T);

  it(
    "DROP SEQUENCE carries DS107 and needs acknowledging",
    async () => {
      const target = await makeDatabase(CUR);
      await runSqlScript(target, "CREATE SEQUENCE public.counter;");
      const desired = await makeDatabase(DES);
      const base = { admin: ADMIN, target, desired, schemas: ["public"], seq: 1, name: "drop_seq", prove: false };

      const bare = await generate(base);
      expect(bare.plan.statements.map((s) => s.sql)).toEqual(['DROP SEQUENCE IF EXISTS "public"."counter"']);
      expect(bare.plan.hazards.map((h) => [h.code, h.severity, h.subject, h.acknowledged])).toEqual([
        ["DS107", "error", "sequence:public.counter", false],
      ]);

      const signed = await generate({ ...base, acknowledge: { allowDataLoss: true, reason: "retired" } });
      expect(signed.plan.hazards[0]?.acknowledged).toBe(true);
    },
    T,
  );

  it(
    "a renamed sequence is a rename candidate, and a hint makes it an ALTER SEQUENCE … RENAME",
    async () => {
      const target = await makeDatabase(CUR);
      await runSqlScript(target, "CREATE SEQUENCE public.order_id_seq;");
      const desired = await makeDatabase(DES);
      await runSqlScript(desired, "CREATE SEQUENCE public.orders_id_seq;");
      const base = {
        admin: ADMIN,
        target,
        desired,
        schemas: ["public"],
        seq: 1,
        name: "rename_seq",
        dumpOracle: "strict" as const,
      };

      const unhinted = await generate({ ...base, prove: false });
      expect(
        renameCandidates(unhinted.diff, unhinted.desiredIR).map((c) => [c.kind, c.from, c.to, c.confidence]),
      ).toEqual([["sequence", "sequence:public.order_id_seq", "sequence:public.orders_id_seq", "unambiguous"]]);

      const hinted = await generate({
        ...base,
        renameHints: [{ from: "sequence:public.order_id_seq", to: "sequence:public.orders_id_seq" }],
      });
      expect(hinted.plan.statements.map((s) => s.sql)).toEqual([
        'ALTER SEQUENCE "public"."order_id_seq" RENAME TO "orders_id_seq"',
      ]);
      expect(hinted.plan.proof.status).toBe("passed");
    },
    T,
  );
});
