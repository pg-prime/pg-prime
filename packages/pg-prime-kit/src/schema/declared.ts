/**
 * The declared lane for RLS policies and `updatedAtTrigger` (design/20 §4, §5.2, §5.5).
 *
 * Declarations render into ordinary `sql/` repeatables: `050_policies/<schema>__<table>.sql`,
 * `070_triggers/000_functions.sql`, `070_triggers/<schema>__<table>.sql` and the root
 * `990_declared_prune.sql`. Every object carries a `COMMENT … IS 'pg-prime:declared sha256:<h>'`
 * marker, which scopes the prune and the census to objects this lane created.
 */

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { CatalogClient, Diagnostic } from "../catalog/extract.js";
import { sha256 } from "../ir/hash.js";
import type { Directive, RepeatableFile } from "../repeatables/scan.js";
import { parseDirectives } from "../repeatables/scan.js";
import { quoteIdent, quoteLiteral } from "../sql/ident.js";
import { splitStatements } from "../sql/statements.js";
import type { PolicyLike, SchemaLike, TableRuntime } from "./types.js";

export const POLICIES_DIR = "050_policies";
export const TRIGGERS_DIR = "070_triggers";
export const PRUNE_FILE = "990_declared_prune.sql";
/** The first line of every file this lane (or the view lane) owns. */
export const DECLARED_PREFIX = "-- pg-prime:declared";
const MARKER = "pg-prime:declared ";

export type DeclaredKind = "rls" | "policy" | "trigger" | "function";

export interface DeclaredObject {
  readonly kind: DeclaredKind;
  /** `s.t` (rls), `s.t.name` (policy, trigger), `s.name()` (function). */
  readonly identity: string;
  /** `sha256:<hex>` of the CREATE statement; `force` / `noforce` for `rls`. */
  readonly state: string;
}

export interface DeclaredFile {
  /** POSIX, relative to the repeatables root. */
  readonly path: string;
  readonly sql: string;
  readonly objects: readonly DeclaredObject[];
}

/** One `-- pg-prime:acknowledged <code> <subject> by <who>: <reason>` header line. */
export interface LaneAck {
  readonly code: string;
  readonly subject: string;
  readonly by: string;
  readonly reason: string;
}

export interface RenderDeclaredOptions {
  readonly defaultSchema?: string;
  /** The managed schemas the prune is scoped to. Default: `[defaultSchema]`. */
  readonly schemas?: readonly string[];
  /** Remaps a declared schema for a shadow; identities and SQL use the remapped name. */
  readonly schemaOf?: (schema: string) => string;
  /** Render the prune even with nothing declared: the file already exists (D13). */
  readonly existingPrune?: boolean;
  readonly acks?: readonly LaneAck[];
}

export interface RenderedDeclared {
  readonly files: readonly DeclaredFile[];
  readonly diagnostics: readonly Diagnostic[];
}

const slug = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const marker = (hash: string): string => quoteLiteral(`${MARKER}${hash}`);

interface TableEntry {
  readonly runtime: TableRuntime;
  readonly schema: string;
  readonly policies: PolicyLike[];
  force?: boolean;
  readonly triggers: Set<string>;
}

