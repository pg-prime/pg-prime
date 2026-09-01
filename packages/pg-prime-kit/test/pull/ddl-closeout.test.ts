/**
 * `pull` over the object kinds design/14 G added to the DSL, and the `NOCREATEDB` leg that
 * design/12 K4's residue list asked for.
 *
 * Two properties, and they are the same two `roundtrip.test.ts` asks of the third-party corpora
 * — the difference is the input. The four corpora are real databases and none of them happens
 * to contain an `EXCLUDE`, a generated column, an expression index or a commented type, so the
 * residue they measure could not have shrunk visibly when those spellings arrived. This fixture
 * is one table that contains all of them.
 *
 *  1. **round-trip**: `pull` → the emitted TypeScript → `migrate generate` against the SAME
 *     database is `up_to_date`. Anything weaker (comparing text, comparing counts) can pass
 *     while the schema is wrong.
 *  2. **residue**: the `-- pull: unsupported` block is EMPTY. Before this round it would have
 *     carried four lines — the exclusion, the generated column, the expression index and the
 *     `WITH (fillfactor)` — and the assertion is exact, so a regression is a failure rather
 *     than a longer list nobody reads.
 *
 * The `NOCREATEDB` leg runs the whole thing again as a role that cannot `CREATE DATABASE`, so
 * `generate` has to reach tier 3 (temp schemas in the target). That is the managed-PostgreSQL
 * shape — Supabase, Neon, an RDS application role — and a tier-3 claim made by a superuser
 * proves nothing, which is the argument `test/shadow/ladder.test.ts` already makes for the
 * ladder itself.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { runSqlScript, withClient, type ConnInfo } from "../../src/db/pg.js";
import { envelopeOf, runCli, urlOf } from "../support/cli.js";
import { ADMIN, dbConn, destroyDatabase, makeDatabase, serverAvailable, withAdmin } from "../support/db.js";
import { makeProject, type Project } from "../cli/_project.js";

const T = 300_000;
const DATABASE = "pgprime_g14_pull";
const ROLE = "pgprime_g14_restricted";
const ROLE_PASSWORD = "pgprime_g14";

const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/**
 * Every kind design/14 G taught the DSL, written as PostgreSQL itself would.
 *
 * `tstzrange` + `&&` needs no extension, so the fixture exercises the EXCLUDE path rather than
 * the extension path; `'room-' || room` and `upper_inf(during)` are both IMMUTABLE, which a
 * generation expression has to be.
 */
const FIXTURE = `
CREATE TYPE public.booking_kind AS ENUM ('standard', 'premium');
COMMENT ON TYPE public.booking_kind IS 'How the room was booked.';

CREATE DOMAIN public.money_amount AS numeric(12,2) DEFAULT 0
  CONSTRAINT money_amount_non_negative CHECK (VALUE >= (0)::numeric);
COMMENT ON DOMAIN public.money_amount IS 'Money, to the cent, never negative.';

CREATE TABLE public.bookings (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room       integer NOT NULL,
  during     tstzrange NOT NULL,
  cancelled  boolean NOT NULL DEFAULT false,
  price      public.money_amount,
  kind       public.booking_kind NOT NULL,
  room_label text NOT NULL GENERATED ALWAYS AS ('room-'::text || room) STORED,
  open_ended boolean GENERATED ALWAYS AS (upper_inf(during)) STORED,
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (during WITH &&) WHERE (NOT cancelled),
  CONSTRAINT bookings_deferred_span EXCLUDE USING gist (during WITH &&) DEFERRABLE INITIALLY DEFERRED
);
COMMENT ON TABLE public.bookings IS 'One booking per room per span.';

CREATE INDEX bookings_room_label_lower_idx ON public.bookings (lower(room_label)) WITH (fillfactor = 70);
CREATE INDEX bookings_room_desc_idx ON public.bookings (room DESC NULLS LAST);
CREATE UNIQUE INDEX bookings_doubled_room_idx ON public.bookings ((room * 2)) WHERE cancelled;
`;

/** `pull` → generate, through the real binary, and the residue it reports. */
async function pullAndGenerate(project: Project): Promise<{
  ts: string;
  unsupported: { kind: string; name: string; reason: string }[];
  generate: Record<string, unknown>;
}> {
  const pulled = await runCli(["pull", "--config", project.config, "--output", "json"]);
  expect(pulled.code, pulled.stdout + pulled.stderr).toBe(EXIT.ok);
  const envelope = envelopeOf(pulled);
  expect(envelope["status"]).toBe("written");

  const generated = await runCli([
    "migrate",
    "generate",
    "--config",
    project.config,
    "--name",
    "g14",
    "--dump-oracle",
    "strict",
    "--dry-run",
    "--output",
    "json",
  ]);
  return {
    ts: await readFile(join(project.dir, "db", "schema.ts"), "utf8"),
    unsupported: envelope["unsupported"] as { kind: string; name: string; reason: string }[],
    generate: envelopeOf(generated),
  };
}

