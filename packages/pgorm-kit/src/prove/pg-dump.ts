/**
 * The `pg_dump` equality oracle.
 *
 * The shadow-clone proof in `prove.ts` is self-referential: it extracts with OUR
 * extractor, diffs with OUR differ and hashes with OUR canonicalizer. If a catalog
 * attribute is not modelled by `catalog/extract.ts`, then the differ never emits DDL
 * for it AND the proof cannot notice the omission, because both sides of the equality
 * are blind in exactly the same way. That is silent semantic loss passing a green gate.
 *
 * `pg_dump` closes that hole for free. It is PostgreSQL's own serializer, it models the
 * entire DDL surface by definition, and it shares no code with us. If the clone and the
 * desired database dump identically, every attribute PostgreSQL considers part of the
 * schema survived the migration - including the ones we have never heard of.
 *
 * Zero npm dependencies: `pg_dump` ships with PostgreSQL and is spawned as a subprocess.
 */

import { spawn } from "node:child_process";
import { connectionString, withDatabase, type ConnInfo } from "../db/pg.js";
import { codeMask, splitStatements } from "../sql/statements.js";

export type DumpOracleMode = "off" | "warn" | "strict";

/**
 * The oracle's verdict, recorded verbatim in `.plan.json`.
 *
 * `skipped` means the oracle could not RUN: no launcher, one that will not spawn or
 * report `--version`, or one older than the server. That is an environment gap. A dump
 * that ran and went wrong - a pattern that matched no schema, a refused connection, a
 * timeout - is `failed`, because it says something about this run; classifying those as
 * `skipped` is how a mixed-case schema sailed through `strict` unwitnessed.
 *
 * `warn` (the default) records any difference and moves on, because Tier-R objects are
 * not modelled by the differ yet and would otherwise make every generate fail on a
 * legitimate, known gap. `strict` blocks on `failed`, and on `skipped` too unless the
 * caller passes `allowSkippedOracle`.
 */
export interface DumpOracleVerdict {
  readonly status: "passed" | "failed" | "skipped";
  readonly mode: DumpOracleMode;
  readonly reason?: string;
  readonly pgDumpVersion?: string;
  readonly statementCount?: number;
  readonly missingCount?: number;
  readonly extraCount?: number;
  /**
   * Tables whose only difference is column order. Reported, never blocking: PostgreSQL
   * cannot reorder columns, so a plan is not at fault for failing to.
   */
  readonly reordered?: readonly string[];
  /** capped samples, so a wide difference cannot balloon the plan file */
  readonly missing?: readonly string[];
  readonly extra?: readonly string[];
}

/** How many differing statements to record per direction. */
export const DUMP_SAMPLE_CAP = 20;

/** A dump that has not finished by now is hung, not slow; the child is killed. */
export const DUMP_TIMEOUT_MS = 120_000;

export interface PgDumpLauncher {
  /**
   * argv of the launcher, e.g. `["pg_dump"]` or, when the server only exists inside a
   * container, `["docker", "exec", "-e", "PGPASSWORD=...", "-i", "pg17", "pg_dump"]`.
   */
  readonly argv: readonly string[];
  /**
   * How a database name becomes the conninfo `pg_dump` receives. Defaults to a URI built
   * from the `ConnInfo` we already hold, WITHOUT the password (that travels in
   * `PGPASSWORD`, so it never lands in the process table).
   */
  readonly uri?: (database: string) => string;
}

export interface ResolvedPgDump {
  readonly argv: readonly string[];
  readonly version: string;
  readonly major: number;
  readonly uri?: (database: string) => string;
}

/**
 * `PGORM_PG_DUMP` accepts a JSON array for exact argv, or a whitespace-separated string.
 *
 * Returns null rather than throwing on anything malformed: a broken env var is an
 * environment gap (the oracle skips), never a proof failure. `JSON.parse` used to run
 * outside the caller's try block, so a stray character turned every generate into a
 * failure with a JSON syntax error for a reason.
 */
export function parseLauncherEnv(raw: string): readonly string[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("[")) {
    const argv = trimmed.split(/\s+/).filter(Boolean);
    return argv.length > 0 ? argv : null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  if (!parsed.every((x): x is string => typeof x === "string" && x.length > 0)) return null;
  return parsed;
}

interface RunOptions {
  readonly timeoutMs?: number;
  /** aborted when the sibling dump fails, so a hung child never outlives the proof */
  readonly signal?: AbortSignal;
}

