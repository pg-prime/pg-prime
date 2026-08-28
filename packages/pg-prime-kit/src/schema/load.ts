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
import { remapDiagnostics, remapIr } from "./remap.js";
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
