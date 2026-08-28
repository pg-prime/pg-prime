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
  clusterOn,
  comment,
  defineSchema,
  foreignKey,
  index,
  partitionBy,
  partitionOf,
  pgDomain,
  pgEnum,
  pgSchema,
  pgSequence,
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

/* -------------------------------------------------------------------------- */
/* design/12 K4's additions — every new emitter path, in one table plus a pair  */
/* -------------------------------------------------------------------------- */

/** A domain, with a default and a named CHECK (design/05 §3.3). */
export const moneyAmount = pgDomain("money_amount", "numeric(12,2)", {
  default: "0",
  checks: [{ name: "money_amount_non_negative", expression: "VALUE >= (0)::numeric" }],
});

/** A standalone sequence OWNED BY a column — what a `serial` decomposes into (§3.5). */
export const ticketsNoSeq = pgSequence("tickets_no_seq", {
  dataType: "integer",
  start: "1",
  increment: "1",
  minValue: "1",
  maxValue: "2147483647",
  cache: "1",
  ownedBy: { table: "tickets", column: "no" },
});

/**
 * `pgExtension` is deliberately NOT in this fixture.
 *
 * An extension belongs to the DATABASE and its member objects live in a schema the tier-3
 * map cannot rename (design/06 §3.2), so a shared fixture that declared one would make two
 * true and valuable properties false — "the user's own `public` was never touched" and
 * "the tier-3 and tier-2 IRs have the same fingerprint", both in
 * `test/shadow/ladder.test.ts`. The emitter's extension path is covered by an exact-text
 * assertion in `emit.test.ts` and, end to end, by AdventureWorks' two extensions in
 * `test/pull/roundtrip.test.ts`.
 */

/**
 * Every index option at once, a NAMED primary key, `CLUSTER ON`, and two `t.raw` columns —
 * one of them typed by the domain above, which is also the emitter's ordering constraint
 * (the domain has to exist before the table that uses it).
 */
export const tickets = pgTable(
  "tickets",
  (t) => ({
    no: t.integer().defaultSql("nextval('public.tickets_no_seq'::regclass)"),
    orgId: t.uuid(),
    amount: t.raw("public.money_amount", "amount").nullable(),
    label: t.raw("character varying(40)", "label"),
    doc: t.jsonb().nullable(),
    createdAt: t.timestamptz().defaultSql("now()"),
  }),
  (t) => [
    primaryKey({ name: "PK_Tickets", columns: [t.no] }),
    foreignKey({ columns: [t.orgId], references: (): readonly RefLike[] => [orgs.cols.id] }),
    index("tickets_label_pattern_idx").on({ column: t.label, opclass: "text_pattern_ops" }),
    index("tickets_created_desc_idx").on({ column: t.createdAt, desc: true, nulls: "last" }),
    index("tickets_doc_idx").using("gin").on({ column: t.doc, opclass: "jsonb_path_ops" }),
    index("tickets_open_idx")
      .where(sql`${t.amount} IS NULL`)
      .include(t.label)
      .on(t.orgId),
    uniqueIndex("tickets_org_label_key").nullsNotDistinct().on(t.orgId, t.label),
    clusterOn("PK_Tickets"),
  ],
);

/** A RANGE-partitioned parent and one child — the shape pagila's `payment` has. */
export const readings = pgTable(
  "readings",
  (t) => ({
    at: t.timestamptz(),
    value: t.numeric(),
  }),
  () => [partitionBy("range", "at")],
);

export const readings2024 = pgTable(
  "readings_2024",
  (t) => ({
    at: t.timestamptz(),
    value: t.numeric(),
  }),
  () => [partitionOf("readings", "FOR VALUES FROM ('2024-01-01 00:00:00+00') TO ('2025-01-01 00:00:00+00')")],
);

/**
 * The registry the emitter sees.
 *
 * `defineSchema(...)` carries tables and relations only — the standalone declarations are
 * discovered off a module's exports by `loadSchema` (design/12 K4), so the fixture spreads
 * them on by hand to reproduce exactly what a real project's config hands to `emitSchema`.
 */
export const schema = {
  ...defineSchema({ orgs, users, memberships, nodes, events, tickets, readings, readings2024 }),
  domains: [moneyAmount],
  sequences: [ticketsNoSeq],
  enums: [memberRole, eventKind],
  schemas: [audit],
};

/** The schemas the fixture declares, in the caller's own names. */
export const SCHEMAS: readonly string[] = ["audit", "public"];
