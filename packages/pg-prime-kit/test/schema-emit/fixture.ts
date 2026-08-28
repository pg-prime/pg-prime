/**
 * The emitter's corpus: one registry that uses **every** column builder, every DDL-affecting
 * modifier and every table extra the DSL ships, plus the four structures that break naive
 * emitters — a cross-schema foreign key, a self-referencing foreign key, a two-table FK cycle,
 * and one enum used by tables in two different schemas.
 *
 * This is the input to `test/schema-emit/roundtrip.test.ts` (R1): everything here is loaded into a
 * shadow, extracted, re-emitted through `diff/ddl.ts` and loaded into a second database, and the
 * two are compared with `pg_dump`. A feature that is declared here and not emitted correctly
 * cannot pass that test, which is why the fixture is deliberately maximal rather than minimal.
 *
 * `pg-prime` is imported as a VALUE here on purpose: a test may, `src/` may not
 * (`no-value-import.test.ts`). That is exactly how a user's `pg-prime.config.ts` behaves.
 */

import {
  check,
  comment,
  defineSchema,
  foreignKey,
  index,
  pgEnum,
  pgSchema,
  pgTable,
  primaryKey,
  renamedFrom,
  sql,
  unique,
  uniqueIndex,
  type DateString,
  type RefLike,
} from "pg-prime";

export const memberRole = pgEnum("member_role", ["owner", "admin", "member"]);

export const audit = pgSchema("audit");
export const eventKind = audit.enum("event_kind", ["created", "updated", "deleted"]);

/**
 * `orgs` ⇄ `users` is a genuine FK cycle: an org names its owner, a user names their primary org.
 * Neither table can carry both its own definition and its FK inline, so the emitter has to break
 * the cycle with an `ALTER TABLE … ADD CONSTRAINT`.
 */
export const orgs = pgTable(
  "orgs",
  (t) => ({
    id: t.uuid().primaryKey().defaultSql("gen_random_uuid()"),
    slug: t.text().unique("orgs_slug_key", { nullsNotDistinct: true }),
    // every remaining scalar builder, so the round-trip covers the whole codec table
    displayName: t.varchar().nullable(),
    seats: t.integer().default(5).check(sql`seats > 0`),
    rank: t.smallint().default(0),
    quota: t.bigint().default(1000n),
    active: t.boolean().default(true),
    balance: t.numeric().default("0.00"),
    foundedOn: t.date().default("2020-01-01" as DateString),
    createdAt: t.timestamptz().defaultSql("now()"),
    settings: t.jsonb().default({ theme: "system", digest: "weekly" }),
    tags: t.text().array().default([]),
    ownerId: t.uuid().nullable(),
    legacyRef: t.text().nullable().renamedFrom("legacy_reference").comment("kept for the 2024 import"),
  }),
  (t) => [
    foreignKey({
      name: "orgs_owner_id_fkey",
      columns: [t.ownerId],
      // `(): readonly RefLike[]` — the annotation is what breaks the TYPE-level cycle. The thunk
      // already breaks the value-level one; TypeScript still has to type `orgs`, which needs
      // `users`, which needs `orgs`, unless the arrow's return type is stated (TS7022/TS7024).
      references: (): readonly RefLike[] => [users.cols.id],
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    index("orgs_created_at_idx").on(t.createdAt),
    comment("One row per tenant."),
    renamedFrom("organisations"),
  ],
);

export const users = pgTable(
  "users",
  (t) => ({
    id: t.uuid().primaryKey().defaultSql("gen_random_uuid()"),
    email: t.text().unique().comment("login address"),
    // an identity column of each flavour
    seq: t.bigint().generatedAlways(),
    counter: t.integer().generatedByDefault(),
    primaryOrgId: t
      .uuid()
      .nullable()
      .references((): RefLike => orgs.cols.id, { onDelete: "set null", initiallyDeferred: true }),
    role: t.enum(memberRole).default("member"),
    roles: t.enum(memberRole).array().default([]),
    // TS-only modifiers: none of these may appear in the emitted DDL ($-law, design/05 D4)
    nickname: t
      .text()
      .nullable()
      .$default(() => "anonymous")
      .$onUpdate(() => "anonymous"),
    prefs: t.jsonb().$type<{ dark: boolean }>().default({ dark: false }),
  }),
  (t) => [uniqueIndex("users_email_lower_idx").on(t.email), index("users_role_idx").on(t.role)],
);

/** Composite primary key, two foreign keys into the cycle, a table-level CHECK and UNIQUE. */
export const memberships = pgTable(
  "memberships",
  (t) => ({
    orgId: t.uuid(),
    userId: t.uuid(),
    role: t.enum(memberRole),
    invitedAt: t.timestamptz().defaultSql("now()"),
    seatNo: t.integer().nullable(),
  }),
  (t) => [
    primaryKey(t.orgId, t.userId),
    foreignKey({ columns: [t.orgId], references: () => [orgs.cols.id], onDelete: "cascade" }),
    foreignKey({ columns: [t.userId], references: () => [users.cols.id], onDelete: "cascade" }),
    unique("memberships_seat_key").nullsNotDistinct().on(t.orgId, t.seatNo),
    check("memberships_seat_positive", sql`${t.seatNo} IS NULL OR ${t.seatNo} > 0`),
    comment("Which user belongs to which org."),
  ],
);

/** A self-referencing FK, declared through the extras callback (the spelling that closes the loop). */
export const nodes = pgTable(
  "nodes",
  (t) => ({
    id: t.uuid().primaryKey(),
    parentId: t.uuid().nullable(),
    path: t.text().check(sql`path <> ''`, "nodes_path_not_empty"),
  }),
  (t) => [
    foreignKey({
      name: "nodes_parent_id_fkey",
      columns: [t.parentId],
      references: () => [t.id],
      onDelete: "cascade",
      deferrable: true,
    }),
    index("nodes_parent_idx").on(t.parentId),
  ],
);

/** A second schema, a cross-schema FK into `public.orgs`, and both enums in one table. */
export const events = audit.table(
  "events",
  (t) => ({
    id: t.bigint().generatedAlways(),
    orgId: t.uuid().references(() => orgs.cols.id, { onDelete: "cascade" }),
    // the SAME public enum a public table uses, from another schema
    actorRole: t.enum(memberRole).nullable(),
    kind: t.enum(eventKind),
    at: t.timestamptz().defaultSql("now()"),
    payload: t.jsonb().nullable(),
  }),
  (t) => [
    primaryKey(t.id),
    index("events_org_at_idx").on(t.orgId, t.at),
    comment("Append-only audit log."),
  ],
);

export const schema = defineSchema({ orgs, users, memberships, nodes, events });

/** The schemas the fixture declares, in the caller's own names. */
export const SCHEMAS: readonly string[] = ["audit", "public"];
