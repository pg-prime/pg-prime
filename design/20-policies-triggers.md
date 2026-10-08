# 20 — Typed RLS policies and trigger helpers on the declared repeatable lane

Status: plan, rev 2 (2026-10-09, after the revmux round), branch `feat/mq`. Implements design/01
§3 row 64 (`definePolicy`, v1.x) without row 63 (structured diffing): policies and triggers stay
**managed, not diffed**, as the lane decision (01 §3) states. Generic by design: no tenant model,
setting name or role is assumed; `app.org_id` / `app_user` below are one example.

Read with 05 §1.9/§3.8/§3.9, 06 §2.2/§3.4/§3.8/§3.9/§5.1, kit `src/schema/views.ts` (the
declared-view precedent), `src/repeatables/*`, `src/pull/tier-r.ts`, core `src/schema/ddl.ts`,
design/19 (shares §3.2's `setting()`).

---

## 0. At a glance

| Piece | Lane | Where |
|---|---|---|
| `rls.enable()` / `rls.force()` table extras | ENABLE structural (`relrowsecurity` is already diffed); FORCE in the declared lane | core `schema/extras.ts`; kit emit/diff + `schema/declared.ts` |
| `definePolicy(name, { on, for, as, to, using, withCheck })` | declared repeatable (Tier R) | core `schema/policy.ts`; kit `schema/declared.ts` |
| `updatedAtTrigger(t.updatedAt)` table extra | declared repeatable (function + trigger) | core `schema/trigger.ts`; kit `schema/declared.ts` |
| `setting(name, codec)` → `.set(v)` / `.current()` | session value + SQL expression (shared with design/19) | core `session/setting.ts` |
| removal | generated prune repeatable, scoped by a catalog marker | kit |
| drift / self-heal | marker census in `verify`, `doctor`, `check`, and the runner | kit |
| `pull` | RLS flags + policies → DSL; marked `updatedAt` triggers → extra | kit `pull/*` |

---

## 1. Goals / non-goals

- G1. A row-level policy is written once in TypeScript, with column references and setting reads
  that type-check honestly, and ships through `generate` → `apply` with no hand SQL.
- G2. Rendered files are ordinary `sql/` repeatables: hashed, ordered by directory rank, re-applied
  on change, applied by `apply` without the TS schema.
- G3. A removed declaration is removed from the database; a restored one is recreated.
- G4. Lockout and leak paths are planned, named and acknowledged before anything is written.
- G5. **Zero runtime cost**: policies and triggers are plain SQL; nothing runs in the query path;
  `setting().current()` is a SQL fragment, not a round trip; the trigger is static plpgsql.

**Non-goals:** structured diffing (row 63); roles/grants (roles must exist, we check); general
`pgFunction`/`pgTrigger` (§12); `ALTER POLICY` in place (DROP + CREATE in the lane's single
transaction is never observable).

---

## 2. Decisions

| # | Decision | Reason (one line) |
|---|---|---|
| D1 | Declarations live in core `pg-prime/schema` (re-exported from root); the kit stays type-only. | 08 §2.1 lists policy/trigger under `./schema`; the kit may not value-import `pg-prime`. |
| D2 | Name: **`definePolicy`**. | Owner decision (01 row 64). |
| D3 | `rls.enable()` / `rls.force()` are table extras. **ENABLE** is structural. | `TablePayload.rowSecurity` is already extracted and diffed (`diff/ddl.ts:886`); a repeatable copy would be a second writer. |
| D4 | **FORCE is not an IR fact.** For every table with `rls.*()`, the table's lane file states it: `ALTER TABLE … FORCE ROW LEVEL SECURITY` or `… NO FORCE …` (header `-- pg-prime:object rls <s.t> force\|noforce`). The census (§5.5) checks it; tables without `rls.*()` are never touched. | Any IR encoding moves the fingerprint of every already-FORCE'd database (payload is hashed into the rollup), and no clean re-stamp exists (`baseline --force` writes `0000_baseline.sql` and leaves the gate on the last row). In the lane, FORCE also commits atomically with the policies, so there is no FORCE window. |
| D5 | `rls.force()` implies enable. | FORCE without ENABLE is legal and inert. |
| D6 | Core renders CREATE statements (`$.ddl(schemaOf)`); the kit renders files (header, DROP IF EXISTS, marker, prune, paths). | Core statements are testable on PGlite without the kit; `schemaOf` lets the kit remap for a tier-3 shadow (D22). |
| D7 | Typed expressions render through `compileDdlExpr` (compiler in DDL mode). **Every column is qualified by its relation name**, own table included (`"documents"."org_id"`); binds inline as `'<encoded>'::<sqlName>`; `ph`/`agg`/`over`/binary binds refused (`SchemaError`). | An unqualified `"org_id"` inside a policy subquery binds to the inner table (`m.org_id = "org_id"` is always true); `fragmentDdlText` cannot render `bin`/`fn`/`cast`. |
| D8 | `CHECK`/index/view bodies keep `fragmentDdlText` and its bind refusal. | They contain no subqueries and no settings; widening them later breaks nothing. |
| D9 | `using`/`withCheck` are thunks `(t) => expr`, evaluated at render time. | A policy may read tables declared later in the file (`RefSpec.target`'s reason). |
| D10 | One repeatable per table per kind: `050_policies/<schema>__<table>.sql` (for every table with `rls.*()` or a policy), `070_triggers/<schema>__<table>.sql`, `070_triggers/000_functions.sql`, root `990_declared_prune.sql`. | CREATE POLICY locks its table ACCESS EXCLUSIVE, so only changed tables should re-apply; ranks match `pull/tier-r.ts`. |
| D11 | Identity: `policy s.t.name`, `trigger s.t.name`, `function s.name()`. Object hash = sha256 of its CREATE statement. File hash = `scan.ts` sha256 (unchanged). | Catalog identities are what PostgreSQL keeps unique; the object hash gives a per-object drift answer without a differ. |
| D12 | Marker: `COMMENT ON … IS 'pg-prime:declared sha256:<hex>'` on every declared object. | Self-contained SQL (shadow, verify, TS-less `apply`), survives dump/restore, scopes prune and census to our objects. |
| D13 | Removal = `990_declared_prune.sql`: drops marked policies, then triggers, then functions in the managed schemas that are not in its keep-list. Rendered while anything is declared **or the file already exists** (empty keep-lists drop everything marked); only a human deletes it. | Covers every removal shape, including the last declaration, with the existing hash mechanism. |
| D14 | Rename = new identity; the old one is pruned in the same transaction. No `renamedFrom`. | Policies/triggers hold no data. |
| D15 | Order: lane after all migrations (unchanged); in it 010 hand functions < 020 views < 050 policies < 070 trigger functions/triggers < 990 prune. | Rank is the only order `scan.ts` has; prune last so a rename's new object exists first. |
| D16 | Conflicts are generate **errors** (`declared_conflict`, nothing written): a non-declared file that creates a declared identity, a pulled `-- pg-prime:object` file for one, or **any non-declared file at a declared path**. A hand `ENABLE RLS` on a table with `rls.*()` warns (`rls_declared_twice`). | Two writers flap by file order; overwriting a hand file deletes its policies from every fresh database. |
| D17 | `definePolicy` is export-discovered (like `pgView`); `updatedAtTrigger` is a table extra. | Policies often live in their own file; the trigger is a table property that needs the typed column ref. A lost export is RL105/RL101 (§6). |
| D18 | `pull` emits DSL for RLS flags and every policy (raw `sql` text from `pg_get_expr`, omitted clauses kept omitted); triggers/functions stay `sql/` except marked `updatedAt` ones. | Raw text is lossless and the DSL represents every legal policy shape (§3.1). |
| D19 | `setting(name, codec).current()` renders `nullif(current_setting('<name>', true), '')::<sqlName>` and is typed **`T \| null`**. Binary operators accept a nullable **expression** on the right (`NonNullOperand<T> = (T \| ExprOf<T \| null>) & {}`); a JS `null` literal is still refused. | Honest in projections; NULL makes a policy predicate false (fail-closed), the safe default; the left operand already accepts nullable expressions, so this makes the two sides consistent. |
| D20 | The runner and `probeEmptiness` set `row_security = off`. Guidance: the migration role has `BYPASSRLS` (or is superuser). | Under RLS the probe sees zero rows and calls a populated table empty; `off` turns silent filtering into 42501, which the probe treats as "not proven empty". |
| D21 | PGlite: rendering, RLS semantics (`SET ROLE`), trigger. Tier 2: login roles, pooled GUC reuse, PG 15–18, the kit lane, the dump oracle. | PGlite's user is a superuser (bypasses RLS even under FORCE); kit shadows need `CREATE DATABASE`. |
| D22 | Generate never runs declared files from disk in a shadow: it applies an in-memory list = hand files ∪ declared files rendered through `shadow.schemaMap`, **prune excluded**. All target reads (markers, policy counts, roles, owners, `pg_depend`) happen before the shadow exists. | On tier 3 the shadow connection is the target; disk files are hard-qualified and the prune would drop live objects. |
| D23 | Lane hazards are evaluated **before** anything is written; an unacknowledged error refuses the whole write (exit 2). Acks use the existing `AcknowledgeInput` and are recorded in the prune file header. | A lane-only change returns `up_to_date` with no plan to carry a hazard, and `apply` never reads hazards. |
| D24 | The runner self-heals: before the lane, the census forces re-apply of any declared file whose objects are missing, carry a different hash or have the wrong FORCE state, whatever `pgprime.repeatables` says. | A restored declaration has the same bytes as its orphaned checksum row, so the checksum alone would skip it. |
| D25 | RL hazards compare **before** = target with **after** = shadow policies (hand `sql/` + declared) ∪ unmarked target policies absent from the shadow, coverage computed per (table, role, command). | Comparing against the declared render alone reports every hand-written policy as lost; per-table coverage misses a single-command removal. |

---

## 3. API (exact; R1 owns it, design/19 consumes §3.2)

### 3.1 `pg-prime/schema`

```ts
export declare const rls: {
  enable(): TableExtra                 // { node: 'rls', force: false }
  force(): TableExtra                  // { node: 'rls', force: true }
}

export type PolicyCommand = 'all' | 'select' | 'insert' | 'update' | 'delete'
export type PolicyRole = 'public' | 'current_user' | 'current_role' | 'session_user' | (string & {})
export type PolicyExpr = { readonly [OUT]: boolean | null } | AnyFragment   // OUT from schema/symbols
type Pred<T extends AnyTable> = (t: T['cols']) => PolicyExpr

interface PolicyBase<T extends AnyTable> {
  readonly on: T
  readonly as?: 'permissive' | 'restrictive'  // default permissive
  readonly to?: readonly PolicyRole[]          // default PUBLIC
}
export type PolicySpec<T extends AnyTable> = PolicyBase<T> &
  (
    | { readonly for?: 'all' | 'update'; readonly using?: Pred<T>; readonly withCheck?: Pred<T> }
    | { readonly for: 'select' | 'delete'; readonly using?: Pred<T>; readonly withCheck?: never }
    | { readonly for: 'insert'; readonly withCheck?: Pred<T>; readonly using?: never }
  )

export interface PolicyRuntime {
  readonly name: string
  readonly table: TableRuntime
  readonly command: PolicyCommand
  readonly permissive: boolean
  readonly roles: readonly string[]
  /** CREATE POLICY text; evaluates the thunks. `schemaOf` maps a declared schema to the emitted one. */
  ddl(schemaOf: (schema: string | undefined) => string): string
}
export interface Policy<T extends AnyTable> {
  readonly kind: 'policy'
  readonly name: string
  readonly $: PolicyRuntime
}
export declare function definePolicy<T extends AnyTable>(name: string, spec: PolicySpec<T>): Policy<T>

/** BEFORE UPDATE … FOR EACH ROW: `NEW.<col> := now()`. */
export declare function updatedAtTrigger(
  column: AnyRef & { readonly [META]: { readonly pg: 'timestamptz' | 'timestamp' } },
): TableExtra                          // { node: 'updatedAtTrigger', column: '<db name>' }
```

Omitted predicates are legal, as in PostgreSQL (a permissive policy without one grants nothing, a
restrictive one restricts nothing); `pull` needs them. Runtime `SchemaError`s at declaration:
invalid/duplicate identifiers or roles, a predicate on the wrong command (JS callers),
`updatedAtTrigger` on a non-timestamp column, `pgprime_set_<col>` over 63 bytes.

### 3.2 `pg-prime` (root): typed settings, shared with design/19

```ts
export interface SettingKey<T, P extends string = string> {
  readonly name: string
  readonly codec: Codec<T, unknown, P>
  /** `{ [name]: codec.encode(value) }`: spreads into `tx.setLocal({...})`, `session.set({...})`, `localSettings`. */
  set(value: T): Readonly<Record<string, string>>
  /** `nullif(current_setting('<name>', true), '')::<sqlName>`; NULL when unset or empty. */
  current(): TypedFragment<T | null, P>
}
export declare function setting(name: string): SettingKey<string, 'text'>
export declare function setting<C extends AnyCodec>(name: string, codec: C): SettingKey<CodecOut<C>, CodecPg<C>>
```

- Name validation is core's `assertGucName` (`session/transaction.ts`, same regex as `setLocal`:
  at most one dot, no `$`), throwing the same `UsageError` at `setting()` time.
- `set()` refuses a codec whose `encode` yields bytes (`UsageError`); the value travels as a bind,
  exactly like today's `setLocal`. No new `setLocal` overload: the record form already exists.
- `current()` is a raw node built from internal chunks (the validated name cannot need escaping),
  so compiled queries keep `usedUnsafeRaw: false`; it renders identically in queries and policies.
- No `required()` variant: an SQL-level raise needs a function or constant-folding tricks, and
  design/19's strict scope already throws client-side before a query is sent.
- `NonNullOperand` change (D19) in `query/ops.types.ts`.

### 3.3 Example: tenant isolation + `updated_at`

```ts
import { definePolicy, pgTable, rls, updatedAtTrigger } from 'pg-prime/schema'
import { eq, setting } from 'pg-prime'
import { uuidCodec } from 'pg-prime/codecs'
import { sql } from 'pg-prime/sql'

export const orgId = setting('app.org_id', uuidCodec)

export const documents = pgTable(
  'documents',
  (t) => ({
    id: t.uuid().primaryKey().defaultSql('gen_random_uuid()'),
    orgId: t.uuid(),
    archived: t.boolean().default(false),
    updatedAt: t.timestamptz().defaultSql('now()'),
  }),
  (t) => [rls.force(), updatedAtTrigger(t.updatedAt)],
)

export const documentsTenant = definePolicy('tenant', {
  on: documents,
  to: ['app_user'],
  using: (t) => eq(t.orgId, orgId.current()),
  withCheck: (t) => eq(t.orgId, orgId.current()),
})

export const documentsArchivedReadOnly = definePolicy('archived_read_only', {
  on: documents,
  for: 'update',
  as: 'restrictive',
  to: ['app_user'],
  using: (t) => eq(t.archived, false),
})

export const documentsShared = definePolicy('shared', {
  on: documents,
  for: 'select',
  to: ['app_user'],
  using: (t) => sql`EXISTS (SELECT 1 FROM document_shares s
                     WHERE s.document_id = ${t.id} AND s.org_id = ${orgId.current()})`,
})
```

Request path: `tx.setLocal(orgId.set(id))`. Type goldens: `for: 'insert'` with `using`;
`using: (t) => t.orgId` (not boolean); `eq(t.orgId, 1)`; `eq(t.orgId, null)`;
`updatedAtTrigger(t.archived)`; `on: someView`; `orgId.set('x')` with a non-string codec type;
a projection of `orgId.current()` typed `string | null`.

---

## 4. Rendering (goldens)

Every file passes `checkIdempotence` (TX201) as rendered.

**Migration** (structural, from `rls.force()`):

```sql
ALTER TABLE "public"."documents" ENABLE ROW LEVEL SECURITY;
```

**`sql/050_policies/public__documents.sql`:**

```sql
-- pg-prime:declared policies public.documents
-- pg-prime:tier R
-- pg-prime:object rls public.documents force
-- pg-prime:object policy public.documents.archived_read_only sha256:<a>
-- pg-prime:object policy public.documents.shared sha256:<b>
-- pg-prime:object policy public.documents.tenant sha256:<c>
--
-- GENERATED by `pg-prime migrate generate` from definePolicy(...) on public.documents.
-- Edit the TypeScript, not this file. Re-applying it takes ACCESS EXCLUSIVE on the table.

ALTER TABLE "public"."documents" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "archived_read_only" ON "public"."documents";

CREATE POLICY "archived_read_only" ON "public"."documents" AS RESTRICTIVE FOR UPDATE TO "app_user"
  USING ("documents"."archived" = false);

COMMENT ON POLICY "archived_read_only" ON "public"."documents" IS 'pg-prime:declared sha256:<a>';

DROP POLICY IF EXISTS "shared" ON "public"."documents";

CREATE POLICY "shared" ON "public"."documents" AS PERMISSIVE FOR SELECT TO "app_user"
  USING (EXISTS (SELECT 1 FROM document_shares s
                 WHERE s.document_id = "documents"."id"
                   AND s.org_id = nullif(current_setting('app.org_id', true), '')::uuid));

COMMENT ON POLICY "shared" ON "public"."documents" IS 'pg-prime:declared sha256:<b>';
-- … tenant likewise, USING and WITH CHECK ("documents"."org_id" = nullif(…)::uuid)
```

Policies sorted by name; `<x>` = sha256 of that CREATE statement; the inlined `false` is whatever
the bool codec encodes (golden-pinned); role keywords bare, other roles quoted. A subquery over the
policy's own table must alias it (`FROM documents d`), or `"documents"` binds to the inner scan —
documented, and pinned by a live case.

**`sql/070_triggers/000_functions.sql`** (one function per `(schema, column)` in use):

```sql
-- pg-prime:declared functions
-- pg-prime:tier R
-- pg-prime:object function public.pgprime_set_updated_at() sha256:<d>

CREATE OR REPLACE FUNCTION "public"."pgprime_set_updated_at"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW."updated_at" := now();
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION "public"."pgprime_set_updated_at"() IS 'pg-prime:declared sha256:<d>';
```

Static per-column body: a generic `TG_ARGV` + `jsonb_populate_record` body round-trips every row
through jsonb on every update.

**`sql/070_triggers/public__documents.sql`:**

```sql
-- pg-prime:declared triggers public.documents
-- pg-prime:tier R
-- pg-prime:object trigger public.documents.pgprime_set_updated_at sha256:<e>

CREATE OR REPLACE TRIGGER "pgprime_set_updated_at" BEFORE UPDATE ON "public"."documents"
  FOR EACH ROW EXECUTE FUNCTION "public"."pgprime_set_updated_at"();

COMMENT ON TRIGGER "pgprime_set_updated_at" ON "public"."documents" IS 'pg-prime:declared sha256:<e>';
```

**`sql/990_declared_prune.sql`** (keep-lists sorted; acks per D23 in the header):

```sql
-- pg-prime:declared prune
-- pg-prime:tier R
-- pg-prime:acknowledged RL105 public.documents.archived_read_only by alice: replaced by app check
--
-- Drops objects carrying a 'pg-prime:declared' comment in the schemas below that are no longer
-- declared. Hand-written objects never carry the marker and are never touched.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS t, p.polname AS o
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY (ARRAY['public'])
       AND obj_description(p.oid, 'pg_policy') LIKE 'pg-prime:declared %'
       AND (n.nspname, c.relname, p.polname) NOT IN (VALUES
         ('public', 'documents', 'shared'),
         ('public', 'documents', 'tenant'))
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.o, r.s, r.t);
  END LOOP;
  -- same loop over pg_trigger (NOT tgisinternal), then pg_proc (pronargs = 0), no CASCADE
END
$$;
```

Tuple comparison avoids a `quote_ident` round trip; an empty keep-list omits `NOT IN`. Functions go
last without CASCADE, so a hand trigger still using one fails the apply loudly.

---

## 5. Kit integration

### 5.1 Discovery (`config/load.ts`, `schema/types.ts`)
- `declarationOf` accepts `kind: 'policy'`, keyed `"<schema>.<table>.<name>"` from `$.table`.
  `SchemaLike.policies?: readonly PolicyLike[]`. `rls`/`updatedAtTrigger` arrive in `$.extras`.

### 5.2 Render + sync (`schema/declared.ts`, new)
- `renderDeclared(schema, { schemaOf, schemas, existingPrune, acks })` → §4's files + diagnostics.
- `syncDeclared(dir, rendered, { write })` generalizes `syncViewRepeatables`' loop for every declared
  directory (views call it too). Before writing, a non-declared file at a wanted path is
  `declared_conflict` and nothing is written (fixes the same exposure for views). Deleting a file
  still requires its `-- pg-prime:declared` first line; the prune file is never deleted (D13).
- `declared_lane_stale` (schema changed, `generate` not run): error for policies/triggers in
  `migrate check`; views keep their warning.
- Conflict scan (D16) over non-declared files with `lexSql` (a `$$` body cannot false-match).

### 5.3 `generate`
1. **Target reads first:** markers (`declaredInCatalog`), `relforcerowsecurity`, every policy with command/roles,
   owners + `pg_has_role`, `pg_roles` for unknown roles, `pg_depend` for RL106.
2. **Render in memory** twice: for disk (declared schemas) and for the shadow (`schemaMap`).
3. **Shadow:** DSL DDL → `afterLoad` applies hand files ∪ shadow-rendered declared files sorted by
   path, prune excluded (D22) → extract. Proves every policy parses, roles exist, columns resolve.
4. **After-state** per table (D25): the shadow's full policy set (hand `sql/` + declared, remapped)
   ∪ target policies that carry no marker and are absent from the shadow (unmanaged policies no
   lane drops), plus ENABLE from the IR and FORCE from the render.
5. **Hazards** on before (target) vs after: lane path (RL101, RL103 NO FORCE, RL105, RL108,
   `declared_conflict`, `policy_unknown_role`) → unacknowledged errors refuse, exit 2, nothing
   written; acks go into the prune header. Statement path (RL101/RL102/RL103 on ENABLE/DISABLE,
   RL106) rides the plan; `DROP TRIGGER IF EXISTS "pgprime_set_<col>"` is emitted before a column
   drop/rename that a marked trigger targets (§6).
6. `syncDeclared` writes (when `outDir`), then plan files. Text output prints lane diagnostics on
   `up_to_date` too.
7. Census subtraction: `censusWithout` learns `policy`/`trigger`/`function` by marker identity.

On tier 3, hand-written repeatables still run on the target's real schemas: pre-existing behaviour
for views and hand files, not widened here; R2 records it as a follow-up.

### 5.4 `apply`
- Lane mechanics unchanged (`planRepeatables`/`applyRepeatables`/`runRepeatables`), plus D24:
  `declaredCensus` on the target forces files with missing/stale objects into `toApply`, in scan
  order. One catalog query per kind.
- `row_security = off` on the runner session (D20).
- A pruned path's `pgprime.repeatables` row is `orphaned`, as a renamed view rank is today; D24
  makes the stale row harmless.

### 5.5 Drift: `verify`, `doctor`, `check`
- `declaredCensus(client, files, schemas)`: `-- pg-prime:object <kind> <identity> sha256:<h>`
  headers vs catalog markers → `declared_missing`, `declared_orphan`, `declared_unmarked`; and
  `-- pg-prime:object rls <s.t> force|noforce` vs `relforcerowsecurity` → `declared_missing`.
  A table whose `rls.*()` is removed loses its file; a FORCE flag left behind is inert once the
  structural diff disables RLS.
- `verify`: census on the replayed database → any finding is drift (exit 4), FORCE state included
  (D4); `rls_no_policies` warning.
- `doctor`: census on the target, skipping files still pending; `rls_not_forced` when the owner
  role can log in; says when the prune file may be deleted (no markers left).
- `check`: `declared_lane_stale`, `declared_conflict` and lane hazards map to `EXIT.lint` (3).
- Hand `ALTER POLICY … USING` with the marker intact is not detected (row 63); the docs say so.

### 5.6 `pull`
- `emit-ts.ts`: `rls.enable()`/`rls.force()` per table; each policy becomes an exported
  `definePolicy` with `to`/`as`/`for` and `using: () => sql\`<pg_get_expr text>\`` (CHECK escaper
  reused), clauses omitted when `pg_get_expr` is NULL. Untyped on purpose.
- A marked trigger shaped `pgprime_set_<col>` becomes `updatedAtTrigger(t.<col>)`; its function is
  skipped. Other triggers/functions stay in `sql/`. `tier-r.ts` stops writing `040_rls/` and
  `050_policies/`.

---

## 6. Hazards and lint

New family **RL** (06 §3.4 + `reference/hazard-codes.mdx`). "Not proven empty" uses the D20 probe.

| Code | Default | Trigger |
|---|---|---|
| RL101 | error | **Coverage lost**, per (table, role, command) on the after-state (D25): an RLS-enabled, not-proven-empty table where a role had a permissive policy for a command before and has none after, or that has no permissive policy at all after ENABLE. `ALL` expands to the four commands; a role is covered by `TO PUBLIC`, itself, or a role it is a member of (`pg_has_role`). Losing SELECT is flagged on its own (UPDATE/DELETE with `WHERE`/`RETURNING` also need it). Subject `table:role:command`. |
| RL102 | warn | ENABLE runs in the migration while a policy an affected role needs arrives only in the later lane commit → that role sees 0 rows in between. Fix: ship policies one deploy earlier (inert without RLS). FORCE has no window: it commits with the policies (D4). |
| RL103 | error | `DISABLE ROW LEVEL SECURITY` (statement) or `NO FORCE` on a FORCE'd table (lane) → widens access. |
| RL104 | warn | Declared policy on a table without `rls.*()` → inert (normal mid-rollout). |
| RL105 | error | A marked **RESTRICTIVE** policy on the target is no longer declared → access widens. |
| RL106 | error | The plan drops/retypes a column or drops a table that any policy depends on (`pg_depend`) → the migration fails at apply. Fix: change the policy first. |
| RL107 | warn | A data migration (`_data.sql`, `-- pg-prime:batch`) touches an RLS-enabled table and the runner role lacks `BYPASSRLS` → 42501 under D20. Checked in the runner's pre-flight sweep (06 §5.1 step 6), where the role is known. |
| RL108 | error | A table FORCE'd after the change, not proven empty, where the owner had permissive coverage for a command before (or the table was not FORCE'd) and has none after, same per-command rule as RL101. |

