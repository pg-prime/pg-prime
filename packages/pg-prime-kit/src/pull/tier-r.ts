/**
 * Tier R, read out of the catalog for `pg-prime pull` (design/06 §2.2, §3.8).
 *
 * Functions, views, materialized views, triggers, RLS policies and aggregates are **not**
 * facts — they are re-applied from `sql/` by hash rather than diffed — so the IR does not
 * carry them and `pull` has to ask the catalog itself. Every statement produced here is
 * idempotent, because `checkIdempotence` (TX201) refuses a repeatable that is not: a
 * repeatable is re-applied on every deploy whose bytes changed, and a bare `CREATE TRIGGER`
 * wedges the second one.
 *
 * The one editorial decision is on views. design/00 decision 5 makes `security_invoker =
 * true` the default for a view pg-prime *creates*; a view pg-prime *finds* has whatever the
 * database gave it, and PostgreSQL's own default is `false`. Silently rewriting a legacy
 * view to `true` would change who its RLS policies are evaluated as — a security change,
 * made by a tool, without being asked. So the real value is written out explicitly and a
 * comment names the default the project would otherwise get. That is the "legacy views
 * annotated with their real `securityInvoker`" of `00` decision 5.
 */

import type { CatalogClient } from "../catalog/extract.js";

export interface TierRObject {
  /** `function` | `view` | `matview` | `trigger` | `policy` | `aggregate` */
  readonly kind: string;
  readonly schema: string;
  /** human-addressable, e.g. `public.actor_info` or `public.film.last_updated` */
  readonly identity: string;
  /** the `sql/` path this becomes, POSIX and prefixed */
  readonly path: string;
  readonly sql: string;
}

/** Fold an identifier into something safe for a filename, without losing which object it is. */
const fileSlug = (text: string): string =>
  text.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "x";

const q = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * `pg_get_viewdef` and friends never end with a `;` in some versions and do in others; the
 * splitter is `;`-terminated, so one is added exactly once.
 */
const stmt = (text: string): string => `${text.trimEnd().replace(/;+$/, "")};`;

interface Row {
  readonly [key: string]: unknown;
}

const str = (v: unknown): string => String(v);

/* --------------------------------- queries -------------------------------- */

/**
 * Extension-owned objects are excluded everywhere, exactly as the extractor excludes them
 * from the fact base: they belong to the extension, `CREATE EXTENSION` brings them back,
 * and writing them into `sql/` would make the repository claim to own `uuid_generate_v1()`.
 */
const NOT_FROM_EXTENSION = `NOT EXISTS (
  SELECT 1 FROM pg_depend d
   WHERE d.classid = $CLASS$::regclass AND d.objid = $OID$ AND d.deptype = 'e')`;

const Q_FUNCTIONS = `
SELECT n.nspname AS schema, p.proname AS name,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_functiondef(p.oid) AS def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = ANY($1)
   AND p.prokind IN ('f','p')
   AND NOT EXISTS (SELECT 1 FROM pg_aggregate a WHERE a.aggfnoid = p.oid)
   AND ${NOT_FROM_EXTENSION.replace("$CLASS$", "'pg_proc'").replace("$OID$", "p.oid")}
 ORDER BY 1, 2, 3`;

const Q_VIEWS = `
SELECT n.nspname AS schema, c.relname AS name,
       pg_get_viewdef(c.oid, true) AS def,
       coalesce((SELECT option_value FROM pg_options_to_table(c.reloptions)
                  WHERE option_name = 'security_invoker'), 'false') AS security_invoker,
       coalesce((SELECT option_value FROM pg_options_to_table(c.reloptions)
                  WHERE option_name = 'security_barrier'), 'false') AS security_barrier,
       (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
          FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = ANY($1) AND c.relkind = 'v'
   AND ${NOT_FROM_EXTENSION.replace("$CLASS$", "'pg_class'").replace("$OID$", "c.oid")}
 ORDER BY 1, 2`;

const Q_MATVIEWS = `
SELECT n.nspname AS schema, c.relname AS name, pg_get_viewdef(c.oid, true) AS def
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = ANY($1) AND c.relkind = 'm'
   AND ${NOT_FROM_EXTENSION.replace("$CLASS$", "'pg_class'").replace("$OID$", "c.oid")}
 ORDER BY 1, 2`;

