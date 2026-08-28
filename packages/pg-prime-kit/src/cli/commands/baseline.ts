/**
 * `pg-prime migrate baseline [--at <id>] [--force]` — design/06 §6.2, design/11 §1.9.
 *
 * "Baseline writes a real migration." `0000_baseline.sql` + `.plan.json` hold the whole
 * current schema as DDL, produced by the ordinary create path (`diffIR(empty, current)`
 * → `buildStatements` → `orderStatements`), so `verify` can replay a baselined repo from
 * empty like any other file. Nothing is executed: the objects already exist. The history
 * row is `baselined` and its `fingerprint_to` is the live fingerprint, which is what makes
 * the next `apply`'s fast-path gate work on an adopted database.
 */

import { extractCatalog, type CatalogClient } from "../../catalog/extract.js";
import type { ResolvedConfig } from "../../config/load.js";
import { withClient } from "../../db/pg.js";
import { buildStatements } from "../../diff/ddl.js";
import { diffIR } from "../../diff/diff.js";
import { orderStatements } from "../../diff/order.js";
import { SchemaIR } from "../../ir/fact.js";
import { encodeId, idName } from "../../ir/stable-id.js";
import { ensureHistory } from "../../history/schema.js";
import { beginRow, markApplied, readMigrationRows } from "../../history/store.js";
import { writePlan, WriteRefusedError } from "../../plan/emit.js";
import { buildPlan, ENGINE, type Plan } from "../../plan/plan.js";
import { readMigrationsDir } from "../../runner/files.js";
import { bool, str, type OptionSpec, type ParseResult } from "../args.js";
import { EXIT } from "../exit.js";
import { bullets, nowIso, pairs, plural, type CommandOutput } from "../output.js";

export const BASELINE_OPTIONS: readonly OptionSpec[] = [
  {
    name: "at",
    type: "string",
    placeholder: "id",
    describe:
      "adopt an existing directory instead: mark every file up to and including <id> as baselined, executing nothing",
  },
  { name: "force", type: "boolean", describe: "proceed even though pgprime.migrations is not empty" },
  { name: "by", type: "string", placeholder: "name", describe: "recorded as the plan's author", defaultText: "$USER" },
];