export function renderDeclared(schema: SchemaLike, options: RenderDeclaredOptions = {}): RenderedDeclared {
  const defaultSchema = options.defaultSchema ?? "public";
  const schemaOf = options.schemaOf ?? ((s: string): string => s);
  const managed = options.schemas ?? [defaultSchema];
  const diagnostics: Diagnostic[] = [];
  const invalid = (subject: string, message: string): void => {
    diagnostics.push({ code: "declared_invalid", severity: "error", message, subject });
  };
  const tables = new Map<string, TableEntry>();
  const entry = (runtime: TableRuntime): TableEntry => {
    const declared = runtime.schema ?? defaultSchema;
    const s = schemaOf(declared);
    const key = `${s}.${runtime.name}`;
    let e = tables.get(key);
    if (e === undefined) {
      // A shadow maps only the managed schemas; anything else would run against the live one.
      if (!managed.includes(declared)) {
        invalid(
          `${declared}.${runtime.name}`,
          `${declared}.${runtime.name} is outside the managed schemas (${managed.join(", ")}); add ${declared} to \`schemas\``,
        );
      }
      e = { runtime, schema: s, policies: [], triggers: new Set() };
      tables.set(key, e);
    }
    return e;
  };

  for (const table of Object.values(schema.tables)) {
    for (const extra of table.$.extras) {
      if (extra.node === "rls") {
        const e = entry(table.$);
        e.force = e.force === true || extra.force;
      } else if (extra.node === "updatedAtTrigger") {
        entry(table.$).triggers.add(extra.column);
        const col = table.$.columns.find((c) => c.dbName === extra.column);
        if (col?.column.ts.onUpdateFn !== undefined) {
          diagnostics.push({
            code: "updated_at_on_update_overlap",
            severity: "info",
            message: `${table.$.name}.${extra.column} has $onUpdate and updatedAtTrigger; the trigger overwrites the value`,
            subject: `${table.$.schema ?? defaultSchema}.${table.$.name}.${extra.column}`,
          });
        }
      }
    }
  }
  const qualified = (t: TableRuntime): string => `${t.schema ?? defaultSchema}.${t.name}`;
  const declaredTables = new Set(Object.values(schema.tables).map((t) => qualified(t.$)));
  const seen = new Set<string>();
  for (const p of schema.policies ?? []) {
    const on = qualified(p.$.table);
    if (!declaredTables.has(on)) {
      invalid(`${on}.${p.name}`, `definePolicy("${p.name}") is on ${on}, which the schema does not declare`);
      continue;
    }
    const e = entry(p.$.table);
    const id = `${e.schema}.${e.runtime.name}.${p.name}`;
    if (seen.has(id)) {
      diagnostics.push({
        code: "declared_conflict",
        severity: "error",
        message: `two definePolicy declarations are both ${id}`,
        subject: id,
      });
      continue;
    }
    seen.add(id);
    e.policies.push(p);
  }

  const files: DeclaredFile[] = [];
  const keep: Record<"policy" | "trigger" | "function", string[][]> = { policy: [], trigger: [], function: [] };
  const functions = new Map<string, { fn: string; sql: string; hash: string }>();
  for (const [id, e] of tables) {
    const on = `${quoteIdent(e.schema)}.${quoteIdent(e.runtime.name)}`;
    if (e.policies.length > 0 || e.force !== undefined) {
      if (e.force === undefined) {
        diagnostics.push({
          code: "RL104",
          severity: "warning",
          message: `${id} has declared policies but no rls.enable()/rls.force(); they are inert until RLS is enabled`,
          subject: id,
        });
      }
      const objects: DeclaredObject[] = [];
      const statements: string[] = [];
      if (e.force !== undefined) {
        objects.push({ kind: "rls", identity: id, state: e.force ? "force" : "noforce" });
        statements.push(`ALTER TABLE ${on} ${e.force ? "FORCE" : "NO FORCE"} ROW LEVEL SECURITY`);
      }
      for (const p of [...e.policies].sort((a, b) => byString(a.name, b.name))) {
        let ddl: string;
        try {
          ddl = p.$.ddl((s) => schemaOf(s ?? defaultSchema));
        } catch (err) {
          diagnostics.push({
            code: "declared_invalid",
            severity: "error",
            message: err instanceof Error ? err.message : String(err),
            subject: `${id}.${p.name}`,
          });
          continue;
        }
        const hash = sha256(ddl);
        const name = quoteIdent(p.name);
        objects.push({ kind: "policy", identity: `${id}.${p.name}`, state: hash });
        keep.policy.push([e.schema, e.runtime.name, p.name]);
        statements.push(
          `DROP POLICY IF EXISTS ${name} ON ${on}`,
          ddl,
          `COMMENT ON POLICY ${name} ON ${on} IS ${marker(hash)}`,
        );
      }
      files.push(
        file(
          `${POLICIES_DIR}/${slug(e.schema)}__${slug(e.runtime.name)}.sql`,
          [
            `${DECLARED_PREFIX} policies ${id}`,
            "-- pg-prime:tier R",
            ...objects.map(objectLine),
            "--",
            `-- GENERATED by \`pg-prime migrate generate\` from definePolicy(...) on ${id}.`,
            "-- Edit the TypeScript, not this file. Re-applying it takes ACCESS EXCLUSIVE on the table.",
          ],
          statements,
          objects,
        ),
      );
    }
    if (e.triggers.size > 0) {
      const objects: DeclaredObject[] = [];
      const statements: string[] = [];
      for (const column of [...e.triggers].sort(byString)) {
        const name = `pgprime_set_${column}`;
        const fn = `${quoteIdent(e.schema)}.${quoteIdent(name)}()`;
        const body = `CREATE OR REPLACE FUNCTION ${fn} RETURNS trigger\n  LANGUAGE plpgsql AS $$\nBEGIN\n  NEW.${quoteIdent(column)} := now();\n  RETURN NEW;\nEND\n$$`;
        if (!functions.has(`${e.schema}.${name}()`)) keep.function.push([e.schema, name]);
        functions.set(`${e.schema}.${name}()`, { fn, sql: body, hash: sha256(body) });
        const ddl =
          `CREATE OR REPLACE TRIGGER ${quoteIdent(name)} BEFORE UPDATE ON ${on}\n` +
          `  FOR EACH ROW EXECUTE FUNCTION ${fn}`;
        const hash = sha256(ddl);
        objects.push({ kind: "trigger", identity: `${id}.${name}`, state: hash });
        keep.trigger.push([e.schema, e.runtime.name, name]);
        statements.push(ddl, `COMMENT ON TRIGGER ${quoteIdent(name)} ON ${on} IS ${marker(hash)}`);
      }
      files.push(
        file(
          `${TRIGGERS_DIR}/${slug(e.schema)}__${slug(e.runtime.name)}.sql`,
          [`${DECLARED_PREFIX} triggers ${id}`, "-- pg-prime:tier R", ...objects.map(objectLine)],
          statements,
          objects,
        ),
      );
    }
  }
  if (functions.size > 0) {
    const ids = [...functions.keys()].sort(byString);
    const objects = ids.map((identity): DeclaredObject => ({
      kind: "function",
      identity,
      state: functions.get(identity)!.hash,
    }));
    const statements = ids.flatMap((identity) => {
      const f = functions.get(identity)!;
      return [f.sql, `COMMENT ON FUNCTION ${f.fn} IS ${marker(f.hash)}`];
    });
    files.push(
      file(
        `${TRIGGERS_DIR}/000_functions.sql`,
        [`${DECLARED_PREFIX} functions`, "-- pg-prime:tier R", ...objects.map(objectLine)],
        statements,
        objects,
      ),
    );
  }

  const seenPaths = new Set<string>();
  for (const f of files) {
    if (seenPaths.has(f.path)) {
      diagnostics.push({
        code: "declared_conflict",
        severity: "error",
        message: `two declared tables render to ${f.path}; rename one`,
        subject: f.path,
      });
    }
    seenPaths.add(f.path);
  }
  if (files.length > 0 || options.existingPrune === true) {
    files.push(renderPrune(keep, options.schemas ?? [defaultSchema], options.acks ?? []));
  }
  return { files: files.sort((a, b) => byString(a.path, b.path)), diagnostics };
}