function run(
  argv: readonly string[],
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: RunOptions = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [cmd, ...prefix] = argv;
    if (!cmd) {
      reject(new SpawnFailure("pg_dump launcher argv is empty"));
      return;
    }
    const child = spawn(cmd, [...prefix, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killedBy: string | null = null;
    const kill = (why: string): void => {
      if (killedBy !== null) return;
      killedBy = why;
      child.kill("SIGKILL");
    };
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => kill(`timed out after ${options.timeoutMs}ms`), options.timeoutMs);
    const onAbort = (): void => kill("cancelled because the sibling dump failed");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (): void => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", (err) => {
      done();
      reject(new SpawnFailure(`cannot spawn ${argv.join(" ")}: ${err.message}`));
    });
    child.on("close", (code) => {
      done();
      if (killedBy !== null) reject(new Error(`pg_dump ${killedBy}`));
      else resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** The launcher itself could not be started — an environment gap, so `skipped`. */
export class SpawnFailure extends Error {
  readonly code = "PGORM_PG_DUMP_SPAWN_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "SpawnFailure";
  }
}

/**
 * Locate a usable `pg_dump`. Resolution order: explicit launcher, then `PGORM_PG_DUMP`,
 * then `pg_dump` on PATH. Returns a reason string when unavailable - the oracle degrades
 * to "skipped" rather than failing a build on a machine without PostgreSQL client tools.
 */
export async function resolvePgDump(
  explicit?: PgDumpLauncher,
): Promise<ResolvedPgDump | { readonly unavailable: string }> {
  const envRaw = process.env["PGORM_PG_DUMP"];
  const envUri = process.env["PGORM_PG_DUMP_URI"];
  const envArgv = envRaw === undefined ? null : parseLauncherEnv(envRaw);
  if (explicit === undefined && envRaw !== undefined && envArgv === null) {
    return { unavailable: `PGORM_PG_DUMP is not a non-empty argv (JSON string array or whitespace-separated)` };
  }
  const argv = explicit?.argv ?? envArgv ?? ["pg_dump"];
  const uri =
    explicit?.uri ??
    // The database name is a URI path segment; an unencoded one silently
    // reroutes the dump (`a/b` becomes a different path entirely).
    (envUri ? (db: string) => envUri.replace("{db}", encodeURIComponent(db)) : undefined);

  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await run(argv, ["--version"], process.env, { timeoutMs: DUMP_TIMEOUT_MS });
  } catch (err) {
    return { unavailable: `cannot spawn ${argv.join(" ")}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (result.code !== 0) {
    return { unavailable: `${argv.join(" ")} --version exited ${result.code}: ${result.stderr.trim()}` };
  }
  // "pg_dump (PostgreSQL) 17.11"
  const m = /(\d+)(?:\.(\d+))?/.exec(result.stdout);
  if (!m) return { unavailable: `cannot parse pg_dump version from ${JSON.stringify(result.stdout.trim())}` };
  const resolved: ResolvedPgDump = {
    argv,
    version: result.stdout.trim(),
    major: Number(m[1]),
    ...(uri ? { uri } : {}),
  };
  return resolved;
}

export interface DumpRequest {
  readonly pgDump: ResolvedPgDump;
  readonly conn: ConnInfo;
  readonly database: string;
  readonly schemas: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * `--schema` takes a PATTERN, not a name: unquoted, it is case-folded and `*`, `?`,
 * `.`, `[` are wildcards, so `--schema App` matched nothing and the oracle reported
 * `skipped: no matching schemas` while the plan sailed through. Double-quoting pins
 * the pattern to a literal identifier, exactly as psql's `\dt "App".*` does.
 */
export function schemaPattern(schema: string): string {
  return `"${schema.replace(/"/g, '""')}"`;
}

/** Schema-only dump of exactly the managed schemas. */
export async function dumpSchema(req: DumpRequest): Promise<string> {
  const target = req.pgDump.uri
    ? req.pgDump.uri(req.database)
    : connectionString({ ...withDatabase(req.conn, req.database), password: "" }).replace(":@", "@");

  // --no-password: never block on an interactive prompt inside a child process
  // whose stdin is /dev/null - that is a hang, not an error.
  const args = ["--schema-only", "--no-owner", "--no-privileges", "--no-password"];
  for (const s of req.schemas) args.push("--schema", schemaPattern(s));
  args.push("--dbname", target);

  const { code, stdout, stderr } = await run(
    req.pgDump.argv,
    args,
    { ...process.env, PGPASSWORD: req.conn.password },
    {
      timeoutMs: req.timeoutMs ?? DUMP_TIMEOUT_MS,
      ...(req.signal ? { signal: req.signal } : {}),
    },
  );
  if (code !== 0) throw new Error(`pg_dump exited ${code}: ${stderr.trim()}`);
  return stdout;
}

/**
 * Session-configuration noise that pg_dump emits identically for every database.
 * Deliberately an allowlist: an unrecognised `SET` is schema-bearing until proven
 * otherwise (`SET default_table_access_method` is how a non-heap table is expressed).
 */
const PREAMBLE = new Set([
  "statement_timeout",
  "lock_timeout",
  "idle_in_transaction_session_timeout",
  "transaction_timeout",
  "client_encoding",
  "standard_conforming_strings",
  "check_function_bodies",
  "xmloption",
  "client_min_messages",
  "row_security",
  "escape_string_warning",
]);

function isPreamble(statement: string): boolean {
  const set = /^SET\s+([A-Za-z_]+)\s*=/.exec(statement);
  if (set && PREAMBLE.has(set[1]!.toLowerCase())) return true;
  return /^SELECT\s+pg_catalog\.set_config\(\s*'search_path'/i.test(statement);
}

/**
 * Raw dump text to a canonical, order-independent statement multiset.
 *
 * Sorting is deliberate: the oracle asserts equality of STATE, and pg_dump's emission
 * order encodes dependency order, which is a property of the plan rather than of the
 * schema. Ordering correctness is already gated by the apply step - a plan in the wrong
 * order does not apply at all.
 */
export function normalizeDump(raw: string): string[] {
  return splitStatements(raw)
    .filter((s) => !isPreamble(s))
    .sort();
}

const CREATE_TABLE = /^CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)\s*\(/i;

/**
 * Rewrite a `CREATE TABLE` with its column/constraint list sorted, so that two tables
 * differing ONLY in column order collapse to the same key.
 *
 * Column order is a real property - it is what `SELECT *` and a column-less `INSERT`
 * observe - but no engine can converge on it, because PostgreSQL has no
 * `ADD COLUMN ... BEFORE`. A column added in the middle of a declared table always
 * lands last. Reporting that as a plan failure would demand the impossible, so it is
 * classified separately instead of being silently normalized away OR treated as drift.
 *
 * The suffix after the column list (`WITH (...)`, `PARTITION BY ...`) is preserved
 * verbatim, so a storage-parameter difference is never mistaken for a reordering.
 */
export function tableReorderKey(statement: string): { key: string; table: string } | null {
  const m = CREATE_TABLE.exec(statement);
  if (!m) return null;
  const open = statement.indexOf("(", m.index + m[0].length - 1);
  if (open < 0) return null;

  const mask = codeMask(statement);
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < statement.length; i++) {
    if (!mask[i]) continue;
    const c = statement[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (c === "," && depth === 1) commas.push(i);
  }
  if (close < 0) return null;

  const bounds = [open, ...commas, close];
  const items: string[] = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    items.push(statement.slice(bounds[k]! + 1, bounds[k + 1]!).trim());
  }
  const suffix = statement.slice(close + 1);
  return {
    key: `${statement.slice(0, open)}(${items.sort().join(", ")})${suffix}`,
    table: m[1]!,
  };
}

export interface DumpComparison {
  readonly equal: boolean;
  /** present in the desired dump, absent from the clone - the migration failed to create it */
  readonly missing: readonly string[];
  /** present in the clone, absent from the desired dump - the migration left something behind */
  readonly extra: readonly string[];
  /** tables whose only difference is column order, which no migration can repair */
  readonly reordered: readonly string[];
  readonly statementCount: number;
}

/** Multiset difference, so a duplicated statement on one side is still a difference. */
export function compareDumps(cloneDump: string, desiredDump: string): DumpComparison {
  const clone = normalizeDump(cloneDump);
  const desired = normalizeDump(desiredDump);

  const counts = new Map<string, number>();
  for (const s of clone) counts.set(s, (counts.get(s) ?? 0) + 1);
  const missing: string[] = [];
  for (const s of desired) {
    const n = counts.get(s) ?? 0;
    if (n > 0) counts.set(s, n - 1);
    else missing.push(s);
  }
  const extra: string[] = [];
  for (const [s, n] of counts) for (let k = 0; k < n; k++) extra.push(s);

  // Pair off anything that differs only in column order before calling it drift.
  const reordered: string[] = [];
  const extraKeys = new Map<string, number[]>();
  extra.forEach((s, i) => {
    const k = tableReorderKey(s);
    if (!k) return;
    const bucket = extraKeys.get(k.key);
    if (bucket) bucket.push(i);
    else extraKeys.set(k.key, [i]);
  });
  const consumed = new Set<number>();
  const stillMissing: string[] = [];
  for (const s of missing) {
    const k = tableReorderKey(s);
    const bucket = k ? extraKeys.get(k.key) : undefined;
    const idx = bucket?.shift();
    if (k && idx !== undefined) {
      consumed.add(idx);
      reordered.push(k.table);
    } else stillMissing.push(s);
  }
  const stillExtra = extra.filter((_, i) => !consumed.has(i));

  stillMissing.sort();
  stillExtra.sort();
  reordered.sort();
  return {
    equal: stillMissing.length === 0 && stillExtra.length === 0,
    missing: stillMissing,
    extra: stillExtra,
    reordered,
    statementCount: desired.length,
  };
}
