/**
 * The shadow ladder, tiers 1–3 (design/06 §3.2, design/11 §3 K2a item 3).
 *
 * The desired state is never diffed as text: it is loaded into a real PostgreSQL and read back
 * out, so that "human form" and "catalog form" are the same form by construction. The whole point
 * of the ladder is that **it never requires `CREATEDB`** — Prisma's single most-reported migration
 * failure, and the reason tier 3 exists.
 *
 * | tier | mechanism | selected when |
 * |---|---|---|
 * | 1 | a shadow database URL the caller supplies | `shadow: { url }`, or the same URL as a string |
 * | 2 | `CREATE DATABASE pgprime_shadow_<rand>` with the target's locale | the admin role has `rolcreatedb` |
 * | 3 | `CREATE SCHEMA pgprime_shadow_<rand>_<name>` **inside the target database** | everything else |
 * | 4 | `--offline` | a typed refusal in this round (design/11 §3 K2a) |
 *
 * Tier 3 works by renaming schema identifiers at emit time and reversing the map on the way back
 * (design/11 §1.6) — never by rewriting `search_path`, because the emitted DDL is always
 * schema-qualified and a GUC cannot disambiguate a cross-schema FK.
 */

import { randomBytes } from "node:crypto";
import pg from "pg";
import type { Diagnostic } from "../catalog/extract.js";
import { dropDatabase, isObjectInUse, withClient, withDatabase, SHADOW_PREFIX, type ConnInfo } from "../db/pg.js";
import { quoteIdent } from "../sql/ident.js";

/** `NAMEDATALEN - 1`: a shadow schema name that PostgreSQL would truncate is not reversible. */
const MAX_IDENT_BYTES = 63;

/**
 * Tier 1 has **two** spellings and they mean the same thing.
 *
 * `{ url }` is the structural one design/06 §3.2 writes; a bare `postgres://…` string is what
 * anybody actually types into `pg-prime.config.ts` after typing `--shadow postgres://…` on the
 * command line. Both are accepted here rather than in one caller, because the third possibility —
 * a string that is neither a keyword nor a URL — must be a refusal and not a silent fall-through
 * to the `auto` ladder (design/12 F2 item f). The template-literal members keep the keywords
 * completing in an editor while still accepting a URL a config file holds as a plain string.
 */
export type ShadowStrategy =
  | "auto"
  | "temp-schema"
  | "createdb"
  | "offline"
  | `postgres://${string}`
  | `postgresql://${string}`
  | { readonly url: string };

export interface ProvisionShadowOptions {
  /** Default `'auto'`. */
  readonly shadow?: ShadowStrategy;
  /** The schemas the desired state declares, in the user's own names. */
  readonly schemas: readonly string[];
  /**
   * The random token in the shadow's name. Supplied only by tests, which need the name to be
   * predictable; production always mints one, because two concurrent `generate` runs on one
   * cluster must not collide.
   */
  readonly token?: string;
}

export interface Shadow {
  /** Where the desired DDL is loaded and where `extractCatalog` is pointed. */
  readonly conn: ConnInfo;
  /**
   * The database whose state is being diffed against. `loadDesired` reads the comments of the
   * managed schemas that already exist here and mirrors them onto the shadow, so that a schema
   * the DSL never *declares* (`public`, created by initdb with `'standard public schema'`) does
   * not turn into a phantom `COMMENT ON SCHEMA` delta: tier 2 would otherwise carry a fresh
   * database's default comment, tier 3 none at all, and neither would be what the target has.
   */
  readonly target: ConnInfo;
  /** User schema name → the schema the DDL is emitted into. Identity for tiers 1 and 2. */
  readonly schemaMap: ReadonlyMap<string, string>;
  readonly tier: 1 | 2 | 3;
  /** How the tier was reached, for `--explain` and for the plan's proof stamp. */
  readonly reason: string;
  readonly diagnostics: readonly Diagnostic[];
  dispose(): Promise<void>;
}

export class OfflineShadowError extends Error {
  readonly code = "PG_PRIME_SHADOW_OFFLINE";
  constructor() {
    super(
      "shadow tier 4 (--offline) is not implemented: the desired state cannot be normalized " +
        "without a PostgreSQL to load it into, so a plan generated offline would compare human " +
        "DDL against catalog DDL and diff forever. Use --shadow <url>, a role with CREATEDB, or " +
        "the temp-schema tier.",
    );
    this.name = "OfflineShadowError";
  }
}