/** The indexes of a materialized view: `Q_INDEXES` skips them, so they travel with it. */
const Q_MATVIEW_INDEXES = `
SELECT n.nspname AS schema, mv.relname AS matview, pg_get_indexdef(i.indexrelid) AS def
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class mv ON mv.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = mv.relnamespace
 WHERE n.nspname = ANY($1) AND mv.relkind = 'm'
 ORDER BY 1, 2, 3`;

const Q_TRIGGERS = `
SELECT n.nspname AS schema, c.relname AS "table", t.tgname AS name,
       pg_get_triggerdef(t.oid, true) AS def
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = ANY($1) AND NOT t.tgisinternal
 ORDER BY 1, 2, 3`;

const Q_POLICIES = `
SELECT n.nspname AS schema, c.relname AS "table", p.polname AS name,
       CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE'
                     WHEN 'd' THEN 'DELETE' ELSE 'ALL' END AS command,
       p.polpermissive AS permissive,
       (SELECT string_agg(quote_ident(r.rolname), ', ' ORDER BY r.rolname)
          FROM pg_roles r WHERE r.oid = ANY(p.polroles)) AS roles,
       pg_get_expr(p.polqual, p.polrelid) AS using_expr,
       pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = ANY($1)
 ORDER BY 1, 2, 3`;

const Q_AGGREGATES = `
SELECT n.nspname AS schema, p.proname AS name,
       pg_get_function_identity_arguments(p.oid) AS args,
       format_type(p.prorettype, NULL) AS rettype,
       (SELECT format('%I.%I', tn.nspname, tp.proname) FROM pg_proc tp
          JOIN pg_namespace tn ON tn.oid = tp.pronamespace WHERE tp.oid = a.aggtransfn) AS transfn,
       format_type(a.aggtranstype, NULL) AS transtype,
       a.agginitval AS initcond,
       CASE WHEN a.aggfinalfn = 0 THEN NULL ELSE
         (SELECT format('%I.%I', fn.nspname, fp.proname) FROM pg_proc fp
            JOIN pg_namespace fn ON fn.oid = fp.pronamespace WHERE fp.oid = a.aggfinalfn) END AS finalfn
  FROM pg_aggregate a
  JOIN pg_proc p ON p.oid = a.aggfnoid
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = ANY($1)
   AND ${NOT_FROM_EXTENSION.replace("$CLASS$", "'pg_proc'").replace("$OID$", "p.oid")}
 ORDER BY 1, 2, 3`;

/** Tables with RLS turned on — the `ALTER TABLE … ENABLE ROW LEVEL SECURITY` a policy needs. */
const Q_RLS_TABLES = `
SELECT n.nspname AS schema, c.relname AS name, c.relforcerowsecurity AS forced
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p') AND c.relrowsecurity
 ORDER BY 1, 2`;

/* --------------------------------- the read -------------------------------- */

export interface TierRResult {
  readonly objects: readonly TierRObject[];
  /** what could be read but not written idempotently, for the `unsupported` block */
  readonly unsupported: readonly { readonly kind: string; readonly name: string; readonly reason: string }[];
}