const objectLine = (o: DeclaredObject): string => `-- pg-prime:object ${o.kind} ${o.identity} ${o.state}`;

const file = (
  path: string,
  header: readonly string[],
  statements: readonly string[],
  objects: readonly DeclaredObject[],
): DeclaredFile => ({
  path,
  sql: `${header.join("\n")}\n\n${statements.map((s) => `${s};`).join("\n\n")}\n`,
  objects,
});

/** `(n.nspname, c.relname, x.name)` not in the keep-list; an empty list keeps nothing. */
function pruneLoop(
  select: string,
  where: string,
  columns: string,
  keep: readonly (readonly string[])[],
  drop: string,
): string {
  const notIn =
    keep.length === 0
      ? ""
      : `\n       AND (${columns}) NOT IN (VALUES\n${keep
          .map((k) => `         (${k.map(quoteLiteral).join(", ")})`)
          .join(",\n")})`;
  return `  FOR r IN\n    ${select}\n     WHERE ${where}${notIn}\n  LOOP\n    EXECUTE format(${drop});\n  END LOOP;`;
}

function renderPrune(
  keep: Readonly<Record<"policy" | "trigger" | "function", string[][]>>,
  schemas: readonly string[],
  acks: readonly LaneAck[],
): DeclaredFile {
  const split = (kind: "policy" | "trigger" | "function"): string[][] =>
    keep[kind].sort((a, b) => byString(a.join("\0"), b.join("\0")));
  const scope = `n.nspname = ANY (ARRAY[${[...schemas].sort(byString).map(quoteLiteral).join(", ")}])`;
  const marked = (oid: string, catalog: string): string => `obj_description(${oid}, '${catalog}') LIKE '${MARKER}%'`;
  const body = [
    pruneLoop(
      `SELECT n.nspname AS s, c.relname AS t, p.polname AS o\n      FROM pg_policy p\n      JOIN pg_class c ON c.oid = p.polrelid\n      JOIN pg_namespace n ON n.oid = c.relnamespace`,
      `${scope}\n       AND ${marked("p.oid", "pg_policy")}`,
      "n.nspname, c.relname, p.polname",
      split("policy"),
      "'DROP POLICY %I ON %I.%I', r.o, r.s, r.t",
    ),
    pruneLoop(
      `SELECT n.nspname AS s, c.relname AS t, g.tgname AS o\n      FROM pg_trigger g\n      JOIN pg_class c ON c.oid = g.tgrelid\n      JOIN pg_namespace n ON n.oid = c.relnamespace`,
      `NOT g.tgisinternal\n       AND ${scope}\n       AND ${marked("g.oid", "pg_trigger")}`,
      "n.nspname, c.relname, g.tgname",
      split("trigger"),
      "'DROP TRIGGER %I ON %I.%I', r.o, r.s, r.t",
    ),
    pruneLoop(
      `SELECT n.nspname AS s, p.proname AS o\n      FROM pg_proc p\n      JOIN pg_namespace n ON n.oid = p.pronamespace`,
      `p.pronargs = 0\n       AND ${scope}\n       AND ${marked("p.oid", "pg_proc")}`,
      "n.nspname, p.proname",
      split("function"),
      "'DROP FUNCTION %I.%I()', r.s, r.o",
    ),
  ];
  const header = [
    `${DECLARED_PREFIX} prune`,
    "-- pg-prime:tier R",
    ...acks.map((a) => `-- pg-prime:acknowledged ${a.code} ${a.subject} by ${a.by}: ${a.reason}`),
    "--",
    `-- Drops objects carrying a '${MARKER.trim()}' comment in the schemas below that are no longer`,
    "-- declared. Hand-written objects never carry the marker and are never touched.",
  ];
  return {
    path: PRUNE_FILE,
    sql: `${header.join("\n")}\n\nDO $$\nDECLARE\n  r record;\nBEGIN\n${body.join("\n")}\nEND\n$$;\n`,
    objects: [],
  };
}