Lane-path codes refuse the write (D23); statement-path ones ride the plan as today. Both read the
same after-state, so a hand-written or unmanaged policy counts as coverage and never trips them.
Diagnostics: `declared_conflict`, `policy_unknown_role` (errors), `rls_declared_twice`,
`declared_lane_stale`, `updated_at_on_update_overlap` (info: `$onUpdate` value is overwritten).

**updatedAt column changes.** plpgsql bodies have no `pg_depend` edge, so dropping or renaming a
column targeted by a marked trigger would make every UPDATE fail with 42703 until the lane commits.
Generate emits `DROP TRIGGER IF EXISTS "pgprime_set_<col>" ON t` in the same migration, before
the column change; the lane recreates it for the new column if still declared. In between, updates
succeed without bumping the column (info diagnostic).

**Pitfalls the guide states:**
- Owner bypass without FORCE → `doctor rls_not_forced`; choose FORCE or a non-owner app role.
- Superusers and `BYPASSRLS` bypass even FORCE; PGlite's only user is one → tests `SET ROLE`.
- FORCE filters the owner's own queries → D20, RL107, RL108.
- Unset or empty setting → `current()` is NULL → zero rows, never an error, never all rows.
  `current_setting('x')` without `true` errors on a fresh connection; `''::uuid` errors on a
  reused one; the helper avoids both.