export async function runBaseline(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput> {
  const started = Date.now();
  const at = str(argv.values, "at");
  const force = bool(argv.values, "force");

  return withClient(config.connection, async (client) => {
    await ensureHistory(client);
    const rows = await readMigrationRows(client);
    if (rows.length > 0 && !force) {
      return refusal(
        config,
        started,
        `${plural(rows.length, "row")} already exist in pgprime.migrations (${rows
          .slice(0, 3)
          .map((r) => r.id)
          .join(", ")}` +
          `${rows.length > 3 ? ", …" : ""}). baseline rewrites the start of history; pass --force if that is what you mean.`,
      );
    }

    const engineVersion = ENGINE.version;
    const appliedFrom = config.env ?? null;

    if (at !== undefined) {
      const { files } = await readMigrationsDir(config.migrationsDir);
      const target = files.find((f) => f.id === at || String(f.seq).padStart(4, "0") === at || f.name === at);
      if (!target)
        return refusal(config, started, `--at ${JSON.stringify(at)} names no migration in ${config.migrationsDir}`);
      // "The database is AT 0003" means 0000..0003 all ran, by whatever tool. Marking only
      // the named file would leave its predecessors pending and `apply` would run them.
      const adopt = files.filter((f) => f.seq < target.seq || (f.seq === target.seq && f.name <= target.name));
      for (const file of adopt) {
        await beginRow(client, {
          id: file.id,
          seq: file.seq,
          name: file.name,
          checksum: file.checksum,
          planId: file.plan?.planId ?? null,
          fingerprintFrom: file.plan?.from.fingerprint ?? null,
          fingerprintTo: file.plan?.to.fingerprint ?? null,
          txmode: file.txmode,
          statementsTotal: file.statements.length,
          statementsApplied: file.statements.length,
          segmentApplied: 0,
          status: "baselined",
          appliedFrom,
          engineVersion,
        });
        await markApplied(client, file.id, file.statements.length);
        await client.query("UPDATE pgprime.migrations SET status = 'baselined' WHERE id = $1", [file.id]);
      }
      const durationMs = Date.now() - started;
      return {
        exitCode: EXIT.ok,
        envelope: {
          command: "migrate baseline",
          status: "marked",
          exitCode: EXIT.ok,
          at: nowIso(),
          durationMs,
          database: config.connection.database,
          migrationsDir: config.migrationsDir,
          schemas: config.schemas,
          marked: adopt.map((f) => f.id),
          written: null,
          migration: null,
          warnings: [],
          error: null,
        },
        text: [
          `migrate baseline --at ${at}`,
          "",
          `marked ${plural(adopt.length, "migration")} as baselined without executing anything:`,
          ...adopt.map((f) => `  ${f.id}`),
        ].join("\n"),
      };
    }

    /* No --at: introspect and write 0000_baseline. */
    const extracted = await extractCatalog(client, { schemas: config.schemas });
    const empty = await freshDatabaseIR(client, extracted.ir, config.schemas);
    const diff = diffIR(empty, extracted.ir);
    const built = buildStatements(diff, extracted.ir);
    const ordered = orderStatements(built.statements);
    const diagnostics = [...extracted.diagnostics, ...built.diagnostics, ...ordered.diagnostics];

    const plan: Plan = buildPlan({
      seq: 0,
      name: "baseline",
      statements: ordered.statements,
      segments: ordered.segments,
      fromFingerprint: empty.fingerprint,
      toFingerprint: extracted.ir.fingerprint,
      pgVersionNum: extracted.pgVersionNum,
      renames: [],
      diagnostics,
      schemas: config.schemas,
      ...(str(argv.values, "by") === undefined ? {} : { by: str(argv.values, "by")! }),
      // Nothing to prove: the DDL below describes a database that already exists, and it
      // is never executed by this command. design/11 §1.9.
      proof: { status: "skipped", reason: "baseline", at: nowIso() },
    });

    let written: { sqlPath: string; planPath: string };
    try {
      written = await writePlan(config.migrationsDir, plan, { allowUnproven: true });
    } catch (err) {
      if (err instanceof WriteRefusedError) return refusal(config, started, err.message);
      throw err;
    }

    await beginRow(client, {
      id: "0000_baseline",
      seq: 0,
      name: "baseline",
      checksum: plan.migration.sha256,
      planId: plan.planId,
      fingerprintFrom: plan.from.fingerprint,
      fingerprintTo: plan.to.fingerprint,
      txmode: plan.txmode,
      statementsTotal: plan.statements.length,
      statementsApplied: plan.statements.length,
      segmentApplied: 0,
      status: "baselined",
      appliedFrom,
      engineVersion,
    });
    await markApplied(client, "0000_baseline", plan.statements.length);
    await client.query("UPDATE pgprime.migrations SET status = 'baselined' WHERE id = '0000_baseline'");

    const durationMs = Date.now() - started;
    const warnings = diagnostics.filter((d) => d.severity !== "info").map((d) => `${d.code}: ${d.message}`);
    return {
      exitCode: EXIT.ok,
      envelope: {
        command: "migrate baseline",
        status: "baselined",
        exitCode: EXIT.ok,
        at: nowIso(),
        durationMs,
        database: config.connection.database,
        migrationsDir: config.migrationsDir,
        schemas: config.schemas,
        marked: ["0000_baseline"],
        written: { sql: written.sqlPath, plan: written.planPath },
        migration: {
          id: "0000_baseline",
          planId: plan.planId,
          statements: plan.statements.length,
          txmode: plan.txmode,
          fingerprint: plan.to.fingerprint,
          proof: plan.proof,
        },
        warnings,
        error: null,
      },
      text: [
        "migrate baseline",
        "",
        pairs([
          ["wrote", written.sqlPath],
          ["plan", written.planPath],
          ["statements", String(plan.statements.length)],
          ["fingerprint", plan.to.fingerprint],
          ["history", "0000_baseline recorded as baselined; nothing was executed"],
        ]),
        bullets("warnings:", warnings),
      ]
        .filter((l) => l !== "")
        .join("\n"),
    };
  });
}

/** `FirstNormalObjectId` — every OID below it was assigned by `initdb`, not by a user. */
const FIRST_NORMAL_OID = 16384;

/**
 * The IR of a database PostgreSQL has just created, restricted to the managed schemas.
 *
 * `SchemaIR.build([], [])` is the wrong "from": it is the *null* IR, and no real database
 * ever matches it — a fresh one already has `public`, so a baseline whose
 * `from.fingerprint` was the null hash could never pass its own fingerprint gate on
 * replay, and `verify`'s "replay from empty" would fail on the very first file. The
 * schemas that come with the database are exactly those whose OID `initdb` assigned, so
 * the server is asked rather than `'public'` being hard-coded: a cluster that pins a
 * different set answers for itself.
 */
async function freshDatabaseIR(
  client: CatalogClient,
  current: SchemaIR,
  schemas: readonly string[],
): Promise<SchemaIR> {
  const r = await client.query(
    `SELECT nspname FROM pg_namespace WHERE nspname = ANY($1) AND oid < ${String(FIRST_NORMAL_OID)}`,
    [[...schemas]],
  );
  const builtIn = new Set(r.rows.map((row) => String(row["nspname"])));
  // The same rule for the two other things `initdb` leaves behind that the extractor can see:
  // the comment it puts on `public` ('standard public schema') and any extension it installed
  // into a managed schema. Without these a fresh database's own furniture becomes the first
  // statements of every baseline, and its replay-from-empty fingerprint never matches.
  const ext = await client.query(`SELECT extname FROM pg_extension WHERE oid < ${String(FIRST_NORMAL_OID)}`);
  const builtInExtensions = new Set(ext.rows.map((row) => String(row["extname"])));
  const schemaFacts = current.factsOfKind("schema").filter((f) => builtIn.has(idName(f.id)));
  const schemaIds = new Set(schemaFacts.map((f) => encodeId(f.id)));
  const commentFacts = current
    .factsOfKind("comment")
    .filter((f) => f.id.kind === "comment" && schemaIds.has(f.id.target));
  const extensionFacts = current.factsOfKind("extension").filter((f) => builtInExtensions.has(idName(f.id)));
  const facts = [...schemaFacts, ...commentFacts, ...extensionFacts];
  const kept = new Set(facts.map((f) => encodeId(f.id)));
  const edges = current.edges().filter((e) => kept.has(encodeId(e.from)) && kept.has(encodeId(e.to)));
  return SchemaIR.build(facts, edges);
}

function refusal(config: ResolvedConfig, started: number, message: string): CommandOutput {
  return {
    exitCode: EXIT.error,
    envelope: {
      command: "migrate baseline",
      status: "refused",
      exitCode: EXIT.error,
      at: nowIso(),
      durationMs: Date.now() - started,
      database: config.connection.database,
      migrationsDir: config.migrationsDir,
      schemas: config.schemas,
      marked: [],
      written: null,
      migration: null,
      warnings: [],
      error: { code: "baseline_refused", message },
    },
    text: `migrate baseline\n\nREFUSED: ${message}`,
  };
}