/** Acks recorded in an existing prune file's header. */
export function parseAcks(directives: readonly Directive[]): LaneAck[] {
  const out: LaneAck[] = [];
  for (const d of directives) {
    if (d.name !== "acknowledged") continue;
    const m = /^(\S+) (\S+) by (.*?): (.*)$/.exec(d.value);
    if (m) out.push({ code: m[1]!, subject: m[2]!, by: m[3]!, reason: m[4]! });
  }
  return out;
}

/** A rendered file as the repeatables pass would read it from `<dir>/<path>`. */
export function asRepeatable(dir: string, f: { readonly path: string; readonly sql: string }): RepeatableFile {
  return {
    path: `${basename(resolve(dir))}/${f.path}`,
    absPath: join(resolve(dir), f.path),
    sha256: sha256(f.sql),
    directives: parseDirectives(f.sql),
    statements: splitStatements(f.sql),
  };
}

export const isDeclared = (f: Pick<RepeatableFile, "directives">): boolean =>
  f.directives[0]?.name === "declared" && f.directives[0].line === 1;

/** `scanRepeatables`' order: one code-unit sort per directory level. */
export function scanOrder(a: { readonly path: string }, b: { readonly path: string }): number {
  const x = a.path.split("/");
  const y = b.path.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return byString(x[i]!, y[i]!);
  }
  return x.length - y.length;
}

/* -------------------------------- the sync -------------------------------- */