- Re-applying a policy file locks its table ACCESS EXCLUSIVE inside the lane transaction (runner
  `lock_timeout` applies); trigger files take SHARE ROW EXCLUSIVE. Only changed tables re-apply.

---

## 7. PGlite vs tier 2

| Behaviour | PGlite (tier 1) | Tier 2 (PG 15–18) |
|---|---|---|
| `compileDdlExpr` output parses; `$.ddl()` applies | yes | yes |
| RLS filters by setting under `SET ROLE` | yes (S0 confirms roles) | login role over its own pool |
| FORCE vs owner | `SET ROLE` non-super owner | owner as a real login |
| `''` placeholder from a previous `SET LOCAL` | two txs on one connection | pooled reuse |
| `updatedAtTrigger` | yes (plpgsql ships) | yes |
| kit lane, census, self-heal, dump oracle | no (shadow needs `CREATE DATABASE`) | yes |

If S0 shows PGlite cannot `SET ROLE`, RLS-semantics cases move to tier 2 (recorded in the RESULT).

---

## 8. Tests

**Unit (tier 0)**
- core `test/compile/ddl-expr.test.ts`: `eq`/`and`/`or`/`not`/`isNull`/`cast` render; **every column
  qualified**, own table included, inside raw subqueries too; binds inlined + cast; refusals `ph`,
  `agg`, `over`, bytea.
