# 05 — Schema Definition API

**Agent:** 05 (schema-definition surface)
**Date:** 2026-08-14
**Status:** DECISIONS. Everything below is a commitment, not a survey.
**Consumers:** agent 04 (type engine) and agent 06 (migration diff IR) both read the objects this API produces. This document is the single source of truth for both.

---

> **Amended 2026-08-25 — nullability inverted.** This document originally showed
> `.notNull()` on every required column. Sign-off 4 (00-overview R1) made **NOT NULL the
> default**, with `.nullable()` opting in: nullable-as-union is free at the type level while
> `.notNull()` costs a distributive `Exclude` per column, and it removes Drizzle's most-reported
> footgun. Every example below has been converted. One consequence is still open — see composite
> types in §3.

## 0. Decisions at a glance

| # | Question | Decision |
|---|---|---|
| D1 | Definition style | Fluent builders returning plain frozen values. `pgTable(name, columns, extras?)` with a **columns callback** `(t) => ({...})` and an **extras callback returning an array** `(t) => [...]`. No decorators, no DSL, no codegen. |
| D2 | Column access | `users.email` works (intersection with the column record), but metadata lives behind a single `$` key (`users.$.name`, `users.$.ir`). `$`-prefixed column names are rejected. |
| D3 | Type inference | Free type functions `Row<T>` / `Insert<T>` / `Update<T>`. No `$inferSelect` property on the value. |
| D4 | The `$` law | **A method or key prefixed with `$` never affects DDL or the migration IR.** `.default()` emits `DEFAULT`; `.$default()` is a TS-side factory. `` emits `NOT NULL`; `.$required()` only changes the TS type. This is a hard, teachable invariant. |
| D5 | Table extras | One heterogeneous array of tagged nodes: constraints, indexes, **and** table options (`partitionBy.range(...)`, `unlogged()`, `rls.enable()`, `comment(...)`, `renamedFrom(...)`, `dropColumn(...)`). Extensible by extension packs without an API change. |
| D6 | Relations | **Separate `defineRelations(tables, r => ...)`**, Drizzle-RQB-v2-shaped — plus **FK inference**: `r.one.orgs()` with no args resolves from the declared FK when unambiguous. Explicit `from`/`to` only for ambiguity, non-FK joins, and `through` (m2m). |
| D7 | Functions / triggers | **Declared inline in TS** with `sql` bodies and structured metadata. **Signature is diffed structurally; body is content-hashed and applied as a repeatable `CREATE OR REPLACE`.** Declared functions become callable, typed expressions in the query builder. |
| D8 | Renames | Uniform `renamedFrom` on every object kind (`.renamedFrom('x')` on builders, `renamedFrom('x')` in extras, `{ renamedFrom: 'x' }` on standalone objects). **Idempotent**: fires only when the old name exists in the live catalog and the new one does not, so it is safe to leave in source forever and safe to delete after deploy. No codemod required. |
| D9 | Destructive changes | Explicit **tombstones**: `dropColumn('legacy_id', { reason })` in extras, `pgDropped({...})` at registry level. A drop becomes a *positive line in the PR diff* instead of an absence. |
| D10 | Raw DDL | Two forms — inline `rawObject({ identity, create, drop, dependsOn, mode })` and `sql/*.sql` files with `-- pg-orm:` header directives. Both compile into the same IR with `provenance: 'raw'`. Third provenance `external` for DBA/extension-owned objects: typed and queryable, never emitted, never dropped. |
| D11 | File organization | **Explicit registry, no globs.** `defineSchema({ ...usersModule, ...orgsModule, relations })` using `import * as`. Flat record, kind derived from the object's brand. |
| D12 | Casing | DB names default from the TS key via a configurable strategy (`snake_case` default). Override with the optional first positional arg: `t.text('email_address')`. |
| D13 | `.$type<T>()` | Allowed **only when `T` is assignable to the codec's TS type**. `jsonb().$type<UserMeta>()` ✅, `text().$type<Email>()` ✅ (branded string), `text().$type<number>()` ❌ compile error. Fixes Drizzle's "the type is a lie" without losing the cheap escape hatch. |
| D14 | Views & RLS | `security_invoker = true` is the **default** for `pgView` (PG15+ floor makes this safe). Silently bypassing RLS through a view is a security bug, not a default. |
| D15 | Index concurrency | `.concurrently()` is tri-state `'auto' | true | false`, default `'auto'`: the generator emits `CREATE INDEX CONCURRENTLY` + `txmode none` when the table already exists, plain `CREATE INDEX` inside a fresh `CREATE TABLE` migration. |
| D16 | Inheritance | **Not supported.** `INHERITS` breaks uniqueness/FK guarantees and blows up the dependency graph. Detected in the catalog and reported as a diagnostic; declarative partitioning is the supported answer. |

---

## 1. The worked example, first

A small real app: **users, orgs, memberships** — with a domain type, an enum, a composite type, arrays, jsonb, a range + exclusion constraint, generated tsvector, a partitioned audit table, two triggers, two SQL functions, RLS policies with roles and grants, and a materialized view.

Read this section top to bottom; the rest of the document is reference.

### 1.1 `db/schema/_shared.ts` — extensions, schemas, presets

```ts
import {
  sql, pgSchema, pgExtension, pgDomain, pgEnum, pgCompositeType,
  uuid, text, timestamptz, citext,
} from 'pg-prime/pg';

// ─── extensions (managed: we emit CREATE EXTENSION and order everything after it)
export const pgcrypto  = pgExtension('pgcrypto');
export const citextExt = pgExtension('citext');
export const btreeGist = pgExtension('btree_gist');

// ─── non-public schemas
export const audit = pgSchema('audit');

// ─── types
export const email = pgDomain('email', citext(), {
  notNull: false,
  // `value` renders as PG's VALUE keyword
  check: (value) => sql`${value} ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'`,
  comment: 'RFC-ish email address, case-insensitive',
});

export const memberRole = pgEnum('member_role', ['owner', 'admin', 'member']);

export const postalAddress = pgCompositeType('postal_address', {
  // NOTE: PG composite attributes cannot carry NOT NULL. `.$required()` is the
  // TS-only assertion ($ = never touches DDL, see D4).
  line1:   text().$required(),
  line2:   text(),
  city:    text().$required(),
  country: text().$required(),
});

// ─── column presets (plain functions; nothing special about them)
export const pk = () => uuid().primaryKey().default(sql`gen_random_uuid()`);

export const timestamps = () => ({
  createdAt: timestamptz().default(sql`now()`),
  updatedAt: timestamptz().default(sql`now()`),
});

export const softDelete = () => ({
  deletedAt: timestamptz().nullable(),
});
```

### 1.2 `db/schema/functions.ts` — SQL functions as first-class, callable objects

```ts
import { sql, pgFunction, uuid } from 'pg-prime/pg';
import { audit } from './_shared.js';

/** BEFORE UPDATE trigger body. */
export const setUpdatedAt = pgFunction('set_updated_at', {
  returns:    'trigger',
  language:   'plpgsql',
  volatility: 'volatile',
  security:   'invoker',
  body: sql`
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
  `,
});

/**
 * Reads the tenant id the app set with `SET LOCAL app.org_id`.
 * Because it is declared here, `currentOrgId()` is a *typed expression* usable
 * in policies, defaults, checks, generated columns and ordinary queries.
 */
export const currentOrgId = pgFunction('current_org_id', {
  args:       [],
  returns:    uuid().nullable(),
  language:   'sql',
  volatility: 'stable',
  parallel:   'safe',
  body: sql`SELECT nullif(current_setting('app.org_id', true), '')::uuid`,
});

export const logMembershipChange = pgFunction('log_membership_change', {
  schema:     audit,
  returns:    'trigger',
  language:   'plpgsql',
  volatility: 'volatile',
  security:   'definer',
  searchPath: ['pg_catalog'],          // required for SECURITY DEFINER; linted if omitted
  body: sql`
    BEGIN
      INSERT INTO audit.membership_events (org_id, user_id, action, actor, payload)
      VALUES (
        coalesce(NEW.org_id, OLD.org_id),
        coalesce(NEW.user_id, OLD.user_id),
        TG_OP,
        current_user,
        to_jsonb(coalesce(NEW, OLD))
      );
      RETURN coalesce(NEW, OLD);
    END;
  `,
});
```

### 1.3 `db/schema/users.ts`

```ts
import {
  sql, pgTable, index, uniqueIndex, check, comment, rls,
} from 'pg-prime/pg';
import { email, postalAddress, pk, timestamps, softDelete } from './_shared.js';

export type UserPrefs = {
  theme: 'light' | 'dark' | 'system';
  digest: 'daily' | 'weekly' | 'off';
};

export const users = pgTable('users', (t) => ({
  id:          pk(),
  email:       t.domain(email).unique(),
  displayName: t.text(),
  avatarUrl:   t.text().nullable(),

  // jsonb with a compile-time narrowing that must be assignable to the codec type
  prefs: t.jsonb().$type<UserPrefs>().default({ theme: 'system', digest: 'weekly' }),

  // text[] with a literal default; multi-dim via .array(2)
  tags: t.text().array().default([]),

  // composite type column → { line1: string|null, ... } with $required() narrowing
  address: t.composite(postalAddress).nullable(),

  // generated tsvector: the expression callback is late-bound to this table's columns
  searchDoc: t.tsvector().generatedAlwaysAs((c) => sql`
    setweight(to_tsvector('english', coalesce(${c.displayName}, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(${c.email}::text, '')), 'B')
  `),

  ...timestamps(),
  ...softDelete(),
}), (t) => [
  index('users_search_idx').using('gin').on(t.searchDoc),

  // partial + expression + unique, all composable
  uniqueIndex('users_active_email_idx')
    .on(sql`lower(${t.email}::text)`)
    .where(sql`${t.deletedAt} IS NULL`),

  check('users_display_name_len', sql`length(${t.displayName}) BETWEEN 1 AND 120`),

  comment('Application user accounts. One row per human.'),
  rls.enable(),
]);
```

### 1.4 `db/schema/orgs.ts`

```ts
import { sql, pgTable, index, check, rls, comment } from 'pg-prime/pg';
import { email, pk, timestamps } from './_shared.js';

export const orgs = pgTable('orgs', (t) => ({
  id:   pk(),
  slug: t.text().unique(),
  name: t.text(),

  // .oneOf() gives a TS union AND emits a CHECK constraint. Drizzle's
  // text({ enum: [...] }) gives you only the (unenforced) union.
  plan: t.text().oneOf(['free', 'pro', 'enterprise']).default('free'),

  seatLimit:    t.integer().default(5),
  billingEmail: t.domain(email).nullable(),

  ...timestamps(),
}), (t) => [
  check('orgs_seat_limit_positive', sql`${t.seatLimit} > 0`),
  index('orgs_slug_idx').on(t.slug),
  comment('Tenant. Everything in the app is scoped to one of these.'),
  rls.enable(),
]);
```

### 1.5 `db/schema/memberships.ts` — composite PK, self-ref FK, range + EXCLUDE

```ts
import {
  sql, pgTable, primaryKey, foreignKey, exclude, index, rls,
} from 'pg-prime/pg';
import { memberRole, btreeGist, timestamps } from './_shared.js';
import { users } from './users.js';
import { orgs } from './orgs.js';

export const memberships = pgTable('memberships', (t) => ({
  orgId:  t.uuid().references(() => orgs.id,  { onDelete: 'cascade' }),
  userId: t.uuid().references(() => users.id, { onDelete: 'cascade' }),
  role:   t.enum(memberRole).default('member'),

  // self-referential FK to a *different* table than the row's own — and the
  // second FK to `users`, which is why relations must disambiguate (§4.3)
  invitedBy: t.uuid().nullable().references(() => users.id, { onDelete: 'set null' }),

  ...timestamps(),
}), (t) => [
  primaryKey(t.orgId, t.userId),
  index('memberships_user_idx').on(t.userId).where(sql`${t.role} <> 'member'`),
  index('memberships_role_idx').on(t.orgId, t.role.desc().nullsLast()),
  rls.enable(),
  rls.force(),           // policies apply to the table owner too
]);