export interface SyncDeclaredOptions {
  readonly write: boolean;
  /** Directories (relative to the root) whose declared files this sync owns. */
  readonly dirs: readonly string[];
}

export interface SyncedDeclared {
  readonly written: readonly string[];
  readonly pruned: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

async function readDeclaredDirs(dir: string, dirs: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const read = async (rel: string): Promise<void> => {
    try {
      out.set(rel, await readFile(join(dir, rel), "utf8"));
    } catch {
      // gone or unreadable: nothing to compare against
    }
  };
  for (const d of dirs) {
    let names: string[] = [];
    try {
      names = await readdir(join(dir, d));
    } catch {
      continue;
    }
    for (const name of names.sort()) if (name.toLowerCase().endsWith(".sql")) await read(`${d}/${name}`);
  }
  await read(PRUNE_FILE);
  return out;
}

/**
 * Bring the declared directories in line with `files`, or with `write: false` report how far out
 * of line they are. A non-declared file at a wanted path is `declared_conflict` and nothing is
 * written; the prune file is never deleted (D13).
 */
export async function syncDeclared(
  dir: string,
  files: readonly { readonly path: string; readonly sql: string }[],
  options: SyncDeclaredOptions,
): Promise<SyncedDeclared> {
  const onDisk = await readDeclaredDirs(dir, options.dirs);
  const conflicts = files.filter((f) => onDisk.has(f.path) && !onDisk.get(f.path)!.startsWith(DECLARED_PREFIX));
  if (conflicts.length > 0) {
    return {
      written: [],
      pruned: [],
      diagnostics: conflicts.map((f) => ({
        code: "declared_conflict",
        severity: "error",
        message: `${f.path} exists and was not generated by pg-prime; move it, the declared lane owns this path`,
        subject: f.path,
      })),
    };
  }
  const wanted = new Map(files.map((f) => [f.path, f.sql]));
  const changed = files.filter((f) => onDisk.get(f.path) !== f.sql).map((f) => f.path);
  const removed = [...onDisk]
    .filter(([path, text]) => text.startsWith(DECLARED_PREFIX) && !wanted.has(path) && path !== PRUNE_FILE)
    .map(([path]) => path);

  if (options.write) {
    for (const path of changed) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), wanted.get(path)!, "utf8");
    }
    for (const path of removed) {
      await unlink(join(dir, path)).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
    }
    return { written: changed, pruned: removed, diagnostics: [] };
  }

  const stale = [...changed, ...removed].sort(byString);
  const views = stale.filter((p) => p.startsWith("020_views/"));
  const lane = stale.filter((p) => !p.startsWith("020_views/"));
  const diagnostics: Diagnostic[] = [];
  if (views.length > 0) {
    diagnostics.push({
      code: "declared_views_stale",
      severity: "warning",
      message:
        `${String(views.length)} declared view file(s) in 020_views/ do not match the schema ` +
        `(${views.join(", ")}); run \`pg-prime migrate generate\` to rewrite the lane`,
      subject: "020_views",
      count: views.length,
    });
  }
  if (lane.length > 0) {
    diagnostics.push({
      code: "declared_lane_stale",
      severity: "warning",
      message:
        `${String(lane.length)} declared policy/trigger file(s) do not match the schema ` +
        `(${lane.join(", ")}); run \`pg-prime migrate generate\``,
      subject: lane[0]!,
      count: lane.length,
    });
  }
  return { written: [], pruned: [], diagnostics };
}

/* ----------------------------- conflict scan ------------------------------ */

