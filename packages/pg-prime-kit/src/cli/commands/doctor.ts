/**
 * `pg-prime migrate doctor` — design/06 §6.2's read-only health report.
 *
 * "INVALID indexes, `_ccnew%` leftovers, unvalidated constraints, catalog vs history
 * drift, stale locks, orphaned Tier-R objects, unmodeled-kind census." Exit 0, or 4 when
 * there is a finding.
 *
 * Read-only in the strong sense, like `status`: it never calls `ensureHistory`, so
 * pointing it at a database the tool has never touched reports "no history" rather than
 * creating one. Everything it says is a catalog query or a `pgprime` read — nothing is
 * inferred from a report the tool wrote about itself.
 */

import { extractCatalog, observedCounts, type CatalogClient } from "../../catalog/extract.js";
import type { ResolvedConfig } from "../../config/load.js";
import { withClient } from "../../db/pg.js";
import { historyPresent } from "../../history/schema.js";
import { currentFingerprint, readMigrationRows, readRepeatableRows } from "../../history/store.js";
import { planRepeatables } from "../../repeatables/index.js";
import { declaredCensus, isDeclared, PRUNE_FILE, readMarks } from "../../schema/declared.js";
import { inspectLease } from "../../runner/run.js";
import { readMigrationsDir } from "../../runner/files.js";
import { ms, type OptionSpec, type ParseResult } from "../args.js";
import { EXIT, type ExitCode } from "../exit.js";
import { bullets, nowIso, pairs, plural, type CommandOutput } from "../output.js";

export const DOCTOR_OPTIONS: readonly OptionSpec[] = [
  {
    name: "stale-lock-after",
    type: "duration",
    placeholder: "duration",
    describe: "a lease whose heartbeat is older than this is stale",
    defaultText: "60s",
  },
];

const names = (r: { rows: Record<string, unknown>[] }): string[] => r.rows.map((x) => String(x["name"]));

async function catalogFindings(
  client: CatalogClient,
  schemas: readonly string[],
): Promise<{ invalidIndexes: string[]; ccnew: string[]; notValid: string[]; notForced: string[] }> {
  const list = [...schemas];
  const invalid = await client.query(
    `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT i.indisvalid AND n.nspname = ANY($1) ORDER BY 1`,
    [list],
  );
  const ccnew = await client.query(
    `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'i' AND c.relname LIKE '%\\_ccnew%' AND n.nspname = ANY($1) ORDER BY 1`,
    [list],
  );
  const notValid = await client.query(
    `SELECT n.nspname || '.' || t.relname || '.' || c.conname AS name
       FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE NOT c.convalidated AND n.nspname = ANY($1) ORDER BY 1`,
    [list],
  );
  const notForced = await client.query(
    `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner
      WHERE c.relrowsecurity AND NOT c.relforcerowsecurity AND r.rolcanlogin AND NOT (r.rolsuper OR r.rolbypassrls)
        AND n.nspname = ANY($1) ORDER BY 1`,
    [list],
  );
  return {
    invalidIndexes: names(invalid),
    ccnew: names(ccnew),
    notValid: names(notValid),
    notForced: names(notForced),
  };
}

