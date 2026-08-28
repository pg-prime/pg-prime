/**
 * The one runtime use of the `pg-prime` peer in the whole kit — design/12 decision 12.
 *
 * `11` §1.3's rule is that `packages/pg-prime-kit/src` imports `pg-prime` for **types
 * only**, enforced by a grep in `test/schema-emit/no-value-import.test.ts`. A `.ts` seed
 * gets "the typed query builder, because that is the whole point of having one" (design/06
 * §7 lane 3), and there is no way to hand it one without constructing a `Db`. Decision 12
 * allows exactly one exception, and this file is it:
 *
 *  - it is **dynamic**, so `@pg-prime/kit` still loads with no peer installed and every
 *    other command still works;
 *  - it is on the **`db seed` path only** — nothing else in the kit calls it;
 *  - it resolves from the **project**, so the seed gets the user's own copy of the DSL and
 *    not a second one with different `Symbol.for` slots;
 *  - the grep guard is amended to allow this file and no other.
 *
 * `pgPrime({ driver, schema })` is today's constructor shape and this file is the only
 * place that knows it. Another workstream is extending `pgPrime` to accept
 * `connection: string`; when it lands, {@link openSeedDb} is the one function that changes.
 */

import pg from "pg";
import { ConfigError } from "../config/load.js";
import { connectionString, type ConnInfo } from "../db/pg.js";

/**
 * The peer's runtime surface as this file uses it, declared structurally.
 *
 * Structural rather than a type import, because the whole point of the dynamic form is
 * that this file works against whatever copy of the DSL the *project* resolves — a
 * compile-time binding to the workspace's own would defeat it.
 */
interface PgPrimeModule {
  readonly pgPrime: (opts: { driver: unknown; schema: unknown }) => unknown;
  readonly pgDriver: (config: { pool: unknown }) => unknown;
  readonly defineSchema: (tables: Record<string, unknown>) => unknown;
}

export interface SeedDb {
  /** the value handed to a `.ts` seed as `db` */
  readonly db: unknown;
  readonly close: () => Promise<void>;
}

const hasHandles = (v: unknown): v is { tables: Record<string, unknown>; h: Record<string, unknown> } => {
  if (typeof v !== "object" || v === null) return false;
  const r = v as { tables?: unknown; h?: unknown };
  return typeof r.tables === "object" && r.tables !== null && typeof r.h === "object" && r.h !== null;
};

const isTableLike = (v: unknown): boolean => {
  const runtime = (v as { $?: unknown } | null)?.$;
  if (typeof runtime !== "object" || runtime === null) return false;
  const r = runtime as { name?: unknown; columns?: unknown; extras?: unknown };
  return typeof r.name === "string" && Array.isArray(r.columns) && Array.isArray(r.extras);
};

/**
 * The registry a `Db` needs, from the modules `config.schema` names.
 *
 * `defineSchema(...)`'s own result is preferred whenever a module exports one, because it
 * carries the relations and `pgPrime` reads `h` off it. A module that exports bare
 * `pgTable(...)` values instead is wrapped with the user's own `defineSchema` — keyed by
 * the **export name**, which is the name a seed will write (`db.users`), and not by the
 * `schema.table` key `loadSchema` uses for the emitter.
 */
export function registryFrom(modules: readonly Record<string, unknown>[], mod: PgPrimeModule): unknown {
  for (const m of modules) {
    const candidates = [m["default"], ...Object.values(m)];
    for (const value of candidates) if (hasHandles(value)) return value;
  }
  const tables: Record<string, unknown> = {};
  for (const m of modules) {
    for (const [key, value] of Object.entries(m)) {
      if (key === "default") continue;
      if (isTableLike(value)) tables[key] = value;
    }
  }
  if (Object.keys(tables).length === 0) {
    throw new ConfigError(
      "a .ts seed asks for `db`, and `db` needs your schema: point `schema` in pg-prime.config.ts at a " +
        "module that exports `defineSchema({ … })` (or one or more `pgTable(...)` values). A .sql seed " +
        "needs no schema.",
    );
  }
  return mod.defineSchema(tables);
}

/**
 * Build the `Db` a `.ts` seed receives.
 *
 * The pool is `max: 1`: seeds run one file at a time, each in its own transaction, and a
 * seed that opened five connections would make "each seed file is one transaction" a claim
 * about the first connection only.
 */
export async function openSeedDb(conn: ConnInfo, schemaPaths: readonly string[]): Promise<SeedDb> {
  let mod: PgPrimeModule;
  try {
    // design/12 decision 12 — the ONE dynamic value import of the peer in the kit. Written
    // as a literal specifier on purpose: `test/schema-emit/no-value-import.test.ts` greps
    // for exactly this form and budgets it to this file, and a variable specifier would
    // make the guard blind rather than satisfied.
    mod = (await import("pg-prime")) as unknown as PgPrimeModule;
  } catch (err) {
    throw new ConfigError(
      `a .ts seed asks for \`db\`, which needs the \`pg-prime\` runtime, and it could not be imported from ` +
        `this project: ${err instanceof Error ? err.message : String(err)}. \`pg-prime\` is a peer dependency of ` +
        `@pg-prime/kit — install it, or write the seed as .sql.`,
    );
  }
  if (typeof mod.pgPrime !== "function" || typeof mod.pgDriver !== "function") {
    throw new ConfigError(
      "the resolved `pg-prime` does not export pgPrime/pgDriver; @pg-prime/kit needs a matching major of the peer.",
    );
  }

  const modules: Record<string, unknown>[] = [];
  for (const path of schemaPaths) {
    modules.push((await import(pathHref(path))) as Record<string, unknown>);
  }
  const schema = registryFrom(modules, mod);

  const pool = new pg.Pool({ ...conn, max: 1 });
  const driver = mod.pgDriver({ pool });
  const db = mod.pgPrime({ driver, schema });
  return {
    db,
    close: async (): Promise<void> => {
      await pool.end().catch(() => undefined);
    },
  };
}

/** `file://` for the dynamic import; a bare Windows path is not a valid specifier. */
function pathHref(path: string): string {
  return new URL(`file://${path.startsWith("/") ? "" : "/"}${path.replace(/\\/g, "/")}`).href;
}

/** For the report: what the seed connected to, without the password. */
export function describeConnection(conn: ConnInfo): string {
  return connectionString({ ...conn, password: "" }).replace("//:@", "//");
}