const ID = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const QID = String.raw`(${ID})(?:\.(${ID}))?`;
const CREATE = String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?`;
const POLICY_RE = new RegExp(`${CREATE}POLICY\\s+(${ID})\\s+ON\\s+${QID}`, "i");
const TRIGGER_RE = new RegExp(`${CREATE}(?:CONSTRAINT\\s+)?TRIGGER\\s+(${ID})\\s.*?\\sON\\s+${QID}`, "is");
const FUNCTION_RE = new RegExp(`${CREATE}FUNCTION\\s+${QID}\\s*\\(\\s*\\)`, "i");
const RLS_RE = new RegExp(
  `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${QID}\\s.*?\\b(?:ENABLE|FORCE)\\s+ROW\\s+LEVEL\\s+SECURITY`,
  "is",
);

const unquote = (id: string): string => (id.startsWith('"') ? id.slice(1, -1).replaceAll('""', '"') : id.toLowerCase());

/**
 * D16 over the non-declared repeatables: a hand file (or a pulled `-- pg-prime:object` file) that
 * creates a declared identity, or one at a declared path, is `declared_conflict`; a hand
 * `ENABLE`/`FORCE ROW LEVEL SECURITY` on a table with `rls.*()` is `rls_declared_twice`.
 */
export function laneConflicts(
  hand: readonly RepeatableFile[],
  declared: readonly DeclaredFile[],
  defaultSchema = "public",
): Diagnostic[] {
  const ids = new Map<string, string>();
  for (const f of declared) for (const o of f.objects) ids.set(`${o.kind} ${o.identity}`, f.path);
  const paths = new Set(declared.map((f) => f.path));
  const qualify = (a: string, b: string | undefined): string =>
    b === undefined ? `${defaultSchema}.${unquote(a)}` : `${unquote(a)}.${unquote(b)}`;
  const out: Diagnostic[] = [];
  const conflict = (file: string, what: string): void => {
    out.push({
      code: "declared_conflict",
      severity: "error",
      message: `${file} ${what}; one writer per object — delete the hand-written copy`,
      subject: file,
    });
  };
  for (const f of hand) {
    const rel = f.path.slice(f.path.indexOf("/") + 1);
    if (paths.has(rel)) conflict(f.path, `sits at the declared path ${rel}`);
    const found = new Set<string>();
    for (const d of f.directives) {
      if (d.name !== "object") continue;
      const [kind, identity] = d.value.split(/\s+/);
      found.add(`${kind ?? ""} ${identity ?? ""}`);
    }
    for (const s of f.statements) {
      let m = POLICY_RE.exec(s);
      if (m) found.add(`policy ${qualify(m[2]!, m[3])}.${unquote(m[1]!)}`);
      m = TRIGGER_RE.exec(s);
      if (m) found.add(`trigger ${qualify(m[2]!, m[3])}.${unquote(m[1]!)}`);
      m = FUNCTION_RE.exec(s);
      if (m) found.add(`function ${qualify(m[1]!, m[2])}()`);
      m = RLS_RE.exec(s);
      const table = m ? qualify(m[1]!, m[2]) : null;
      if (table !== null && ids.has(`rls ${table}`)) {
        out.push({
          code: "rls_declared_twice",
          severity: "warning",
          message: `${f.path} enables row level security on ${table}, which rls.*() already declares`,
          subject: table,
        });
      }
    }
    for (const key of found) {
      if (key.startsWith("rls ") || !ids.has(key)) continue;
      conflict(f.path, `creates ${key}, which ${ids.get(key)!} declares`);
    }
  }
  return out;
}

/* --------------------------------- census --------------------------------- */

export interface CatalogMark {
  readonly kind: Exclude<DeclaredKind, "rls">;
  readonly identity: string;
  /** `sha256:<hex>` from the marker, or null when the object carries none. */
  readonly hash: string | null;
}

const Q_MARKS = `
SELECT 'policy' AS kind, n.nspname AS s, n.nspname || '.' || c.relname || '.' || p.polname AS id,
       obj_description(p.oid, 'pg_policy') AS d
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
UNION ALL
SELECT 'trigger', n.nspname, n.nspname || '.' || c.relname || '.' || g.tgname, obj_description(g.oid, 'pg_trigger')
  FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE NOT g.tgisinternal
