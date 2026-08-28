/**
 * `pg-prime db seed` — design/06 §7 lane 3.
 *
 * "`seeds/*.sql` and `seeds/*.ts`, environment-scoped (`db seed --set demo`), re-runnable,
 * expected to be idempotent (`ON CONFLICT DO NOTHING`). Never recorded in
 * `pgprime.migrations`. Refuses on a production-tagged environment without `--force`.
 * `.ts` seeds get the typed query builder, because that is the whole point of having one."
 *
 * Four decisions §7 leaves open, taken here.
 *
 * **1. A set is a subdirectory.** `seeds/*.{sql,ts}` is the base set and runs on every
 * `db seed`; `seeds/<name>/**` runs only when `--set <name>` asks for it. Subdirectories
 * rather than a filename suffix because the walk is then the one `scanRepeatables` already
 * uses — directory-lexicographic, files and directories in ONE sort — so `010_x.sql` runs
 * before `020_y/` in a way an author can see. `--set` is repeatable, and a `--set` naming
 * a directory that does not exist is an **error**: a typo that silently seeded nothing is
 * the worst possible outcome for a command whose whole job is side effects.
 *
 * **2. Nothing is recorded.** No `pgprime.migrations` row, no `pgprime.repeatables` row, no
 * `ensureHistory`. `db seed` never creates the history schema — a seeded dev database that
 * has never been migrated must not acquire one as a side effect, or `migrate baseline`
 * refuses it afterwards.
 *
 * **3. One transaction per FILE.** Not one per run: a run that half-applies is bad, and a
 * run that rolls back nine good seeds because the tenth has a typo is worse, because seeds
 * are re-runnable by construction. The report names the file that failed and the ones that
 * committed before it.
 *
 * **4. The production refusal is `push --dev`'s, verbatim.** Same three conditions
 * (`PG_PRIME_ENV=production`, `production: true` in the config, or `--prod-pattern` against
 * `host:port/database`), same default pattern, evaluated before a single statement is
 * issued. `--force` is a flag and only a flag: nothing about it is written down, so nothing
 * can remember it.
 */

import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { CatalogClient } from "../catalog/extract.js";
import { withClient, type ConnInfo } from "../db/pg.js";
import { splitStatements } from "../sql/statements.js";
import { openSeedDb } from "./db.js";

/** design/06 §6.2 `push --dev`'s default, shared so the two refusals cannot drift. */
export const DEFAULT_PROD_PATTERN = "prod|production|live";

export interface SeedFile {
  /** POSIX and prefixed with the seeds directory's own name, like a repeatable's `path` */
  readonly path: string;
  readonly absPath: string;
  readonly kind: "sql" | "ts";
  /** the set this file belongs to; `null` for the base set */
  readonly set: string | null;
}

export interface AppliedSeed {
  readonly path: string;
  readonly kind: "sql" | "ts";
  readonly set: string | null;
  readonly statements: number;
  readonly durationMs: number;
}

export type SeedStatus = "seeded" | "nothing_to_do" | "refused" | "failed";

export interface SeedResult {
  readonly status: SeedStatus;
  readonly applied: readonly AppliedSeed[];
  readonly skipped: readonly string[];
  readonly sets: readonly string[];
  readonly seedsDir: string;
  readonly error: { readonly code: string; readonly message: string; readonly file?: string } | null;
  readonly durationMs: number;
}

export interface SeedOptions {
  readonly seedsDir: string;
  readonly connection: ConnInfo;
  /** `--set`, repeatable; empty means the base set only */
  readonly sets?: readonly string[];
  readonly force?: boolean;
  /** true when `PG_PRIME_ENV=production` or `production: true` */
  readonly production?: boolean;
  readonly prodPattern?: string;
  /** `config.schema`, needed only when a `.ts` seed asks for `db` */
  readonly schemaPaths?: readonly string[];
  readonly onEvent?: (event: { readonly file: string; readonly state: "start" | "done" }) => void;
}

/* -------------------------------- the scan -------------------------------- */