export async function runDoctor(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput> {
  const started = Date.now();
  const staleAfter = ms(argv.values, "stale-lock-after") ?? config.config.staleLockAfterMs;

  return withClient(config.connection, async (client) => {
    const present = await historyPresent(client);
    const rows = present ? await readMigrationRows(client) : [];
    const lease = await inspectLease(client, staleAfter);
    const catalog = await catalogFindings(client, config.schemas);
    const extracted = await extractCatalog(client, { schemas: config.schemas, observe: true });

    /* history vs catalog: the fingerprint of record against the live one. */
    const recorded = currentFingerprint(rows);
    const live = extracted.ir.fingerprint;
    const fingerprintDrift = recorded !== null && recorded !== live;

    /* files on disk vs recorded rows. */
    const { files } = await readMigrationsDir(config.migrationsDir);
    const onDisk = new Set(files.map((f) => f.id));
    const missingFiles = rows.filter((r) => !onDisk.has(r.id)).map((r) => r.id);
    const partial = rows
      .filter((r) => r.status === "running" || (r.status === "failed" && r.statementsApplied > 0))
      .map((r) => `${r.id} (${String(r.statementsApplied)}/${String(r.statementsTotal)})`);

    /* Tier R: recorded, no longer on disk — design/06 §2.2 says removal is never auto-detected. */
    const tracked = present ? await readRepeatableRows(client) : [];
    const repeatables = await planRepeatables(config.repeatablesDir, new Map(tracked.map((r) => [r.path, r.checksum])));

    /* design/20 §5.5: declared objects against their catalog markers, pending files skipped. */
    const pending = new Set(repeatables.toApply.map((f) => f.path));
    const lane = [...repeatables.toApply, ...repeatables.unchanged];
    const census = (await declaredCensus(client, lane, config.schemas)).findings.filter(
      (d) => d.path === undefined || !pending.has(d.path),
    );
    const declared = lane.filter(isDeclared);
    const pruneDeletable =
      declared.length > 0 &&
      declared.every((f) => f.path.endsWith(`/${PRUNE_FILE}`)) &&
      (await readMarks(client, config.schemas, [])).length === 0;

    /* Tier O census and Tier U census. */
    const observed = observedCounts(extracted.observed);
    const unmodeled = extracted.diagnostics
      .filter((d) => d.code === "unmodeled_kind")
      .map((d) => ({ kind: d.subject ?? "?", count: d.count ?? 0 }));

    const findings: string[] = [
      ...catalog.invalidIndexes.map(
        (n) =>
          `INVALID index ${n} — a CREATE INDEX CONCURRENTLY did not finish; DROP INDEX CONCURRENTLY it and rebuild`,
      ),
      ...catalog.ccnew.map((n) => `${n} is a REINDEX CONCURRENTLY leftover (_ccnew); it is not used by any query`),
      ...catalog.notValid.map(
        (n) => `${n} is NOT VALID — existing rows were never checked; ALTER TABLE … VALIDATE CONSTRAINT`,
      ),
      // The two fingerprints are in `history` above rather than in the sentence: they are
      // 71 characters each, they say nothing to a human, and putting them here made the
      // finding unreadable in a terminal and unstable in a golden.
      ...(fingerprintDrift
        ? [
            "the catalog does not match the fingerprint pgprime.migrations records — something changed outside the migration history (see `history` for both values)",
          ]
        : []),
      ...missingFiles.map((id) => `${id} is recorded as applied but ${id}.sql is not on disk`),
      ...partial.map((p) => `${p} is partially applied`),
      ...(lease.lease !== null && lease.stale
        ? [
            `a stale lease is held by ${lease.lease.holder} (last beat ${String(lease.lease.heartbeatAgeMs)} ms ago); \`migrate unlock --force\` breaks it`,
          ]
        : []),
      ...census.map((d) => `${d.code}: ${d.message}`),
      ...catalog.notForced.map(
        (n) =>
          `rls_not_forced: ${n} has row level security enabled, not FORCE'd, and its owner can log in — the owner bypasses every policy; use rls.force() or a non-owner application role`,
      ),
      ...repeatables.orphaned.map(
        (p) =>
          `${p} is recorded in pgprime.repeatables but is gone from disk — the objects it created are STILL in the database (design/06 §2.2: a Tier-R removal is never auto-detected)`,
      ),
    ];

    const exitCode: ExitCode = findings.length > 0 ? EXIT.drift : EXIT.ok;
    return {
      exitCode,
      envelope: {
        command: "migrate doctor",
        status: findings.length > 0 ? "findings" : "healthy",
        exitCode,
        at: nowIso(),
        durationMs: Date.now() - started,
        database: config.connection.database,
        migrationsDir: config.migrationsDir,
        schemas: config.schemas,
        history: { present, recordedFingerprint: recorded, liveFingerprint: live, drift: fingerprintDrift },
        invalidIndexes: catalog.invalidIndexes,
        ccnewLeftovers: catalog.ccnew,
        notValidConstraints: catalog.notValid,
        missingFiles,
        partiallyApplied: partial,
        lock: { held: lease.lease !== null, stale: lease.stale, holder: lease.lease },
        repeatables: {
          tracked: tracked.length,
          drift: repeatables.toApply.map((f) => f.path),
          orphaned: repeatables.orphaned,
        },
        observed,
        unmodeled,
        declared: { findings: census.map((d) => ({ code: d.code, subject: d.subject ?? null })), pruneDeletable },
        findings,
        error: null,
      },
      text: [
        `migrate doctor — ${config.connection.database}`,
        "",
        pairs([
          ["history", present ? `present, ${plural(rows.length, "row")}` : "absent"],
          ["fingerprint", fingerprintDrift ? `DRIFT (${live} live, ${recorded ?? "?"} recorded)` : live],
          ["lock", lease.lease === null ? "free" : lease.stale ? "STALE" : "held"],
          [
            "tier O",
            observed.length === 0 ? "nothing observed" : observed.map((o) => `${String(o.count)} ${o.kind}`).join(", "),
          ],
          [
            "tier U",
            unmodeled.length === 0
              ? "nothing unmodeled"
              : unmodeled.map((o) => `${String(o.count)} ${o.kind}`).join(", "),
          ],
        ]),
        bullets("findings:", findings),
        findings.length === 0 ? "\nno findings." : "",
        pruneDeletable ? `\nno declared objects are left: ${PRUNE_FILE} may be deleted.` : "",
      ]
        .filter((l) => l !== "")
        .join("\n"),
    };
  });
}