UNION ALL
SELECT 'function', n.nspname, n.nspname || '.' || p.proname || '()', obj_description(p.oid, 'pg_proc')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.pronargs = 0 AND p.prokind = 'f'`;

/** Declared-kind objects that are either named in `ids` or marked in `schemas`. */
export async function readMarks(
  client: CatalogClient,
  schemas: readonly string[],
  ids: readonly string[],
): Promise<CatalogMark[]> {
  const r = await client.query(
    `SELECT kind, id, d FROM (${Q_MARKS}) x
      WHERE id = ANY($2) OR (s = ANY($1) AND d LIKE '${MARKER}%')
      ORDER BY kind, id`,
    [[...schemas], [...ids]],
  );
  return (r.rows as { kind: CatalogMark["kind"]; id: string; d: string | null }[]).map((row) => ({
    kind: row.kind,
    identity: row.id,
    hash: row.d?.startsWith(MARKER) === true ? row.d.slice(MARKER.length) : null,
  }));
}

/** The `-- pg-prime:object` headers of the declared files among `files`. */
export function declaredObjects(files: readonly RepeatableFile[]): { path: string; object: DeclaredObject }[] {
  const out: { path: string; object: DeclaredObject }[] = [];
  for (const f of files) {
    if (!isDeclared(f)) continue;
    for (const d of f.directives) {
      if (d.name !== "object") continue;
      const parts = d.value.split(" ");
      const kind = parts[0] as DeclaredKind;
      if (!["rls", "policy", "trigger", "function"].includes(kind) || parts.length < 3) continue;
      out.push({ path: f.path, object: { kind, identity: parts.slice(1, -1).join(" "), state: parts.at(-1)! } });
    }
  }
  return out;
}

export interface DeclaredCensus {
  /** `declared_missing`, `declared_orphan`, `declared_unmarked`; `path` is the file that fixes it. */
  readonly findings: readonly (Diagnostic & { readonly path?: string })[];
  /** Files whose objects are missing, stale, unmarked or in the wrong FORCE state (D24). */
  readonly heal: ReadonlySet<string>;
}

/** §5.5: the `-- pg-prime:object` headers of `files` against the catalog's markers and FORCE flags. */
export async function declaredCensus(
  client: CatalogClient,
  files: readonly RepeatableFile[],
  schemas: readonly string[],
): Promise<DeclaredCensus> {
  const declared = declaredObjects(files);
  const prune = files.find((f) => isDeclared(f) && f.directives[0]!.value === "prune");
  if (declared.length === 0 && prune === undefined) return { findings: [], heal: new Set() };

  const ids = declared.filter((d) => d.object.kind !== "rls").map((d) => d.object.identity);
  const marks = new Map((await readMarks(client, schemas, ids)).map((m) => [`${m.kind} ${m.identity}`, m]));
  const tables = declared.filter((d) => d.object.kind === "rls").map((d) => d.object.identity);
  const forced = new Map<string, boolean>();
  if (tables.length > 0) {
    const r = await client.query(
      `SELECT n.nspname || '.' || c.relname AS id, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND n.nspname || '.' || c.relname = ANY($1)`,
      [tables],
    );
    for (const row of r.rows as { id: string; forced: boolean }[]) forced.set(row.id, row.forced);
  }

  const findings: (Diagnostic & { path?: string })[] = [];
  const heal = new Set<string>();
  const finding = (code: string, subject: string, message: string, path?: string): void => {
    findings.push({ code, severity: "error", message, subject, ...(path === undefined ? {} : { path }) });
    if (path !== undefined) heal.add(path);
  };
  const keep = new Set<string>();
  for (const { path, object: o } of declared) {
    const what = `${o.kind} ${o.identity}`;
    if (o.kind === "rls") {
      const want = o.state === "force";
      const have = forced.get(o.identity);
      if (have !== undefined && have !== want) {
        finding(
          "declared_missing",
          o.identity,
          `${o.identity} should be ${want ? "FORCE" : "NO FORCE"} ROW LEVEL SECURITY (${path})`,
          path,
        );
      }
      continue;
    }
    keep.add(what);
    const m = marks.get(what);
    if (m === undefined)
      finding("declared_missing", o.identity, `${what} is declared in ${path} and missing from the database`, path);
    else if (m.hash === null)
      finding(
        "declared_unmarked",
        o.identity,
        `${what} exists without the pg-prime:declared marker; ${path} will replace it`,
        path,
      );
    else if (m.hash !== o.state)
      finding("declared_missing", o.identity, `${what} carries ${m.hash}, ${path} declares ${o.state}`, path);
  }
  for (const [key, m] of marks) {
    if (keep.has(key) || m.hash === null) continue;
    finding(
      "declared_orphan",
      m.identity,
      `${key} carries the pg-prime:declared marker and is no longer declared`,
      prune?.path,
    );
  }
  return { findings, heal };
}