/** Time-bounded seat reservations: the exclusion-constraint showcase. */
export const seatHolds = pgTable('seat_holds', (t) => ({
  orgId:  t.uuid(),
  userId: t.uuid(),
  during: t.tstzrange(),
  reason: t.text().nullable(),
}), (t) => [
  foreignKey({
    columns:        [t.orgId, t.userId],
    foreignColumns: [memberships.orgId, memberships.userId],
    onDelete:       'cascade',
  }).deferrable().initiallyDeferred(),

  exclude('seat_holds_no_overlap')
    .using('gist')
    .on([t.orgId, '='], [t.userId, '='], [t.during, '&&'])
    .where(sql`${t.reason} IS DISTINCT FROM 'void'`)
    .requires(btreeGist),        // capability check: fails generate with a clear
                                 // message if btree_gist isn't in the registry
]);
```

### 1.6 `db/schema/audit.ts` — partitioning, identity, non-public schema

```ts
import { sql, primaryKey, index, partitionBy, partitions, pgPartition } from 'pg-prime/pg';
import { audit } from './_shared.js';

export const membershipEvents = audit.table('membership_events', (t) => ({
  id:        t.bigint().generatedAlwaysAsIdentity({ start: 1, increment: 1 }),
  orgId:     t.uuid(),
  userId:    t.uuid(),
  action:    t.text(),
  actor:     t.text(),
  payload:   t.jsonb(),
  createdAt: t.timestamptz().default(sql`now()`),
}), (t) => [
  primaryKey(t.id, t.createdAt),      // partition key must be in every unique key
  partitionBy.range(t.createdAt),

  // Partitions created by cron are ADOPTED, never dropped. Only partitions we
  // declare are managed. This is the #1 way partition-aware diffing destroys data.
  partitions({ manage: 'declared', unknown: 'adopt' }),

  index('membership_events_org_idx').on(t.orgId, t.createdAt.desc()),
]);

export const membershipEvents2026 = pgPartition('membership_events_2026', {
  of:   membershipEvents,
  from: [sql`'2026-01-01'`],
  to:   [sql`'2027-01-01'`],
});
```

### 1.7 `db/schema/triggers.ts`

```ts
import { sql, pgTrigger } from 'pg-prime/pg';
import { setUpdatedAt, logMembershipChange } from './functions.js';
import { users } from './users.js';
import { orgs } from './orgs.js';
import { memberships } from './memberships.js';

export const usersTouch = pgTrigger('users_touch', {
  on: users, timing: 'before', events: ['update'], level: 'row',
  execute: setUpdatedAt(),
});

export const orgsTouch = pgTrigger('orgs_touch', {
  on: orgs, timing: 'before', events: ['update'], level: 'row',
  execute: setUpdatedAt(),
});

export const membershipsAudit = pgTrigger('memberships_audit', {
  on: memberships,
  timing: 'after',
  events: ['insert', 'update', 'delete'],
  level: 'row',
  // OLD/NEW are typed proxies over the table's columns
  when: (r) => sql`${r.old.role} IS DISTINCT FROM ${r.new.role}`,
  execute: logMembershipChange(),
});
```

### 1.8 `db/schema/views.ts`

```ts
import { sql, pgMaterializedView, pgView, uniqueIndex, count, eq } from 'pg-prime/pg';
import { orgs } from './orgs.js';
import { memberships } from './memberships.js';

/** Typed from the query — columns and TS types are inferred. */
export const orgSeatUsage = pgMaterializedView('org_seat_usage')
  .as((q) => q
    .from(memberships)
    .innerJoin(orgs, (m, o) => eq(m.orgId, o.id))
    .groupBy((m, o) => [o.id, o.slug, o.seatLimit])
    .select((m, o) => ({
      orgId:     o.id,
      slug:      o.slug,
      seatLimit: o.seatLimit,
      used:      count(m.userId),
      owners:    count(sql`CASE WHEN ${m.role} = 'owner' THEN 1 END`).as('owners'),
    })))
  // a matview needs a UNIQUE index to support REFRESH ... CONCURRENTLY;
  // declaring `.refreshable({ concurrently: true })` without one is a lint error.
  .indexes((v) => [uniqueIndex('org_seat_usage_pk').on(v.orgId)])
  .refreshable({ concurrently: true })
  .comment('Seat consumption per org. Refreshed by the seats worker every 60s.');

/** Declared columns + raw SQL, for anything the builder can't express. */
export const orgHealth = pgView('org_health')
  .columns((t) => ({
    orgId:  t.uuid(),
    status: t.text().oneOf(['ok', 'over_seats', 'dormant']),
  }))
  .as(sql`
    SELECT u.org_id,
           CASE WHEN u.used > u.seat_limit THEN 'over_seats'
                WHEN u.used = 0            THEN 'dormant'
                ELSE 'ok' END AS status
    FROM org_seat_usage u
  `);
  // security_invoker = true by default (D14). Opt out explicitly:
  // .with({ securityInvoker: false })
```

### 1.9 `db/schema/security.ts` — roles, RLS policies, grants

```ts
import { sql, pgRole, pgPolicy, grant } from 'pg-prime/pg';
import { currentOrgId } from './functions.js';
import { orgs } from './orgs.js';
import { users } from './users.js';
import { memberships } from './memberships.js';

export const appUser = pgRole('app_user', { login: false, inherit: true });

export const orgsTenantScope = pgPolicy('orgs_tenant_scope', {
  on: orgs, for: 'select', as: 'permissive', to: [appUser],
  using: (t) => sql`${t.id} = ${currentOrgId()}`,
});

export const membershipsTenantScope = pgPolicy('memberships_tenant_scope', {
  on: memberships, for: 'all', as: 'permissive', to: [appUser],
  using:     (t) => sql`${t.orgId} = ${currentOrgId()}`,
  withCheck: (t) => sql`${t.orgId} = ${currentOrgId()}`,
});

/** RESTRICTIVE: composes with AND, so only admins/owners may write memberships. */
export const membershipsAdminWrite = pgPolicy('memberships_admin_write', {
  on: memberships, for: ['insert', 'update', 'delete'], as: 'restrictive', to: [appUser],
  using:     () => sql`current_setting('app.role', true) IN ('owner', 'admin')`,
  withCheck: () => sql`current_setting('app.role', true) IN ('owner', 'admin')`,
});

export const usersSelfOrSameOrg = pgPolicy('users_self_or_same_org', {
  on: users, for: 'select', to: [appUser],
  using: (t) => sql`
    ${t.id} = nullif(current_setting('app.user_id', true), '')::uuid
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = ${t.id} AND m.org_id = ${currentOrgId()}
    )`,
});

// Grants are OPT-IN and never diff-and-drop by default (see §3.9).
export const appUserGrants = [
  grant(['select'], { on: orgs,  to: appUser }),
  grant(['select'], { on: users, to: appUser }),
  grant(['select', 'insert', 'update', 'delete'], { on: memberships, to: appUser }),
];
```

### 1.10 `db/schema/relations.ts`

```ts
import { defineRelations } from 'pg-prime';
import * as tables from './tables.js';   // barrel re-exporting users, orgs, memberships, …

export const relations = defineRelations(tables, (r) => ({
  users: {
    // FK-inferred: exactly one FK memberships.user_id → users.id? No — there are
    // two (user_id and invited_by), so the reverse side must be explicit.
    memberships:  r.many.memberships({ from: r.users.id, to: r.memberships.userId }),
    sentInvites:  r.many.memberships({ from: r.users.id, to: r.memberships.invitedBy }),

    // many-to-many through the junction table (which stays a real, declared table)
    orgs: r.many.orgs({
      from: r.users.id.through(r.memberships.userId),
      to:   r.orgs.id.through(r.memberships.orgId),
    }),
  },

  orgs: {
    memberships: r.many.memberships(),          // inferred: single FK memberships.org_id
    members:     r.many.users({
      from: r.orgs.id.through(r.memberships.orgId),
      to:   r.users.id.through(r.memberships.userId),
    }),
    // relation-level predicate + non-nullable `one`
    owner: r.one.users({
      from:     r.orgs.id.through(r.memberships.orgId),
      to:       r.users.id.through(r.memberships.userId),
      where:    { role: 'owner' },
      optional: false,
    }),
    // relations to views/matviews are ordinary relations
    seatUsage: r.one.orgSeatUsage({ from: r.orgs.id, to: r.orgSeatUsage.orgId }),
  },

  memberships: {
    org:       r.one.orgs(),                                              // inferred
    user:      r.one.users({ from: r.memberships.userId,    to: r.users.id }),
    inviter:   r.one.users({ from: r.memberships.invitedBy, to: r.users.id }),
    // composite-key relation: array form on both sides
    seatHolds: r.many.seatHolds({
      from: [r.memberships.orgId, r.memberships.userId],
      to:   [r.seatHolds.orgId,   r.seatHolds.userId],
    }),
  },
}));
```

### 1.11 `db/schema/index.ts` — the registry

```ts
import { defineSchema } from 'pg-prime';

import * as shared     from './_shared.js';
import * as functions  from './functions.js';
import * as usersMod   from './users.js';
import * as orgsMod    from './orgs.js';
import * as memberMod  from './memberships.js';
import * as auditMod   from './audit.js';
import * as triggers   from './triggers.js';
import * as views      from './views.js';
import * as security   from './security.js';
import { relations }   from './relations.js';

export const schema = defineSchema({
  ...shared, ...functions, ...usersMod, ...orgsMod, ...memberMod,
  ...auditMod, ...triggers, ...views, ...security,
  relations,
}, {
  defaultSchema: 'public',
  casing:        'snake_case',
  grants:        'manage',     // 'manage' | 'observe' (default) — see §3.9
  rawDir:        './sql',      // raw-DDL escape hatch, §5.3
});