/**
 * A `--shadow <value>` / `shadow:` value that names no tier.
 *
 * It exists so that the flag, the config file and the ladder itself all refuse the same typo with
 * the same sentence. Before design/12 F2 a string that was not one of the four keywords reached
 * `provisionShadow` and fell through to `'auto'`: a `shadow: 'postgress://…'` in a config file
 * silently created a tier-2 database on the very cluster the key was set to stay off.
 */
export class ShadowStrategyError extends Error {
  readonly code = "PG_PRIME_SHADOW_STRATEGY";
  constructor(
    readonly value: string,
    detail?: string,
  ) {
    super(
      detail ??
        `${JSON.stringify(value)} is not a shadow strategy (--shadow, or \`shadow\` in ` +
          `pg-prime.config.ts): pass a postgres:// or postgresql:// URL (tier 1), \`createdb\` ` +
          `(tier 2), \`temp-schema\` (tier 3), \`auto\` (the ladder, the default), or ` +
          `\`none\`/\`offline\` (tier 4, refused with a sentence).`,
    );
    this.name = "ShadowStrategyError";
  }
}

export class ShadowNameTooLongError extends Error {
  readonly code = "PG_PRIME_SHADOW_NAME_TOO_LONG";
  constructor(
    readonly schema: string,
    readonly candidate: string,
  ) {
    super(
      `the temp-schema tier cannot host ${JSON.stringify(schema)}: its shadow name ` +
        `${JSON.stringify(candidate)} is ${Buffer.byteLength(candidate, "utf8")} UTF-8 bytes and ` +
        `PostgreSQL truncates identifiers at ${MAX_IDENT_BYTES}, which would make the map ` +
        `irreversible. Use --shadow <url> or a role with CREATEDB.`,
    );
    this.name = "ShadowNameTooLongError";
  }
}

/* ------------------------------------------------------------------ */

const token = (supplied?: string): string => supplied ?? randomBytes(4).toString("hex");

/** `postgres://u:p@h:p/db` → `ConnInfo`. Tier 1's only input. */
export function parseShadowUrl(url: string): ConnInfo {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ShadowStrategyError(url);
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new ShadowStrategyError(url);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (database === "")
    throw new ShadowStrategyError(
      url,
      `shadow url ${JSON.stringify(url)} names no database: the tier-1 shadow is a database that ` +
        `already exists and whose managed schemas this command DROPs and recreates, so the URL has ` +
        `to end in one (postgres://user@host:5432/a_throwaway_database).`,
    );
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username) || "postgres",
    password: decodeURIComponent(u.password),
    database,
  };
}

/**
 * One string → one strategy, for `--shadow <value>` and for `shadow:` in the config file.
 *
 * Both spellings go through here so they cannot disagree about what a URL is, and so a typo is a
 * refusal in exactly one place. `none` is design/06 §6.2's spelling of tier 4 and `offline` is the
 * ladder's; `docker` is named explicitly because §3.2 offers it and this release does not ship it.
 */
export function parseShadowStrategy(raw: string): ShadowStrategy {
  if (raw === "auto" || raw === "temp-schema" || raw === "createdb" || raw === "offline") return raw;
  if (raw === "none") return "offline";
  if (raw === "docker") {
    throw new ShadowStrategyError(
      raw,
      "--shadow docker is not built in this release: the kit has no testcontainers dependency " +
        "(design/08 §1.1's dependency budget). Pass a postgres:// URL, or use --shadow createdb / " +
        "--shadow temp-schema, both of which need no Docker.",
    );
  }
  parseShadowUrl(raw); // throws ShadowStrategyError when it is not a usable postgres URL
  return { url: raw };
}

/** Does the connected role get to `CREATE DATABASE`? Superusers do, whatever `rolcreatedb` says. */
async function canCreateDatabase(conn: ConnInfo): Promise<boolean> {
  return withClient(conn, async (client) => {
    const r = await client.query("SELECT rolcreatedb OR rolsuper AS ok FROM pg_roles WHERE rolname = current_user");
    return r.rows[0]?.["ok"] === true;
  });
}

interface Locale {
  readonly encoding: string;
  readonly collate: string;
  readonly ctype: string;
  readonly provider: string;
  readonly locale: string | null;
}

/**
 * The target database's locale, read version-independently.
 *
 * `daticulocale` (PG 15/16) was renamed `datlocale` (PG 17), so the row is taken as `jsonb` and
 * both spellings are probed. Copying the locale is not cosmetic: design/06 §3.2 records it as one
 * of the two things learned the hard way — a shadow with a different `LC_COLLATE` normalizes index
 * and constraint definitions differently, and every one of those is a phantom diff.
 */
