/** `migrate verify` replays into the shadow database the config names, as often as it is run. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { envelopeOf, runCli, urlOf } from "../support/cli.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { BASE_SCHEMA, makeProject, type Project } from "./_project.js";

const T = 240_000;
const TARGET = "pgprime_vs_target";
const SHADOW = "pgprime_vs_shadow";

describe("verify with `shadow` set to a database url", () => {
  let p: Project;
  const cli = (...args: readonly string[]) => runCli(["migrate", ...args, "--config", p.config, "--output", "json"]);

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    await makeDatabase(TARGET);
    await makeDatabase(SHADOW);
    p = await makeProject("verify-shadow", {
      url: urlOf(dbConn(TARGET)),
      schema: BASE_SCHEMA,
      shadow: urlOf(dbConn(SHADOW)),
    });
    const g = await cli("generate", "--name", "init");
    expect(g.code, g.stdout + g.stderr).toBe(EXIT.ok);
  }, T);

  afterAll(async () => {
    if (p) await p.dispose().catch(() => undefined);
    await destroyDatabase(TARGET).catch(() => undefined);
    await destroyDatabase(SHADOW).catch(() => undefined);
  }, T);

  it(
    "replays there, twice",
    async () => {
      for (const _ of [1, 2]) {
        const r = await cli("verify");
        expect(r.code, r.stdout + r.stderr).toBe(EXIT.ok);
        expect(envelopeOf(r)).toMatchObject({ status: "verified", ephemeral: { tier: 1, database: SHADOW } });
      }
    },
    T,
  );
});
