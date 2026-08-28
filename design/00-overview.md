# pg-prime — Design Overview & Decision Record

**Living document.** Last reconciled **2026-08-29**. Design round completed 2026-08-14; this file
is the entry point, the decision record, and the honest status of what is actually built.
Research basis: [`../research/SUMMARY.md`](../research/SUMMARY.md).

## Document map

| Doc | Owns | Headline decision |
|---|---|---|
| [01-features.md](./01-features.md) | Scope | Tiered feature spec; explicit "never" list; v1 has two XL items (unified builder, diff engine) |
| [02-driver.md](./02-driver.md) | Driver seam | Structural `PgDriver`/`PgConnection`, zero deps *and* zero peer deps; text-only decoding in v1 |
| [03-query-builder.md](./03-query-builder.md) | Query engine | Immutable AST → single-pass compiler → `{sql, binds, shape}`; `LEFT JOIN LATERAL` + `json_agg` nesting with per-codec JSON casts |
| [04-type-system.md](./04-type-system.md) | Types | Runtime builders + flat `ColMeta` flattened once per table; no whole-schema type parameter, so query cost is schema-size-independent |
| [05-schema-api.md](./05-schema-api.md) | Schema surface | `pgTable(name, cols, extras[])`; `defineRelations` with FK inference; functions/triggers as body-hash repeatables |
| [06-migrations.md](./06-migrations.md) | Migration engine | In-house differ over a fact-base IR; nothing reaches disk unproven (D6); witnessed by `pg_dump` (D10) |
| [07-runtime.md](./07-runtime.md) | Execution | `unnamedExtended` default; 40001 retry at RR/serializable only; declared (not detected) `poolerMode` |
| [08-architecture.md](./08-architecture.md) | Packaging | 4 packages; tsgo + oxlint; unbundled ESM; PGlite default test tier with a multi-session ban |
| [09-query-builder-implementation-plan.md](./09-query-builder-implementation-plan.md) | Build plan | Sequenced workstreams to get from the four spikes to a working builder; per-workstream test contracts and exit gates |

## Where the implementation actually is

Four spikes exist and are green. **They are not yet connected to each other**, so there is no
usable ORM: `schema/` does not import `compile/`, `compile/` does not import `driver/`, and two
different `Codec` types coexist (`sql/codec.ts` carries a self-described spike-local one).

