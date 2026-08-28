/**
 * The shadow ladder against a real server (design/06 §3.2, design/11 §3 K2a item 3).
 *
 * The load-bearing case is **tier 3**: the test creates a role `WITH NOCREATEDB`, connects as that
 * role, and runs the whole `provisionShadow` → `loadDesired` → dispose path through it. That is
 * the managed-PostgreSQL shape (Supabase, Neon, RDS restricted roles) and the tier Prisma lacks;
 * a tier-3 test run as a superuser proves nothing, because a superuser could have taken tier 2.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { loadDesired } from "../../src/schema/load.js";
import {
  OfflineShadowError,
  parseShadowUrl,
  provisionShadow,
  ShadowNameTooLongError,
} from "../../src/shadow/ladder.js";
import { connectionString, withClient, type ConnInfo } from "../../src/db/pg.js";
import { encodeId } from "../../src/ir/stable-id.js";
import { ADMIN, dbConn, destroyDatabase, makeDatabase, serverAvailable, withAdmin } from "../support/db.js";
import { schema as corpus, SCHEMAS } from "../schema-emit/fixture.js";

const T = 120_000;

/** Everything this suite creates is prefixed so a crashed run is greppable and reclaimable. */
const PREFIX = "pgprime_k2_";
const TARGET = `${PREFIX}target`;
const URL_SHADOW = `${PREFIX}url_shadow`;
const ROLE = `${PREFIX}nocreatedb`;
const ROLE_PASSWORD = "pgprime_k2_pw";

let target: ConnInfo;