- core `test/session/setting.test.ts`: `set()` record, `current()` SQL in a query (`toSQL`) and in
  DDL, `assertGucName` parity with `setLocal` (one dot, no `$`), binary codec refused.
- core `test/schema/policy.test.ts` / `trigger.test.ts`: runtime shapes, `$.ddl()` per
  command/as/to, omitted predicates, `schemaOf` remap, every `SchemaError`, lazy thunks.
- core type goldens (§3.3 list) incl. `NonNullOperand` accepting a nullable expression and refusing
  `null`; `bench:types` ≤ +2 % per fixture.
- kit `test/schema-emit/declared.test.ts`: §4 files byte-for-byte; TX201 ok; stable ordering;
  empty and non-empty keep-lists; prune kept when nothing is declared; marker hash; ack header;
  conflict scan incl. a hand file at a declared path (nothing written).
- kit emit/IR: `rls.*()` ENABLE DDL; IR and fingerprint of a FORCE'd table unchanged; RL101–RL108
  on synthetic state; trigger pre-drop on column drop/rename.
- `tools/api-snapshot/{pg-prime,pg-prime-kit}.json` regenerated (own golden only).

**Live on PGlite** (core `test/live/rls.test.ts`, applying `$.ddl()` + `ALTER TABLE`):
1. `SET ROLE app_user`; `setLocal(orgId.set(A))` sees only A; B only B; unset → 0 rows.
2. Tx 1 sets A; tx 2 on the same connection sets nothing → 0 rows, no 22P02.
3. `WITH CHECK` violation → `InsufficientPrivilegeError` (42501).
4. Restrictive policy: update of an archived row affects 0 rows.
5. Subquery capture: `memberships` and `documents` both have `org_id`; the qualified policy filters
   correctly (the unqualified rendering would return every row — asserted on raw SQL as control).