const isSeedFile = (name: string): "sql" | "ts" | null => {
  const lower = name.toLowerCase();
  if (lower.endsWith(".sql")) return "sql";
  // `.d.ts` is a declaration, never a seed, and `.ts` alone would pick it up.
  if (lower.endsWith(".d.ts")) return null;
  if (lower.endsWith(".ts") || lower.endsWith(".mts")) return "ts";
  if (lower.endsWith(".mjs") || lower.endsWith(".js")) return "ts";
  return null;
};

const isEnoent = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";

async function readdirSorted(absDir: string): Promise<Dirent[] | null> {
  let entries: Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  // Code-unit order, never `localeCompare`: two developers must not seed in two orders.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

async function collect(
  absDir: string,
  rel: string,
  prefix: string,
  set: string | null,
  out: SeedFile[],
): Promise<void> {
  const entries = await readdirSorted(absDir);
  if (entries === null) return;
  for (const e of entries) {
    if (e.isDirectory()) continue; // subdirectories of a set are the set's own business
    const kind = isSeedFile(e.name);
    if (kind === null) continue;
    const abs = join(absDir, e.name);
    if (
      !e.isFile() &&
      !(
        e.isSymbolicLink() &&
        (await stat(abs).then(
          (s) => s.isFile(),
          () => false,
        ))
      )
    )
      continue;
    const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
    out.push({ path: `${prefix}/${childRel}`, absPath: abs, kind, set });
  }
}

/** Every set on disk: each immediate subdirectory of `seeds/` that holds a seed file. */
export async function seedSets(seedsDir: string): Promise<string[]> {
  const entries = await readdirSorted(resolve(seedsDir));
  if (entries === null) return [];
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const inner: SeedFile[] = [];
    await collect(join(resolve(seedsDir), e.name), "", "x", e.name, inner);
    if (inner.length > 0) out.push(e.name);
  }
  return out;
}

/** The base set, then each named set in the order it was asked for. */
export async function scanSeeds(seedsDir: string, sets: readonly string[] = []): Promise<SeedFile[]> {
  const root = resolve(seedsDir);
  const prefix = basename(root);
  const out: SeedFile[] = [];
  await collect(root, "", prefix, null, out);
  for (const set of sets) {
    await collect(join(root, set), set, prefix, set, out);
  }
  return out;
}

/* ------------------------------ the refusals ------------------------------ */

export function productionRefusal(options: SeedOptions): string | null {
  if (options.force === true) return null;
  const target = `${options.connection.host}:${String(options.connection.port)}/${options.connection.database}`;
  if (options.production === true) {
    return (
      `refusing to seed a production-tagged environment (PG_PRIME_ENV=production, or \`production: true\` in ` +
      `pg-prime.config.ts). Seeds are development and test data and are never recorded in the migration ` +
      `history, so nothing would record that they ran. Pass --force if you mean it.`
    );
  }
  const pattern = options.prodPattern ?? DEFAULT_PROD_PATTERN;
  if (pattern !== "" && new RegExp(pattern, "i").test(target)) {
    return (
      `refusing to seed ${target}: it matches --prod-pattern /${pattern}/i. Seeds are development and test ` +
      `data and are never recorded in the migration history. Pass --force if you mean it, or narrow the ` +
      `pattern with --prod-pattern.`
    );
  }
  return null;
}

/* -------------------------------- the run --------------------------------- */

/** What a `.ts` seed's default export receives. */
export interface SeedContext {
  /** a real `pg-prime` `Db` built from the project's own DSL (design/12 decision 12) */
  readonly db: unknown;
  /** the set this file belongs to, or `null` for the base set */
  readonly set: string | null;
  /** `PG_PRIME_ENV`, verbatim; `null` when unset */
  readonly env: string | null;
}

type SeedModule = { default?: unknown };

function pathHref(path: string): string {
  return new URL(`file://${path.startsWith("/") ? "" : "/"}${path.replace(/\\/g, "/")}`).href;
}