describe("pull over design/14 G's object kinds", () => {
  let project: Project;

  beforeAll(async () => {
    expect(await serverAvailable(), `no PostgreSQL at ${ADMIN.host}:${ADMIN.port}`).toBe(true);
    await makeDatabase(DATABASE);
    await runSqlScript(dbConn(DATABASE), FIXTURE);
    project = await makeProject("g14-pull", { url: urlOf(dbConn(DATABASE)), noSchema: false });
  }, T);

  afterAll(async () => {
    await project?.dispose().catch(() => undefined);
    await destroyDatabase(DATABASE).catch(() => undefined);
  }, T);

  it(
    "emits every new spelling, with an EMPTY residue, and generate is up to date",
    async () => {
      const { ts, unsupported, generate } = await pullAndGenerate(project);

      expect(unsupported, JSON.stringify(unsupported, null, 2)).toEqual([]);
      expect(ts).not.toContain("-- pull: unsupported");

      // the four spellings that did not exist before this round
      expect(ts).toContain('exclude("bookings_no_overlap").using("gist").where(sql.unsafeRaw("(NOT cancelled)"))');
      expect(ts).toContain('exclude("bookings_deferred_span").using("gist").initiallyDeferred()');
      expect(ts).toContain(`.generatedAlwaysAs(sql.unsafeRaw("('room-'::text || room)"))`);
      expect(ts).toContain('.nullable().generatedAlwaysAs(sql.unsafeRaw("upper_inf(during)"))');
      expect(ts).toContain('.with({ "fillfactor": "70" })');
      expect(ts).toContain('comment: "How the room was booked."');
      expect(ts).toContain('comment: "Money, to the cent, never negative."');
      // an expression index key goes back out as the text PostgreSQL printed
      expect(ts).toContain('index("bookings_room_label_lower_idx")');
      expect(ts).toContain('.on(sql.unsafeRaw("lower(room_label)"))');

      expect(generate["status"], JSON.stringify(generate["files"] ?? generate["error"], null, 2)).toBe("up_to_date");
      expect(generate["files"]).toEqual([]);
    },
    T,
  );

  it(
    "a second pull over the result is byte-identical",
    async () => {
      const first = await readFile(join(project.dir, "db", "schema.ts"), "utf8");
      const again = await runCli(["pull", "--config", project.config, "--output", "json"]);
      expect(again.code, again.stdout + again.stderr).toBe(EXIT.ok);
      expect(await readFile(join(project.dir, "db", "schema.ts"), "utf8")).toBe(first);
    },
    T,
  );
});

/**
 * design/12 K4's residue: the same loop run by a role that cannot `CREATE DATABASE`.
 *
 * `NOCREATEDB` is the whole point — the ladder must land on tier 3 (temp schemas inside the
 * target) and the pulled schema must still round-trip through it. A tier-3 run as a superuser
 * proves nothing, because a superuser could have taken tier 2.
 */
describe("pull and generate as a NOCREATEDB role (design/12 K4 residue)", () => {
  const database = `${DATABASE}_nocreatedb`;
  let project: Project;
  let restricted: ConnInfo;

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    await makeDatabase(database);
    await runSqlScript(dbConn(database), FIXTURE);
    await withAdmin(async (admin) => {
      await admin.query(`DROP ROLE IF EXISTS ${q(ROLE)}`);
      await admin.query(`CREATE ROLE ${q(ROLE)} WITH LOGIN NOCREATEDB NOSUPERUSER PASSWORD '${ROLE_PASSWORD}'`);
      await admin.query(`GRANT CREATE, CONNECT ON DATABASE ${q(database)} TO ${q(ROLE)}`);
    });
    // The restricted role has to own the temp schemas it creates, and be able to read the
    // objects it is pulling.
    await withClient(dbConn(database), async (c) => {
      await c.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${q(ROLE)}`);
      await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${q(ROLE)}`);
    });
    restricted = { ...dbConn(database), user: ROLE, password: ROLE_PASSWORD };
    project = await makeProject("g14-nocreatedb", { url: urlOf(restricted), noSchema: false });
  }, T);

  afterAll(async () => {
    await project?.dispose().catch(() => undefined);
    await destroyDatabase(database).catch(() => undefined);
    await withAdmin(async (admin) => {
      await admin.query(`DROP ROLE IF EXISTS ${q(ROLE)}`).catch(() => undefined);
    });
  }, T);

  it(
    "lands on tier 3, emits the same schema, and generate reports an empty diff",
    async () => {
      const { ts, unsupported, generate } = await pullAndGenerate(project);

      expect(unsupported, JSON.stringify(unsupported, null, 2)).toEqual([]);
      expect(ts).toContain('exclude("bookings_no_overlap")');
      expect(ts).toContain(".generatedAlwaysAs(sql.unsafeRaw(");

      // the load-bearing assertion: the ladder could NOT take tier 2
      const shadow = generate["shadow"] as { tier: number; reason: string } | undefined;
      expect(shadow?.tier, JSON.stringify(generate, null, 2)).toBe(3);
      expect(shadow?.reason).toMatch(/CREATEDB|createdb/);

      expect(generate["status"], JSON.stringify(generate["files"] ?? generate["error"], null, 2)).toBe("up_to_date");
      expect(generate["files"]).toEqual([]);

      // …and the shadow left nothing behind in the user's own database
      const leftovers = await withClient(restricted, async (c) => {
        const r = await c.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'pgprime_shadow_%'");
        return r.rows.map((row) => String(row["nspname"]));
      });
      expect(leftovers).toEqual([]);
    },
    T,
  );
});
