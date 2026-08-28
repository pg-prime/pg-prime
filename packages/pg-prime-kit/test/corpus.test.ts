/**
 * The fixture corpus, swept end to end.
 *
 * This replaces the `@supabase/pg-delta` differential oracle (00-overview sign-off item 7).
 * That oracle existed to give a second, independent opinion on plans our own IR declared
 * converged. D10's pg_dump witness gives a strictly stronger one - PostgreSQL's own
 * serializer models the entire DDL surface, where pg-delta modelled its own subset - and
 * costs no dependency, so the corpus sweep is kept and the dependency is not.
 *
 * What every fixture must satisfy:
 *   1. no error-severity diagnostics
 *   2. the plan applies to a shadow clone and re-extracts to zero drift (D6)
 *   3. the migrated clone and the desired database dump IDENTICALLY (D10, strict)
 */

import { describe, expect, it } from "vitest";
import { generateFromDatabases as generate } from "../src/generate.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "./support/db.js";

const T = 180_000;

interface Case {
  readonly name: string;
  readonly slug: string;
  /** null = start from an empty database */
  readonly current: string | null;
  /** null = converge to an empty database */
  readonly desired: string | null;
  readonly schemas?: readonly string[];
  /** tables whose column order cannot be repaired by any plan (see D10 / 3.9) */
  readonly reordered?: readonly string[];
}

const CORPUS: readonly Case[] = [
  { name: "acceptance", slug: "acc", current: null, desired: "acceptance/desired.sql" },
  {
    name: "evolve",
    slug: "evo",
    current: "evolve/current.sql",
    desired: "evolve/desired.sql",
    // `full_name` is declared 4th; ADD COLUMN can only append it.
    reordered: ["public.customers"],
  },
  {
    name: "enum-ordering",
    slug: "enum",
    current: "enum-ordering/current.sql",
    desired: "enum-ordering/desired.sql",
  },
  {
    name: "multi-schema/up",
    slug: "msu",
    current: null,
    desired: "multi-schema/desired.sql",
    schemas: ["public", "app", "billing"],
  },
  // `serial`: CREATE SEQUENCE must not consume the column its own table produces.
  { name: "serial", slug: "ser", current: null, desired: "serial/desired.sql" },
  // `$` is a legal identifier character AND a String.replace replacement pattern
  { name: "dollar-names", slug: "dol", current: null, desired: "dollar-names/desired.sql" },
  // the §1.3 enum bug with a quoted type name, where the `evaluates` edge used to be lost
  {
    name: "enum-quoted",
    slug: "enq",
    current: "enum-quoted/current.sql",
    desired: "enum-quoted/desired.sql",
  },
  // dropping a UNIQUE that a FOREIGN KEY on another table binds to
  {
    name: "uniqueness",
    slug: "uni",
    current: "uniqueness/current.sql",
    desired: "uniqueness/desired.sql",
  },
  // ---- K3: one pair per Tier-M kind (design/11 §2 R16) ----
  // PG 18's `contype = 'n'` validity, and the §3.5 lock-safe SET NOT NULL on both sides
  // of the catalog gate.
  {
    name: "not-null-validity",
    slug: "nnv",
    current: "not-null-validity/current.sql",
    desired: "not-null-validity/desired.sql",
  },
  // `ChooseConstraintName`'s uniquifying suffix: without it the 15-17 rewrite collides.
  {
    name: "name-collision",
    slug: "nco",
    current: "name-collision/current.sql",
    desired: "name-collision/desired.sql",
  },
  { name: "exclude", slug: "exc", current: "exclude/current.sql", desired: "exclude/desired.sql" },
  { name: "domain", slug: "dom", current: "domain/current.sql", desired: "domain/desired.sql" },
  {
    name: "composite",
    slug: "cmp",
    current: "composite/current.sql",
    desired: "composite/desired.sql",
  },
  {
    name: "comment",
    slug: "cmt",
    current: "comment/current.sql",
    desired: "comment/desired.sql",
    schemas: ["public", "docs"],
  },
  {
    name: "extension",
    slug: "ext",
    current: "extension/current.sql",
    desired: "extension/desired.sql",
  },
  {
    name: "partitioned",
    slug: "par",
    current: "partitioned/current.sql",
    desired: "partitioned/desired.sql",
  },
  {
    name: "column-default",
    slug: "cdf",
    current: "column-default/current.sql",
    desired: "column-default/desired.sql",
    // `fresh` is appended by ADD COLUMN, which is the only place it can go.
    reordered: [],
  },
  // `pg_index.indisclustered` — found by the third-party corpus, and pinned here in both
  // directions so `CLUSTER ON` and `SET WITHOUT CLUSTER` are each a fixture.
  { name: "cluster/on", slug: "clu", current: "cluster/current.sql", desired: "cluster/desired.sql" },
  { name: "cluster/off", slug: "cluf", current: "cluster/desired.sql", desired: "cluster/current.sql" },
  {
    name: "multi-schema/down",
    slug: "msd",
    current: "multi-schema/desired.sql",
    desired: null,
    schemas: ["public", "app", "billing"],
  },
];

describe("fixture corpus: every plan converges, and PostgreSQL agrees", () => {
  for (const c of CORPUS) {
    it(
      c.name,
      async () => {
        expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);

        const current = `pgprime_corpus_${c.slug}_cur`;
        const desired = `pgprime_corpus_${c.slug}_des`;
        await makeDatabase(current, c.current ?? undefined);
        await makeDatabase(desired, c.desired ?? undefined);

        try {
          const result = await generate({
            admin: ADMIN,
            target: { ...ADMIN, database: current },
            desired: { ...ADMIN, database: desired },
            schemas: c.schemas ?? ["public"],
            seq: 1,
            name: c.slug,
            dumpOracle: "strict",
          });

          expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

          const proof = result.plan.proof;
          expect(proof.driftDeltas, `residual drift: ${JSON.stringify(proof.deltas)}`).toBe(0);

          const oracle = proof.dumpOracle;
          expect(
            oracle?.status,
            `pg_dump witness: ${JSON.stringify({ reason: oracle?.reason, missing: oracle?.missing, extra: oracle?.extra }, null, 2)}`,
          ).toBe("passed");
          expect(oracle?.reordered ?? []).toEqual(c.reordered ?? []);

          expect(proof.status).toBe("passed");
        } finally {
          await destroyDatabase(current).catch(() => undefined);
          await destroyDatabase(desired).catch(() => undefined);
        }
      },
      T,
    );
  }
});
