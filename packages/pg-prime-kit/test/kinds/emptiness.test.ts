/**
 * The MF family's emptiness probe — design/06 §3.4: "Emptiness is established by a
 * `SELECT EXISTS(SELECT 1 FROM t LIMIT 1)` probe against the target when one is
 * reachable; offline, MF rules stay at `error` and must be acknowledged."
 *
 * Both directions are load-bearing and both are bugs if wrong. Reporting MF104 on an
 * empty table is the noise that trains people to pass `--allow-data-loss` reflexively;
 * NOT reporting it because nobody asked the question is `06` §1.2's pg-delta finding —
 * `ADD COLUMN … NOT NULL` planned with `dataLoss: "none"` and failing at apply.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCatalog, probeEmptiness } from "../../src/catalog/extract.js";
import { buildStatements } from "../../src/diff/ddl.js";
import { diffIR } from "../../src/diff/diff.js";
import { runSqlScript, withClient } from "../../src/db/pg.js";
import { encodeId } from "../../src/ir/stable-id.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";

const CUR = "pgprime_k3_empty_cur";
const DES = "pgprime_k3_empty_des";
const T = 180_000;

const EMPTY = encodeId({ kind: "table", schema: "public", name: "fresh" });
const POPULATED = encodeId({ kind: "table", schema: "public", name: "busy" });

describe("MF rules are gated on a probe, not on optimism", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
    const cur = await makeDatabase(CUR);
    await runSqlScript(
      cur,
      `CREATE TABLE public.fresh (id bigint PRIMARY KEY, a integer, b text);
       CREATE TABLE public.busy  (id bigint PRIMARY KEY, a integer, b text);
       INSERT INTO public.busy (id) VALUES (1);`,
    );
    const des = await makeDatabase(DES);
    await runSqlScript(
      des,
      `CREATE TABLE public.fresh (id bigint PRIMARY KEY, a integer NOT NULL, b text,
                                  CONSTRAINT fresh_a_key UNIQUE (a));
       CREATE TABLE public.busy  (id bigint PRIMARY KEY, a integer NOT NULL, b text,
                                  CONSTRAINT busy_a_key UNIQUE (a));`,
    );
  }, T);

  afterAll(async () => {
    for (const db of [CUR, DES]) await destroyDatabase(db).catch(() => undefined);
  }, T);

  it(
    "probeEmptiness answers per table, and says nothing about one it cannot read",
    async () => {
      const empty = await withClient({ ...ADMIN, database: CUR }, (c) =>
        probeEmptiness(c, [
          { kind: "table", schema: "public", name: "fresh" },
          { kind: "table", schema: "public", name: "busy" },
          // A table that is not there is a table we cannot prove empty — the answer is
          // "unknown", spelled as absence, not an exception and not `true`.
          { kind: "table", schema: "public", name: "gone" },
        ]),
      );
      expect([...empty].sort()).toEqual([EMPTY]);
    },
    T,
  );

  it(
    "MF101/MF103/MF104 fire on the populated table and not on the empty one",
    async () => {
      const cur = { ...ADMIN, database: CUR };
      const current = await withClient(cur, (c) => extractCatalog(c, { schemas: ["public"] }));
      const desired = await withClient({ ...ADMIN, database: DES }, (c) =>
        extractCatalog(c, { schemas: ["public"] }),
      );
      const diff = diffIR(current.ir, desired.ir);
      const emptyTables = await withClient(cur, (c) =>
        probeEmptiness(c, current.ir.factsOfKind("table").map((f) => f.id)),
      );

      const codesFor = (table: string, opts: Parameters<typeof buildStatements>[2]): string[] => [
        ...new Set(
          buildStatements(diff, desired.ir, opts)
            .statements.filter((s) => s.sql.includes(`"${table}"`))
            .flatMap((s) => s.hazards)
            .filter((h) => h.startsWith("MF")),
        ),
      ].sort();

      // With the probe: the populated table keeps its MF hazards, the empty one loses them.
      expect(codesFor("busy", { emptyTables })).toEqual(["MF101", "MF104"]);
      expect(codesFor("fresh", { emptyTables })).toEqual([]);

      // Offline — no probe — BOTH keep them. That is the documented behaviour and the
      // safe direction: silence about a table nobody looked at is not evidence.
      expect(codesFor("fresh", {})).toEqual(["MF101", "MF104"]);

      // LK104 is NOT suppressed by emptiness: an empty table still takes ACCESS
      // EXCLUSIVE, and being empty makes the statement succeed, not free.
      const lk = buildStatements(diff, desired.ir, { emptyTables })
        .statements.filter((s) => s.sql.includes('"fresh"'))
        .flatMap((s) => s.hazards);
      expect(lk).toContain("LK104");
    },
    T,
  );
});
