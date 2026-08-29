/**
 * Loading `pg-prime.config.ts` with **no loader dependency** (design/11 §1.4).
 *
 * Node ≥ 22.18 strips types from a `.ts` file it `import()`s, so the config is just a
 * module. Below that the extension is unknown and the CLI re-executes itself once with
 * `--experimental-strip-types` (`cli/main.ts` does the re-exec; this file only classifies
 * the failure, because a library cannot decide to replace the process). If that also
 * fails the user gets one sentence naming their Node version and the `.mjs` alternative.
 * No `jiti`, no `tsx`, no `esbuild` at runtime.
 */

import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ConnInfo } from "../db/pg.js";
import { parseShadowStrategy } from "../shadow/ladder.js";
import type { PgPrimeConfig } from "./define.js";
import { enableTsSpecifiers, typeScriptSiblingUrl } from "./ts-specifiers.js";

/** Searched in this order in the starting directory, then in each ancestor. */
export const CONFIG_FILENAMES: readonly string[] = [
  "pg-prime.config.ts",
  "pg-prime.config.mts",
  "pg-prime.config.js",
  "pg-prime.config.mjs",
];

/** design/11 §1.1 — the production tag (`06` §6.2's `push` refusal reads it). */
export const ENV_VAR = "PG_PRIME_ENV";

/** Set by `cli/main.ts` before it re-execs, so the retry can happen at most once. */
export const STRIP_TYPES_MARKER = "PG_PRIME_STRIP_TYPES_RETRY";