6. Owner: unforced sees all rows; FORCE'd, filtered.
7. `updatedAtTrigger` sets `now()`; an explicit value is overwritten.

**Tier 2** (core `test/pg/rls.test.ts`): the seven cases with LOGIN roles on separate pools; pooled
reuse for case 2; a PgBouncer transaction-mode case guarded on `PG_PRIME_TEST_PGBOUNCER_URL`;
nightly matrix PG 15–18.

**Kit `test:pg`**
- `test/generate/declared-rls.test.ts`: §3.3 → generate → `applyPending` → rows filter; edit one
  policy → only its table file re-applies; rename → old gone; remove everything → prune (still
  present) drops policies, trigger, function; **apply → remove → apply → restore → apply** recreates
  (D24); manual `DROP POLICY` on the target → next apply recreates; tier-3 generate leaves target
  policies and markers untouched (census before = after); RL101 (enable; separate permissive
  SELECT and INSERT policies, remove only SELECT → flagged; `ALL` → `SELECT` split → not flagged;
  hand-written `sql/` policy and an unmanaged target policy provide coverage → not flagged), RL102,
  RL103 NO FORCE, RL105 refusal and ack round trip, RL106, RL108; column rename with a
  marked trigger → UPDATEs never fail; `probeEmptiness` under RLS → not empty.
