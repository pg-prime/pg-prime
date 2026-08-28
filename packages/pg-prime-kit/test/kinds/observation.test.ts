/**
 * Tiers O and U — the halves of design/06 §2.2's completeness rule that are reported
 * rather than diffed.
 *
 * Two failure modes, both of them silence:
 *   - a Tier-O object that leaks into the fact base. A grant is not schema state we own,
 *     and a fact is hashed into the fingerprint — so one `GRANT SELECT` would read as
 *     drift and refuse every pending migration through `06` §4.3's gate;
 *   - a Tier-U kind that is present and not counted. "Enumerate everything, subtract
 *     Tiers M/R/O, and report the remainder. Silence is never an option."
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCatalog, observationDiagnostics, observedCounts } from "../../src/catalog/extract.js";
import { diffIR } from "../../src/diff/diff.js";
import { runSqlScript, withClient } from "../../src/db/pg.js";
import { encodeId } from "../../src/ir/stable-id.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";

const DB = "pgprime_k3_observe";
const T = 180_000;

let result: Awaited<ReturnType<typeof extractCatalog>>;

describe("Tier O is observed and Tier U is counted", () => {
  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
    const conn = await makeDatabase(DB);
    await runSqlScript(
      conn,
      `CREATE TABLE public.t (id bigint PRIMARY KEY, body text);
       CREATE ROLE pgprime_k3_reader NOLOGIN;
       GRANT SELECT ON public.t TO pgprime_k3_reader;
       ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO pgprime_k3_reader;
       CREATE PUBLICATION pgprime_k3_pub FOR TABLE public.t;
       CREATE COLLATION public.pgprime_k3_coll (locale = 'C');

       -- Tier R: authored as repeatables, expected to be non-empty
       CREATE VIEW public.v AS SELECT id FROM public.t;
       CREATE FUNCTION public.f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;

       -- Tier U: unmodelled, and the whole point is that they are still COUNTED
       CREATE STATISTICS public.t_stats ON id, body FROM public.t;
       CREATE TEXT SEARCH CONFIGURATION public.tsc (COPY = simple);`,
    );
    result = await withClient(conn, (c) => extractCatalog(c, { schemas: ["public"] }));
  }, T);

  afterAll(async () => {
    await destroyDatabase(DB).catch(() => undefined);
    // The role is cluster-scoped, so dropping the database does not take it with it.
    await withClient({ ...ADMIN, database: "postgres" }, async (c) => {
      await c.query("DROP ROLE IF EXISTS pgprime_k3_reader");
    }).catch(() => undefined);
  }, T);

  it("observed objects reach `observed`, and never the fact base", () => {
    const kinds = new Set(result.observed.map((o) => o.kind));
    for (const expected of ["role", "acl", "defaultPrivilege", "publication", "publicationRel", "collation"]) {
      expect([...kinds], `missing Tier-O kind ${expected}`).toContain(expected);
    }
    expect(result.observed.find((o) => o.kind === "acl" && o.name === "public.t")?.detail).toContain(
      "pgprime_k3_reader",
    );

    // The negative half, and the load-bearing one: NONE of this is a fact.
    const factKinds = new Set(result.ir.facts().map((f) => f.id.kind));
    for (const forbidden of ["role", "acl", "publication", "collation"]) {
      expect([...factKinds]).not.toContain(forbidden);
    }
    expect(
      result.ir
        .facts()
        .map((f) => encodeId(f.id))
        .filter((s) => s.includes("pgprime_k3_reader")),
    ).toEqual([]);
  });

  it("observation is reportable as counts, sorted and stable", () => {
    const counts = observedCounts(result.observed);
    expect(counts.map((c) => c.kind)).toEqual(counts.map((c) => c.kind).sort());
    expect(counts.every((c) => c.count > 0)).toBe(true);
    const diags = observationDiagnostics(result.observed);
    expect(diags.every((d) => d.code === "observed_kind" && d.severity === "info")).toBe(true);
    expect(diags.find((d) => d.subject === "publication")?.count).toBeGreaterThanOrEqual(1);
  });

  it("the Tier U census counts what `06` §2.2 lists, and separates it from Tier R", () => {
    const census = new Map(
      result.diagnostics.filter((d) => d.code === "unmodeled_kind").map((d) => [d.subject ?? "?", d] as const),
    );
    expect(census.get("statisticsObject")?.count).toBe(1);
    expect(census.get("textSearchConfig")?.count).toBe(1);
    expect(census.get("view")?.count).toBe(1);
    expect(census.get("function")?.count).toBeGreaterThanOrEqual(1);
    // Tier R says so in the message; Tier U says so too. A CLI that wants to escalate
    // only the Tier-U half must be able to tell them apart without a hard-coded list.
    expect(census.get("view")?.message).toContain("Tier R");
    expect(census.get("statisticsObject")?.message).toContain("Tier U");
    // A kind with nothing in it is not reported at all — a census of zeroes is noise.
    expect(census.has("largeObject")).toBe(false);
  });

  it("--strict-unmodeled turns the Tier-U remainder into an error, and leaves Tier R alone", () => {
    const lax = diffIR(result.ir, result.ir, { diagnostics: result.diagnostics });
    expect(lax.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const strict = diffIR(result.ir, result.ir, {
      strictUnmodeled: true,
      diagnostics: result.diagnostics,
    });
    const escalated = strict.diagnostics.filter((d) => d.code === "unmodeled_kind_strict");
    expect(escalated.every((d) => d.severity === "error")).toBe(true);
    expect(escalated.map((d) => d.subject)).toEqual(expect.arrayContaining(["statisticsObject", "textSearchConfig"]));
    // Tier R is authored on purpose: escalating a view the repo owns would make
    // `--strict-unmodeled` unusable in any project that has one.
    expect(escalated.map((d) => d.subject)).not.toContain("view");
    expect(escalated.map((d) => d.subject)).not.toContain("function");
  });
});