export class ConfigError extends Error {
  readonly code = "PG_PRIME_CONFIG";
  /** true ⟹ re-running this process with `--experimental-strip-types` could fix it */
  readonly retryWithStripTypes: boolean;
  constructor(message: string, retryWithStripTypes = false) {
    super(message);
    this.name = "ConfigError";
    this.retryWithStripTypes = retryWithStripTypes;
  }
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** First config file at or above `from`. Null when there is none. */
export async function findConfigFile(from: string): Promise<string | null> {
  let dir = resolve(from);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (await exists(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const errCode = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

function stripTypesAdvice(file: string, err: unknown): ConfigError {
  const message = err instanceof Error ? err.message : String(err);
  return new ConfigError(
    `${file} could not be loaded on Node ${process.version} (${errCode(err) ?? "no code"}: ${message}) — ` +
      `either upgrade to Node >= 22.18, where TypeScript type stripping is on by default, or rename the file ` +
      `to pg-prime.config.mjs and write it in JavaScript.`,
    errCode(err) === "ERR_UNKNOWN_FILE_EXTENSION",
  );
}

/** The four codes Node uses when it cannot strip the types out of a `.ts` file. */
const STRIP_TYPES_CODES: readonly string[] = [
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
  "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING",
  "ERR_INVALID_TYPESCRIPT_SYNTAX",
];

/**
 * The Node 22.12–22.14 failure, turned into a sentence (design/13 §5, E's F3).
 *
 * `ts-specifiers.ts` redirects a relative `./x.js` with no file on disk to the `./x.ts` beside it,
 * through `module.registerHooks` — which arrived in **Node 22.15**. Below that the hook cannot be
 * installed, the specifier resolves literally, and the user got Node's raw `ERR_MODULE_NOT_FOUND`
 * naming a file they never wrote. `stripTypesAdvice` did not cover it: that one is reached only
 * for {@link STRIP_TYPES_CODES}, and neither of its two ways out (Node >= 22.18, or a `.mjs`
 * config) is the fix for this.
 *
 * Every clause of the test matters, because an `ERR_MODULE_NOT_FOUND` is ordinarily the user's own
 * typo and must keep saying so: the hook is **not** installed, the missing module ends in a
 * JavaScript extension, it is not on disk, and its TypeScript sibling **is**. That last pair is
 * {@link typeScriptSiblingUrl} — the same predicate the hook itself uses, so the message cannot
 * promise a redirect the hook would not have made.
 *
 * @returns the `ConfigError` to throw, or `null` to let the original error through untouched.
 */
export function tsSpecifierAdvice(file: string, err: unknown, hooksInstalled: boolean): ConfigError | null {
  if (hooksInstalled) return null;
  if (errCode(err) !== "ERR_MODULE_NOT_FOUND") return null;
  const url = (err as { url?: unknown } | null)?.url;
  if (typeof url !== "string") return null;
  const sibling = typeScriptSiblingUrl(url);
  if (sibling === null) return null;
  return new ConfigError(
    `${file} imports "${pathOfUrl(url)}", which does not exist — only "${pathOfUrl(sibling)}" beside ` +
      `it. Node resolves a .js specifier literally, and the resolve hook that redirects it to its ` +
      `TypeScript sibling needs module.registerHooks (Node >= 22.15); this is Node ${process.version}, ` +
      `so either upgrade Node or compile the project first, which puts the .js there.`,
  );
}

/** `file:///a/b.js` to `/a/b.js`, and anything else back unchanged. */
function pathOfUrl(url: string): string {
  try {
    return fileURLToPath(url);
  } catch {
    return url;
  }
}

/**
 * The one place an import of the USER's TypeScript is classified — the config file and every
 * schema module take the same two branches, and they used to be two copies of the same `if`.
 *
 * @returns the error to throw instead of `err`, or `null` when `err` is already the right one.
 */
function classifyUserImportFailure(file: string, err: unknown, hooksInstalled: boolean): ConfigError | null {
  const code = errCode(err);
  if (code !== undefined && STRIP_TYPES_CODES.includes(code)) return stripTypesAdvice(file, err);
  return tsSpecifierAdvice(file, err, hooksInstalled);
}

export interface LoadedConfig {
  readonly file: string | null;
  readonly config: PgPrimeConfig;
}

/**
 * Import a config module and take its default export.
 *
 * A cache-busting query is deliberately NOT added: the CLI is one process per invocation,
 * and a `?t=` suffix would make the specifier differ from the one a user sees in a stack
 * trace for no benefit.
 */
export async function loadConfig(path?: string, cwd: string = process.cwd()): Promise<LoadedConfig> {
  const file = path ? (isAbsolute(path) ? path : resolve(cwd, path)) : await findConfigFile(cwd);
  if (!file) return { file: null, config: {} };
  if (path && !(await exists(file))) throw new ConfigError(`no config file at ${file}`);

  let mod: { default?: unknown };
  // A `.ts` config that imports a sibling `.ts` module writes `'./db/schema.js'`, because that
  // is the specifier `tsc` requires and emits. Node resolves it literally (design/12 F2 item j).
  const hooks = await enableTsSpecifiers();
  try {
    mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  } catch (err) {
    throw classifyUserImportFailure(file, err, hooks) ?? err;
  }

  const value = mod.default;
  if (value === undefined) throw new ConfigError(`${file} has no default export`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${file}'s default export must be an object, received ${typeof value}`);
  }
  return { file, config: validate(value as Record<string, unknown>, file) };
}

const STRING_KEYS = ["url", "migrations", "repeatables", "seeds", "lockTimeout", "statementTimeout"] as const;
const NUMBER_KEYS = ["lockWaitMs", "staleLockAfterMs"] as const;

/**
 * `shadow` is the one key that is not a plain string.
 *
 * design/06 §3.2's tier 1 is `{ url }`, and the same thing written as a bare `postgres://…`
 * string is what a reader of `--shadow postgres://…` types into the file. Both are accepted and
 * both are *parsed here*, so a typo is a refusal naming the file rather than a silent demotion to
 * the `auto` ladder — which is what `shadow` was set to avoid (design/12 F2 item f).
 */
function validateShadow(raw: Record<string, unknown>, file: string): void {
  const v = raw["shadow"];
  if (v === undefined) return;
  const refuse = (why: string): never => {
    throw new ConfigError(`${file}: \`shadow\` ${why}`);
  };
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const url = (v as { url?: unknown }).url;
    if (typeof url !== "string") refuse("must be a string or `{ url: 'postgres://…' }`");
    try {
      parseShadowStrategy(url as string);
    } catch (err) {
      refuse(`names a shadow database that cannot be reached: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  if (typeof v !== "string") refuse("must be a string or `{ url: 'postgres://…' }`");
  try {
    parseShadowStrategy(v as string);
  } catch (err) {
    refuse(err instanceof Error ? `is invalid: ${err.message}` : String(err));
  }
}

function validate(raw: Record<string, unknown>, file: string): PgPrimeConfig {
  for (const key of STRING_KEYS) {
    const v = raw[key];
    if (v !== undefined && typeof v !== "string") throw new ConfigError(`${file}: \`${key}\` must be a string`);
  }
  validateShadow(raw, file);
  for (const key of NUMBER_KEYS) {
    const v = raw[key];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
      throw new ConfigError(`${file}: \`${key}\` must be a finite number`);
    }
  }
  for (const key of ["schemas", "replicas"] as const) {
    const v = raw[key];
    if (v !== undefined && !(Array.isArray(v) && v.every((s) => typeof s === "string"))) {
      throw new ConfigError(`${file}: \`${key}\` must be an array of strings`);
    }
  }
  if (raw["production"] !== undefined && typeof raw["production"] !== "boolean") {
    throw new ConfigError(`${file}: \`production\` must be a boolean`);
  }
  return raw as PgPrimeConfig;
}

/* ----------------------------- the schema module --------------------------- */

/**
 * Import the module(s) `config.schema` points at and hand back one registry.
 *
 * Three shapes are accepted, in this order, because all three are things people write:
 *
 *  1. `export default defineSchema({ users, orgs })` — the documented one;
 *  2. any named export carrying a `tables` property — `export const schema = …`;
 *  3. failing both, every export that *is* a table (`{ $: TableRuntime }`) is collected
 *     into one registry, so `export * from './tables.js'` works with no ceremony.
 *
 * Several paths are merged into one registry; a table exported twice under two keys is
 * kept once, keyed by `schema.name`, because that is its identity in the catalog and two
 * TypeScript names for one table must not emit two `CREATE TABLE`s.
 */
export interface LoadedSchema {
  readonly schema: {
    readonly tables: Readonly<Record<string, { readonly $: unknown }>>;
    /** design/05 §3.2/§3.3/§3.5/§3.10/§3.1, discovered off the module's exports */
    readonly enums: readonly unknown[];
    readonly domains: readonly unknown[];
    readonly sequences: readonly unknown[];
    readonly extensions: readonly unknown[];
    readonly schemas: readonly unknown[];
  };
  readonly files: readonly string[];
}

/**
 * A standalone declaration — `pgEnum`, `pgDomain`, `pgSequence`, `pgExtension`, `pgSchema`.
 *
 * Each is a frozen plain object carrying a `kind` discriminant and a `name`, so one
 * structural test covers all five and a sixth costs one string. Discovered off the
 * module's exports for the same reason tables are: `defineSchema(...)` is the query
 * layer's registry and these objects are author-time only.
 */
const declarationOf = (v: unknown): string | null => {
  if (typeof v !== "object" || v === null) return null;
  const r = v as { kind?: unknown; name?: unknown };
  if (typeof r.name !== "string") return null;
  return r.kind === "enum" ||
    r.kind === "domain" ||
    r.kind === "sequence" ||
    r.kind === "extension" ||
    r.kind === "schema"
    ? r.kind
    : null;
};

const isTableLike = (v: unknown): v is { $: { name: string; schema?: string; columns: unknown; extras: unknown } } => {
  const runtime = (v as { $?: unknown } | null)?.$;
  if (typeof runtime !== "object" || runtime === null) return false;
  const r = runtime as { name?: unknown; columns?: unknown; extras?: unknown };
  return typeof r.name === "string" && Array.isArray(r.columns) && Array.isArray(r.extras);
};

const hasTables = (v: unknown): v is { tables: Record<string, unknown> } => {
  const t = (v as { tables?: unknown } | null)?.tables;
  return typeof t === "object" && t !== null && !Array.isArray(t);
};

export async function loadSchema(paths: string | readonly string[], base: string): Promise<LoadedSchema> {
  const list = (typeof paths === "string" ? [paths] : [...paths]).map((p) => (isAbsolute(p) ? p : resolve(base, p)));
  if (list.length === 0) throw new ConfigError("`schema` names no file");

  const tables: Record<string, { $: unknown }> = {};
  const declared: Record<string, Map<string, unknown>> = {
    enum: new Map(),
    domain: new Map(),
    sequence: new Map(),
    extension: new Map(),
    schema: new Map(),
  };
  for (const file of list) {
    if (!(await exists(file))) throw new ConfigError(`no schema module at ${file}`);
    let mod: Record<string, unknown>;
    // Same reason as `loadConfig`: a schema split over several files imports its own siblings
    // with `.js` specifiers, and nothing has compiled them (design/12 F2 item j).
    const hooks = await enableTsSpecifiers();
    try {
      mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    } catch (err) {
      throw classifyUserImportFailure(file, err, hooks) ?? err;
    }
    const registry = hasTables(mod["default"]) ? mod["default"] : Object.values(mod).find((v) => hasTables(v));
    const candidates: unknown[] = registry ? Object.values(registry.tables) : Object.values(mod);
    let found = 0;
    for (const value of candidates) {
      if (!isTableLike(value)) continue;
      const runtime = value.$;
      tables[`${runtime.schema ?? "public"}.${runtime.name}`] = value;
      found += 1;
    }
    // The standalone declarations always come off the MODULE, never off a registry:
    // `defineSchema(...)` takes tables and relations only, so a `pgDomain` can be reached
    // in exactly one way — the export that names it. Keyed by `schema.name` for the same
    // reason tables are: one object exported twice under two names is one object.
    for (const [key, value] of Object.entries(mod)) {
      if (key === "default") continue;
      const kind = declarationOf(value);
      if (kind === null) continue;
      const decl = value as { name: string; schema?: string };
      declared[kind]!.set(kind === "schema" ? decl.name : `${decl.schema ?? "public"}.${decl.name}`, value);
    }
    if (found === 0) {
      throw new ConfigError(
        `${file} exports no tables: expected \`export default defineSchema({ … })\`, an export with a ` +
          `\`tables\` property, or one or more \`pgTable(...)\` exports.`,
      );
    }
  }
  return {
    schema: {
      tables,
      enums: [...declared["enum"]!.values()],
      domains: [...declared["domain"]!.values()],
      sequences: [...declared["sequence"]!.values()],
      extensions: [...declared["extension"]!.values()],
      schemas: [...declared["schema"]!.values()],
    },
    files: list,
  };
}

/* ------------------------------ URL → ConnInfo ---------------------------- */

export interface ParsedUrl {
  readonly conn: ConnInfo;
  readonly warnings: readonly string[];
}

/**
 * `postgres://user:pass@host:port/db` → `ConnInfo`.
 *
 * `ConnInfo` is the kit's five-field connection record and has no TLS or option surface,
 * so a URL that carries one is accepted and the dropped parameters are *named* — a
 * silently ignored `sslmode=require` is the kind of thing that only shows up in
 * production.
 */
export function parseDatabaseUrl(url: string): ParsedUrl {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ConfigError(`${JSON.stringify(url)} is not a URL`);
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new ConfigError(`${JSON.stringify(url)} must use the postgres: or postgresql: scheme`);
  }
  const user = decodeURIComponent(u.username) || process.env["PGUSER"] || "postgres";
  const database = decodeURIComponent(u.pathname.replace(/^\//, "")) || user;
  const warnings: string[] = [];
  const ignored = [...u.searchParams.keys()];
  if (ignored.length > 0) {
    warnings.push(
      `the connection URL carries ${ignored.map((k) => `\`${k}\``).join(", ")}, which this release ignores ` +
        `(the kit connects with host/port/user/password/database only)`,
    );
  }
  return {
    warnings,
    conn: {
      // `new URL` brackets an IPv6 literal; `pg` wants it bare.
      host: u.hostname.replace(/^\[|\]$/g, "") || "127.0.0.1",
      port: Number(u.port || 5432),
      user,
      password: decodeURIComponent(u.password),
      database,
    },
  };
}

export interface ResolveInput {
  readonly config: PgPrimeConfig;
  readonly configFile: string | null;
  /**
   * Throw when no connection can be resolved. `false` for the one command that is a pure
   * function of files — `migrate lint <file>` — because requiring a database URL to lint
   * SQL text is the kind of friction that gets a linter dropped from CI.
   */
  readonly requireConnection?: boolean;
  /** `--url` */
  readonly url?: string | undefined;
  /** `--migrations` */
  readonly migrations?: string | undefined;
  /** `--schema` (repeatable) */
  readonly schemas?: readonly string[] | undefined;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface ResolvedConfig {
  readonly file: string | null;
  readonly config: PgPrimeConfig;
  readonly connection: ConnInfo;
  /** false ⟹ `connection` is a placeholder and nothing may connect with it */
  readonly hasConnection: boolean;
  /** absolute paths from `config.schema`, or `[]` when the config names none */
  readonly schemaPaths: readonly string[];
  readonly migrationsDir: string;
  readonly repeatablesDir: string;
  /** `seeds/` (design/06 §7 lane 3) */
  readonly seedsDir: string;
  readonly schemas: readonly string[];
  /** design/12 decision 13 — parsed `config.replicas`, empty when the config names none */
  readonly replicas: readonly ConnInfo[];
  /** `PG_PRIME_ENV`, verbatim; null when unset */
  readonly env: string | null;
  readonly production: boolean;
  readonly warnings: readonly string[];
}

/**
 * Precedence, highest first: `--url`, `config.connection`, `config.url`,
 * `PG_PRIME_DATABASE_URL`, `DATABASE_URL`. The project's own file beats the ambient
 * environment because a `DATABASE_URL` left over in a shell is the classic way to run a
 * migration against the wrong database.
 */
export function resolveConfig(input: ResolveInput): ResolvedConfig {
  const { config, env, cwd } = input;
  const warnings: string[] = [];
  const base = input.configFile ? dirname(input.configFile) : cwd;

  let connection: ConnInfo;
  let hasConnection = true;
  const explicit = input.url ?? config.url ?? env["PG_PRIME_DATABASE_URL"] ?? env["DATABASE_URL"];
  if (input.url === undefined && config.connection) {
    connection = config.connection;
  } else if (explicit) {
    const parsed = parseDatabaseUrl(explicit);
    connection = parsed.conn;
    warnings.push(...parsed.warnings);
  } else if (input.requireConnection === false) {
    connection = { host: "", port: 0, user: "", password: "", database: "" };
    hasConnection = false;
  } else {
    throw new ConfigError(
      "no database connection: pass --url, set `url` in pg-prime.config.ts, or export PG_PRIME_DATABASE_URL",
    );
  }

  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(base, p));
  const envTag = env[ENV_VAR] ?? null;
  const schemaPaths =
    config.schema === undefined
      ? []
      : (typeof config.schema === "string" ? [config.schema] : [...config.schema]).map(abs);
  return {
    file: input.configFile,
    config,
    connection,
    hasConnection,
    schemaPaths,
    migrationsDir: abs(input.migrations ?? config.migrations ?? "migrations"),
    repeatablesDir: abs(config.repeatables ?? "sql"),
    seedsDir: abs(config.seeds ?? "seeds"),
    schemas: input.schemas ?? config.schemas ?? ["public"],
    replicas: (config.replicas ?? []).map((url) => parseDatabaseUrl(url).conn),
    env: envTag,
    production: config.production === true || envTag === "production",
    warnings,
  };
}