- `test/cli/verify-declared.test.ts`: verify green; doctor `declared_missing` / `declared_unmarked`
  / `rls_not_forced`; `check` exits 3 on a stale lane and on a conflict.
- `test/pull/rls-roundtrip.test.ts` with the pg_dump oracle, marker `COMMENT`s stripped in every
  comparison: (a) DB A from §3.3 → `pull` → generate+apply into fresh B → `compareDumps(A, B)`
  equal, plus census green on each DB against its own files; (b) DB C from a hand-written
  reference SQL fixture → `compareDumps(A, C)` equal; (c) negative control: one changed role in C
  is reported.
- Upgrade: a DB FORCE'd by a hand file under the previous kit keeps its fingerprint; apply of the
  next migration passes the gate; adding `rls.force()` to that table re-applies only its lane file.

**Gates**: full chain (14 §2); `docs:check` coverage 100 %.

---

## 9. Docs (`docs/INDEX.md` convention: Purpose / Public API / Flow / Gotchas / Tests)

- New module docs: core `schema/policy.md`, `schema/trigger.md`, `session/setting.md`; kit
  `schema/declared.md`.
- Updated: core `schema/extras.md`, `schema/index.md`, `compile/compiler.md`, `query/ops.types.md`,
  `session/transaction.md`; kit `schema/views.md`, `schema/types.md`, `config/load.md`,
  `catalog/payloads.md`, `catalog/extract.md`, `diff/ddl.md`, `plan/plan.md`, `generate.md`,
  `runner/run.md`, `pull/tier-r.md`, `pull/emit-ts.md`, `cli/commands/{verify,doctor,check}.md`.
- Site: `guides/row-level-security.mdx` (generic: roles, FORCE vs non-owner role, `setting()`,
  rollout order, testing with `SET ROLE`, §6 pitfalls); `guides/schema.mdx`
  section for `updatedAtTrigger`; `reference/{schema,query,kit,cli,hazard-codes}.mdx`;
  `concepts/tiers.mdx` (declared Tier R, marker, prune, self-heal); `operations/zero-downtime.mdx`;
  `operations/troubleshooting.mdx` (refused generate: reading RL101/RL108 subjects). Examples run on PGlite
  unless S0 fails (then `no-run` naming the tier-2 test, R22).

---

## 10. Changesets

