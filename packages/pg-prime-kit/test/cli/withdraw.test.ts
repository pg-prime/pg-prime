/** Deleting the file of a failed migration: allowed when it rolled back whole, drift when a segment committed. */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { envelopeOf, runCli, urlOf } from "../support/cli.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { writeHandMigration } from "../support/migrations.js";
import { makeProject, type Project } from "./_project.js";

const T = 240_000;

const SEED = `-- pg-prime:migration 0001_seed
-- pg-prime:txmode    transactional

-- pg-prime:stmt 0 lock=accessExclusive non-idempotent
CREATE TABLE public.base_t (id int PRIMARY KEY);
`;

const BROKEN = `-- pg-prime:migration 0002_broken
-- pg-prime:txmode    transactional

-- pg-prime:stmt 0 lock=accessExclusive non-idempotent
CREATE TABLE public.rolled_back_t (id int PRIMARY KEY);

-- pg-prime:stmt 1 lock=accessExclusive non-idempotent
CREATE TABLE public.base_t (id int PRIMARY KEY);
`;

const SPLIT = `-- pg-prime:migration 0002_broken
-- pg-prime:txmode    segmented

-- pg-prime:segment 0
-- pg-prime:stmt 0 lock=accessExclusive non-idempotent
CREATE TABLE public.committed_t (id int PRIMARY KEY);

-- pg-prime:segment 1
-- pg-prime:stmt 1 lock=accessExclusive non-idempotent
CREATE TABLE public.base_t (id int PRIMARY KEY);
`;

describe("withdrawing a failed migration by deleting its file", () => {
  const projects: Project[] = [];
  const databases: string[] = [];
  afterAll(async () => {
    for (const p of projects) await p.dispose().catch(() => undefined);
    for (const db of databases) await destroyDatabase(db).catch(() => undefined);
  }, T);

  const failThenDelete = async (slug: string, ...attempts: string[]) => {
    expect(await serverAvailable()).toBe(true);
    const database = `pgprime_withdraw_${slug}`;
    databases.push(database);
    await makeDatabase(database);
    const p = await makeProject(`withdraw-${slug}`, { url: urlOf(dbConn(database)), noSchema: true });
    projects.push(p);
    await writeHandMigration(p.migrations, "0001_seed.sql", SEED);
    const cli = (cmd: string) => runCli(["migrate", cmd, "--config", p.config, "--output", "json"]);
    for (const body of attempts) {
      await writeHandMigration(p.migrations, "0002_broken.sql", body);
      expect((await cli("apply")).code).toBe(EXIT.error);
    }
    await rm(join(p.migrations, "0002_broken.sql"));
    return { status: await cli("status"), apply: await cli("apply"), doctor: await cli("doctor") };
  };

  it(
    "a transactional file that rolled back is withdrawn: status, apply and doctor are clean",
    async () => {
      const { status, apply, doctor } = await failThenDelete("tx", BROKEN);
      expect(status.code, status.stdout).toBe(EXIT.ok);
      expect(apply.code, apply.stdout).toBe(EXIT.ok);
      expect(doctor.code, doctor.stdout).toBe(EXIT.ok);
    },
    T,
  );

  it.each([
    ["seg", [SPLIT]],
    ["mislabeled", [SPLIT.replace("txmode    segmented", "txmode    transactional")]],
    ["retried", [BROKEN, SPLIT]],
    ["rerun", [SPLIT, SPLIT]],
  ])(
    "a failed file with a committed segment stays a missing file (%s)",
    async (slug, attempts) => {
      const { status, apply, doctor } = await failThenDelete(slug, ...attempts);
      expect(status.code, status.stdout).toBe(EXIT.drift);
      expect(envelopeOf(status)["missingFiles"]).toEqual(["0002_broken"]);
      expect(apply.code, apply.stdout).not.toBe(EXIT.ok);
      expect(doctor.code, doctor.stdout).toBe(EXIT.drift);
    },
    T,
  );
});