// Types come out as free type functions:
import type { Row, Insert, Update } from 'pg-prime';
export type User      = Row<typeof usersMod.users>;
export type NewUser   = Insert<typeof usersMod.users>;
export type UserPatch = Update<typeof usersMod.users>;
```

`Row<typeof users>` for the table above:

```ts
{
  id:          string;
  email:       string;
  displayName: string;
  avatarUrl:   string | null;
  prefs:       UserPrefs;
  tags:        string[];
  address:     { line1: string; line2: string | null; city: string; country: string } | null;
  searchDoc:   TsVector;
  createdAt:   Date;
  updatedAt:   Date;
  deletedAt:   Date | null;
}
```

`Insert<typeof users>`:

```ts
{
  id?:          string;              // has a default  → Opt
  email:        string;
  displayName:  string;
  avatarUrl?:   string | null;
  prefs?:       UserPrefs;           // has a default  → Opt
  tags?:        string[];
  address?:     PostalAddressInput | null;
  // searchDoc omitted entirely — GENERATED ALWAYS is never insertable
  createdAt?:   Date;
  updatedAt?:   Date;
  deletedAt?:   Date | null;
}
```

---

## 2. Core table definition — reference

### 2.1 Signature and the three positions

```ts
declare function pgTable<TName extends string, TCols extends ColumnRecord>(
  name:    TName,
  columns: TCols | ((t: ColumnKit) => TCols),
  extras?: (t: ColumnRefs<TCols>) => TableExtra[],
): Table<TName, TCols>;
```

- **Position 1** — the *DB* table name, always literal.
- **Position 2** — columns. The callback form `(t) => ({...})` is primary: it keeps the import list at the top of a schema file to ~5 names and gives extension packs a single place to hang new column types (`t.vector(1536)`, `t.geometry(...)`, `t.ltree()`). The plain-object form works too, for helper composition.
- **Position 3** — a callback returning **one flat array** of tagged nodes. Drizzle's deprecated object form does not exist here; neither does a fourth options argument. Everything table-level is a node in the array (D5).

Column keys are TS names. DB names come from the casing strategy, or from the optional first positional arg to any column builder: `t.text('email_address')`. Keys beginning with `$` are rejected at definition time.

### 2.2 Column types — the full PG breadth

Everything below is a **first-class builder with an owned codec**, not `customType`. Types that Drizzle has no builder for — you must hand-roll `customType` — are marked `/*★*/`. There are 20+ of them, including every range type.

```ts
pgTable('kitchen_sink', (t) => ({
  // ── integers / identity
  i16:  t.smallint(),
  i32:  t.integer(),
  i64:  t.bigint(),                       // → bigint (decode throws above 2^53 if .asNumber())
  i64n: t.bigint().asNumber(),            // → number, explicit opt-in, range-checked on decode
  idA:  t.integer().generatedAlwaysAsIdentity({ start: 1000, increment: 1, cache: 20 }),
  idB:  t.bigint().generatedByDefaultAsIdentity(),
  // `serial` exists but is deprecated-by-lint in favour of identity (Squawk prefer-identity)
  legacySerial: t.serial(),

  // ── exact / approximate numerics
  price:  t.numeric({ precision: 12, scale: 2 }),          // → string (lossless, default)
  priceD: t.numeric({ precision: 12, scale: 2 }).asDecimal(decimalCodec), // → your Decimal
  ratio:  t.real(),
  ratioD: t.doublePrecision(),
  cash: /*★*/ t.money(),                                        // → string

  // ── text
  s:      t.text(),
  vc:     t.varchar({ length: 255 }),
  ch:     t.char({ length: 2 }),
  ci:     t.citext(),                                       // requires the citext extension
  status: t.text().oneOf(['open', 'closed']),               // TS union + CHECK constraint

  // ── boolean / uuid / binary
  flag: t.boolean(),
  uid:  t.uuid(),
  blob: t.bytea(),                                          // → Uint8Array

  // ── temporal (see §6.5 for the full decode policy)
  tstz: t.timestamptz(),                                    // → Date
  ts:   t.timestamp(),                                      // → PlainDateTime string; lint nudges to timestamptz
  d:    t.date(),                                           // → 'YYYY-MM-DD' string. NEVER a Date. No day shifts.
  tm:   t.time(),
  tmz:  t.timetz(),
  iv:   t.interval(),                                       // → { years, months, days, hours, minutes, seconds }

  // ── json
  j:   t.json(),
  jb:  t.jsonb(),
  jbT: t.jsonb().$type<{ a: number }>(),

  // ── arrays (any element type, incl. enums/domains/composites)
  tags:  t.text().array(),
  grid:  t.integer().array(2),                              // int[][]
  roles: t.enum(memberRole).array(),

  // ── ranges & multiranges ★ (Drizzle has none of these)
  r1: /*★*/ t.int4range(),        // → Range<number>
  r2: /*★*/ t.int8range(),
  r3: /*★*/ t.numrange(),
  r4: /*★*/ t.tsrange(),
  r5: /*★*/ t.tstzrange(),        // → Range<Date> = { lower, upper, lowerInc, upperInc }
  r6: /*★*/ t.daterange(),
  m1: /*★*/ t.tstzmultirange(),   // → Range<Date>[]

  // ── full text ★
  tsv: /*★*/ t.tsvector(),
  tsq: /*★*/ t.tsquery(),

  // ── network / bit / xml / misc ★
  ip:   t.inet(), cidr: t.cidr(), mac: t.macaddr(), mac8: t.macaddr8(),
  bits: /*★*/ t.bit({ length: 8 }), vbits: /*★*/ t.varbit({ length: 64 }),
  xml:  /*★*/ t.xml(),
  oid:  /*★*/ t.oid(),
  ltre: /*★*/ t.ltree(),          // requires the ltree extension

  // ── geometric ★
  pt: t.point(), ln: /*★*/ t.line(), sg: /*★*/ t.lseg(), bx: /*★*/ t.box(),
  pa: /*★*/ t.path(), pg_: /*★*/ t.polygon(), ci_: /*★*/ t.circle(),

  // ── user-defined types declared elsewhere in this schema
  dom:  t.domain(email),                                    // → the domain's TS type
  comp: t.composite(postalAddress),                         // → inferred object type
  en:   t.enum(memberRole),                                 // → 'owner' | 'admin' | 'member'

  // ── extension-pack types (see §6.7)
  emb: t.vector(1536),                                      // from the pgvector pack
  geo: t.geometry('Point', 4326),                           // from the postgis pack

  // ── last resort, still typed and still diffable
  weird: t.custom<MyTs>({ sqlType: 'my_weird_type', codec: myCodec }),
}));
```

### 2.3 Modifiers

DDL-affecting (no `$`):

| Modifier | Emits |
|---|---|
| `.nullable()` | drops the default `NOT NULL` |
| `.primaryKey()` | single-column `PRIMARY KEY` |
| `.unique(name?, { nullsNotDistinct? })` | `UNIQUE` constraint |
| `.default(v)` | `DEFAULT <literal>` — structurally compared |
| `.default(sql\`…\`)` | `DEFAULT <expr>` — normalized through the shadow DB before comparison |
| `.references(() => col, opts)` | single-column `FOREIGN KEY`; `onDelete`/`onUpdate` = `cascade\|restrict\|no action\|set null\|set default`, plus `deferrable()`, `initiallyDeferred()`, `notValid()` |
| `.check(expr)` | column-scoped `CHECK` (named `<table>_<col>_check` unless given) |
| `.generatedAlwaysAsIdentity(opts)` / `.generatedByDefaultAsIdentity(opts)` | identity |
| `.generatedAlwaysAs(expr, { stored?: true })` | `GENERATED ALWAYS AS (…) STORED` (`VIRTUAL` gated on PG18) |
| `.oneOf([...])` | TS union **and** a `CHECK (col IN (...))`; `.oneOf([...], { check: false })` for type-only |
| `.array(dim?)` | `T[]` / `T[][]` |
| `.collate('C')` | `COLLATE` |
| `.storage('external')` | `SET STORAGE` |
| `.compression('lz4')` | `SET COMPRESSION` |
| `.comment('…')` | `COMMENT ON COLUMN` |
| `.renamedFrom('old')` | rename annotation (§5.1) |
| `.deprecated({ reason, removeAfter? })` | a `COMMENT` marker + lint rule; **does not change TS types** |

TS-only (`$` prefix — never in the IR, per D4):

| Modifier | Effect |
|---|---|
| `.$type<T>()` | narrows the TS type; **`T` must extend the codec's type** (D13) |
| `.$default(() => v)` | client-side default applied on insert; no `DEFAULT` in DDL |
| `.$onUpdate(() => v)` | client-side value on update; no trigger emitted |
| `.$required()` | present-but-nullable in `Insert<>` (MikroORM's `RequiredNullable`) |
| `.$optional()` | force optional in `Insert<>` without a DB default |
| `.$hidden()` | excluded from `serialize()` output; still selectable/queryable |
| `.$name('tsAlias')` | *n/a* — TS names are the object keys; there is no alias mechanism |

`.codec(c)` is the one non-`$` type-affecting modifier: it swaps the encode/decode pair **and** may change the SQL type, so it belongs in the IR.

> **AS BUILT (design/12 §4 F1).** `.$default(fn)` and `.$onUpdate(fn)` are **applied**, which they
> were not: both were recorded on `ColumnTsMeta` and read by nothing, so `Insert<>` marked a
> `$default` column optional and the insert then omitted it — a `NOT NULL` column whose only
> default was a `$default` failed with `23502` (design/12 §4 D finding a).
>
> `$default` is called **once per row**, at `.values(…)` / `.valuesMany(…)` rather than at
> `.compile()`, because `toAst()` and `compileAll()` each build from the stored rows and a factory
> evaluated there would run twice for a builder that is inspected and then executed — `03` §1.3's
> "the same builder always produces the same tree" would stop being true. An explicit value wins;
> a key present with the value `undefined` counts as absent, since that is the shape a
> `{ ...partial }` spread produces for an optional column.
>
> `$onUpdate` is applied at `toAst()` (memoised, so once per builder) and only for a column
> `.set({…})` did not already assign — doing it inside `.set()` would produce two assignments to
> one column, which PostgreSQL rejects with 42701. Two places deliberately do **not** apply either:
> `insertInto(t).defaultValues()`, which means the *database's* defaults and sends no values, and
> `onConflict(…).doUpdate(…)`, whose list is the caller's chosen conflict action.
>
> The `$` law (D4) is intact throughout: neither reaches DDL or the migration IR. The runtime seam
> is `TableCodecMeta.clientDefaults` / `.clientOnUpdates` in `src/query/meta.ts`, built once per
> (registry, table) and `undefined` when no column declares one, so a schema that uses neither pays
> a single property read on the insert path.

> **AS BUILT 2026-08-28 (design/11 §3 K2a).** Eleven of the DDL-affecting rows above exist;
> the rest are named here so the gap is a row and not an absence.
>
> | row | as built |
> |---|---|
> | `.nullable()` `.primaryKey()` `.default(v)` `.array()` | built (WS0) |
> | `.unique(name?, { nullsNotDistinct? })` | **built.** Extends the old no-argument `.unique()`; `nullsNotDistinct` needs PG 15, which is the floor. `ColumnDdl.unique` stays a boolean and `ColumnDdl.uniqueSpec` carries the two options, so nothing that read the old field broke. |
> | `.references(() => col, opts)` | **built**, single-column, `opts = { name?, onDelete?, onUpdate?, deferrable?, initiallyDeferred? }` with the five actions of the row above, validated at declaration time. `initiallyDeferred` implies `deferrable`, as PostgreSQL's own grammar does. `notValid()` is NOT built (the two-phase add is a `generate`-time rewrite, `06` §3.5, not a declaration). |
> | `.check(sql\`…\`, name?)` | **built.** The fragment's TEXT is stored; a bind parameter is rejected at declaration with `SchemaError`, because a `pg_constraint` row has nowhere to put a `$n`. A column reference interpolated into the hole (`` sql`${t.price} > 0` ``) renders as a quoted identifier. Multiple `.check()` calls accumulate — two CHECKs are two catalog rows. `.notValid()` as above. |
> | `.comment('…')` `.renamedFrom('old')` | **built**, as `ColumnDdl.comment` / `ColumnDdl.renamedFrom`. `renamedFrom` is carried, not acted on: it becomes a `RenameHint` in K2b (`11` §1.8). |
> | `.default(sql\`…\`)` | spelled **`.defaultSql('…')`** (WS0) and unchanged: `.default()`'s parameter is `M['t']`, and widening it to `M['t'] \| Fragment` would put a conditional on the hottest signature in the package. |
> | `.generatedAlwaysAsIdentity()` / `.generatedByDefaultAsIdentity()` | spelled **`.generatedAlways()` / `.generatedByDefault()`** (WS0). Same DDL. |
> | ~~`.generatedAlwaysAs(expr)`~~ `.oneOf()` `.collate()` `.storage()` `.compression()` `.deprecated()` | **not built.** None is reachable from `ColumnDdl` yet; each is one field plus one emitter branch. → `.generatedAlwaysAs()` **is built** (design/14 §G, below); the other five are not. |
>
> **Not one of these moved `Col<M>`.** Every addition is a `ColumnDdl` field and every new method
> returns `Col<M>` unchanged — asserted per method by `expectTypeOf` in
> `packages/pg-prime/test/schema/ddl.test.ts` and in aggregate by `pnpm bench:types`
> (instantiations/column 3.08 → 3.08 on TS 7.0.2, instantiations/table 37 → 37).
>
> **Two circularity notes.** A *self*-reference cannot be written as `.references(() => t.cols.id)`
> inside `t`'s own initializer — TS7022, the thunk's body needs the type being inferred — so the
> spelling is the `foreignKey` extra, whose callback parameter is that table's own refs. A
> *mutual* pair needs the thunk's return type stated once (`(): RefLike => orgs.cols.id`), the same
> device as Drizzle's `AnyPgColumn`. Both are documented on the method and tested.
>
> **`Table` gained one property, `cols`** — the same instantiation `[REFS]` already holds, under a
> name a schema file can type, because `.references(() => orgs.cols.id)` otherwise needs the
> phantom slot symbol. Measured cost across the 100-table headline: 63 instantiations on TS 5.9.3,
> 19 on TS 7.0.2 (0.08% / 0.01%).

> **AS BUILT 2026-08-29 (design/12 K4) — one more column builder, and it is an escape hatch.**
>
> **`t.raw(pgType, name?)`** declares a column of ANY PostgreSQL type, named as text:
> `t.raw('character varying(40)')`, `t.raw('xml')`, `t.raw('public."Name"')`. The eleven typed
> builders cover eleven types; PostgreSQL has hundreds, plus every domain and composite a schema
> declares. §5.3's rule for that gap is that the escape hatch lives INSIDE the model or the
> un-modelled part becomes permanent drift, and this is that rule at **column** grain. It is also
> what makes `pg-prime pull` able to emit a schema that round-trips a database it did not create:
> all four third-party corpora do, with an empty residue.
>
> The read type is `unknown` and that is deliberate — the type name is a string this package
> cannot reason about, so pretending to know what a `real` decodes to would be a lie the codec
> layer cannot honour. Narrow it with `.$type<T>()`. `test/query/meta.test.ts`'s "EVERY builder
> resolves to a codec" names `raw` as the single exception rather than filtering by shape, so a
> twelfth builder with no codec still fails that test.
>
> Cost: zero. `raw` returns `Base<unknown, string>`, introduces no type parameter, and
> `bench:types` moved not one per-declaration or per-query number.

> **AS BUILT 2026-09-01 (design/14 §G) — `.generatedAlwaysAs()`, design/01 §3 row 51.**
>
> `t.numeric().generatedAlwaysAs(expr, { stored? })` emits `GENERATED ALWAYS AS (<expr>) STORED`.
> `expr` is a fragment, or **§2.3's late-bound callback** `(cols) => sql\`…\`` — a generation
> expression names its SIBLINGS, and inside `pgTable(name, (t) => ({ … }))` they do not exist as
> references yet. `pgTable` resolves the callback the moment the DB names are known, against a
> names-only pre-pass that is built **only** when some column of that table asks for one; the
> resolved text lands in `ColumnDdl.generatedAs` and `generatedAsFrom` is cleared, so every
> consumer reads one field. `cols` is typed `Readonly<Record<string, RefLike>>` and not the
> table's `[REFS]` slot, because the column builder runs before the table's shape is inferred:
> a key that does not exist is caught when the expression is rendered, not by the compiler.
>
> **The type level is `ro: true`,** the same slot `.generatedAlways()` sets, so the key is erased
> from `Insert<>`/`Update<>` with no new machinery — pinned per shape by `expectTypeOf` in
> `test/schema/g14-ddl-closeout.test.ts`. `bench:types`: instantiations/column 3.08 → 3.08,
> /table 37 → 37, every per-query fixture and every schema-size ratio unchanged.
>
> Three consequences, and each is a refusal:
>
>  - **`.nullable()` goes first.** A stored generated column MAY be nullable, but `ro: true`
>    closes `.nullable()` afterwards. `NullableFn`'s sentence is amended to name both spellings
>    (`~~'.nullable() after .generatedAlways(): a generated column is always NOT NULL'~~` →
>    `'.nullable() after .generatedAlways()/.generatedAlwaysAs(): an identity column is never
>    null, and a generated expression column takes .nullable() BEFORE it'`).
>  - **STORED only.** `{ stored: false }` is `OrmTypeError` in *parameter* position — design/04
>    §4.1's sentinel, moved to the argument because that is what is wrong — plus a runtime
>    sentence naming PG 18. §2.3's gate said "PG 18"; the real reason is that `attgenerated`
>    cannot be altered in place in EITHER direction, so `diff/ddl.ts` refuses every generated
>    transition and a VIRTUAL column would be declarable only for a table the same plan creates.
>  - **The expression must be IMMUTABLE**, which is PostgreSQL's rule: `price * quantity` is,
>    `lower(during)::date` is not (it reads the session's `TimeZone`) — measured on 17.11 while
>    writing the emitter fixture.
>
> **Runtime, not just DDL.** `metaOf().insertableKeys` drops it, so `copyFrom`'s default column
> list does too — which closes design/13 §5 F3's open edge, where the column could not be
> declared and COPY's own `42P10` was the only refusal available. A new `generatedKeys` tells the
> two kinds apart, because only ONE of them may be named explicitly: COPY writes an identity
> value you give it, and can never write a generated expression.

### 2.4 Table-level nodes (the extras array)

```ts
(t) => [
  // keys & constraints
  primaryKey(t.a, t.b),
  primaryKey({ name: 'pk_ab', columns: [t.a, t.b] }),
  unique('u_ab').on(t.a, t.b).nullsNotDistinct(),
  check('c_positive', sql`${t.n} > 0`).notValid(),           // two-phase add
  foreignKey({ columns: [...], foreignColumns: [...], onDelete: 'cascade' })
    .name('fk_x').deferrable().initiallyDeferred().notValid(),
  exclude('no_overlap').using('gist')
    .on([t.room, '='], [t.during, '&&'])
    .where(sql`…`).requires(btreeGist).deferrable(),

  // indexes
  index('i1').on(t.a, t.b.desc().nullsLast()),
  index('i2').using('gin').on(t.doc).with({ fastupdate: false }),
  index('i3').on(sql`lower(${t.email})`).where(sql`${t.deletedAt} IS NULL`),
  index('i4').on(t.a).include(t.b, t.c),                     // covering
  uniqueIndex('i5').on(t.a).nullsNotDistinct(),
  index('i6').on(t.a).concurrently(false),                   // opt out of D15
  index('i7').on(t.vec.opclass('vector_cosine_ops')).using('hnsw').with({ m: 16, ef_construction: 64 }),
  index('i8').tablespace('fast_ssd').fillfactor(70),

  // table options
  partitionBy.range(t.createdAt),
  partitionBy.list(t.tenantId),
  partitionBy.hash(t.id),
  partitions({ manage: 'declared', unknown: 'adopt' }),
  unlogged(),
  withOptions({ fillfactor: 70, autovacuum_vacuum_scale_factor: 0.01 }),
  tablespace('fast_ssd'),
  replicaIdentity.full(),                                    // or .using(index('i5'))

  // RLS
  rls.enable(),
  rls.force(),

  // metadata & migration annotations
  comment('…'),
  renamedFrom('organisations'),
  dropColumn('legacy_id', { reason: 'replaced by external_ref in #4412' }),
  external(),                                                // provenance: never emit, never drop
]
```

`INHERITS` is deliberately absent (D16).

> **AS BUILT 2026-08-28 (design/11 §3 K2a).** `TableExtra` is the tagged union D5 promises, with
> seven node kinds:
>
> | node | spelling as built |
> |---|---|
> | `primaryKey` | `primaryKey(t.a, t.b)` (WS0). The `{ name, columns }` object form is not built; the emitter always names it `<table>_pkey`, which is what the server would have chosen. |
> | `index` / `uniqueIndex` | `index('i').on(t.a, t.b)` (WS0). Plain b-tree column lists only — `.using()`, `.where()`, `.include()`, `.desc()`, `.opclass()`, `.with()`, `.concurrently()` and expression indexes are **not built**. |
> | `comment` | `comment('…')` (WS0). |
> | `unique` | **built**: `unique('u_ab').nullsNotDistinct().on(t.a, t.b)`. A UNIQUE *constraint*, distinct from `uniqueIndex`, because an FK can point at the first and not at the second. The name is optional; unnamed falls back to `<table>_<cols>_key`. |
> | `check` | **built**: `check('c_positive', sql\`…\`)`. The name is **mandatory** here (unlike the column method): PostgreSQL's own default for a multi-column check is the bare `<table>_check`, which collides on the second one. `.notValid()` is not built. |
> | `foreignKey` | **built**: `foreignKey({ name?, columns: [...refs], references: () => [...refs], onDelete?, onUpdate?, deferrable?, initiallyDeferred? })`. `references` is a thunk for the same reason `.references()` is one; it is also the **self-FK** and **composite-FK** spelling. Named `foreignColumns` in the design sketch — renamed to `references` to match the column method, and because the thunk is the load-bearing part. |
> | `renamedFrom` | **built**: `renamedFrom('organisations')`. |
>
> **Not built:** ~~`exclude`~~, ~~`partitionBy`~~, `partitions`, `unlogged`, `withOptions`,
> `tablespace`, `replicaIdentity`, `rls.*`, `dropColumn`, `external`. `EXCLUDE`, partitions and
> `comment`-as-a-fact are K3's; the rest have no IR to land in yet. → `partitionBy` landed in
> design/12 K4 and `exclude` in design/14 §G (both below); the table-level `tablespace()` and
> `withOptions()` are still not built — the INDEX-level `.tablespace()` / `.with()` of design/14
> §G are a different node.

> **AS BUILT 2026-08-29 (design/12 K4).** Six more, every one of them a Tier-M fact the differ
> already models — which is the bar: a fact the differ can DROP is a fact the DSL has to be able
> to declare, or every adopted database's first migration destroys it.
>
> | node | spelling as built |
> |---|---|
> | `index` / `uniqueIndex` | **the options are built**: `index('i', { using, where, include, nullsNotDistinct })`, and the same four as chained methods (`.using('gin')`, `.where(sql\`…\`)`, `.include(t.b, t.c)`, `.nullsNotDistinct()`). Per-column `desc` / `nulls` / `opclass` are **item objects** — `index('i').on(t.a, { column: t.b, desc: true, nulls: 'last', opclass: 'text_pattern_ops' })`. The plain-column form is unchanged and fills the options in with "not stated", so the emitted `CREATE INDEX` is byte-identical to what it was before they existed. ~~Still not built: `.with({ … })`, `.concurrently(false)`, `.tablespace()`, and **expression** indexes — `pull` records an expression index as unsupported rather than approximating it.~~ → all four built in design/14 §G, below. |
> | `primaryKey` | **the `{ name, columns }` object form is built.** §2.4 always listed it; K2a's "the emitter always names it `<table>_pkey`" turned out to be exactly what stops an adopted database round-tripping — AdventureWorks names all 68 of its primary keys `PK_Something`, and without a name the first generated migration renames every one of them. |
> | `clusterOn('idx')` | **built**, beyond §2.4's list. `pg_index.indisclustered` became a Tier-M fact in design/11 K2b (the D10 witness found it missing on all 68 AdventureWorks tables); a fact that is diffed and cannot be declared is a fact that gets dropped. |
> | `partitionBy(strategy, key)` / `partitionOf(parent, bound, { schema? })` | **built.** The parent gets `PARTITION BY RANGE (…)`; the child is emitted as a standalone `CREATE TABLE` followed by `ALTER TABLE parent ATTACH PARTITION child …`, which is `pg_dump`'s own form and the only one that round-trips on PostgreSQL 18 — `CREATE TABLE … PARTITION OF` clones the parent's constraints *including their names*, and PG 18 catalogues NOT NULL as a named `pg_constraint` row. The key travels as **text**, because `pg_get_partkeydef` is an expression (`RANGE (date_trunc('month', at))` is legal) and a column-list-only spelling would round-trip some partitioned tables and silently mangle the rest. `partitions({ manage, unknown })` is still not built. |
>
> The item-object spelling for `desc` / `nulls` / `opclass` **diverges from §2.4's sketch**, which
> writes them as methods on the column reference (`t.b.desc().nullsLast()`). `Ref` is the hottest
> type in the package — it is what `[REFS]` holds for every column of every table — and three more
> methods on it would be paid for by every schema in every program, for a feature that appears in
> a handful of index declarations. The item object costs nothing at the type level and says the
> same thing. `bench:types`: not one per-declaration or per-query number moved.

> **AS BUILT 2026-09-01 (design/14 §G) — `exclude`, and the rest of the i1–i8 sketch.**
>
> | node | spelling as built |
> |---|---|
> | `exclude` | **built**, design/01 §3 row 49: `exclude(name).using(m).where(sql\`…\`).deferrable()/.initiallyDeferred().requires(ext).on([ref \| sql, 'op'], …)`. The name is MANDATORY, for the reason `check`'s is — PostgreSQL's own default is `<table>_<first column>_excl`, which collides on the second one, and an adopted database's constraint names are data `pull` has to reproduce. An element is a column reference (rendered as a quoted identifier) or a fragment (parenthesised); the operator is checked against PostgreSQL's own operator alphabet at declaration time, so `OPERATOR(schema.&&)` is refused rather than emitted without the resolution rules that make it mean anything. |
> | `index` / `uniqueIndex` | **the remaining four options are built**: an **expression** key (`index('i').on(sql\`lower(${'x'})\`)`, or `{ expression, desc?, nulls?, opclass? }`), `.with({ … })` (rendered sorted by key, text values quoted, merging across calls), `.fillfactor(n)` as sugar for it, `.tablespace(name)`, and `.concurrently(false)`. `IndexItem.column` widens to `string \| undefined` beside a new `expression`; `TableExtra`'s `columns` stays the COLUMN keys only, because an expression has no name and inventing one would make that list lie. |
>
> **`.on(...)` is terminal on `exclude`, and that diverges from §2.4's sketch**, which writes
> `.on(...)` in the middle and `.where(...)` after it. Making that order work needs the builder
> itself to BE the `TableExtra`, and the node's fields are exactly the method names (`using`,
> `where`, `deferrable`, `initiallyDeferred`) — one object cannot hold both. Terminal `.on()` is
> what `index` and `unique` already do, so the divergence buys consistency rather than costing it.
>
> **`.requires(ext)` is built**, which design/14 decision 2 left optional. It is checked in the
> EMITTER against the registry's own `pgExtension(...)` declarations — the only thing that decides
> whether `CREATE EXTENSION` runs before the table — and an unsatisfiable claim is an `error`
> diagnostic naming the declaration to add, instead of a `42704` about an operator class three
> steps later on the shadow. Nothing else is checked: the version, and whether the DBA installed
> it on the cluster, are §3.10's business and not the schema's.
>
> **`.concurrently(false)` is NOT a catalog fact and cannot become one.** `CONCURRENTLY` is a
> property of how an index is BUILT; `pg_get_indexdef` has nothing to say about it, so an
> `IndexPayload` field would read `false` on the DSL side and absent on the catalog side and every
> such index would diff for ever. It travels as `BuildOptions.noConcurrentIndexes`, filled by
> `generate` straight off the registry — the same route `renamedFrom` takes to the rename hints.
>
> **`.tablespace(name)` emits and diffs, and no fixture creates a tablespace.** A tablespace is a
> cluster-level object with a filesystem path behind it, so a schema that names one only loads
> where that name already exists; the emitted clause is pinned by exact text in
> `test/schema-emit/emit.test.ts` and `pull` reads one back out of `pg_get_indexdef`, but no
> shadow-loading fixture declares one and no CI leg has one to declare.
>
> `bench:types`: not one per-declaration or per-query number moved.

---

## 3. Beyond tables — the differentiator surface

Every object below is a value with the same IR contract as a table, participates in the topological sort, and carries `renamedFrom` / `comment` / provenance.

### 3.1 `pgSchema` — multiple schemas

```ts
export const audit = pgSchema('audit', { renamedFrom: 'auditing' });

// a schema is a namespace factory bound to that schema
export const events = audit.table('events', (t) => ({ ... }));
export const eventKind = audit.enum('event_kind', ['created', 'deleted']);
export const eventsView = audit.view('recent_events').as(...);
export const cleanup = audit.function('cleanup', { ... });
```

`defineSchema({ ... }, { defaultSchema: 'public' })` sets where unqualified objects land. `search_path` is set explicitly per connection by the runtime, never inferred.

> **AS BUILT 2026-08-28 (design/11 §3 K2a).** `pgSchema(name, { renamedFrom? })` returns
> `{ kind: 'schema', name, renamedFrom, table(...), enum(...) }` — `table` is `pgTable` with
> `{ schema: name }` already applied and `enum` is `pgEnum` with `{ schema: name }`. `.view()`,
> `.function()`, `.domain()`, `.sequence()` are **not built** (no IR for them yet).
>
> Two consequences worth stating:
>
>  - **`RefRuntime` gained `schema`.** `.references(() => events.cols.id)` hands the emitter one
>    column reference and nothing else; without the schema on it, a cross-schema FK target would
>    have to be guessed by table name, which is ambiguous the moment two schemas hold a table of
>    the same name. Runtime metadata only — `RefRuntime` is non-generic, so the type budget did not
>    move.
>  - **`defaultSchema` is an emitter option, not a registry one.** `defineSchema` still takes
>    tables (and relations) only; `emitSchema(schema, { defaultSchema })` decides where an
>    unqualified object lands, defaulting to `public`. The registry describes the schema; where it
>    is *written* is a property of the run (and, under the tier-3 shadow map, of the tier).
>
> An enum with no `{ schema }` lands in the emitter's default schema — deliberately **not** in the
> schema of whichever table happens to use it, because two tables in two schemas may share one enum
> and letting the placement follow the first user makes the DDL depend on registry order. An enum
> no column uses is not emitted at all (`11` §3 K2a: enums are reachable only through
> `ColumnDdl.enumName`/`enumValues`/`enumSchema`).

### 3.2 `pgEnum`

```ts
export const memberRole = pgEnum('member_role', ['owner', 'admin', 'member'], {
  schema: undefined,
  comment: 'Membership authority level',
  renamedFrom: 'org_role',
  // PG supports ALTER TYPE ... RENAME VALUE; map is { newLabel: oldLabel }
  renamedValues: { member: 'user' },
});

type Role = Infer<typeof memberRole>;              // 'owner' | 'admin' | 'member'
memberRole.values;                                 // readonly ['owner','admin','member']
```

> **AS BUILT 2026-08-29 (design/12 F2).** `renamedValues` is built with the spelling above —
> `{ [newLabel]: oldLabel }` — and the keys are checked against the declared labels at declaration
> time. ~~`comment` on `pgEnum` is still not built.~~ See §5.1's AS BUILT note for the emitter half.
>
> > **AS BUILT 2026-09-01 (design/14 §G) — design/01 §3 row 54's third target.** `comment` is built
> > on **`pgEnum` and `pgDomain`**, as a plain option, and emits `COMMENT ON TYPE` for both:
> > PostgreSQL resolves a domain name through the same `pg_type` lookup, and `diff/ddl.ts`'s
> > `commentTarget` already said `TYPE` for both, so the DSL renderer and the catalog renderer can
> > be compared statement for statement. The extractor has carried a type's `pg_description` row as
> > a `comment` fact since design/11 K3, so nothing on the diff side moved — the gap was that the
> > DSL could not put one there, which made a commented enum in an adopted database a
> > `COMMENT ON TYPE … IS NULL` in the first generated migration. An enum discovered through a
> > COLUMN is MERGED with its standalone declaration rather than replaced by it: `ColumnDdl` carries
> > only the name, labels and schema of the enum a column uses, so which of the two the emitter saw
> > first must not decide whether the comment is emitted.

**Ordering matters and we honour it.** Adding a label in the middle emits `ALTER TYPE … ADD VALUE 'x' BEFORE 'y'`. Removing or reordering labels is impossible in PG; the generator emits the full rename → create → `ALTER COLUMN … USING` → drop dance, flags it `DS` (destructive) + `MF` (table rewrite), and requires a tombstone. `ADD VALUE` and a same-migration `UPDATE … SET col='new'` are automatically split into two migration files, because PG forbids using a new label in the transaction that added it.

### 3.3 `pgDomain`

```ts
export const email = pgDomain('email', citext(), {
  notNull: false,
  default: undefined,
  check: (value) => sql`${value} ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'`,
  // multiple named constraints
  checks: { email_has_tld: (v) => sql`${v} LIKE '%.%'` },
  comment: 'Case-insensitive email',
});

