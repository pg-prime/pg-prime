/** design/20 §3.3's example: tenant isolation, a restrictive policy, a raw subquery, `updated_at`. */

import { definePolicy, defineSchema, eq, pgTable, rls, setting, sql, updatedAtTrigger, uuidCodec } from "pg-prime";
import type { SchemaLike } from "../../src/schema/types.js";
import { withAdmin } from "../support/db.js";

/** Rendering only; the database suites grant to PUBLIC, so they leave no role behind. */
export const APP_ROLE = "app_user";

export const orgId = setting("app.org_id", uuidCodec);

export const documents = pgTable(
  "documents",
  (t) => ({
    id: t.uuid().primaryKey().defaultSql("gen_random_uuid()"),
    orgId: t.uuid(),
    archived: t.boolean().default(false),
    updatedAt: t.timestamptz().defaultSql("now()"),
  }),
  (t) => [rls.force(), updatedAtTrigger(t.updatedAt)],
);

export const documentShares = pgTable("document_shares", (t) => ({
  documentId: t.uuid(),
  orgId: t.uuid(),
}));

/** `tenant`, `archived_read_only` (restrictive) and `shared` on `documents`, granted to `role`. */
export const policiesFor = (role: string) => [
  definePolicy("tenant", {
    on: documents,
    to: [role],
    using: (t) => eq(t.orgId, orgId.current()),
    withCheck: (t) => eq(t.orgId, orgId.current()),
  }),
  definePolicy("archived_read_only", {
    on: documents,
    for: "update",
    as: "restrictive",
    to: [role],
    using: (t) => eq(t.archived, false),
  }),
  definePolicy("shared", {
    on: documents,
    for: "select",
    to: [role],
    using: (t) => sql`EXISTS (SELECT 1 FROM document_shares s
                     WHERE s.document_id = ${t.id} AND s.org_id = ${orgId.current()})`,
  }),
];

export const POLICIES = policiesFor(APP_ROLE);

/** RLS checks need `SET ROLE` to a non-superuser, so the suites need a role that may create one. */
export const canCreateRoles = (): Promise<boolean> =>
  withAdmin(async (c) => {
    const r = await c.query("SELECT rolsuper OR rolcreaterole AS ok FROM pg_roles WHERE rolname = current_user");
    return r.rows[0]?.["ok"] === true;
  });

/** A committed role for the length of `fn`, dropped after: other suites count the cluster's roles. */
export async function withRole<T>(name: string, attributes: string, fn: () => Promise<T>): Promise<T> {
  await withAdmin((c) => c.query(`CREATE ROLE "${name}" ${attributes}`));
  try {
    return await fn();
  } finally {
    await withAdmin((c) => c.query(`DROP ROLE IF EXISTS "${name}"`)).catch(() => undefined);
  }
}

export const schemaWith = (
  policies: readonly unknown[] = POLICIES,
  tables: Record<string, unknown> = { documents, documentShares },
): SchemaLike => ({ ...(defineSchema(tables as never) as unknown as SchemaLike), policies }) as unknown as SchemaLike;
