/**
 * R1 for the emitter: **PostgreSQL is the oracle.**
 *
 *   DSL ──emitSchema──► SQL ──► database A ──extractCatalog──► IR
 *                                                               │
 *                                        diff/ddl.ts (the CATALOG-side renderer)
 *                                                               ▼
 *                                                          database B
 *
 * and then `pg_dump` A and `pg_dump` B must agree (design/06 §3.9, D10 `strict`). The two
 * renderers are independent — `schema/emit.ts` reads `ColumnDdl`/`TableExtra`, `diff/ddl.ts` reads
 * the extracted payloads — so agreement between their outputs *through PostgreSQL* is a real
 * statement about both, not a tautology.
 *
 * The fixture is deliberately maximal (`fixture.ts`): every column builder, every DDL-affecting
 * modifier, every extra, a second schema, a cross-schema FK, a self FK, a two-table FK cycle, an
 * enum shared by tables in two schemas, a composite PK, a unique index and comments.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCatalog, type ExtractResult } from "../../src/catalog/extract.js";
import { buildStatements } from "../../src/diff/ddl.js";
import { diffIR } from "../../src/diff/diff.js";
import { orderStatements } from "../../src/diff/order.js";
import { SchemaIR } from "../../src/ir/fact.js";
import { encodeId } from "../../src/ir/stable-id.js";
import type { PlanStatement } from "../../src/plan/plan.js";
import { compareDumps, dumpSchema, resolvePgDump } from "../../src/prove/pg-dump.js";
import { applySegments } from "../../src/runner/apply.js";
import { withClient, type ConnInfo } from "../../src/db/pg.js";
import { emitSchema } from "../../src/schema/emit.js";
import { loadDesired } from "../../src/schema/load.js";
import { provisionShadow, type Shadow } from "../../src/shadow/ladder.js";
import { ADMIN, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { schema as corpus, SCHEMAS } from "./fixture.js";

const T = 180_000;
const A = "pgprime_k2_rt_a";
const B = "pgprime_k2_rt_b";

let dbA: ConnInfo;
let dbB: ConnInfo;
let irA: ExtractResult;

/** A shadow bound to an existing database, so the round-trip owns its own two databases. */
function shadowOf(conn: ConnInfo): Shadow {
  return {
    conn,
    target: conn,
    schemaMap: new Map(SCHEMAS.map((s) => [s, s])),
    tier: 2,
    reason: "test fixture",
    diagnostics: [],
    // oxlint-disable-next-line typescript/require-await -- implements the async dispose seam
    dispose: async () => undefined,
  };
}

