/**
 * A hand-written migrations directory, on purpose.
 *
 * The CLI goldens describe the *envelope*, and a generated fixture would put the differ's
 * statement count and the server's fingerprint into every one of them — so a K3 change to
 * `ddl.ts`, or running the suite on PostgreSQL 18 instead of 17, would rewrite goldens
 * that have nothing to do with either. Hand-written files make every structural number in
 * the envelope a constant, and the generated path is covered by `test/runner/apply.test.ts`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "../support/migrations.js";

export const CREATE_WIDGETS = `-- pg-prime:migration 0001_create_widgets
-- pg-prime:txmode    transactional
-- pg-prime:timeout   lock=3s statement=30s

-- pg-prime:stmt 0 lock=accessExclusive non-idempotent
CREATE TABLE public.widgets (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL);

-- pg-prime:stmt 1 lock=accessExclusive non-idempotent
ALTER TABLE public.widgets ADD CONSTRAINT widgets_name_key UNIQUE (name);
`;

export const INDEX_WIDGETS = `-- pg-prime:migration 0002_index_widgets
-- pg-prime:txmode    none
-- pg-prime:timeout   lock=3s statement=0

-- pg-prime:stmt 0 lock=shareUpdateExclusive idempotent hazards=LK101
DROP INDEX CONCURRENTLY IF EXISTS public.widgets_name_idx;

-- pg-prime:stmt 1 lock=shareUpdateExclusive idempotent hazards=LK101
CREATE INDEX CONCURRENTLY widgets_name_idx ON public.widgets USING btree (name);
`;

export interface CliFixture {
  readonly dir: string;
}

export async function migrationsFixture(slug: string): Promise<CliFixture> {
  const dir = join(await tempDir(`pgprime-k1-cli-${slug}`), "migrations");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "0001_create_widgets.sql"), CREATE_WIDGETS, "utf8");
  await writeFile(join(dir, "0002_index_widgets.sql"), INDEX_WIDGETS, "utf8");
  return { dir };
}

/** An empty directory, for the "no migrations at all" goldens. */
export async function emptyMigrations(slug: string): Promise<CliFixture> {
  const dir = join(await tempDir(`pgprime-k1-cli-${slug}`), "migrations");
  await mkdir(dir, { recursive: true });
  return { dir };
}