export const positiveInt = pgDomain('positive_int', integer(), {
  check: (v) => sql`${v} > 0`,
});

// usage
t.domain(email)                  // TS type = the base codec's type, brandable via $type
t.domain(email).array()
```

Domain check constraints are separate diffable objects (`ALTER DOMAIN … ADD/DROP CONSTRAINT`), so adding a rule doesn't drop the domain.

### 3.4 `pgCompositeType`

```ts
export const postalAddress = pgCompositeType('postal_address', {
  line1:   text().$required(),
  line2:   text(),
  city:    text().$required(),
  country: char({ length: 2 }).$required(),
});

type Address = Infer<typeof postalAddress>;
// { line1: string; line2: string | null; city: string; country: string }
```

PG composite attributes cannot carry `NOT NULL`. **OPEN (consequence of the nullability inversion, see §0):** under NOT-NULL-by-default a bare `text()` attribute would type as non-null while PostgreSQL still permits null — unsound. Either composite attributes invert too (bare = nullable, `.$required()` narrows, as the examples here assume), or `.nullable()` becomes mandatory on them. Needs a decision before the composite builder is implemented. Attribute add/drop/rename/retype all diff individually (`ALTER TYPE … ADD/DROP/RENAME/ALTER ATTRIBUTE`). Composite columns encode/decode through the record wire format, not string munging.

### 3.5 `pgSequence`

```ts
export const invoiceNo = pgSequence('invoice_no', {
  start: 1000, increment: 1, minValue: 1000, cache: 1, cycle: false,
  ownedBy: () => invoices.number,       // ALTER SEQUENCE … OWNED BY
});