beforeAll(async () => {
  expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
  dbA = await makeDatabase(A);
  dbB = await makeDatabase(B);

  // ── leg 1: the DSL, through the emitter, into A
  irA = await loadDesired(corpus, shadowOf(dbA));

  // ── leg 2: A's extracted IR, through the CATALOG-side renderer, into B
  const build = buildStatements(diffIR(SchemaIR.build([], []), irA.ir), irA.ir);
  expect(build.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const ordered = orderStatements(build.statements);
  const statements: PlanStatement[] = ordered.statements.map((s, index) => ({
    ...s,
    index,
    timeouts: { lock: null, statement: null },
  }));
  const report = await withClient(dbB, (client) => applySegments(client, statements, ordered.segments));
  expect(report.error === undefined ? "" : `${report.error.message} — ${report.error.sql}`).toBe("");
  expect(report.status).toBe("applied");
}, T);

afterAll(async () => {
  await destroyDatabase(A);
  await destroyDatabase(B);
}, T);

describe("emit → load → extract → re-emit → load (R1)", () => {
  it("the emitted DDL loads with no error diagnostics", () => {
    expect(irA.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(emitSchema(corpus).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it(
    "converges in ONE step: the IR of B is the IR of A, fingerprint included",
    async () => {
      const irB = await withClient(dbB, (c) => extractCatalog(c, { schemas: [...SCHEMAS] }));
      expect(irB.ir.facts().length).toBe(irA.ir.facts().length);
      expect(diffIR(irB.ir, irA.ir).deltas.map((d) => `${d.op} ${encodeId(d.op === "rename" ? d.to : d.id)}`)).toEqual(
        [],
      );
      expect(irB.ir.fingerprint).toBe(irA.ir.fingerprint);
    },
    T,
  );

  it("every declared object is in the IR, in the right schema", () => {
    const has = (kind: "table" | "type", schema: string, name: string): boolean => irA.ir.has({ kind, schema, name });
    expect(has("table", "public", "orgs")).toBe(true);
    expect(has("table", "public", "users")).toBe(true);
    expect(has("table", "public", "memberships")).toBe(true);
    expect(has("table", "public", "nodes")).toBe(true);
    expect(has("table", "audit", "events")).toBe(true);
    expect(has("type", "public", "member_role")).toBe(true);
    expect(has("type", "audit", "event_kind")).toBe(true);
  });

  it("names its constraints exactly as PostgreSQL would have", () => {
    const names = irA.ir
      .factsOfKind("constraint")
      .map((f) => `${(f.id as { schema: string; name: string }).schema}.${(f.id as { name: string }).name}`)
      .sort();
    expect(names).toEqual(
      [
        "audit.events_org_id_fkey",
        "audit.events_pkey",
        // design/14 G: two EXCLUDE constraints, both named — PostgreSQL's own default is
        // `<table>_<first column>_excl`, which collides on the second one.
        "public.bookings_deferred_span",
        "public.bookings_no_overlap",
        "public.bookings_pkey",
        "public.memberships_org_id_fkey",
        "public.memberships_pkey",
        "public.memberships_seat_key",
        "public.memberships_seat_positive",
        "public.memberships_user_id_fkey",
        "public.nodes_parent_id_fkey",
        "public.nodes_path_not_empty",
        "public.nodes_pkey",
        "public.orgs_owner_id_fkey",
        "public.orgs_pkey",
        "public.orgs_seats_check",
        "public.orgs_slug_key",
        // design/12 K4: `primaryKey({ name })` is the one constraint whose name is NOT the
        // server's default — an adopted database names its primary keys whatever created
        // them, and `pull` has to be able to say so.
        "public.PK_Tickets",
        "public.tickets_org_id_fkey",
        "public.users_email_key",
        "public.users_pkey",
        "public.users_primary_org_id_fkey",
      ].sort(),
    );
  });

  it(
    "carries the modifiers PostgreSQL can only have learned from the emitted DDL",
    async () => {
      const rows = await withClient(dbA, async (c) => {
        const r = await c.query(`
        SELECT con.conname, pg_get_constraintdef(con.oid) AS def
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = rel.relnamespace
         WHERE n.nspname IN ('public','audit') ORDER BY con.conname`);
        return new Map(r.rows.map((row) => [String(row["conname"]), String(row["def"])]));
      });
      // .unique(name, { nullsNotDistinct }) and the unique() extra
      expect(rows.get("orgs_slug_key")).toBe("UNIQUE NULLS NOT DISTINCT (slug)");
      expect(rows.get("memberships_seat_key")).toBe("UNIQUE NULLS NOT DISTINCT (org_id, seat_no)");
      // .references() actions and deferral
      expect(rows.get("users_primary_org_id_fkey")).toBe(
        "FOREIGN KEY (primary_org_id) REFERENCES orgs(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED",
      );
      expect(rows.get("orgs_owner_id_fkey")).toBe(
        "FOREIGN KEY (owner_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL",
      );
      expect(rows.get("nodes_parent_id_fkey")).toBe(
        "FOREIGN KEY (parent_id) REFERENCES nodes(id) ON DELETE CASCADE DEFERRABLE",
      );
      // a cross-schema FK is qualified by the server too
      expect(rows.get("events_org_id_fkey")).toBe("FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE");
      // .check() on a column and check() in the extras
      expect(rows.get("orgs_seats_check")).toBe("CHECK ((seats > 0))");
      expect(rows.get("memberships_seat_positive")).toBe("CHECK (((seat_no IS NULL) OR (seat_no > 0)))");
      // composite PK, in declaration order
      expect(rows.get("memberships_pkey")).toBe("PRIMARY KEY (org_id, user_id)");
    },
    T,
  );

  it(
    "carries identity, defaults and comments",
    async () => {
      const cols = await withClient(dbA, async (c) => {
        const r = await c.query(`
        SELECT a.attname, a.attidentity, format_type(a.atttypid, a.atttypmod) AS type,
               pg_get_expr(d.adbin, d.adrelid) AS def
          FROM pg_attribute a
          JOIN pg_class rel ON rel.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = rel.relnamespace
          LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE n.nspname = 'public' AND rel.relname = 'users' AND a.attnum > 0`);
        return new Map(r.rows.map((row) => [String(row["attname"]), row]));
      });
      expect(cols.get("seq")?.["attidentity"]).toBe("a");
      expect(cols.get("counter")?.["attidentity"]).toBe("d");
      expect(cols.get("role")?.["type"]).toBe("member_role");
      expect(cols.get("roles")?.["type"]).toBe("member_role[]");
      expect(cols.get("role")?.["def"]).toBe("'member'::member_role");
      expect(cols.get("roles")?.["def"]).toBe("ARRAY[]::member_role[]");
      // `$default` / `$onUpdate` are TS-only: no DEFAULT reaches the catalog ($ law, design/05 D4)
      expect(cols.get("nickname")?.["def"]).toBeNull();

      const comments = await withClient(dbA, async (c) => {
        const r = await c.query(`
        SELECT obj_description('public.orgs'::regclass, 'pg_class') AS org_table,
               obj_description('audit.events'::regclass, 'pg_class') AS event_table,
               col_description('public.users'::regclass, (
                 SELECT attnum FROM pg_attribute
                  WHERE attrelid = 'public.users'::regclass AND attname = 'email')) AS email_col`);
        return r.rows[0] ?? {};
      });
      expect(comments["org_table"]).toBe("One row per tenant.");
      expect(comments["event_table"]).toBe("Append-only audit log.");
      expect(comments["email_col"]).toBe("login address");
    },
    T,
  );
});

describe("the D10 pg_dump witness (strict)", () => {
  it(
    "dumps A and B identically — comments included, now that `comment` is a fact kind",
    async () => {
      const pgDump = await resolvePgDump();
      // The kit has no non-server tier; a missing pg_dump is an environment the suite refuses to
      // pass silently in, because silence is what the witness exists to remove.
      expect("unavailable" in pgDump ? pgDump.unavailable : "", "no usable pg_dump").toBe("");
      if ("unavailable" in pgDump) return;

      const [dumpA, dumpB] = await Promise.all([
        dumpSchema({ pgDump, conn: ADMIN, database: A, schemas: [...SCHEMAS] }),
        dumpSchema({ pgDump, conn: ADMIN, database: B, schemas: [...SCHEMAS] }),
      ]);
      const cmp = compareDumps(dumpB, dumpA);

      // Nothing may be in B that is not in A: the catalog-side renderer must not invent anything.
      expect(cmp.extra).toEqual([]);
      /**
       * R16, as it stood when K2a landed: `comment` was not a fact kind, so this assertion allowed
       * exactly the five `COMMENT ON` statements to be missing and nothing else. design/11 K3 made
       * `comment` a fact (extractor + `ddl.ts`), so the witness now demands byte-equality: the five
       * comments the emitter wrote into A come back out of the extracted IR into B.
       */
      expect(cmp.missing).toEqual([]);
      expect(cmp.statementCount).toBeGreaterThan(30);
    },
    T,
  );
});

describe("the same corpus through the tier-3 schema map", () => {
  it(
    "produces the identical desired IR",
    async () => {
      const shadow = await provisionShadow(ADMIN, dbA, {
        schemas: SCHEMAS,
        shadow: "temp-schema",
        token: "a1b2c3d4",
      });
      try {
        const mapped = await loadDesired(corpus, shadow);
        // design/12 K4 put a `t.raw('public.money_amount')` column and a
        // `nextval('public.tickets_no_seq')` default in the fixture, and both are TEXT the
        // schema map has to reach: without `remapTypeQualifier` / `remapNextval` this
        // fingerprint diverges — the first by a type that does not exist in the shadow, the
        // second by a silently missing `column → sequence` dependency edge.
        expect(mapped.ir.fingerprint).toBe(irA.ir.fingerprint);
      } finally {
        await shadow.dispose();
      }
    },
    T,
  );
});
