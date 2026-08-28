/**
 * `--dry-run` promises "the exact statement stream, including transaction framing"
 * (design/06 §6.2). This is the test that the promise is true.
 *
 * The dry run and the real run share one code path — the dry run swaps in a client that
 * records instead of executing — so the stream is correct by construction rather than by
 * a second implementation that has to be kept in step. What that construction cannot
 * prove on its own is that the seam is in the right place, i.e. that nothing the real run
 * issues while applying a file is skipped by the capture client. So the real run is
 * recorded through a forwarding proxy and the two streams are compared query for query,
 * bind for bind.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CatalogClient } from "../../src/catalog/extract.js";
import { withClient } from "../../src/db/pg.js";
import { applyPendingOn, type IssuedQuery } from "../../src/runner/run.js";
import { CREATE_WIDGETS, INDEX_WIDGETS } from "../cli/_fixture.js";
import { dbConn, destroyDatabase, makeDatabase, serverAvailable } from "../support/db.js";
import { tempDir, writeHandMigration } from "../support/migrations.js";

const T = 120_000;
const DATABASE = "pgprime_k1_dryrun";

class Recorder implements CatalogClient {
  readonly issued: IssuedQuery[] = [];
  constructor(private readonly inner: CatalogClient) {}
  async query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.issued.push(values === undefined ? { text } : { text, values });
    return this.inner.query(text, values);
  }
}

describe("--dry-run is the stream that runs", () => {
  let dir = "";

  beforeAll(async () => {
    expect(await serverAvailable()).toBe(true);
    dir = join(await tempDir("pgprime-k1-dryrun"), "migrations");
    await mkdir(dir, { recursive: true });
    await writeHandMigration(dir, "0001_create_widgets.sql", CREATE_WIDGETS);
    await writeHandMigration(dir, "0002_index_widgets.sql", INDEX_WIDGETS);
    await makeDatabase(DATABASE);
  }, T);

  afterAll(async () => {
    await destroyDatabase(DATABASE).catch(() => undefined);
  });

  it(
    "the printed stream equals the executed one, query for query and bind for bind",
    async () => {
      const conn = dbConn(DATABASE);
      const options = {
        appliedFrom: "dry-run-test",
        // The strict pooler probe opens a second connection and its own transactions;
        // that is startup, not the migration, and it would add BEGIN/COMMIT pairs to the
        // recording that the dry run has no reason to contain.
        // oxlint-disable-next-line typescript/require-await -- implements the async poolerProbe seam
        poolerProbe: async (): Promise<boolean> => false,
      } as const;

      const planned = await withClient(conn, (c) => applyPendingOn(c, dir, { ...options, dryRun: true }));
      expect(planned.status).toBe("dry_run");
      expect(planned.dryRun).not.toBeNull();

      let from = -1;
      let to = -1;
      const executed = await withClient(conn, async (client) => {
        const recorder = new Recorder(client);
        const result = await applyPendingOn(recorder, dir, {
          ...options,
          onEvent: (e) => {
            if (e.kind !== "migration") return;
            if (e.state === "start" && from === -1) from = recorder.issued.length;
            if (e.state === "done") to = recorder.issued.length;
          },
        });
        expect(result.error, JSON.stringify(result.error)).toBeNull();
        expect(result.status).toBe("applied");
        return recorder.issued.slice(from, to);
      });

      expect(executed).toStrictEqual(planned.dryRun);
    },
    T,
  );
});
