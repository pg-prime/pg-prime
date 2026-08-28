/**
 * The history tables — design/06 §4.4, verbatim, with `pgprime` substituted for the
 * document's `pg_orm` (design/11 §1.1: `pgprime` per layer, never `pg_prime_`).
 *
 * One addition the design does not have: `pgprime.meta`. A schema that a later release
 * must migrate needs a version it can read BEFORE it reads anything else, and inferring
 * it from `information_schema.columns` is guesswork. `history_version` is written once,
 * on the first `ensureHistory`, and never touched again by this release.
 */

import type { CatalogClient } from "../catalog/extract.js";

/** Every history object lives here. Also the default managed-schema exclusion. */
export const HISTORY_SCHEMA = "pgprime";

/** Bumped when the shape of the tables below changes. Read from `pgprime.meta`. */
export const HISTORY_VERSION = "1";

/** design/06 §4.4's `status` column. `superseded` is reserved for K4's checkpoints. */
export type MigrationStatus = "running" | "applied" | "failed" | "baselined" | "superseded";

/**
 * The DDL, one statement per array element.
 *
 * `IF NOT EXISTS` on every object makes the sequence idempotent for the single-runner
 * case; it does NOT make it race-free (two sessions doing `CREATE TABLE IF NOT EXISTS`
 * concurrently can both pass the existence check and one then gets a 23505 on
 * `pg_type_typname_nsp_index`), which is why `ensureHistory` retries.
 */
export const HISTORY_DDL: readonly string[] = [
  `CREATE SCHEMA IF NOT EXISTS ${HISTORY_SCHEMA}`,
  `CREATE TABLE IF NOT EXISTS ${HISTORY_SCHEMA}.migrations (
  id                  text PRIMARY KEY,
  seq                 integer     NOT NULL,
  name                text        NOT NULL,
  checksum            text        NOT NULL,
  plan_id             text,
  fingerprint_from    text,
  fingerprint_to      text,
  txmode              text        NOT NULL,
  statements_total    integer     NOT NULL,
  statements_applied  integer     NOT NULL DEFAULT 0,
  statement_uncertain integer,
  segment_applied     integer     NOT NULL DEFAULT 0,
  status              text        NOT NULL,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  duration_ms         integer,
  applied_by          text        NOT NULL DEFAULT current_user,
  applied_from        text,
  error               jsonb,
  engine_version      text        NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS ${HISTORY_SCHEMA}.repeatables (
  path        text PRIMARY KEY,
  checksum    text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer
)`,
  `CREATE TABLE IF NOT EXISTS ${HISTORY_SCHEMA}.checkpoints (
  id          text PRIMARY KEY,
  fingerprint text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
)`,
  `CREATE TABLE IF NOT EXISTS ${HISTORY_SCHEMA}.lock (
  singleton    boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  run_id       uuid        NOT NULL,
  holder       text        NOT NULL,
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
)`,
  `CREATE TABLE IF NOT EXISTS ${HISTORY_SCHEMA}.data_progress (
  migration_id text PRIMARY KEY,
  watermark    jsonb       NOT NULL,
  rows_done    bigint      NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
)`,
  `CREATE TABLE IF NOT EXISTS ${HISTORY_SCHEMA}.meta (
  key   text PRIMARY KEY,
  value text NOT NULL
)`,
  `INSERT INTO ${HISTORY_SCHEMA}.meta (key, value) VALUES ('history_version', '${HISTORY_VERSION}')
   ON CONFLICT (key) DO NOTHING`,
];

/** SQLSTATEs two concurrent `CREATE … IF NOT EXISTS` runs can raise against each other. */
const CREATE_RACE = new Set([
  "23505", // unique_violation on a pg_catalog index
  "42P06", // duplicate_schema
  "42P07", // duplicate_table
  "42710", // duplicate_object
]);

function sqlState(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * design/06 §5.1 step 3 — idempotent, in its OWN transaction.
 *
 * Its own transaction matters twice: the seven statements must not half-land, and they
 * must not be inside the caller's migration transaction (a failed migration would then
 * roll the history schema away with it).
 */
export async function ensureHistory(client: CatalogClient): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.query("BEGIN");
      for (const ddl of HISTORY_DDL) await client.query(ddl);
      await client.query("COMMIT");
      return;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      // Two runners starting together is the NORMAL case (k8s replicas, design/06 §5.5),
      // and `IF NOT EXISTS` is checked before the catalog row is inserted, so the loser
      // sees a duplicate rather than a no-op. One retry is enough: the object exists now.
      if (attempt === 0 && CREATE_RACE.has(sqlState(err) ?? "")) continue;
      throw err;
    }
  }
}

/** Does `pgprime.migrations` exist? Read-only commands must not create it. */
export async function historyPresent(client: CatalogClient): Promise<boolean> {
  const r = await client.query(`SELECT to_regclass('${HISTORY_SCHEMA}.migrations') IS NOT NULL AS present`);
  return r.rows[0]?.["present"] === true;
}

/** The `history_version` row, or null when the schema has not been created yet. */
export async function historyVersion(client: CatalogClient): Promise<string | null> {
  const r = await client.query(
    `SELECT value FROM ${HISTORY_SCHEMA}.meta WHERE key = 'history_version'`,
  );
  const value = r.rows[0]?.["value"];
  return typeof value === "string" ? value : null;
}