async function targetLocale(conn: ConnInfo): Promise<Locale | undefined> {
  return withClient(conn, async (client) => {
    const r = await client.query(
      `SELECT pg_encoding_to_char(d.encoding) AS encoding, d.datcollate, d.datctype,
              d.datlocprovider, to_jsonb(d) AS raw
         FROM pg_database d WHERE d.datname = current_database()`,
    );
    const row = r.rows[0];
    if (row === undefined) return undefined;
    const raw = (row["raw"] ?? {}) as Record<string, unknown>;
    const loc = raw["daticulocale"] ?? raw["datlocale"] ?? null;
    return {
      encoding: String(row["encoding"]),
      collate: String(row["datcollate"]),
      ctype: String(row["datctype"]),
      provider: String(row["datlocprovider"] ?? "c"),
      locale: typeof loc === "string" ? loc : null,
    };
  });
}

const lit = (s: string): string => `'${s.replaceAll("'", "''")}'`;

function createDatabaseSql(name: string, locale: Locale | undefined): string {
  // TEMPLATE template0 is mandatory whenever the locale is stated explicitly, and template0 is
  // the one database nobody connects to — so this is also the spelling least likely to hit 55006.
  if (locale === undefined) return `CREATE DATABASE ${quoteIdent(name)}`;
  const bits = [
    `CREATE DATABASE ${quoteIdent(name)}`,
    "TEMPLATE template0",
    `ENCODING ${lit(locale.encoding)}`,
    `LC_COLLATE ${lit(locale.collate)}`,
    `LC_CTYPE ${lit(locale.ctype)}`,
  ];
  if (locale.provider === "i" && locale.locale !== null) {
    bits.push(`LOCALE_PROVIDER 'icu'`, `ICU_LOCALE ${lit(locale.locale)}`);
  } else if (locale.provider === "b" && locale.locale !== null) {
    bits.push(`LOCALE_PROVIDER 'builtin'`, `BUILTIN_LOCALE ${lit(locale.locale)}`);
  }
  return bits.join(" ");
}

/* ------------------------------------------------------------------ */

/**
 * Provision a shadow and hand back the connection, the schema map and a `dispose`.
 *
 * `admin` is a maintenance connection (any database other than the shadow); `target` is the
 * database being migrated. Tier 3 uses `target` itself, which is exactly why it needs no
 * `CREATEDB` and exactly why `dispose` asserts afterwards that nothing of ours is left in it.
 */
export async function provisionShadow(
  admin: ConnInfo,
  target: ConnInfo,
  options: ProvisionShadowOptions,
): Promise<Shadow> {
  const strategy = options.shadow ?? "auto";
  const schemas = [...new Set(options.schemas)].sort();
  if (schemas.length === 0) throw new Error("provisionShadow: no schemas were given");
  if (strategy === "offline") throw new OfflineShadowError();

  if (typeof strategy === "object") {
    return tier1(parseShadowUrl(strategy.url), target, schemas, "shadow url supplied");
  }
  if (strategy === "temp-schema") return tier3(target, schemas, options.token, "requested");
  if (strategy === "createdb") {
    return tier2(admin, target, schemas, options.token, "requested");
  }
  if (strategy !== "auto") {
    // A string that is not one of the four keywords is the OTHER tier-1 spelling — or a typo.
    // Either way it must not reach the ladder below: falling through to `auto` is how
    // `shadow: 'postgres://…'` in a config file used to create a tier-2 database on the cluster
    // the key was set to avoid, with no diagnostic (design/12 F2 item f).
    return tier1(parseShadowUrl(strategy), target, schemas, "shadow url supplied");
  }

  // 'auto': the ladder proper.
  if (await canCreateDatabase(admin)) {
    try {
      return await tier2(admin, target, schemas, options.token, "the admin role has CREATEDB");
    } catch (err) {
      // 55006: something is attached to the template. design/06 §3.2 says demote rather than
      // terminate — the sessions belong to somebody else.
      if (!isObjectInUse(err)) throw err;
      return tier3(
        target,
        schemas,
        options.token,
        "CREATE DATABASE raised 55006 (template in use); demoted to the temp-schema tier",
      );
    }
  }
  return tier3(target, schemas, options.token, "the admin role has no CREATEDB");
}

/* ---- tier 1 ---- */