beforeAll(async () => {
  // The kit has no tier that runs without a server (design/08 §4.4): a missing one is a failure,
  // not a skip, exactly as every other suite in this package treats it.
  expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
  target = await makeDatabase(TARGET);
  await makeDatabase(URL_SHADOW);
  await withAdmin(async (admin) => {
    await admin.query(`DROP ROLE IF EXISTS ${q(ROLE)}`);
    // NOCREATEDB is the whole point: this role cannot reach tier 2, so `auto` must land on tier 3.
    await admin.query(`CREATE ROLE ${q(ROLE)} WITH LOGIN NOCREATEDB NOSUPERUSER PASSWORD '${ROLE_PASSWORD}'`);
    await admin.query(`GRANT CREATE, CONNECT ON DATABASE ${q(TARGET)} TO ${q(ROLE)}`);
  });
  // The restricted role needs to own what it creates inside the target.
  await withClient(target, async (c) => {
    await c.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${q(ROLE)}`);
  });
}, T);

afterAll(async () => {
  await destroyDatabase(TARGET);
  await destroyDatabase(URL_SHADOW);
  await withAdmin(async (admin) => {
    await admin.query(`DROP ROLE IF EXISTS ${q(ROLE)}`).catch(() => undefined);
  });
}, T);

const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** Schemas of a database, filtered to ours. */
async function shadowSchemas(conn: ConnInfo): Promise<string[]> {
  return withClient(conn, async (c) => {
    const r = await c.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'pgprime_shadow_%' ORDER BY nspname");
    return r.rows.map((row) => String(row["nspname"]));
  });
}

async function databases(): Promise<string[]> {
  return withAdmin(async (admin) => {
    const r = await admin.query(
      "SELECT datname FROM pg_database WHERE datname LIKE 'pgprime_shadow_%' ORDER BY datname",
    );
    return r.rows.map((row) => String(row["datname"]));
  });
}

describe("tier selection", () => {
  it(
    "auto picks tier 2 when the admin role has CREATEDB, and dispose drops the database",
    async () => {
      const shadow = await provisionShadow(ADMIN, target, { schemas: SCHEMAS });
      try {
        expect(shadow.tier).toBe(2);
        expect(shadow.reason).toContain("CREATEDB");
        expect(shadow.conn.database).toMatch(/^pgprime_shadow_[0-9a-f]{8}$/);
        // identity map: nothing to rename when we own a whole database
        expect([...shadow.schemaMap]).toEqual([
          ["audit", "audit"],
          ["public", "public"],
        ]);
        expect(await databases()).toContain(shadow.conn.database);
      } finally {
        await shadow.dispose();
      }
      expect(await databases()).not.toContain(shadow.conn.database);
    },
    T,
  );

  it(
    "tier 2 copies the target's encoding and collation",
    async () => {
      const shadow = await provisionShadow(ADMIN, target, { schemas: SCHEMAS, shadow: "createdb" });
      try {
        const [want, got] = await Promise.all([localeOf(target.database), localeOf(shadow.conn.database)]);
        expect(got).toEqual(want);
      } finally {
        await shadow.dispose();
      }
    },
    T,
  );

  it(
    "an explicit url is tier 1, and its managed schemas are reset",
    async () => {
      const url = connectionString(dbConn(URL_SHADOW));
      // seed something the reset has to remove
      await withClient(dbConn(URL_SHADOW), async (c) => {
        await c.query("CREATE TABLE IF NOT EXISTS public.leftover (id int)");
      });
      const shadow = await provisionShadow(ADMIN, target, { schemas: SCHEMAS, shadow: { url } });
      try {
        expect(shadow.tier).toBe(1);
        expect(shadow.conn.database).toBe(URL_SHADOW);
        expect(shadow.diagnostics.map((d) => d.code)).toContain("shadow_url_reset");
        const left = await withClient(shadow.conn, async (c) => c.query("SELECT to_regclass('public.leftover') AS t"));
        expect(left.rows[0]?.["t"]).toBeNull();
      } finally {
        await shadow.dispose();
      }
    },
    T,
  );

  it("refuses tier 4 with a typed error naming the alternatives", async () => {
    await expect(provisionShadow(ADMIN, ADMIN, { schemas: ["public"], shadow: "offline" })).rejects.toBeInstanceOf(
      OfflineShadowError,
    );
  });

  it("parses a shadow url and refuses one that names no database", () => {
    expect(parseShadowUrl("postgres://u:p%40x@h:6543/db")).toEqual({
      host: "h",
      port: 6543,
      user: "u",
      password: "p@x",
      database: "db",
    });
    expect(() => parseShadowUrl("postgres://u@h:5432/")).toThrow(/names no database/);
  });

  it(
    "falls back to a positional shadow name when the readable one would not fit",
    async () => {
      const long = "s".repeat(63);
      const shadow = await provisionShadow(ADMIN, target, {
        schemas: [long, "public"],
        shadow: "temp-schema",
        token: "deadbeef",
      });
      try {
        // Readable where it fits, positional where PostgreSQL would truncate — never truncated,
        // because a truncated name is a map that cannot be reversed.
        expect(shadow.schemaMap.get("public")).toBe("pgprime_shadow_deadbeef_public");
        // `schemas` is sorted before it is mapped, so "public" is index 0 and the long one is 1.
        expect(shadow.schemaMap.get(long)).toBe("pgprime_shadow_deadbeef_s1");
      } finally {
        await shadow.dispose();
      }
    },
    T,
  );

  it("refuses outright when even the positional name would be truncated", async () => {
    await expect(
      provisionShadow(ADMIN, ADMIN, {
        schemas: ["s".repeat(63)],
        shadow: "temp-schema",
        token: "t".repeat(60),
      }),
    ).rejects.toBeInstanceOf(ShadowNameTooLongError);
  });
});

describe("tier 3 — a role WITHOUT CREATEDB (design/06 §3.2's managed-PostgreSQL tier)", () => {
  /** The target database, connected as the restricted role rather than as postgres. */
  const asRole = (): ConnInfo => ({ ...target, user: ROLE, password: ROLE_PASSWORD });

  it(
    "the role really cannot CREATE DATABASE",
    async () => {
      const client = new pg.Client({ ...asRole() });
      await client.connect();
      try {
        const r = await client.query("SELECT rolcreatedb, rolsuper FROM pg_roles WHERE rolname = current_user");
        expect(r.rows[0]).toEqual({ rolcreatedb: false, rolsuper: false });
        await expect(client.query(`CREATE DATABASE ${q(`${PREFIX}nope`)}`)).rejects.toThrow(
          /permission denied to create database/i,
        );
      } finally {
        await client.end();
      }
    },
    T,
  );

  it(
    "auto demotes to tier 3, loads the whole corpus, and reverses the map on the IR",
    async () => {
      const conn = asRole();
      const shadow = await provisionShadow(conn, conn, { schemas: SCHEMAS, token: "cafe1234" });
      let disposed = false;
      try {
        expect(shadow.tier).toBe(3);
        expect(shadow.reason).toContain("no CREATEDB");
        expect(shadow.conn.database).toBe(TARGET);
        expect([...shadow.schemaMap]).toEqual([
          ["audit", "pgprime_shadow_cafe1234_audit"],
          ["public", "pgprime_shadow_cafe1234_public"],
        ]);
        expect(await shadowSchemas(conn)).toEqual(["pgprime_shadow_cafe1234_audit", "pgprime_shadow_cafe1234_public"]);

        const desired = await loadDesired(corpus, shadow);

        // Every fact is back in the CALLER's schema names…
        // (`extension` facts — `plpgsql` is in every database — are keyed `[name]` and carry no schema)
        const schemas = new Set(desired.ir.facts().flatMap((f) => ("schema" in f.id ? [f.id.schema] : [])));
        expect([...schemas].sort()).toEqual(["audit", "public"]);
        expect(desired.ir.has({ kind: "table", schema: "public", name: "orgs" })).toBe(true);
        expect(desired.ir.has({ kind: "table", schema: "audit", name: "events" })).toBe(true);
        expect(desired.ir.has({ kind: "type", schema: "public", name: "member_role" })).toBe(true);

        // …including the payload TEXT the server produced, which is what is hashed.
        const encoded = JSON.stringify(desired.ir.toCheckpoint(0));
        expect(encoded).not.toContain("pgprime_shadow_");

        // the cross-schema FK edge points at the user's `public.orgs`
        const fk = desired.ir
          .factsOfKind("constraint")
          .find((f) => "schema" in f.id && f.id.schema === "audit" && f.payload["contype"] === "f");
        expect(fk).toBeDefined();
        const targets = desired.ir
          .outgoingEdges(fk!.id)
          .filter((e) => e.kind === "depends")
          .map((e) => encodeId(e.to));
        expect(targets).toContain("table:public.orgs");
      } finally {
        await shadow.dispose();
        disposed = true;
      }
      expect(disposed).toBe(true);
      // dispose asserts this itself; asserted again from the outside, per design/11 §3 K2a.
      expect(await shadowSchemas(asRole())).toEqual([]);
      // and the user's own `public` was never touched
      const left = await withClient(target, async (c) =>
        c.query(
          "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'",
        ),
      );
      expect(left.rows[0]?.["n"]).toBe(0);
    },
    T,
  );

  it(
    "the IR from tier 3 and the IR from tier 2 have the same fingerprint",
    async () => {
      const roleConn = asRole();
      const three = await provisionShadow(roleConn, roleConn, {
        schemas: SCHEMAS,
        shadow: "temp-schema",
        token: "beef0001",
      });
      const two = await provisionShadow(ADMIN, target, { schemas: SCHEMAS, shadow: "createdb" });
      try {
        // Sequential: two concurrent loads would leave one client open if the other threw, and the
        // afterAll drop then reports as an unhandled `Connection terminated unexpectedly`.
        const a = await loadDesired(corpus, three);
        const b = await loadDesired(corpus, two);
        // THE property the schema map exists to preserve: normalizing in a renamed schema produces
        // the same desired state as normalizing in a database of its own.
        expect(a.ir.fingerprint).toBe(b.ir.fingerprint);
      } finally {
        await three.dispose();
        await two.dispose();
      }
    },
    T,
  );
});

async function localeOf(database: string): Promise<Record<string, unknown>> {
  return withAdmin(async (admin) => {
    const r = await admin.query(
      `SELECT pg_encoding_to_char(encoding) AS encoding, datcollate, datctype, datlocprovider
         FROM pg_database WHERE datname = $1`,
      [database],
    );
    return r.rows[0] ?? {};
  });
}