export async function readTierR(
  client: CatalogClient,
  schemas: readonly string[],
  prefix = "sql",
): Promise<TierRResult> {
  const list = [...schemas];
  const objects: TierRObject[] = [];
  const unsupported: { kind: string; name: string; reason: string }[] = [];
  const push = (kind: string, dir: string, schema: string, identity: string, file: string, sql: string): void => {
    objects.push({ kind, schema, identity, path: `${prefix}/${dir}/${file}.sql`, sql });
  };

  /* 010 — functions and procedures. `pg_get_functiondef` already says CREATE OR REPLACE. */
  const functions = (await client.query(Q_FUNCTIONS, [list])).rows as Row[];
  if (functions.length > 0) {
    // PostgreSQL parses a `LANGUAGE sql` body at CREATE time, so a function that calls
    // another one cannot be created before it — and the call graph is not in `pg_depend`
    // for non-atomic SQL bodies, so there is no order to sort them into. `pg_dump` has the
    // same problem and answers it the same way, in its own preamble. The bodies are still
    // checked: they are checked when they RUN, and the shadow load runs the schema's own
    // objects around them.
    objects.push({
      kind: "prelude",
      schema: "",
      identity: "check_function_bodies",
      path: `${prefix}/000_prelude.sql`,
      sql: [
        "-- pg-prime:object prelude check_function_bodies",
        "-- Written by `pg-prime pull`. Functions below are applied in directory order, and a",
        "-- LANGUAGE sql body is parsed at CREATE time, so one that calls another would fail on",
        "-- the alphabet. `pg_dump` emits exactly this line in its preamble for the same reason.",
        "SET check_function_bodies = false;",
      ].join("\n"),
    });
  }
  for (const r of functions) {
    const identity = `${str(r["schema"])}.${str(r["name"])}(${str(r["args"])})`;
    push("function", "010_functions", str(r["schema"]), identity,
      `${fileSlug(str(r["schema"]))}__${fileSlug(str(r["name"]))}__${fileSlug(str(r["args"]))}`,
      `-- pg-prime:object function ${identity}\n${stmt(str(r["def"]))}`);
  }

  /* 020 — views. */
  for (const r of (await client.query(Q_VIEWS, [list])).rows as Row[]) {
    const schema = str(r["schema"]);
    const name = str(r["name"]);
    const identity = `${schema}.${name}`;
    const invoker = str(r["security_invoker"]) === "true";
    const barrier = str(r["security_barrier"]) === "true";
    const options = [`security_invoker = ${invoker ? "true" : "false"}`, ...(barrier ? ["security_barrier = true"] : [])];
    const note = invoker
      ? "-- security_invoker = true: RLS on the underlying tables is evaluated as the CALLER."
      : "-- security_invoker = false — PostgreSQL's own default, and what this database has.\n" +
        "-- design/00 decision 5 makes `true` the default for a view pg-prime CREATES; pull writes\n" +
        "-- the real value rather than changing who this view's RLS is evaluated as.";
    push("view", "020_views", schema, identity, `${fileSlug(schema)}__${fileSlug(name)}`,
      `-- pg-prime:object view ${identity}\n${note}\nCREATE OR REPLACE VIEW ${q(schema)}.${q(name)} ` +
      `WITH (${options.join(", ")}) AS\n${stmt(str(r["def"]))}`);
  }

  /* 030 — materialized views, then their indexes in the same file. */
  const mvIndexes = new Map<string, string[]>();
  for (const r of (await client.query(Q_MATVIEW_INDEXES, [list])).rows as Row[]) {
    const key = `${str(r["schema"])}.${str(r["matview"])}`;
    const existing = mvIndexes.get(key);
    const def = stmt(str(r["def"]).replace(/^CREATE (UNIQUE )?INDEX /, "CREATE $1INDEX IF NOT EXISTS "));
    if (existing) existing.push(def);
    else mvIndexes.set(key, [def]);
  }
  for (const r of (await client.query(Q_MATVIEWS, [list])).rows as Row[]) {
    const schema = str(r["schema"]);
    const name = str(r["name"]);
    const identity = `${schema}.${name}`;
    // `IF NOT EXISTS` and no `OR REPLACE`: PostgreSQL has no `CREATE OR REPLACE
    // MATERIALIZED VIEW`, so re-applying a CHANGED matview needs a human (drop + create is
    // a data loss this file will not perform behind anyone's back).
    push("matview", "030_matviews", schema, identity, `${fileSlug(schema)}__${fileSlug(name)}`,
      [
        `-- pg-prime:object matview ${identity}`,
        "-- PostgreSQL has no CREATE OR REPLACE MATERIALIZED VIEW. Changing the query below needs a",
        "-- DROP first, which is a decision (and a REFRESH) rather than something a repeatable does.",
        `CREATE MATERIALIZED VIEW IF NOT EXISTS ${q(schema)}.${q(name)} AS\n${stmt(str(r["def"]))}`,
        ...(mvIndexes.get(identity) ?? []),
      ].join("\n"));
  }

  /* 040 — RLS enablement, then the policies. */
  for (const r of (await client.query(Q_RLS_TABLES, [list])).rows as Row[]) {
    const schema = str(r["schema"]);
    const name = str(r["name"]);
    const identity = `${schema}.${name}`;
    push("rls", "040_rls", schema, identity, `${fileSlug(schema)}__${fileSlug(name)}`,
      [
        `-- pg-prime:object rls ${identity}`,
        `ALTER TABLE ${q(schema)}.${q(name)} ENABLE ROW LEVEL SECURITY;`,
        ...(r["forced"] === true ? [`ALTER TABLE ${q(schema)}.${q(name)} FORCE ROW LEVEL SECURITY;`] : []),
      ].join("\n"));
  }
  for (const r of (await client.query(Q_POLICIES, [list])).rows as Row[]) {
    const schema = str(r["schema"]);
    const table = str(r["table"]);
    const name = str(r["name"]);
    const identity = `${schema}.${table}.${name}`;
    const bits = [
      `CREATE POLICY ${q(name)} ON ${q(schema)}.${q(table)}`,
      `  AS ${r["permissive"] === true ? "PERMISSIVE" : "RESTRICTIVE"}`,
      `  FOR ${str(r["command"])}`,
      `  TO ${r["roles"] === null || r["roles"] === undefined ? "PUBLIC" : str(r["roles"])}`,
      ...(r["using_expr"] === null || r["using_expr"] === undefined ? [] : [`  USING (${str(r["using_expr"])})`]),
      ...(r["check_expr"] === null || r["check_expr"] === undefined ? [] : [`  WITH CHECK (${str(r["check_expr"])})`]),
    ];
    push("policy", "050_policies", schema, identity, `${fileSlug(schema)}__${fileSlug(table)}__${fileSlug(name)}`,
      [
        `-- pg-prime:object policy ${identity}`,
        `DROP POLICY IF EXISTS ${q(name)} ON ${q(schema)}.${q(table)};`,
        `${bits.join("\n")};`,
      ].join("\n"));
  }

  /* 015 — aggregates, before the views: a view may call one (pagila's `group_concat`),
   * and an aggregate's SFUNC is a function, so this sits between the two. */
  for (const r of (await client.query(Q_AGGREGATES, [list])).rows as Row[]) {
    const schema = str(r["schema"]);
    const name = str(r["name"]);
    const identity = `${schema}.${name}(${str(r["args"])})`;
    const parts = [
      `SFUNC = ${str(r["transfn"])}`,
      `STYPE = ${str(r["transtype"])}`,
      ...(r["finalfn"] === null || r["finalfn"] === undefined ? [] : [`FINALFUNC = ${str(r["finalfn"])}`]),
      ...(r["initcond"] === null || r["initcond"] === undefined ? [] : [`INITCOND = '${str(r["initcond"]).replace(/'/g, "''")}'`]),
    ];
    push("aggregate", "015_aggregates", schema, identity,
      `${fileSlug(schema)}__${fileSlug(name)}__${fileSlug(str(r["args"]))}`,
      [
        `-- pg-prime:object aggregate ${identity}`,
        `DROP AGGREGATE IF EXISTS ${q(schema)}.${q(name)}(${str(r["args"])});`,
        `CREATE AGGREGATE ${q(schema)}.${q(name)}(${str(r["args"])}) (\n  ${parts.join(",\n  ")}\n);`,
      ].join("\n"));
  }

  /* 070 — triggers, last: a trigger's function must exist first. */
  for (const r of (await client.query(Q_TRIGGERS, [list])).rows as Row[]) {
    const schema = str(r["schema"]);
    const table = str(r["table"]);
    const name = str(r["name"]);
    const identity = `${schema}.${table}.${name}`;
    push("trigger", "070_triggers", schema, identity, `${fileSlug(schema)}__${fileSlug(table)}__${fileSlug(name)}`,
      [
        `-- pg-prime:object trigger ${identity}`,
        `DROP TRIGGER IF EXISTS ${q(name)} ON ${q(schema)}.${q(table)};`,
        stmt(str(r["def"])),
      ].join("\n"));
  }

  return { objects, unsupported };
}