| Area | State |
|---|---|
| Schema DSL | 11 column types + `t.raw(pgType)` for the rest of PostgreSQL, 8 modifiers, table extras incl. the full index options / `clusterOn` / partitions, `pgDomain` · `pgSequence` · `pgExtension`, relations. Type budget gated, and K4's seven additions moved not one per-declaration number |
| Codecs | 29 built-ins, `decodeJson` required and golden-tested at depth 0 and 3 |
| Driver | `execute` · `stream` (real cursors) · `describe` · `cancel` · error taxonomy. No transactions, no COPY |
| SQL + compiler | `sql` tag with `ident`/`lit`/`join`/`unsafeRaw`; SELECT and INSERT compile. **UPDATE and DELETE do not** — the AST nodes exist, the compiler throws |
| Migration engine | **[06](./06-migrations.md)'s whole v1 cut line is built (2026-08-29).** `pg-prime migrate generate → apply → status → check → verify` runs from a `pg-prime.config.ts` with no `desired` database and no `CREATEDB`, and `apply` refuses a transaction-mode pooler. **All twelve** of [06 §6.2](./06-migrations.md)'s commands ship; Tier M is complete, Tier R applies repeatables, Tier O is observed, Tier U is counted; all 35 hazard codes and all 7 lock-safe rewrites are built, three of them by emitting a `txmode none` companion file at the same `seq`. Nothing reaches disk unproven (D6) and `pg_dump` witnesses every plan (D10). **405 kit tests** on PG 17 and 18 |
| Migration engine — data, seeds, checkpoints, pull | **Done (2026-08-29, [12 §3 K4](./12-v1-completion-plan.md)).** `-- pg-prime:batch` is a runner feature, not a template: one transaction per iteration, the `{ rows_done, watermark }` committed *with* the batch, replica-lag aware, so a SIGKILLed 50 000-row backfill resumes at the row it reached and touches none twice — asserted with `max(touched) = 1` over every row. `db seed` runs `.sql` and typed `.ts` seeds and records nothing. `migrate checkpoint` gives a fresh database the jump and `apply`/`status` the ability to **name** the drifted objects, which [11](./11-kit-v1-loop-plan.md) K1 could not |
| Migration engine — the 1.0 gate | [01 §11.6 #5](./01-features.md) is **met twice over**: `baseline` → `verify` is green on Pagila, Northwind, AdventureWorks and Chinook, committed under `fixtures/corpus/` from pinned upstreams (empty IR diff on all four; `pg_dump` byte-equal on two and differing only by Tier-R objects on the other two). And `pull` now round-trips **all four** the other way — introspect → TypeScript → `generate` reports `up_to_date`, a second `pull` is byte-identical, and the `-- pull: unsupported` block is **empty** on every one. The corpus found four Tier-M bugs, all fixed ([06 §2.2](./06-migrations.md), [06 §4.5](./06-migrations.md)) |
| Packaging | **Done (2026-08-28).** Both packages build (`tsc` → unbundled ESM + `.d.ts` + maps), ship an `exports` map with the `types@<5.9` gate first on every subpath, and install from a `pnpm pack` tarball into a throwaway project — proved on every PR by the `package` CI job. `@pg-prime/testing` and `@pg-prime/create` are still README-only |

**2 714 tests green** (790 runtime offline in 4.7 s, 1 519 runtime live, 405 kit on PostgreSQL 17
*and* 18); workspace typecheck clean.
**Type budget, measured on the real implementation:** 137,778 instantiations, 1.11 s on TS 5.9 /
0.231 s on TS 7, schema-size-independence ratio **1.00** against a 1.15 gate.
**Dependencies:** `pg-prime` has zero runtime deps and zero peer deps — verified, `src/` contains no
non-relative imports at all. `@pg-prime/kit` depends on `pg` + `@types/pg`, and on `pg-prime` as a
**types-only peer**. 7 devDeps at the root.

## Decisions of record

1. **Names.** Runtime `pg-prime` · CLI `@pg-prime/kit` · helpers `@pg-prime/testing` · scaffolder
   `@pg-prime/create` — every package other than the runtime lives under the `@pg-prime` scope (npm org
   held). Renamed from `pgorm` / `pgormjs` on 2026-08-27. The lesson that survives the rename: bare
   `pgorm` was permanently unpublishable — npm's similarity rule rejected it against the squatted 2015
   `pg-orm`, and **a 404 does not prove a name is available**. The rule compares names with `.`, `-`
   and `_` stripped, so `pg-prime` was checked together with `pgprime`, `pg_prime` and `pg.prime` (all
   unregistered). `pgormjs@0.0.0`, the pre-rename placeholder, is published and to be deprecated; the
   four new names are unclaimed until their `0.0.0` placeholders publish.
2. **TypeScript.** Build with tsgo (TS 7); **consumer floor 5.9**. The floor is what a *user* needs
   to typecheck against our `.d.ts`, enforced by a `types@<5.9` export gate. Lowering a floor later
   is non-breaking; raising one is not.
3. **License: MPL-2.0.** Forks of our files stay open; applications that merely import are
   untouched. Apache/MIT fail the requirement, GPL/AGPL scare library adopters.
4. **Nullability: NOT NULL by default**, `.nullable()` opts in. Nullable-as-union is free at the
   type level; `.notNull()` would cost a distributive `Exclude` per column. Removes Drizzle's
   most-reported footgun.
5. **Views default to `securityInvoker: true`** — a PG-only tool that ships RLS cannot default to a
   view that silently bypasses it. `pull` annotates introspected legacy views with their real setting.
6. **Decode defaults:** `int8`→`bigint`, `numeric`→`string`, `date`→branded `'YYYY-MM-DD'` string,
   `timestamptz`→`Date`.
7. **The diff engine is ours.** pg-delta was evaluated, then rejected as a dependency; it served as
   a dev-time differential oracle for one release and was **removed entirely on 2026-08-25**,
   superseded by D10. Building our own is M/L rather than XL because Tier-R repeatables remove the
   worst-behaved objects from the differ, annotation-first renames remove rename inference, and the
   prove gate catches ordering bugs before a plan reaches disk.
8. **The proof is witnessed by PostgreSQL itself (06 D10).** After the shadow clone converges on
   our IR, the clone and the desired database are dumped with `pg_dump` and compared. Our IR proof
   is self-referential — a catalog attribute the extractor does not model is invisible to both
   sides of its own equality — and `pg_dump` shares no code with us. Zero dependencies.

## Reconciliations between docs — all resolved

| | Conflict | Resolution |
|---|---|---|
| R1 | 05 showed nullable-by-default, 04 decided NOT NULL by default | 04 won; **05 and 03 examples converted 2026-08-25**. One consequence is still open: composite-type attributes cannot carry `NOT NULL` in PG, so a bare attribute would type non-null unsoundly — see 05 §3 |
| R2 | TS floor 5.4 (04) vs 5.9 (08) | 5.9 |
| R3 | `sql` fragment typing | The tag takes **no type parameter**; result typing requires `.as(codec)`. A bare cast is a compile error |
| R4 | `cachedDescribe` justification after binary was cut | Stays opt-in, justified by decode-plan reuse alone. Binary is out of v1: `pg-protocol` UTF-8-decodes every DataRow field and corrupts payloads (measured) |
| R5 | Nested JSON rehydration — *the largest type-level risk in the design* | **Closed.** `decodeJson` is a required `Codec` member and a golden test asserts identical values at depth 0 and depth 3. No degradation types were written |
| R6 | Migration lock primitive | Session advisory lock + heartbeat lease, because a `txmode none` file has no transaction to scope `pg_advisory_xact_lock` to |
| R7 | 01's scope questions | RLS/policies move **into v1** as Tier-R repeatables; perf bar ≤1.15× raw `pg` median / ≤1.30× p99; 4 packages |

## Superseded

- **06 D1** — "adopt `@supabase/pg-delta` behind a `DiffBackend` port". Reversed by decision 7.
  06 §1 now keeps only the evidence that outlived it: the enum-ordering bug (our fixture #1), the
  missing data-dependent-failure hazard class, and the over-conservative rewrite flag.
- **08 §1.3** — the three-way name evaluation. Decided; only the 404-is-not-availability lesson kept.
- **08 §6.5** — Apache-2.0. Superseded by MPL-2.0 (decision 3).

## What is actually next

1–3. **The builder track is sequenced in [09](./09-query-builder-implementation-plan.md)**: unify the
   two `Codec` types and wire `schema/` → `compile/` (WS2, and nothing else can start before it),
   then the `Query<S,O>` type engine, the `Ref` operator surface, the runtime builders including
   UPDATE and DELETE, and relation accessors. That plan also carries the three unresolved 03-vs-04
   API forks, to be settled by measurement rather than fiat.
4. ~~Package entry points and a build, so any of this is installable.~~ **Done 2026-08-28.**
   `pg-prime` exports `.` / `./schema` / `./sql` / `./codecs` / `./driver` / `./package.json` and
   `@pg-prime/kit` exports `.` / `./package.json`, all ESM-only with `"types@<5.9"` first in every
   condition object; `pnpm build` emits unbundled `tsc` output; `pnpm package:check` gates size
   budgets, the public-API golden, emit parity (5.9.3 vs 7.0.2, every `.js` byte-identical),
   `check:dts`, the tree-shake goldens, `publint --strict`, `attw --profile esm-only`, and a real
   tarball install that compiles and runs a consumer. Still `0.0.0` and not on npm. See
   [08 §2.1, §2.4, §3.1, §3.2, §4.6 AS BUILT](./08-architecture.md).
5. CI. There is none: every gate in these documents is currently run by hand.
6. Claim `@pg-prime/kit`, `@pg-prime/testing`, `@pg-prime/create` on npm.
7. ~~**K4, the migration engine's last workstream**: data migrations, seeding,
   `migrate checkpoint`, `pull`.~~ **Done 2026-08-29** ([12 §3 K4](./12-v1-completion-plan.md)).
   All twelve of [06 §6.2](./06-migrations.md)'s commands ship, so **the whole of 06's v1 cut
   line is built**: the `-- pg-prime:batch` runner (one transaction per iteration, the watermark
   committed with the batch, so a SIGKILLed 50 000-row backfill resumes at the row it reached and
   touches none twice), `db seed` with `.sql` and typed `.ts` seeds, `migrate checkpoint` with the
   fresh-database jump and `verify --from-checkpoint`, and `pull` — which round-trips **all four**
   third-party corpus schemas to an empty `generate` with an empty unsupported block. Seven DSL
   additions came with it (`05` §2.3/§2.4/§5.1 AS BUILT), all runtime metadata: not one
   per-declaration or per-query `bench:types` number moved.
8. **The rest of [12](./12-v1-completion-plan.md)**: the session layer (`07`, which has never had
   a workstream), the builder gaps `09` deferred, release engineering, the docs site, and the perf
   residue. K4 was one of round A's four.