- `.changeset/rls-policies-core.md` — `'pg-prime': minor`: `definePolicy`, `rls`,
  `updatedAtTrigger`, `setting()`, nullable right-hand expressions in binary operators.
- `.changeset/rls-policies-kit.md` — `'@pg-prime/kit': minor`: declared lane, prune, self-heal,
  census, RL hazards, FORCE via the lane, pull emits policies as DSL, runner `row_security = off`.
  No fingerprint changes: no re-baseline on upgrade.
- Two more minors keep the fixed group at 0.2.0. No `package.json` version edits.

---

## 11. Workstreams and agent briefs

```
S0 ─▶ R1 contract commit ─▶ R2 kit lane ∥ R3 kit structural+pull ─▶ R2 round-trip ─▶ R4 site ─▶ integrator
```

### Rules for every agent
- **Never edit:** `docs/INDEX.md`, `tools/budgets.json`, `tools/*.mjs`, `pnpm-lock.yaml`, any
  `package.json` dependency or version field, `.changeset/config.json`, `.github/**`,
  `packages/pg-prime-mq/**`, `packages/pg-prime-context/**`, `packages/pg-prime-nestjs/**`,
  `packages/pg-prime-{events,outbox,cron,testing,create}/**`, any `design/*.md` except appending your
  RESULT here. INDEX lines and measured sizes go in the RESULT; the integrator applies them.
- **Regenerators** (`pnpm api-snapshot`, `pnpm treeshake:update`): keep only your own golden.
- **Database:** your own databases via `~/.agents/bin/pg-dev` on PG 17 (:5417) and PG 18 (:5418);
  export `PG_PRIME_TEST_URL`.
- **No branch switches or commits** unless the owner says so.
- **Code style:** simple, clean, short; comments only for a non-obvious reason, workaround or trap,
  one short line; no history, ticket ids or ALL-CAPS headings; trim comments in code you touch.
- **Done** = tier commands + the 14 §2 chain green + `#### <agent> — RESULT` appended here.

### R1 — core (`pg-prime`)
**Owns:** `src/schema/{policy,trigger}.ts` (new), `src/schema/extras.ts`, `src/schema/index.ts`,
`src/session/setting.ts` (new), `src/session/transaction.ts` (export `assertGucName` only),
`src/query/ops.types.ts` (`NonNullOperand` only), `src/compile/compiler.ts` (`compileDdlExpr` + DDL
flag only), `src/index.ts` (exports only), core tests, `tools/api-snapshot/pg-prime.json`, core
module docs, `reference/{schema,query}.mdx` entries, `.changeset/rls-policies-core.md`.
**First:** S0 (PGlite `CREATE ROLE`/`SET ROLE`/RLS/plpgsql, 15 min), then a contract commit with
§3 exactly, so R2/R3 and design/19 build against it.
**Brief:** §3, D6–D9, D19. `definePolicy` takes no value import from `src/query`. Try typed
subqueries via a `compileOnly` handle; document if `compileDdlExpr` renders them, else defer.

### R2 — kit declared lane
**Owns:** `src/schema/declared.ts` (new), `src/schema/{views,types}.ts`, `src/config/load.ts`,
`src/generate.ts`, `src/repeatables/plan.ts` + the census hook in `src/runner/run.ts`'s
`runRepeatables` (D24 only), `src/cli/commands/{generate,verify,doctor,check}.ts`, kit
`src/index.ts` + `tools/api-snapshot/pg-prime-kit.json`, `test/schema-emit/declared.test.ts`,
`test/generate/declared-rls.test.ts`, `test/cli/verify-declared.test.ts`,
`test/pull/rls-roundtrip.test.ts` (after R3), module docs, `reference/{kit,cli}.mdx`,
`.changeset/rls-policies-kit.md`.
**Brief:** §4, §5.1–5.5, D4, D10–D17, D22–D25; wire R3's helpers into `buildStatements` and the lane hazards.

### R3 — kit structural + pull
**Owns:** `src/catalog/{extract,payloads}.ts`, `src/schema/emit.ts`, `src/diff/{diff,ddl}.ts`,
`src/plan/plan.ts`, the `row_security` line and RL107 pre-flight in `src/runner/run.ts` (coordinate
the one shared file with R2: R3 merges first), `src/pull/*`, tests under `test/kinds/`,
`test/pull/` (not the round trip), `test/runner/`, module docs, `reference/hazard-codes.mdx`.
**Brief:** D3, D5, D18, D20; RL101–RL103/RL106 on statements via optional `BuildOptions` fields;
the per-(role, command) coverage function and the target/after-state readers in `extract.ts`, used
by R2 for the lane path; trigger pre-drop; no new public kit exports.