t.bigint().default(sql`nextval(${invoiceNo})`)
```

`last_value` is data, not schema; it is never diffed.

### 3.6 `pgView` / `pgMaterializedView`

Two authoring forms, one IR node:

```ts
// (a) typed from a query — columns and TS types inferred
pgView('active_users').as((q) => q.from(users).where((u) => isNull(u.deletedAt)).select(...))

// (b) declared columns + raw SQL — for anything the builder can't express
pgView('org_health').columns((t) => ({ orgId: t.uuid(), status: t.text() })).as(sql`…`)

// (c) it exists but we don't manage it
pgView('legacy_report').columns((t) => ({ ... })).existing()
```

Options: `.with({ securityInvoker, securityBarrier, checkOption })` — **`securityInvoker: true` is the default** (D14). `.comment()`, `.renamedFrom()`, `.dependsOn(...)` for explicit ordering when the SQL is opaque.

Materialized views add `.indexes((v) => [...])`, `.using('heap')`, `.tablespace(...)`, `.withNoData()`, and `.refreshable({ concurrently })`. `concurrently: true` without a unique index on the matview is a lint **error**, not a runtime surprise. Matviews cannot honour `security_invoker`, so a matview reading an RLS-enabled table emits lint `SEC002`.

**Diff strategy:** views/matviews are compared by normalized definition through the shadow DB (never by source text — `pg_get_viewdef` re-renders), and are recreated with `DROP … CASCADE`-aware ordering. Dependent views, policies and grants are re-created by the generator, which is exactly what drizzle-kit gets wrong today.

### 3.7 `pgFunction` — declared inline, callable, hash-diffed (D7)

```ts
export const slugify = pgFunction('slugify', {
  args:       [{ name: 'input', type: text() }],
  returns:    text(),
  language:   'sql',
  volatility: 'immutable',
  parallel:   'safe',
  strict:     true,
  cost:       10,
  body: sql`SELECT lower(regexp_replace($1, '[^a-zA-Z0-9]+', '-', 'g'))`,
});

// A declared function is a typed expression factory:
slugify(orgs.name)                       // Expr<string>
t.text().generatedAlwaysAs((c) => slugify(c.name))
check('slug_matches', sql`${t.slug} = ${slugify(t.name)}`)
db.select({ s: slugify(orgs.name) }).from(orgs)
```

Full option set: `schema`, `args` (name/type/mode `in|out|inout|variadic`/default), `returns` (type expr, `'trigger'`, `'void'`, `setOf(type)`, `table({...})`), `language` (`sql|plpgsql|plv8|c|internal`), `volatility`, `parallel`, `strict`, `security` (`invoker|definer`), `searchPath`, `cost`, `rows`, `leakproof`, `set` (per-function GUCs), `body`, `comment`, `renamedFrom`, `dependsOn`. `pgProcedure` is the same shape without `returns`.

**The diff rule** — this is the contract for agent 06:

- **Signature** (`schema.name(argtypes)`) is the catalog identity and is diffed **structurally**. Changing an argument type, adding a parameter, or changing the return type is a `DROP FUNCTION` + `CREATE FUNCTION` (PG requires it), and drops of overloads are ordered against dependents.
- **Body + non-signature attributes** are reduced to a `bodyHash` and applied as an **idempotent repeatable object**: whenever the hash changes we emit `CREATE OR REPLACE FUNCTION …` in a repeatable migration, exactly graphile-migrate's model. We never attempt to text-diff a function body.

That split is the whole trick: it gets us structural safety where PG demands it and hash-based idempotence where text diffing is a phantom-diff generator.

### 3.8 `pgTrigger`

```ts
export const membershipsAudit = pgTrigger('memberships_audit', {
  on:      memberships,
  timing:  'after',                       // before | after | insteadOf
  events:  ['insert', 'update', 'delete'],
  // column-scoped UPDATE:
  // events: [{ update: (t) => [t.role, t.orgId] }, 'delete'],
  level:   'row',                         // row | statement
  when:    (r) => sql`${r.old.role} IS DISTINCT FROM ${r.new.role}`,
  execute: logMembershipChange(),         // arity/type-checked against the pgFunction
  constraint: false,                      // CONSTRAINT TRIGGER + deferrable if true
  // statement-level transition tables:
  // referencing: { newTable: 'inserted', oldTable: 'deleted' },
  comment: 'Writes to audit.membership_events on role changes',
});
```

`when` receives typed `OLD`/`NEW` proxies over the target table's columns, so a renamed column breaks the trigger at compile time instead of at deploy time. Triggers have no `ALTER` for most attribute changes, so any change is `DROP TRIGGER` + `CREATE TRIGGER`; the generator warns that creation takes `SHARE ROW EXCLUSIVE` (Atlas PG308) and offers to emit it in its own file.

### 3.9 `pgRole`, `pgPolicy`, `grant`

```ts
export const appUser = pgRole('app_user', {
  login: false, inherit: true, createDb: false, createRole: false,
  bypassRls: false, connectionLimit: -1, memberOf: [readonlyRole],
});

