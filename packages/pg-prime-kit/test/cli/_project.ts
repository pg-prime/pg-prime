/**
 * A throwaway project on disk: `pg-prime.config.ts` + `db/schema.ts` + `migrations/`.
 *
 * It lives INSIDE the package rather than in `os.tmpdir()` because `db/schema.ts` does
 * `import { pgTable } from 'pg-prime'`, and Node resolves that by walking `node_modules`
 * up from the importing file — from `/tmp` there is nothing to find, from here the walk
 * reaches `packages/pg-prime-kit/node_modules/pg-prime`, which is the workspace link. That
 * is the resolution a real project gets, and it is the point of going through the binary.
 *
 * The config is a `.ts` file with **no imports**, so loading it exercises Node's own type
 * stripping (design/11 §1.4) without needing `@pg-prime/kit` to be resolvable from a
 * directory that is not a package.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRATCH = resolve(here, "../../.e2e");

export interface Project {
  readonly dir: string;
  readonly config: string;
  readonly migrations: string;
  readonly repeatables: string;
  writeSchema(source: string): Promise<void>;
  writeRepeatable(name: string, sql: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface ProjectOptions {
  readonly url: string;
  readonly schema?: string;
  readonly schemas?: readonly string[];
  /** omit `schema` from the config entirely — the "pure SQL adopter" shape */
  readonly noSchema?: boolean;
}

export async function makeProject(slug: string, options: ProjectOptions): Promise<Project> {
  await mkdir(SCRATCH, { recursive: true });
  const dir = await mkdtemp(join(SCRATCH, `${slug}-`));
  await mkdir(join(dir, "db"), { recursive: true });
  await mkdir(join(dir, "migrations"), { recursive: true });
  await mkdir(join(dir, "sql"), { recursive: true });

  const config = join(dir, "pg-prime.config.ts");
  await writeFile(
    config,
    `export default {
  url: ${JSON.stringify(options.url)},
${options.noSchema === true ? "" : "  schema: './db/schema.ts',\n"}  migrations: './migrations',
  repeatables: './sql',
  schemas: ${JSON.stringify(options.schemas ?? ["public"])},
}
`,
    "utf8",
  );
  if (options.schema !== undefined) await writeFile(join(dir, "db", "schema.ts"), options.schema, "utf8");

  return {
    dir,
    config,
    migrations: join(dir, "migrations"),
    repeatables: join(dir, "sql"),
    writeSchema: (source) => writeFile(join(dir, "db", "schema.ts"), source, "utf8"),
    writeRepeatable: (name, sql) => writeFile(join(dir, "sql", name), sql, "utf8"),
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

/** The schema every CLI golden diffs against: two tables, nothing clever. */
export const BASE_SCHEMA = `import { defineSchema, pgTable } from 'pg-prime'

export const widgets = pgTable('widgets', (t) => ({
  id: t.bigint().generatedAlways().primaryKey(),
  name: t.text().unique(),
}))

export default defineSchema({ widgets })
`;