### R4 — site docs (after R1–R3)
**Owns:** `guides/row-level-security.mdx` (new), `guides/schema.mdx` (section),
`concepts/tiers.mdx`, `operations/{zero-downtime,troubleshooting}.mdx`, `docs/astro.config.mjs`
(sole owner; design/19's sidebar entries arrive through the integrator).

### Integrator
Merge R1 → R3 → R2 → R4; apply INDEX lines and budget/treeshake/bench moves with measurements;
run the chain; append the integration record.

---

## 12. Deferred (with the reason)

- General `pgTrigger` / `pgFunction` (05 §3.7–3.8): identity needs argument signatures and
  overloads, the option surface is large, and pull has no lossless target. The lane (marker, prune,
  census, self-heal) is ready for them.
- `pgRole` / `grant` (05 §3.9).
- Body drift from a hand `ALTER POLICY` (row 63).
- `updatedAtTrigger({ onlyIfChanged })`; multi-command `for: [...]` (one command per policy in PG);
  user comments on declared objects; repeatables in the D6 clone (dump oracle `strict`).
- Tier-3 isolation for hand-written repeatables (pre-existing, §5.3).

---

## 13. Resolved questions

| Question | Default | Reason |
|---|---|---|
| Name | `definePolicy` | Owner decision. |
| Setting API | core `setting(name, codec)` → `SettingKey` with `.set()` / `.current()`; no free `currentSetting` | One way to name a setting in both `setLocal` and SQL; design/19 imports it. |
| Nullability | `current()` is `T \| null`; no `required()` | Honest types; fail-closed is the safe default; strictness lives in design/19's scope. |
| `CHECK`/index/view bodies on `compileDdlExpr` | No | No subqueries or settings there; can widen later without breaking. |
| Stale declared views in `check` | Stay `warning` | No security effect; unchanged behaviour. |
| Trigger function placement | The table's schema | It exists in shadow, verify and target before the lane runs; no bootstrap. |
| Runner `row_security = off` | On by default | It only turns silent wrong results into errors; the changeset says so. |
| Interface name | `SettingKey` (not `Setting`) | design/19 already exports `type Setting = string \| number \| boolean`. |

---

#### R1 — RESULT

Branch `worktree-agent-ae0f989b445bb5b4b` on `0b38870`. Commits: `5343882` **contract** (§3 API,
`compileDdlExpr`, `inTransactionFrame`, API snapshot), `f671008` tests, `60b99c8` docs + changeset,
`8ee4fb4` fix (no TS parameter property: Node's strip-only loader rejected it in outbox's child
process), then this RESULT with the `root-import-all` module golden.

**S0 (PGlite 0.5.7 = PG 18.3, user `postgres` is superuser):** `CREATE ROLE … NOLOGIN` ok; `SET ROLE`
to a non-super role ok; RLS filters by `current_setting('app.org', true)`; the `''` placeholder
after a committed `set_config(…, true)` is reproduced; owner sees all rows unforced and 0 rows after
`FORCE`; plpgsql `CREATE OR REPLACE TRIGGER` and `COMMENT ON POLICY` work. All §8 live cases run on
PGlite; no `no-run` fallback needed.

**Contract as built (deviations from §3):**
- `Policy<T>` has one extra optional phantom member `__table?: T` (never present at runtime): an
  unused type parameter fails `no-unused-vars` and made `Policy<A>` equal `Policy<B>`.
- `$.ddl()` returns the statement **without** a trailing `;`, always printing `AS …`, `FOR …` and
  `TO …` (default `TO PUBLIC`); keywords upper-case bare, other roles quoted.
- `updatedAtTrigger` returns the §3.1 node only; core does **not** render the function/trigger SQL —
  the kit (R2) renders §4's two files. `test/live/rls.test.ts` pins that SQL on PGlite.
- `assertGucName` was already exported; unchanged.
- Bind rendering: `quoteStringLiteral(encoded)::<codec.sqlName>` (`'f'::boolean`, `'10'::integer`,
  `E'a\\b'::text`, `NULL::integer`); a bind whose codec is `unknownCodec` (raw `sql` holes, columns
  whose type the default registry does not know: enums, arrays, typmods) is a bare untyped literal.
  Column codecs come from `defaultRegistry().byName(pgType)`, no `src/query` import.
- A schema ref passed as data (e.g. `${other.cols.x}` in raw SQL) renders `"<table>"."<col>"`.
- Typed subqueries via `compileOnly` render (`exists(db.from(...)…)`), but their `FROM` keeps the
  declared schema; `schemaOf` does not remap them. Documented; raw `sql` is the remappable form.
- Aggregates/window calls are refused anywhere in the tree, subqueries included.

**Added for design/19:** `inTransactionFrame(tx, fn)` (`session/guard.ts`, `txFrames` filled in
`makeTxHandle`), root export, tier-0 test, reference entry in `reference/pg-prime.mdx`.

**Tests:** core unit 61 files / 1159 tests; core live (PGlite) 100 / 1987 (+18 skipped); core
`test:pg` on pg-dev PG 17.11 and 18.6 (`pgprime_r1`) 113 files / 2067 each (RLS files skip loudly:
no CREATEROLE) and on a docker PG 17 superuser + PgBouncer (transaction mode) 113 / 2079, RLS live
7/7 and tier-2 4/4 including the PgBouncer case.

**Chain** (docker PG 17 + PgBouncer, `PG_PRIME_PG_DUMP` via `docker exec`): lint ✓, format ✓,
typecheck ✓, test ✓, test:live ✓, test:pg ✓ (one cron timing flake, `misfire past endAt`, green
on rerun), build ✓, bench:compile ✓, docs:check ✓, docs:examples:pg ✓; package:check: api-snapshot,
emit-parity, check:dts, pack-smoke, create-smoke ✓. **Size-only failures (integrator re-baselines):**
- `size-budget`: pg-prime total `.js` **981.7 KB** > 974.0 KB (unpacked 2546.2 KB of 2560 KB ok).
- `treeshake`: `root-import-all` **88 916 B** min+gz > 88 064 B; module set +3
  (`schema/policy.js`, `schema/trigger.js`, `session/setting.js`, golden updated here).
  `connect-one-select` 76 472 B and `full-crud-tx` 76 718 B stay within 76 800 B.
- `bench:types`: package `.d.ts` bytes **617 933** > 613 376; every instantiation line in budget.

**INDEX lines** (for the integrator):
- docs/packages/pg-prime/src/schema/policy.md — definePolicy, PolicySpec/PolicyRuntime, CREATE POLICY rendering, column qualification — read when a declared policy renders or validates wrongly.
- docs/packages/pg-prime/src/schema/trigger.md — updatedAtTrigger table extra and its refusals — read when declaring an updated_at trigger or it throws.
- docs/packages/pg-prime/src/session/setting.md — setting()/SettingKey: typed GUC set() records and current() SQL — read when a setting reads NULL, 22P02, or setLocal names misbehave.
- Updated summaries: `compile/compiler.md` — add "compileDdlExpr"; `session/guard.md` — add "inTransactionFrame".
