/** design/20 §5.5 through the binary: verify, doctor and check on the declared lane. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { withClient } from "../../src/db/pg.js";
import { canCreateRoles, withRole } from "../schema-emit/rls-fixture.js";
import { envelopeOf, runCli, urlOf } from "../support/cli.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { makeProject, type Project } from "./_project.js";

const T = 240_000;
const LOGIN = "pgprime_r2_login";

const ok = (await serverAvailable()) && (await canCreateRoles());
if (!ok) console.warn("verify-declared: skipped, the test role cannot CREATE ROLE");

const schema = (
  predicate: string,
): string => `import { definePolicy, defineSchema, pgTable, rls, sql, updatedAtTrigger } from 'pg-prime'

export const notes = pgTable(
  'notes',
  (t) => ({ id: t.integer().primaryKey(), author: t.text(), updatedAt: t.timestamptz() }),
  (t) => [rls.enable(), updatedAtTrigger(t.updatedAt)],
)

export const notesAuthor = definePolicy('author', {
  on: notes,
  using: (t) => sql\`${predicate}\`,
})

export default defineSchema({ notes })
`;

describe.skipIf(!ok)("verify, doctor and check on the declared lane", () => {
  const database = "pgprime_r2_cli";
  let p: Project;
  const cli = (...args: readonly string[]) => runCli(["migrate", ...args, "--config", p.config, "--output", "json"]);
  const sql = (text: string) => withClient(dbConn(database), (c) => c.query(text));
  const findings = async (): Promise<string[]> => {
    const r = await cli("doctor");
    return (envelopeOf(r)["findings"] as string[]).map((f) => f.slice(0, f.indexOf(":")));
  };

  beforeAll(async () => {
    await makeDatabase(database);
    p = await makeProject("r2-declared", {
      url: urlOf(dbConn(database)),
      schema: schema("${t.author} = current_user"),
    });
    const g = await cli("generate", "--name", "init", "--no-prove");
    expect(g.code, g.stdout + g.stderr).toBe(EXIT.ok);
    const a = await cli("apply");
    expect(a.code, a.stdout + a.stderr).toBe(EXIT.ok);
  }, T);

  afterAll(async () => {
    if (p) await p.dispose().catch(() => undefined);
    await destroyDatabase(database).catch(() => undefined);
  }, T);

  it(
    "verify replays the lane and finds every marker",
    async () => {
      const r = await cli("verify");
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.ok);
      expect(envelopeOf(r)).toMatchObject({ status: "verified", census: [], warnings: [] });
    },
    T,
  );

  it(
    "doctor names a dropped policy, an unmarked one and an unforced table whose owner logs in",
    async () => {
      expect(await findings()).toEqual([]);

      await sql("DROP POLICY author ON notes");
      expect(await findings()).toEqual(["declared_missing"]);
      expect((await cli("apply")).code).toBe(EXIT.ok);

      await sql("COMMENT ON POLICY author ON notes IS NULL");
      expect(await findings()).toEqual(["declared_unmarked"]);
      expect((await cli("apply")).code).toBe(EXIT.ok);
      expect(await findings()).toEqual([]);

      await withRole(LOGIN, "LOGIN", async () => {
        await sql(`ALTER TABLE notes OWNER TO ${LOGIN}`);
        try {
          const r = await cli("doctor");
          expect(r.code).toBe(EXIT.drift);
          expect((envelopeOf(r)["findings"] as string[]).join("\n")).toContain("rls_not_forced: public.notes");
        } finally {
          await sql("ALTER TABLE notes OWNER TO CURRENT_USER");
        }
      });
    },
    T,
  );

  it(
    "check exits 3 on a stale lane and on a hand file that creates a declared policy",
    async () => {
      expect((await cli("check")).code).toBe(EXIT.ok);

      await p.writeSchema(schema("${t.author} = session_user"));
      const stale = await cli("check");
      expect(stale.code, stale.stdout).toBe(EXIT.lint);
      expect((envelopeOf(stale)["hazards"] as { code: string }[]).map((h) => h.code)).toEqual(["declared_lane_stale"]);
      await p.writeSchema(schema("${t.author} = current_user"));

      await p.writeRepeatable("045_dup.sql", "CREATE POLICY author ON notes USING (true);\n");
      const conflict = await cli("check");
      expect(conflict.code, conflict.stdout).toBe(EXIT.lint);
      expect((envelopeOf(conflict)["hazards"] as { code: string }[]).map((h) => h.code)).toEqual(["declared_conflict"]);

      const refused = await cli("generate", "--name", "dup", "--no-prove");
      expect(refused.code).toBe(EXIT.missingHints);
      expect(envelopeOf(refused)["status"]).toBe("lane_refused");
    },
    T,
  );
});