export const p = pgPolicy('name', {
  on:        memberships,
  for:       'all',              // all | select | insert | update | delete | [ ... ]
  as:        'permissive',       // permissive (default) | restrictive
  to:        [appUser],          // roles; PUBLIC if omitted
  using:     (t) => sql`…`,      // typed column proxy
  withCheck: (t) => sql`…`,
  renamedFrom: 'old_policy_name',
});

grant(['select', 'insert'], { on: memberships, to: appUser, withGrantOption: false });
grant(['usage'], { on: audit, to: appUser });                       // schema-level
grant(['execute'], { on: slugify, to: appUser });                   // function-level
grantDefault(['select'], { in: audit, to: appUser, for: 'tables' }); // ALTER DEFAULT PRIVILEGES
```

Policy expressions have the same normalization problem as views and get the same shadow-DB treatment. `ALTER POLICY` is used where possible so the policy is never briefly absent.

**Grants are `observe` by default** (`defineSchema(..., { grants: 'observe' })`): we read them, report drift, and never emit revokes. Set `grants: 'manage'` to make them a managed, diff-and-drop object kind. Roles are cluster-scoped and shared across databases, so `pgRole` defaults to `manage: 'create-if-missing'` — we create roles we declare, never drop roles we don't.

### 3.10 `pgExtension`

```ts
export const pgcrypto  = pgExtension('pgcrypto');
export const vectorExt = pgExtension('vector', { schema: 'extensions', version: '0.8.0', cascade: true });
```

Declared extensions are emitted as `CREATE EXTENSION IF NOT EXISTS`, installed into the shadow DB before normalization (solving Prisma's `initShadowDb` mess), and **their owned objects are tagged `provenance: 'extension'` and excluded from the drop set**. Anything in the catalog owned by an extension we don't declare surfaces as a diagnostic, never a `DROP`.

### 3.11 Comments

Three equivalent spellings, one IR node kind (`comment`, identity = the commented object):

```ts
t.text().comment('…')                          // column
[ comment('…') ]                               // table extras
pgEnum('x', [...], { comment: '…' })           // standalone object option
```

---

## 4. Relations (D6)

### 4.1 Why a separate map, not in-table

1. **A foreign key is a constraint; a relation is a query affordance.** They are not the same object and do not always coincide (relations through views, through non-key predicates, m2m through a junction). Conflating them is what forces Prisma into implicit join tables and what makes composite FKs awkward everywhere.
2. **Circular imports.** Bidirectional in-table relations force lazy thunks (MikroORM's `() => p.manyToOne(Author)` tax). A central map over a table barrel has no cycle.
3. **One object for the type engine.** Agent 04 walks a single relation graph rather than N table objects, which keeps `Loaded<T, Hint>` path inference cheap.
4. **Splittable.** `defineRelations` may be called per module; the registry merges parts (Drizzle's `defineRelationsPart`, but without a second function name).

### 4.2 Surface

```ts
defineRelations(tables, (r) => ({
  <tableKey>: {
    <relationName>: r.one.<target>(config?) | r.many.<target>(config?),
  },
}))
```

`config`:

| Key | Meaning |
|---|---|
| `from` | column ref, `[refs]` for composite, or `ref.through(junctionRef)` |
| `to` | same shapes on the target side |
| `where` | relation-level predicate, applied to every load and to filters |
| `optional` | `one` only. `false` → non-nullable in the result type |
| `alias` | disambiguates two relations sharing the same from/to pair |

### 4.3 FK inference and its failure mode

`r.one.orgs()` with no config resolves by looking for **exactly one** FK from the owning table to the target. `memberships → orgs` has one (`org_id`), so it infers. `memberships → users` has two (`user_id`, `invited_by`), so a bare `r.one.users()` is:

- a **type error**: `Ambiguous relation: 2 foreign keys from "memberships" to "users" (memberships_user_id_fkey, memberships_invited_by_fkey). Specify { from, to }.`
- and a **runtime throw at `defineRelations`**, with the same message and both constraint names.

Inference never guesses. `r.many.X()` on the reverse side infers the same way (single inbound FK) and errors identically when ambiguous. This is the ergonomic delta over Drizzle RQB v2, which makes you restate `from`/`to` even in the unambiguous 90% case.

### 4.4 Shapes covered

```ts
// one-to-many (inferred)
orgs:        { memberships: r.many.memberships() }
memberships: { org: r.one.orgs() }

// one-to-one, non-nullable
users: { profile: r.one.profiles({ from: r.users.id, to: r.profiles.userId, optional: false }) }

// self-referential
users: {
  invitees: r.many.users({ from: r.users.id, to: r.users.invitedById }),
  inviter:  r.one.users({ from: r.users.invitedById, to: r.users.id }),
}

// many-to-many through an explicit junction table
users: { orgs: r.many.orgs({
  from: r.users.id.through(r.memberships.userId),
  to:   r.orgs.id.through(r.memberships.orgId),
}) }

// composite-key relation
memberships: { seatHolds: r.many.seatHolds({
  from: [r.memberships.orgId, r.memberships.userId],
  to:   [r.seatHolds.orgId,   r.seatHolds.userId],
}) }

// filtered relation
orgs: { admins: r.many.users({
  from: r.orgs.id.through(r.memberships.orgId),
  to:   r.users.id.through(r.memberships.userId),
  where: { role: { in: ['owner', 'admin'] } },
}) }

// relation to a view / matview
orgs: { seatUsage: r.one.orgSeatUsage({ from: r.orgs.id, to: r.orgSeatUsage.orgId }) }
```

There is **no implicit junction table**. If you want m2m, you declare the table — because it will grow a `role`, a `created_at` and a policy within a month, and Prisma's implicit `_UserToOrg` is unmigratable when it does.

Relations produce **zero DDL**. `defineRelations` contributes nothing to the migration IR; it is purely a query-layer artifact. (The FKs it may infer from already exist as constraints on the tables.)

---

## 5. Migration-facing annotations

### 5.1 `renamedFrom` (D8)

One concept, three spellings, one IR field:

```ts
// columns, indexes, constraints — builder method
email: t.text().renamedFrom('email_address'),
index('users_email_idx').renamedFrom('users_email_key').on(t.email),

// tables — extras node
pgTable('orgs', cols, (t) => [ renamedFrom('organisations') ])

// standalone objects — option
pgEnum('member_role', [...], { renamedFrom: 'org_role', renamedValues: { member: 'user' } })
pgSchema('audit', { renamedFrom: 'auditing' })
pgFunction('slugify', { renamedFrom: 'make_slug', ... })

// raw SQL files — header directive
-- pg-orm:renamed_from audit.log_change(text,jsonb)
```

**Resolution semantics (the important part):** during `generate`, a `renamedFrom: 'old'` on object `new` fires **iff** `old` exists in the live/normalized catalog **and** `new` does not. Otherwise it is inert.

Consequences:
- Safe to leave in source forever → no codemod, no post-generate file rewriting, nothing that can corrupt a user's file.
- Safe to delete after the migration ships.
- Deterministic in CI and for agentic editors, which is exactly why Atlas shipped `renamed_from` in 2026.
- Chained renames work: `a → b → c` across two migrations, because each annotation only fires against the state that actually exists.
- Lint rule `stale-rename` (warning) flags annotations that have been inert for N consecutive `generate` runs, so they get cleaned up eventually.

Interactive `--interactive` mode does not "resolve" anything — it **writes the annotation into your source file** and re-runs. There is exactly one resolution mechanism.

> **AS BUILT 2026-08-28 (design/11 §3 K2a).** Two of the four spellings exist and both are
> **carriers only** — nothing in K2a acts on them:
>
>  - `.renamedFrom('old')` on a column → `ColumnDdl.renamedFrom`;
>  - `renamedFrom('old')` in the extras → `{ node: 'renamedFrom', from }`;
>  - `pgSchema('audit', { renamedFrom: 'auditing' })` → `PgSchema.renamedFrom`;
>  - `pgEnum(..., { renamedFrom })` and `renamedValues` are **not built**.
>
> The emitter ignores all of them: a rename is a statement about the *difference* between two
> states, and the emitter only ever describes one. The resolution semantics above ("fires iff `old`
> exists and `new` does not") are evaluated by K2b's `generate` against the current IR, feeding the
> kit's existing `RenameHint[]` — which is what makes `--hints-file` and the annotation one
> mechanism with two spellings (`11` §1.8).

> **AS BUILT 2026-08-29 (design/12 K4).** `pgEnum(name, values, { renamedFrom })` is now built,
> so **all four** spellings of the annotation exist: the column method, the extras node,
> `pgSchema(…, { renamedFrom })` (K2a) and `pgEnum(…, { renamedFrom })`. `pgDomain` and
> `pgSequence` take one too, for the same reason.
>
> **`generate` now READS all of them**, which is what K2b left undone. `annotationHints` walks
> `schema.schemas` / `schema.enums` / `schema.domains` / `schema.sequences` — populated by
> `loadSchema` off the module's own exports — and produces `RenameHint`s keyed by the right fact
> kind (`schema`, `type` for both enums and domains, since `05` §7.2 gives them the same identity
> tuple, and `sequence`). `acceptHints` applies §5.1's firing rule to them unchanged: old exists,
> new does not, so an annotation left in the source after its migration shipped is inert.
>
> `renamedValues` (`ALTER TYPE … RENAME VALUE`) is still not built.

> **AS BUILT 2026-08-29 (design/12 F2).** `renamedValues` is built, so §5.1 and §3.2 are complete:
> `pgEnum(name, values, { renamedValues: { member: 'user' } })` — **`{ [newLabel]: oldLabel }`**, as
> §3.2 writes it — is a carrier like the other four, `annotationHints` turns each pair into an
> `enumLabel` rename hint, `acceptHints` applies §5.1's firing rule to it unchanged, and the emitter
> writes `ALTER TYPE … RENAME VALUE 'old' TO 'new'` (hazard **BC105**, new; `06` §3.4).
>
> Three things worth recording:
>
>  - **The keys are typed.** `PgEnumOptions<V>` maps the keys over the declared labels, so a typo is
>    a compile error rather than an annotation that never fires. Three shapes that could never fire
>    are refused at declaration time: a key the enum does not declare, an old label that is *also*
>    still declared (two labels, not one renamed one), and a label mapped to itself.
>  - **The dependents come along for free, and that needed one change.** A label is stored as the
>    `pg_enum` row's oid, so PostgreSQL re-renders every DEFAULT, CHECK and index predicate that
>    names it — but the *current* IR was extracted before the rename and still says `'user'`, and
>    `definitionsAgreeUnderRename` compares literals byte for byte (deliberately: §3.3's textual
>    rewriter used to edit CHECK bodies). `diff/rename.ts` now substitutes a renamed label **only**
>    where it is immediately cast to the renamed type (`'user'::public.member_role`) and **only**
>    accepts the result when it reproduces PostgreSQL's own desired text exactly. Without it a
>    label rename planned a `DROP INDEX` + `CREATE INDEX` and an `ADD CONSTRAINT … NOT VALID` +
>    `VALIDATE` for objects that were already correct. With it the plan is one statement.
>  - **Three neighbouring renames were unreachable and now are not.** K4's `type`, `sequence` and
>    `schema` hints reached an emitter that had branches for `table`/`column`/`constraint`/`index`
>    only, so `pgEnum(…, { renamedFrom })` produced an `unsupported_rename` **error** and a plan
>    that renamed the type in its own head and never said so in SQL. `ALTER TYPE … RENAME TO`,
>    `ALTER SEQUENCE … RENAME TO` and `ALTER SCHEMA … RENAME TO` are emitted.
>
> Witness: `fixtures/diff/rename-enum-value/{current,desired}.sql` (R16), D10 `strict`, plus a
> negative control that runs the same pair with no annotation and gets EN102.

### 5.2 Destructive-change acknowledgment (D9)

Deleting a column from your schema file produces an *absence*, and absences are invisible in code review. Tombstones make the intent a positive diff line:

```ts
pgTable('users', cols, (t) => [
  dropColumn('legacy_id', { reason: 'replaced by external_ref, see #4412' }),
  dropIndex('users_old_email_idx'),
  dropConstraint('users_legacy_check'),
])