export async function runSeeds(options: SeedOptions): Promise<SeedResult> {
  const started = Date.now();
  const seedsDir = resolve(options.seedsDir);
  const sets = [...(options.sets ?? [])];
  const done = (status: SeedStatus, extra: Partial<SeedResult> = {}): SeedResult => ({
    status,
    applied: [],
    skipped: [],
    sets,
    seedsDir,
    error: null,
    durationMs: Date.now() - started,
    ...extra,
  });

  const refusal = productionRefusal(options);
  if (refusal !== null) return done("refused", { error: { code: "production", message: refusal } });

  const available = await seedSets(seedsDir);
  const unknown = sets.filter((s) => !available.includes(s));
  if (unknown.length > 0) {
    return done("refused", {
      error: {
        code: "unknown_set",
        message:
          `--set ${unknown.map((s) => JSON.stringify(s)).join(", ")} names no directory under ${seedsDir} that ` +
          `holds a seed file. ${available.length === 0 ? "There are no sets." : `Sets on disk: ${available.join(", ")}.`} ` +
          `A --set that silently seeded nothing would be the worst possible outcome for this command.`,
      },
    });
  }

  const files = await scanSeeds(seedsDir, sets);
  if (files.length === 0) {
    return done("nothing_to_do", {
      error: null,
      skipped: [],
    });
  }

  const needsDb = files.some((f) => f.kind === "ts");
  const seedDb = needsDb ? await openSeedDb(options.connection, options.schemaPaths ?? []) : null;
  const applied: AppliedSeed[] = [];
  const emit = options.onEvent ?? ((): void => undefined);

  try {
    for (const file of files) {
      emit({ file: file.path, state: "start" });
      const at = Date.now();
      try {
        const statements = await applyOne(file, options, seedDb?.db);
        applied.push({ path: file.path, kind: file.kind, set: file.set, statements, durationMs: Date.now() - at });
        emit({ file: file.path, state: "done" });
      } catch (err) {
        return done("failed", {
          applied,
          skipped: files.slice(files.indexOf(file) + 1).map((f) => f.path),
          error: {
            code: "seed_failed",
            message: `${file.path} failed: ${err instanceof Error ? err.message : String(err)}`,
            file: file.path,
          },
        });
      }
    }
  } finally {
    if (seedDb) await seedDb.close();
  }

  return done("seeded", { applied });
}

/**
 * One file, one transaction.
 *
 * A `.sql` seed is split with the SQL lexer and sent statement by statement inside a
 * `BEGIN`/`COMMIT` on a dedicated connection. A `.ts` seed is imported and its default
 * export is called inside `db.transaction(...)`, so the file's writes are atomic for the
 * same reason and by the same mechanism the user's own code would use.
 */
async function applyOne(file: SeedFile, options: SeedOptions, db: unknown): Promise<number> {
  if (file.kind === "sql") {
    const text = await readFile(file.absPath, "utf8");
    const statements = splitStatements(text);
    if (statements.length === 0) return 0;
    await withClient(options.connection, async (client: CatalogClient) => {
      await client.query("BEGIN");
      try {
        for (const sql of statements) await client.query(sql);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
    });
    return statements.length;
  }

  const mod = (await import(pathHref(file.absPath))) as SeedModule;
  const fn = mod.default;
  if (typeof fn !== "function") {
    throw new Error(
      `a .ts seed must \`export default async ({ db, set, env }) => { … }\` (design/06 §7 lane 3); ` +
        `this module's default export is ${fn === undefined ? "absent" : typeof fn}`,
    );
  }
  const context: SeedContext = { db, set: file.set, env: process.env["PG_PRIME_ENV"] ?? null };
  const handle = db as { transaction?: (f: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
  if (typeof handle.transaction !== "function") {
    throw new Error("the seed `db` has no transaction(); @pg-prime/kit needs a matching major of the pg-prime peer");
  }
  await handle.transaction(async (tx: unknown) => {
    await (fn as (c: SeedContext) => Promise<unknown>)({ ...context, db: tx });
  });
  return 1;
}