async function tier1(conn: ConnInfo, target: ConnInfo, schemas: readonly string[], reason: string): Promise<Shadow> {
  const diagnostics: Diagnostic[] = [
    {
      code: "shadow_url_reset",
      severity: "warning",
      message:
        `the shadow database ${JSON.stringify(conn.database)} is RESET: ` +
        `${schemas.join(", ")} are dropped and recreated before the desired state is loaded`,
      subject: conn.database,
    },
  ];
  await resetSchemas(conn, schemas);
  return {
    conn,
    target,
    schemaMap: identityMap(schemas),
    tier: 1,
    reason,
    diagnostics,
    dispose: async () => {
      await resetSchemas(conn, schemas);
    },
  };
}

/* ---- tier 2 ---- */

async function tier2(
  admin: ConnInfo,
  target: ConnInfo,
  schemas: readonly string[],
  supplied: string | undefined,
  reason: string,
): Promise<Shadow> {
  const name = `${SHADOW_PREFIX}${token(supplied)}`;
  const locale = await targetLocale(target);
  const client = new pg.Client({ ...admin });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
    await client.query(createDatabaseSql(name, locale));
  } finally {
    await client.end();
  }
  const conn = withDatabase(target, name);
  return {
    conn,
    target,
    schemaMap: identityMap(schemas),
    tier: 2,
    reason,
    diagnostics: [],
    dispose: async () => {
      const c = new pg.Client({ ...admin });
      await c.connect();
      try {
        await dropDatabase(c, name);
      } finally {
        await c.end();
      }
    },
  };
}

/* ---- tier 3 ---- */

/**
 * The tier that matters: temp schemas inside the target database (design/06 §3.2).
 *
 * The mapped name keeps the original schema name in it when it fits, because a human staring at
 * `pg_namespace` mid-failure needs to know which of their schemas a leftover belongs to; when it
 * does not fit, the name falls back to a positional suffix rather than a truncation, since a
 * truncated name is exactly the collision `quoteIdent` refuses to create elsewhere.
 */
async function tier3(
  target: ConnInfo,
  schemas: readonly string[],
  supplied: string | undefined,
  reason: string,
): Promise<Shadow> {
  const prefix = `${SHADOW_PREFIX}${token(supplied)}`;
  const map = new Map<string, string>();
  schemas.forEach((s, i) => {
    const readable = `${prefix}_${s}`;
    const positional = `${prefix}_s${i}`;
    if (Buffer.byteLength(readable, "utf8") <= MAX_IDENT_BYTES) map.set(s, readable);
    else if (Buffer.byteLength(positional, "utf8") <= MAX_IDENT_BYTES) map.set(s, positional);
    else throw new ShadowNameTooLongError(s, readable);
  });

  const shadowNames = [...map.values()];
  await withClient(target, async (client) => {
    for (const name of shadowNames) {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(name)} CASCADE`);
      await client.query(`CREATE SCHEMA ${quoteIdent(name)}`);
    }
  });

  return {
    conn: target,
    target,
    schemaMap: map,
    tier: 3,
    reason,
    diagnostics: [
      {
        code: "shadow_temp_schema",
        severity: "info",
        message:
          `the desired state is normalized in ${shadowNames.join(", ")} inside ` +
          `${target.database}; objects with a fixed schema (extensions, event triggers, roles) ` +
          `cannot be renamed into it and are not normalized (design/06 §3.2)`,
        subject: target.database,
      },
    ],
    dispose: async () => {
      await withClient(target, async (client) => {
        for (const name of shadowNames) {
          await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(name)} CASCADE`);
        }
        // Asserted, not assumed: a temp schema left behind in the USER's database is the one
        // failure mode this tier can cause that the other two cannot.
        const left = await client.query("SELECT nspname FROM pg_namespace WHERE nspname = ANY($1) ORDER BY nspname", [
          shadowNames,
        ]);
        if (left.rows.length > 0) {
          throw new Error(
            `provisionShadow(tier 3): ${left.rows
              .map((r) => String(r["nspname"]))
              .join(", ")} survived DROP SCHEMA … CASCADE in ${target.database}`,
          );
        }
      });
    },
  };
}

/* ---- shared ---- */

function identityMap(schemas: readonly string[]): ReadonlyMap<string, string> {
  return new Map(schemas.map((s) => [s, s]));
}

async function resetSchemas(conn: ConnInfo, schemas: readonly string[]): Promise<void> {
  await withClient(conn, async (client) => {
    for (const s of schemas) {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(s)} CASCADE`);
      await client.query(`CREATE SCHEMA ${quoteIdent(s)}`);
    }
  });
}
