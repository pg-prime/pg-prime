/**
 * `loadDesired` — the `desired SQL text → [shadow DB] → extract → IR(desired)` leg of design/06 §3
 * (design/11 §3 K2a item 4). This is the function `migrate generate` calls in K2b.
 *
 * There is no second modelling of PostgreSQL anywhere in this path: the emitter produces text, the
 * server parses it, `extractCatalog` reads the catalog, and the schema map is reversed on the way
 * out. Anything the DSL can say that PostgreSQL disagrees with fails HERE, at generate time, on a
 * shadow — not at apply time on the user's database.
 */

import { extractCatalog, type ExtractResult } from "../catalog/extract.js";
import type { Diagnostic } from "../catalog/extract.js";
import { withClient } from "../db/pg.js";
import { emitSchema, type EmitOptions } from "./emit.js";
import { remapDiagnostics, remapIr, remapObserved } from "./remap.js";
import { quoteIdent, quoteLiteral } from "../sql/ident.js";
import type { SchemaLike } from "./types.js";
import type { Shadow } from "../shadow/ladder.js";

export interface LoadDesiredOptions {
  readonly defaultSchema?: string;
  /** Forwarded to `extractCatalog`; the shadow is ours, so a short one is safe. */
  readonly statementTimeout?: string;
}

export class DesiredLoadError extends Error {
  readonly code = "PG_PRIME_DESIRED_LOAD";
  constructor(
    message: string,
    readonly sql: string | undefined,
    readonly diagnostics: readonly Diagnostic[],
  ) {
    super(message);
    this.name = "DesiredLoadError";
  }
}

/**
 * Emit the schema into the shadow, read it back, and return the IR in the CALLER's schema names.
 *
 * The emitter's diagnostics are merged into the result rather than thrown, with one exception: an
 * `error`-severity emit diagnostic stops the load before a single statement runs. Under the
 * temp-schema tier an unmapped schema would put the desired state into the user's real `public`,
 * so "report and continue" is not available on that path.
 */
export async function loadDesired(
  schema: SchemaLike,
  shadow: Shadow,
  options: LoadDesiredOptions = {},
): Promise<ExtractResult> {
  const emitOptions: EmitOptions = {
    schemaMap: shadow.schemaMap,
    ...(options.defaultSchema === undefined ? {} : { defaultSchema: options.defaultSchema }),
  };
  const emitted = emitSchema(schema, emitOptions);
  const fatal = emitted.diagnostics.filter((d) => d.severity === "error");
  if (fatal.length > 0) {
    throw new DesiredLoadError(
      `the desired schema cannot be emitted: ${fatal.map((d) => `${d.code} — ${d.message}`).join("; ")}`,
      undefined,
      emitted.diagnostics,
    );
  }

  const shadowSchemas = [...new Set(shadow.schemaMap.values())].sort();

  // Schema comments are not declared by the DSL (no `pgSchema(...).comment()` yet), so the desired
  // state MIRRORS the target's: `public` is created by initdb with 'standard public schema', a
  // fresh tier-2 database has the same default, a tier-3 shadow schema has none — and only the
  // target's own value is not a phantom delta. Read before the load, written after it, so a schema
  // the emitter creates (`audit`) is covered as well as one it finds (`public`).
  const targetComments = await withClient(shadow.target, async (client) => {
    const r = await client.query(
      "SELECT nspname, obj_description(oid, 'pg_namespace') AS comment FROM pg_namespace WHERE nspname = ANY($1)",
      [[...shadow.schemaMap.keys()]],
    );
    const out = new Map<string, string>();
    for (const row of r.rows as { nspname: string; comment: string | null }[]) {
      if (row.comment !== null) out.set(row.nspname, row.comment);
    }
    return out;
  });

  const extracted = await withClient(shadow.conn, async (client) => {
    for (const statement of emitted.sql) {
      try {
        await client.query(statement);
      } catch (err) {
        throw new DesiredLoadError(
          `the desired schema failed to load into the shadow (tier ${shadow.tier}): ` +
            `${err instanceof Error ? err.message : String(err)}\n--- statement ---\n${statement}`,
          statement,
          emitted.diagnostics,
        );
      }
    }
    for (const [user, shadowName] of shadow.schemaMap) {
      const comment = targetComments.get(user);
      await client.query(
        `COMMENT ON SCHEMA ${quoteIdent(shadowName)} IS ${comment === undefined ? "NULL" : quoteLiteral(comment)}`,
      );
    }
    return extractCatalog(client, {
      schemas: shadowSchemas,
      ...(options.statementTimeout === undefined ? {} : { statementTimeout: options.statementTimeout }),
    });
  });

  // shadow schema → user schema. Built here rather than stored on the Shadow because the forward
  // map is the one the emitter needs and two copies of one fact drift.
  const reverse = new Map<string, string>();
  for (const [user, shadowName] of shadow.schemaMap) reverse.set(shadowName, user);

  return {
    ir: remapIr(extracted.ir, reverse),
    pgVersionNum: extracted.pgVersionNum,
    observed: remapObserved(extracted.observed, reverse),
    diagnostics: [
      ...emitted.diagnostics,
      ...shadow.diagnostics,
      ...remapDiagnostics(extracted.diagnostics, reverse),
    ],
  };
}

/** The statements `loadDesired` would run, for `--dry-run` and for the golden tests. */
export function desiredSql(schema: SchemaLike, shadow: Shadow, options: LoadDesiredOptions = {}): readonly string[] {
  return emitSchema(schema, {
    schemaMap: shadow.schemaMap,
    ...(options.defaultSchema === undefined ? {} : { defaultSchema: options.defaultSchema }),
  }).sql;
}