// object-level
pgDropped({ kind: 'view', name: 'public.old_report', reason: 'unused since 2026-05' })
pgDropped({ kind: 'table', name: 'public.sessions_v1', reason: 'migrated to redis' })
```

Rules:
- A drop of a **non-empty** object without a matching tombstone → `generate` fails with a `missing_hints`-shaped envelope (exit 2, never prompts in CI).
- A drop **with** a tombstone → emitted, and the `reason` is copied into `.plan.json` under `confirmed_data_loss`, so it appears in the PR both in the TS diff and in the plan.
- Tombstones are inert once the object is gone; `migrate checkpoint` sweeps them and `pg-orm schema doctor` lists stale ones.

The softer, expand/contract-phase marker is `.deprecated({ reason, removeAfter })`: emits a `COMMENT`, enables lint rule `no-new-deprecated-writes`, and shows up in `doctor`. It deliberately does **not** change TS types — silently removing a column from `Insert<>` breaks builds for the wrong reason at the wrong time.

### 5.3 The raw-DDL escape hatch and its provenance

The TS DSL will never cover 100% of Postgres. When it doesn't, users write SQL — and if that SQL lives outside the model, you get permanent drift. So it lives inside.

**Inline form:**

```ts
export const ensurePartition = rawObject({
  kind:     'function',
  identity: 'audit.ensure_partition(date)',       // catalog identity, used for ordering + dedup
  mode:     'repeatable',                          // 'repeatable' (hash-applied) | 'once'
  create:   sql`CREATE OR REPLACE FUNCTION audit.ensure_partition(d date) RETURNS void AS $$ … $$ LANGUAGE plpgsql`,
  drop:     sql`DROP FUNCTION IF EXISTS audit.ensure_partition(date)`,
  dependsOn: [audit, membershipEvents],
  txmode:   'default',
});
```

**File form** (`rawDir: './sql'`), same IR node:

```sql
-- sql/010_ensure_partition.sql
-- pg-orm:object function audit.ensure_partition(date)
-- pg-orm:mode repeatable
-- pg-orm:depends-on schema audit
-- pg-orm:depends-on table audit.membership_events
-- pg-orm:txmode default
-- pg-orm:drop DROP FUNCTION IF EXISTS audit.ensure_partition(date)
CREATE OR REPLACE FUNCTION audit.ensure_partition(d date) RETURNS void AS $$
BEGIN
  …
END;
$$ LANGUAGE plpgsql;
```

Both compile into an IR node with `provenance: 'raw'`. Raw objects are **never structurally diffed** — only hash-applied when `mode: 'repeatable'`, or applied once and recorded when `mode: 'once'`. They participate fully in the topological sort via `dependsOn`, and they are registered in the "known objects" set so the diff engine does not try to drop them.

**Third provenance — `external`:** an object that exists and that we type and query, but never emit and never drop.

```ts
export const authUsers = externalTable('auth.users', (t) => ({
  id:    t.uuid().primaryKey(),
  email: t.text(),
}));

// FKs may reference it; queries may join it; the diff engine ignores it entirely
export const profiles = pgTable('profiles', (t) => ({
  userId: t.uuid().primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }),
}));
```

`external()` is also available as a table-extras node for tables you declared before handing ownership to a DBA. This is Prisma's `externalTables` — the one genuinely good idea in its escape-hatch story — but with full typing instead of `Unsupported()`'s all-or-nothing hole.

**Provenance summary (agent 06's contract):**

| Tag | Emitted by generate? | Diffed? | Droppable? |
|---|---|---|---|
| `managed` | yes | structurally | yes, with a tombstone |
| `raw` | yes, verbatim | no — hash only | only via explicit `drop` |
| `extension` | via `CREATE EXTENSION` only | no | no |
| `external` | never | no | never |
| *(unknown catalog object)* | never | no | **never** — reported as a diagnostic (pg-delta's catalog-completeness check) |

---

## 6. Ergonomics

### 6.1 Organization: explicit registry, no globs (D11)

```ts
import * as usersMod from './users.js';
export const schema = defineSchema({ ...usersMod, ...orgsMod, relations }, opts);
```

Why not file-glob discovery:
- Globs break under bundlers and ESM (`import.meta.glob` is a Vite-ism; `require.context` is webpack's).
- Discovery order is filesystem-dependent → non-deterministic IR ordering → unstable schema fingerprints.
- The type engine would need the filesystem, which kills the "types work in a fresh checkout with no DB and no build step" property.
- "What is managed?" becomes unanswerable by reading code.

`import * as` + spread gives file-level modularity with none of that: the barrel is explicit, tree-shakeable, and diffable. Non-branded exports (types, helper functions, constants) are ignored; `defineSchema` filters by brand. `pg-orm schema check` reports any schema-branded export in `rawDir`/`schemaDir` that is not reachable from the registry — the TS-side twin of the catalog-completeness check.

The CLI reads `pg-orm.config.ts`:

```ts
import { defineConfig } from 'pg-prime/config';
import { schema } from './db/schema/index.js';

export default defineConfig({
  schema,
  migrations: './migrations',
  db: { url: process.env.DATABASE_URL! },
  shadow: 'auto',           // env url → CREATE DATABASE → temp schema → offline
});
```

### 6.2 Reuse patterns

Column builders are importable as free functions **and** available on the `t` param, so presets need no argument:

```ts
export const timestamps = () => ({
  createdAt: timestamptz().default(sql`now()`),
  updatedAt: timestamptz().default(sql`now()`),
});
export const softDelete = () => ({ deletedAt: timestamptz().nullable() });
export const pk        = () => uuid().primaryKey().default(sql`gen_random_uuid()`);
export const tenant    = () => ({ orgId: uuid().references(() => orgs.id, { onDelete: 'cascade' }) });

// composed
export const invoices = pgTable('invoices', (t) => ({
  ...pk(), ...tenant(), ...timestamps(), ...softDelete(),
  total: t.numeric({ precision: 12, scale: 2 }),
}));
```

Table-extras presets work the same way, since extras is just an array:

```ts
export const tenantRls = (t: { orgId: ColumnRef<string> }) => [
  rls.enable(), rls.force(),
  index('tenant_idx').on(t.orgId),
];

pgTable('invoices', cols, (t) => [ ...tenantRls(t), check(...) ]);
```

`pgTableCreator`-style global prefixing is replaced by `pgSchema` + the casing strategy; per-tenant fan-out is a runtime `search_path` concern, not a schema-definition concern.

### 6.3 Brands: `Opt`, `GeneratedAlways`, `RequiredNullable`

Derived from the builder chain, not hand-written (Kysely's `ColumnType<S, I, U>` triple is the internal representation; agent 04 owns it):

| Chain | `Row` | `Insert` | `Update` |
|---|---|---|---|
| `text()` | `string` | `string` (required) | `string \| undefined` |
| `text().nullable()` | `string \| null` | `string \| null \| undefined` | `string \| null \| undefined` |
| `text().default('x')` | `string` | `string \| undefined` (Opt) | `string \| undefined` |
| `text().$default(() => 'x')` | `string \| null` | `string \| undefined` (Opt, filled client-side) | `…` |
| `int().generatedAlwaysAsIdentity()` | `number` | **absent** | **absent** |
| `int().generatedByDefaultAsIdentity()` | `number` | `number \| undefined` | `number \| undefined` |
| `tsvector().generatedAlwaysAs(…)` | `TsVector` | **absent** | **absent** |
| `text().nullable().$required()` | `string \| null` | `string \| null` (present, may be null) | `…` |

`Row<T>` / `Insert<T>` / `Update<T>` are the public names; `Selectable`/`Insertable`/`Updateable` aliases exist for Kysely refugees. Nothing brand-shaped ever leaks into application code: `Row<typeof users>` is a plain object type with no `ColumnType<>` in sight (kysely-codegen #63's long-standing complaint).

### 6.4 `.$type<T>()` and codec interplay (D13)

```ts
t.jsonb().$type<UserPrefs>()                       // ✅ UserPrefs extends Json
t.text().$type<`${string}@${string}`>()            // ✅ template literal extends string
t.uuid().$type<UserId>()                           // ✅ UserId = string & { __brand }
t.text().$type<number>()                           // ❌ Type 'number' does not satisfy the
                                                   //    codec type 'string' for column type 'text'
```

`$type` narrows; it never changes the wire format, never changes the SQL type, and never appears in the IR. When you need the wire format to change, you need a codec:

```ts
const decimalCodec = definePgCodec<Decimal>({
  sqlType: 'numeric',
  decode:  (raw) => new Decimal(raw),
  encode:  (v)   => v.toFixed(),
});

t.numeric({ precision: 12, scale: 2 }).codec(decimalCodec)
```

`.codec()` is not `$`-prefixed because it can change `sqlType` and therefore the DDL. A codec whose `sqlType` differs from the builder's produces a compile error unless the builder is `t.custom<T>()`.

### 6.5 Scalar decode policy (surface commitments; agent 04 owns the codecs)

These are user-visible guarantees, identical on every adapter:

| PG type | Default TS | Opt-in alternatives |
|---|---|---|
| `int2/int4` | `number` | — |
| `int8` | `bigint` | `.asNumber()` (throws on decode above `Number.MAX_SAFE_INTEGER`) |
| `numeric` | `string` (lossless) | `.asNumber()` (documented lossy), `.codec(decimalCodec)` |
| `float4/float8` | `number` | — |
| `timestamptz` | `Date` | `.asIsoString()` |
| `timestamp` | ISO string, no offset | `.asDate()`; lint nudges toward `timestamptz` |
| `date` | `'YYYY-MM-DD'` string | `.asDate()` — **never the default**; `pg-types@2.2.0`'s `DATE` parser shifts days across timezones and that bug does not get to exist here |
| `time`/`timetz` | string | — |
| `interval` | `{ years, months, days, hours, minutes, seconds }` | `.asIsoDuration()` |
| `bytea` | `Uint8Array` | — |
| `json`/`jsonb` | `unknown` until `$type` | — |
| `T[]` | `T[]`, nulls preserved | — |
| range types | `Range<T> = { lower, upper, lowerInc, upperInc }` | — |
| `money` | `string` | — |

### 6.6 Naming and collisions

- `$` is reserved: `$`-prefixed **column keys** are a definition-time error; `$`-prefixed **methods** are TS-only (D4); the table's metadata lives at `users.$`.
- Table objects expose columns directly (`users.email`) *and* `users.$.columns.email`. A column literally named `$` or colliding with `$` is rejected with a message pointing at the casing option.
- ~~Relation names live in a separate namespace from column names; a relation named `email` on a table with an `email` column is legal (they never appear in the same position).~~
  > **AMENDED 2026-08-26 (WS5, `09` §3.5).** They *do* appear in the same position. Fork F3 (`09`
  > §3.0) put relation accessors on the table scope next to the columns — measured cheaper than
  > `04` §2.4's second lambda parameter on every shape and both compilers — and the price of that
  > win is exactly this sentence. `defineSchema` now rejects a relation whose name matches a column
  > of the same table, with a message saying one would hide the other. That is `03` §4.1's first
  > hard ask, and it is what fork F3 owes.

### 6.7 Extension packs

Prisma-next's codec-descriptor design, collapsed to one package and one verb (their `family`/`target`/`adapter`/`extensionPacks`/`createSqlExecutionStack` ceremony exists only because MongoDB is still in scope):

```ts
export const pgvector = definePgExtensionPack({
  name: 'vector',
  extension: pgExtension('vector'),                  // the baseline CREATE EXTENSION
  columnTypes: {
    vector: (dims: number) => definePgColumn<number[]>({
      sqlType: `vector(${dims})`, codec: vectorCodec, params: { dims },
    }),
  },
  operators: {
    cosineDistance: op('<=>', { returns: float8() }),
    l2Distance:     op('<->', { returns: float8() }),
  },
  indexMethods: ['hnsw', 'ivfflat'],
});

defineSchema({ ...objects }, { packs: [pgvector] });
// now available: t.vector(1536), cosineDistance(col, param), .using('hnsw')
```

A pack's baseline extension is installed into the shadow DB before normalization, which is the clean fix for Prisma's extension-drift problem. `pgvector` and `postgis` ship in-tree; everything else is a ~200-line community package rather than a maintainer roadmap item.

---

## 7. Contracts for the neighbouring agents

### 7.1 To agent 04 (type engine) — the printed-form budget

The single biggest complaint about Drizzle's schema layer is error spew. Concrete, testable constraints on the public surface:

1. **No public generic has more than 2 parameters.** `Column<T, Flags>`, `Table<Name, Cols>`, `Relations<Tables, Graph>`.
2. **`Flags` is a string-literal union**, not an object: `Column<string, 'notNull' | 'pk'>` prints in ~30 characters. All of `{ name, tableName, dataType, columnType, driverParam, hasDefault, isPrimaryKey, … }` lives behind a `unique symbol` slot and never prints.
3. **A modifier returns the same nominal interface with a widened `Flags` union.** No subclass per modifier, no builder-class explosion.
4. **The table type is `Cols & { readonly $: TableMeta<Name> }`** — one extra key, so `users.email` works without intersecting a 15-parameter generic class.
5. **Type-instantiation budget:** < 2,000 instantiations for a 20-table schema, measured with `@ark/attest` in CI from the first table builder. (Reference points: Prisma 428, Drizzle 1.0-beta 5,017, Drizzle 0.44 41,150 on Northwind.) A regression on this number fails the build.
6. **No conditional type deeper than 3 levels on the schema-construction path.** Deep conditionals belong in the query layer, where they're paid once per call site, not once per column.

### 7.2 To agent 06 (migration IR) — the node contract

Every builder produces a plain, JSON-serializable node. `schema.$ir()` returns `{ nodes: IrNode[], fingerprint: string }` with nodes sorted by `identity` so the fingerprint is stable across machines and file reorderings.

```ts
interface IrNode {
  kind:        IrKind;             // 'schema' | 'extension' | 'enum' | 'domain' | 'composite'
                                   // | 'sequence' | 'table' | 'column' | 'default' | 'pk'
                                   // | 'fk' | 'unique' | 'check' | 'exclude' | 'index'
                                   // | 'partition' | 'view' | 'matview' | 'function'
                                   // | 'procedure' | 'trigger' | 'policy' | 'role' | 'grant'
                                   // | 'comment' | 'raw'
  identity:    string[];           // uniform-arity tuple per kind (drizzle-kit's model)
  provenance:  'managed' | 'raw' | 'extension' | 'external';
  renamedFrom: string | null;
  dependsOn:   string[];           // identity keys — drives the topological sort
  comment:     string | null;
  spec:        unknown;            // kind-specific, fully structural
  bodyHash?:   string;             // repeatable objects (functions, triggers, raw)
  tombstone?:  { reason: string; at: string };
  source:      { file: string; line: number; export: string };  // for diagnostics + --explain
}
```

Identity tuples (matching drizzle-kit's uniform-arity idea, extended for the objects it doesn't model):

| kind | tuple |
|---|---|
| `schema`, `role`, `extension` | `[name]` |
| `table`, `enum`, `domain`, `composite`, `sequence`, `view`, `matview` | `[schema, name]` |
| `function`, `procedure` | `[schema, name, argTypesSignature]` |
| `column`, `index`, `pk`, `fk`, `unique`, `check`, `exclude`, `policy`, `trigger`, `partition` | `[schema, table, name]` |
| `grant` | `[grantee, schema, object, privilege]` |
| `comment` | `[...targetIdentity, 'comment']` |
| `raw` | `[declaredIdentityString]` |

Behavioural contracts the schema layer guarantees:
- `sql`-valued defaults, view bodies, policy expressions and check expressions are **never** compared as text — they are handed to the diff engine as opaque strings for shadow-DB normalization.
- Literal defaults **are** structurally comparable and carry their codec, so `default(0)` on `int4` and `default('0')` on `text` don't collide.
- Functions/triggers/raw objects carry `bodyHash`; signature changes appear in `identity`, so the drop/replace decision is a pure function of the IR.
- `partitions({ unknown: 'adopt' })` means the IR asserts *nothing* about undeclared partitions; they must never enter the drop set.
- Relations contribute **zero** IR nodes.

> **AS BUILT 2026-08-28 — NOT BUILT, and deliberately so (design/11 §1.5).** `schema.$ir()` does
> not exist and will not. DDL emission lives in `@pg-prime/kit` (`src/schema/emit.ts`), and the
> desired IR is derived the way `06` §3's diagram already says — `desired SQL text → [shadow DB] →
> extract → IR(desired)`. `IrNode` above would be a **second model of PostgreSQL** living in the
> runtime package: a second place for `format_type` to be approximated, a second set of identity
> tuples to keep in step with `ir/stable-id.ts`, and a second thing to be wrong when PostgreSQL
> normalizes an expression differently from how we wrote it. One extractor, one IR.
>
> What the schema layer supplies instead is exactly the structural metadata this section's
> behavioural contracts require, and the kit reads it **structurally, through `import type`**
> (`11` §1.3):
>
> | this section's contract | as built |
> |---|---|
> | `IrNode.identity` tuples | `ir/stable-id.ts`'s `StableId`, in the kit — the same uniform-arity idea, one definition |
> | `sql`-valued defaults / check expressions are opaque strings | `DefaultSpec { kind: 'expr' }` and `CheckSpec.expression`; the shadow database normalizes them |
> | literal defaults are structurally comparable and carry their codec | `DefaultSpec { kind: 'value' }` + `ColumnDdl.pgType`; the kit's literal renderer keys on `pgType`, so `default(0)` on `int4` and `default('0')` on `text` cannot collide |
> | `dependsOn` drives the topological sort | FK edges from `ColumnDdl.references` / the `foreignKey` extra, resolved at emit time; the kit's `diff/order.ts` does the sort on the extracted IR |
> | `renamedFrom` | `ColumnDdl.renamedFrom` / the `renamedFrom` extra (§5.1 AS BUILT) |
> | `comment` | `ColumnDdl.comment` / the `comment` extra; emitted as `COMMENT ON`, **not yet a fact kind** (K3) |
> | `bodyHash`, `tombstone`, `provenance`, `source` | not built — no repeatables, no tombstones, no source maps in K2a |

---

## 8. Alternatives rejected

| Alternative | Why not |
|---|---|
| **Decorators (`@Entity`, `@Column`)** | Requires `experimentalDecorators` or ES-decorator support, plus `reflect-metadata` for any inference worth having; `emitDecoratorMetadata` breaks under SWC/esbuild/Babel; classes force a runtime object where a frozen value would do. MikroORM demoted decorators to a separate package in v7 after five majors. The verdict is in and it's not close. |
| **Decorators + `ts-morph` reflection** | Best syntax, worst plumbing: the TypeScript compiler as a *runtime* dependency, `.ts` sources required at boot, incompatible with SWC/Babel. Non-starter for a minimal-deps library. |
| **A `.prisma`-style closed DSL** | The single most instructive failure in the research. A closed DSL turns every Postgres capability into a maintainer roadmap item and the queue never drains: partial indexes took 4.8 years and shipped buggy; CHECK constraints have been open since 2020 with 294 👍; views have been "preview" since January 2023; triggers, functions, domains, composites, partitions, RLS and exclusion constraints are simply absent. You also owe the world a parser, a formatter, a language server, and a VS Code extension before you can ship your first column type. Our differentiator is *full PG DDL coverage*; a closed DSL is structurally incompatible with that goal. |
| **Database-first codegen (kanel / kysely-codegen shape)** | The schema then lives in the database, which means: no reviewable artifact in the PR, no way to express rename *intent*, a live DB required in CI to type-check, and generated files that conflict on every branch. We still ship `pg-orm pull` — but as an **adoption** tool that emits our TS once, not as the workflow. |
| **Client emission / `prisma generate`** | Inference beat codegen; Prisma's own v8 rewrite is abandoning it. A generate step is a competitive liability (Docker builds, postinstall hooks, stale-artifact bugs). Accepted cost: TS compile time, which §7.1 budgets explicitly. |
| **JSON/YAML schema files** | No expressions, no reuse, no type inference, no IDE. Liquibase's XML is the cautionary tale. |
| **Active Record base class (`class User extends Model`)** | Couples the schema to instance identity and pulls Unit-of-Work gravity back in through the side door. Schema objects are data. |
| **Object-literal-only column config (`{ type: 'text', notNull: true }`)** | Worse autocomplete, worse errors, and modifier validity (`.length` on `text`) can't be enforced without a large discriminated-union type. Chaining gives per-step narrowing for free. |
| **Relations declared in-table** | §4.1 — circular-import thunks, conflates constraints with query affordances, N objects for the type engine to walk instead of 1. |
| **Implicit m2m join tables (Prisma's `_UserToOrg`)** | The junction always grows columns; when it does, an implicit table is unmigratable. `.through()` over a declared table costs three lines and never traps you. |
| **`text({ enum: [...] })` with no constraint (Drizzle)** | The type says `'a' | 'b'` and the database accepts `'zzz'`. Our `.oneOf()` emits the CHECK by default. |
| **Interactive-prompt-only rename resolution** | Doesn't work in CI, doesn't work for agents, and the failure mode is silent data loss. Annotation-first, prompt as a convenience that *writes* the annotation. |
| **Table inheritance (`INHERITS`)** | Breaks unique/PK/FK guarantees across the hierarchy (constraints aren't inherited), makes the dependency graph and the drop set far harder, and PG's own docs steer users to declarative partitioning. Detected in the catalog, reported, never emitted. |
| **Full-state JSON snapshot per migration (drizzle-kit)** | A guaranteed merge-conflict generator; drizzle-kit's own docs tell you to hide the diff with `.gitattributes`. Our fingerprint is a hash; full state lives only in periodic checkpoints. |

---

## 9. v1 cut line

**v1 (ships with the schema API):** `pgTable` + full column breadth incl. ranges/tsvector/domains/composites/arrays; all constraints incl. exclusion; indexes incl. partial/expression/covering/opclass/concurrently; identity + generated columns; `pgSchema`, `pgEnum`, `pgDomain`, `pgCompositeType`, `pgSequence`, `pgExtension`, comments; `defineRelations` with FK inference and `through`; `renamedFrom` everywhere; tombstones; `rawObject` + `sql/` directory + `external()`; `defineSchema` registry; presets; `$type`/codec API.

**v1 with repeatable-migration semantics (not structural diffing):** `pgFunction`, `pgProcedure`, `pgTrigger`, `pgView`, `pgMaterializedView`, `pgPolicy`, `pgRole`, `grant`. The *API surface* is v1 — the objects exist, are typed, and are applied. Full structural diffing for these lands in v1.1 per agent 06's staging. This is deliberate: the Prisma partial-index lesson is that a schema feature which lands before the differ can round-trip it produces infinite phantom migrations, which is worse than not having it.

**v2:** partition management beyond adopt-and-never-drop; `grants: 'manage'` as a default; event triggers, publications, subscriptions, FDW/foreign tables, collations, rules.

## 10. Open questions for the lead

1. **`t.` callback vs. bare imports as the *documented* primary.** Both work. The callback keeps imports at ~5 names and is the natural extension point for packs; bare imports read better in one-line presets. Docs should pick one — I've written everything callback-first.
2. **`Row`/`Insert`/`Update` vs. `Selectable`/`Insertable`/`Updateable` as the canonical names.** I chose the short ones; the long ones are aliases. Reversible.
3. **`.oneOf()` emitting a CHECK by default** is a behaviour change relative to what Drizzle users expect (silent type-only union). It's the right default, but it will surprise migrants — worth a named entry in the migration guide.
4. **`securityInvoker: true` default on views (D14)** diverges from Postgres's own default. It's a security improvement and PG15+ makes it universally available, but it *will* change behaviour for anyone porting a view that relies on owner privileges. Confirm you want the safe default over the familiar one.
