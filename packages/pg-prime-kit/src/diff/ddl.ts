import type { Diagnostic } from "../catalog/extract.js";
import { GENERATED_NAME } from "../catalog/payloads.js";
import type {
  ColumnPayload,
  ConstraintPayload,
  DefaultPayload,
  ExtensionPayload,
  IndexPayload,
  SequencePayload,
  TablePayload,
  TypeAttributePayload,
  TypePayload,
} from "../catalog/payloads.js";
import type { Fact, SchemaIR } from "../ir/fact.js";
import { encodeId, idSchema, parseId, type StableId } from "../ir/stable-id.js";
import { chooseConstraintName, defaultNotNullName, quoteIdent, quoteLiteral, quoteQualified } from "../sql/ident.js";
import type { Delta } from "./delta.js";
import type { DiffResult } from "./diff.js";
import { labelsOf } from "./diff.js";
import { PHASE, type Statement } from "./statement.js";

export interface BuildResult {
  readonly statements: Statement[];
  readonly diagnostics: Diagnostic[];
}

export interface BuildOptions {
  /**
   * Encoded `default` fact ids whose expression calls a function with
   * `pg_proc.provolatile <> 'i'` — LK109's catalog test, asked by
   * `catalog/extract.ts` and reported as a `volatile_default` diagnostic. Also harvested
   * from `diff.diagnostics` when a caller threads the extractor's findings through
   * `diffIR`; absent from both, `mentionsVolatileFunction` is the fallback.
   */
  readonly volatileDefaults?: ReadonlySet<string>;
  /**
   * `--no-safe-rewrite` (design/06 §3.5): emit the literal DDL instead of the lock-safe
   * equivalent. Off by default — the safe form is the product.
   */
  readonly noSafeRewrite?: boolean;
  /**
   * Encoded `table` ids the MF family may treat as provably empty — the output of
   * `probeEmptiness` against the TARGET (design/06 §3.4: "unless the table is proven
   * empty"). Absent means offline, and offline every MF rule stays `error`.
   *
   * Suppresses MF only, never LK. An empty table still takes ACCESS EXCLUSIVE and still
   * blocks readers for the duration of the build; being empty makes the statement
   * *succeed*, not *free*.
   */
  readonly emptyTables?: ReadonlySet<string>;
  /**
   * The caller can emit **more than one file** for this plan (design/06 §3.5 rows 1, 6, 7).
   *
   * Three of §3.5's seven rewrites were blocked on nothing in the differ: they need a
   * `CREATE INDEX CONCURRENTLY`, which PostgreSQL refuses inside a transaction, so a plan
   * that contains one cannot also be an atomic DDL file. `migrate generate` can now split
   * a plan into `NNNN_name.sql` + `NNNN_name_concurrently.sql` and says so here; a caller
   * that cannot — `generateFromDatabases`, and every round-1 test that pins the
   * single-file shape — leaves it off and gets the literal form plus its hazard.
   *
   * Statements the rewrite produces carry `stage: "concurrent"`; the volatile-default
   * split (row 7) additionally reports a `volatile_default_split` diagnostic, from which
   * the caller renders the `-- pg-prime:data` backfill stub.
   */
  readonly multiFile?: boolean;
}

const id = encodeId;

function evaluatesOf(ir: SchemaIR, subject: StableId): string[] {
  return ir
    .outgoingEdges(subject)
    .filter((e) => e.kind === "evaluates")
    .map((e) => id(e.to));
}

/* -------------------------- column clause -------------------------- */

export function columnClause(
  colId: StableId & { kind: "column" },
  p: ColumnPayload,
  /** the column's `default` fact expression, now that a DEFAULT is a fact of its own */
  defaultExpr: string | null = null,
): string {
  const bits = [quoteIdent(colId.name), p.type];
  if (p.collation) bits.push(`COLLATE ${quoteIdent(p.collation)}`);
  if (p.generated === "s" && p.generationExpr) {
    bits.push(`GENERATED ALWAYS AS (${p.generationExpr}) STORED`);
  } else if (p.identity) {
    bits.push(`GENERATED ${p.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`);
  } else if (defaultExpr !== null) {
    bits.push(`DEFAULT ${defaultExpr}`);
  }
  // A generated name is what an unnamed `NOT NULL` produces anyway (PG >= 18), so it is
  // never spelled out — spelling it would make the DDL depend on a name we derived.
  if (p.notNull) {
    bits.push(
      p.notNullConstraint !== null && p.notNullConstraint !== GENERATED_NAME
        ? `CONSTRAINT ${quoteIdent(p.notNullConstraint)} NOT NULL`
        : "NOT NULL",
    );
    // PG >= 18 only. An inline NOT NULL is validated by construction, so `NOT VALID`
    // here is never redundant: it is the one spelling that produces `convalidated =
    // false` on a table being created, which is what a desired state carrying an
    // unvalidated NOT NULL means.
    if (p.notNullValidated === false) bits.push("NOT VALID");
  }
  return bits.join(" ");
}

/**
 * LK109's volatility test, without a catalog.
 *
 * `06` §3.4 specifies `pg_proc.provolatile <> 'i'` on the functions the default calls.
 * `catalog/extract.ts` asks exactly that and reports the answer as a `volatile_default`
 * diagnostic; a caller that has it passes the set through `BuildOptions.volatileDefaults`
 * and this list is never consulted. This is the fallback for a `buildStatements` call
 * with no diagnostics threaded in, and it is deliberately a *positive* list of the
 * built-ins that actually rewrite a table:
 *
 *  - `now()` / `current_timestamp` are STABLE, so they do NOT rewrite — flagging them is
 *    pg-delta's over-conservative bug and §1.2 says we do not inherit it;
 *  - a USER-defined volatile function is not in this list, so the fallback under-reports.
 *    Under-reporting a `warn` is the right direction for a heuristic; over-reporting one
 *    trains people to ignore it.
 */
const VOLATILE_BUILTINS =
  /\b(random|random_normal|clock_timestamp|statement_timestamp|timeofday|nextval|gen_random_uuid|uuid_generate_v[145]|uuid_generate_v3)\s*\(/i;

export function mentionsVolatileFunction(expression: string): boolean {
  return VOLATILE_BUILTINS.test(expression);
}

/** The `default` fact hanging off a column, if the IR has one. */
function defaultExprOf(ir: SchemaIR, colId: StableId): string | null {
  const f = ir.get({
    kind: "default",
    schema: (colId as { schema: string }).schema,
    table: (colId as { table: string }).table,
    name: (colId as { name: string }).name,
  });
  return f === undefined ? null : String((f.payload as unknown as DefaultPayload).expression);
}

/**
 * The name the NOT NULL constraint carries in the database, resolving `%GENERATED%`
 * against the column's identity. `null` when the server does not catalogue one.
 */
function notNullConstraintName(c: StableId & { kind: "column" }, p: ColumnPayload): string | null {
  if (!p.notNull || p.notNullConstraint === null) return null;
  return p.notNullConstraint === GENERATED_NAME ? defaultNotNullName(c.table, c.name) : p.notNullConstraint;
}

/**
 * Every constraint name already spoken for on this relation, in the state the plan is
 * converging on. The predicate `chooseConstraintName` needs when the emitter has to
 * INVENT a name — which it does exactly twice, both of them in the §3.5 lock-safe
 * `SET NOT NULL` rewrite.
 */
function constraintNamesOn(ir: SchemaIR, table: StableId): (candidate: string) => boolean {
  const taken = new Set(
    ir
      .childrenOf(table)
      .filter((f) => f.id.kind === "constraint")
      .map((f) => (f.id as { name: string }).name),
  );
  return (candidate) => taken.has(candidate);
}

/* ---------------------------- the builder --------------------------- */

export function buildStatements(diff: DiffResult, desired: SchemaIR, options: BuildOptions = {}): BuildResult {
  const statements: Statement[] = [];
  const diagnostics: Diagnostic[] = [...diff.diagnostics];
  const current = diff.current;
  const volatileDefaults =
    options.volatileDefaults ??
    new Set(diff.diagnostics.filter((d) => d.code === "volatile_default").map((d) => d.subject ?? ""));
  const isVolatile = (defaultId: string, expression: string): boolean =>
    volatileDefaults.size > 0 ? volatileDefaults.has(defaultId) : mentionsVolatileFunction(expression);
  const emptyTables = options.emptyTables ?? new Set<string>();

  const createdTables = new Set(
    diff.deltas.filter((d) => d.op === "create" && d.id.kind === "table").map((d) => id(deltaId(d))),
  );
  const droppedTables = new Set(
    diff.deltas.filter((d) => d.op === "drop" && d.id.kind === "table").map((d) => id(deltaId(d))),
  );
  const createdTypes = new Set(
    diff.deltas.filter((d) => d.op === "create" && d.id.kind === "type").map((d) => id(deltaId(d))),
  );
  const droppedTypes = new Set(
    diff.deltas.filter((d) => d.op === "drop" && d.id.kind === "type").map((d) => id(deltaId(d))),
  );
  const droppedColumns = new Set(
    diff.deltas.filter((d) => d.op === "drop" && d.id.kind === "column").map((d) => id(deltaId(d))),
  );
  const createdColumns = new Set(
    diff.deltas.filter((d) => d.op === "create" && d.id.kind === "column").map((d) => id(deltaId(d))),
  );
  const parentTableId = (x: StableId): string | null =>
    x.kind === "column" || x.kind === "constraint" || x.kind === "default"
      ? id({ kind: "table", schema: x.schema, name: x.table })
      : null;
  const indexTableId = (ir: SchemaIR, x: StableId): string | null => {
    const f = ir.get(x);
    return f?.parent ? id(f.parent) : null;
  };

  /**
   * May design/06 §3.5's `CONCURRENTLY` rewrites fire for an object on this table?
   *
   * Three refusals, each for a reason PostgreSQL enforces or the design states:
   *
   *  - the caller cannot carry a second file (`multiFile` off) — §3.5's own AS BUILT note
   *    records that as the blocker, not the differ;
   *  - `--no-safe-rewrite` asked for the literal diff;
   *  - the table is created by THIS plan, or is a partitioned parent. A brand-new table
   *    has no readers to block, so a concurrent build buys nothing and costs a second
   *    file; and `CREATE INDEX CONCURRENTLY` is rejected outright on a partitioned table.
   */
  const concurrentOk = (tableKey: string | null): boolean => {
    if (options.multiFile !== true || options.noSafeRewrite === true) return false;
    if (tableKey === null || createdTables.has(tableKey)) return false;
    const table = desired.get(parseId(tableKey));
    return table === undefined || table.payload["partitionStrategy"] === null;
  };

  /**
   * Everything a fact (and its descendants) REFERENCES — released the moment it
   * is dropped, so `relate(releasers, destroyers)` orders the referencing side
   * first. Without this the drop half of a plan has no hard edges at all and
   * falls back to the phase tie-break, which is a name sort: `app.tenants`
   * sorts before `billing.invoices` and dropping it first fails.
   */
  const referencesHeldBy = (ir: SchemaIR, subject: StableId): string[] => {
    const facts = [ir.get(subject), ...ir.descendantsOf(subject)].filter((f) => f !== undefined);
    const out = facts
      .flatMap((f) => ir.outgoingEdges(f.id))
      .filter((e) => e.kind === "depends" || e.kind === "evaluates")
      .map((e) => id(e.to));
    // An extension is database-scoped and a comment belongs to its target: neither has
    // a schema to hold, and `idSchema` answers `""` rather than making this a null check.
    const schema = idSchema(subject);
    if (schema !== "") out.push(id({ kind: "schema", schema }));
    return [...new Set(out)].filter((x) => x !== id(subject));
  };

  /* ---- 0. RENAMEs, from the annotations (D5) — always first ---- */
  for (const r of diff.renames) {
    const from = parseId(r.from);
    const to = parseId(r.to);
    if (from.kind === "table" && to.kind === "table") {
      statements.push({
        sql: `ALTER TABLE ${quoteQualified(from.schema, from.name)} RENAME TO ${quoteIdent(to.name)}`,
        verb: "alter",
        kind: "table",
        produces: [id(to)],
        consumes: [id({ kind: "schema", schema: to.schema })],
        destroys: [id(from)],
        releases: [],
        transactionality: "transactional",
        lockClass: "accessExclusive",
        idempotent: false,
        dataLoss: "none",
        rewrite: false,
        hazards: ["BC101"],
        phase: PHASE.rename,
      });
    } else if (from.kind === "column" && to.kind === "column") {
      statements.push({
        sql: `ALTER TABLE ${quoteQualified(from.schema, from.table)} RENAME COLUMN ${quoteIdent(from.name)} TO ${quoteIdent(to.name)}`,
        verb: "alter",
        kind: "column",
        produces: [id(to)],
        consumes: [id({ kind: "table", schema: to.schema, name: to.table })],
        destroys: [id(from)],
        releases: [],
        transactionality: "transactional",
        lockClass: "accessExclusive",
        idempotent: false,
        dataLoss: "none",
        rewrite: false,
        hazards: ["BC102"],
        phase: PHASE.rename,
      });
    } else if (from.kind === "constraint" && to.kind === "constraint") {
      // Only the NAME differs (the differ paired them by rollup), so PostgreSQL's
      // catalog-only rename replaces what used to be a DROP + ADD — which for a PK
      // fails outright while a dependent FK exists, and for an FK costs a full
      // VALIDATE scan.
      statements.push(
        simple(
          `ALTER TABLE ${quoteQualified(from.schema, from.table)} RENAME CONSTRAINT ${quoteIdent(from.name)} TO ${quoteIdent(to.name)}`,
          {
            verb: "alter",
            kind: "constraint",
            produces: [id(to)],
            consumes: [id({ kind: "table", schema: to.schema, name: to.table })],
            destroys: [id(from)],
            hazards: ["BC104"],
            phase: PHASE.rename,
          },
        ),
      );
    } else if (from.kind === "index" && to.kind === "index") {
      statements.push(
        simple(`ALTER INDEX ${quoteQualified(from.schema, from.name)} RENAME TO ${quoteIdent(to.name)}`, {
          verb: "alter",
          kind: "index",
          produces: [id(to)],
          consumes: [id({ kind: "schema", schema: to.schema })],
          destroys: [id(from)],
          hazards: ["BC104"],
          phase: PHASE.rename,
        }),
      );
    } else {
      diagnostics.push({
        code: "unsupported_rename",
        severity: "error",
        message: `rename of ${from.kind} is not implemented in the v1-M spike`,
        subject: r.from,
      });
    }
  }

  for (const d of diff.deltas) {
    switch (d.op) {
      case "addEnumValue": {
        const label = d.id as StableId & { kind: "enumLabel" };
        const anchor = d.anchor ? ` ${d.anchor.position} ${quoteLiteral(d.anchor.label)}` : "";
        statements.push({
          // IF NOT EXISTS keeps TX201 (idempotence) intact for txmode-none files.
          sql: `ALTER TYPE ${quoteQualified(label.schema, label.type)} ADD VALUE IF NOT EXISTS ${quoteLiteral(label.name)}${anchor}`,
          verb: "alter",
          kind: "enumLabel",
          produces: [id(label)],
          consumes: [id({ kind: "type", schema: label.schema, name: label.type })],
          destroys: [],
          releases: [],
          // THE fix for §1.3: the value is unusable until this commits.
          transactionality: "commitBoundaryAfter",
          lockClass: "shareRowExclusive",
          idempotent: true,
          dataLoss: "none",
          rewrite: false,
          hazards: [],
          phase: PHASE.addEnumValue,
        });
        break;
      }

      case "create": {
        const f = d.fact;
        switch (f.id.kind) {
          case "schema":
            statements.push(
              simple(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(f.id.schema)}`, {
                verb: "create",
                kind: "schema",
                produces: [id(f.id)],
                phase: PHASE.createSchema,
                lockClass: "none",
                idempotent: true,
              }),
            );
            break;
          case "type":
            statements.push(...createType(f.id, f.payload as unknown as TypePayload, desired));
            break;
          case "sequence": {
            const p = f.payload as unknown as SequencePayload;
            // `CREATE SEQUENCE … OWNED BY t.id` CONSUMES the column that the
            // CREATE TABLE produces, so the table gets ordered first - but a
            // `serial` table's own DEFAULT `nextval('t_id_seq')` needs the
            // sequence to exist, and the plan died with `relation "t_id_seq"
            // does not exist`. Ownership is therefore a separate statement:
            // the CREATE consumes only its schema, the ALTER consumes the column.
            statements.push(
              simple(sequenceDDL(f.id, p, "create", false), {
                verb: "create",
                kind: "sequence",
                produces: [id(f.id)],
                consumes: [id({ kind: "schema", schema: f.id.schema })],
                phase: PHASE.createSequence,
                lockClass: "none",
                idempotent: true,
              }),
            );
            if (p.ownedBy) {
              statements.push(
                simple(`ALTER SEQUENCE ${quoteQualified(f.id.schema, f.id.name)} ${ownedByClause(p.ownedBy)}`, {
                  verb: "alter",
                  kind: "sequence",
                  consumes: [id(f.id), p.ownedBy],
                  phase: PHASE.alterSequence,
                  lockClass: "none",
                  idempotent: true,
                }),
              );
            }
            break;
          }
          case "table": {
            const t = f.id;
            const p = f.payload as unknown as TablePayload;
            const cols = desired
              .childrenOf(t)
              .filter((c) => c.id.kind === "column")
              .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
            const body = cols.map((c) =>
              columnClause(
                c.id as StableId & { kind: "column" },
                c.payload as unknown as ColumnPayload,
                defaultExprOf(desired, c.id),
              ),
            );
            const unlogged = p.persistence === "u" ? "UNLOGGED " : "";
            // A partitioned parent is a `CREATE TABLE … PARTITION BY`; a partition is
            // created standalone and ATTACHed, exactly as pg_dump emits it. Creating it
            // with `PARTITION OF` instead would inline the bound into the CREATE, and
            // then a bound CHANGE (which is a real DETACH + ATTACH) would have no
            // statement to be.
            const partitionBy = isPartitioned(p.partitionKey) ? ` PARTITION BY ${p.partitionKey}` : "";
            statements.push({
              sql: `CREATE ${unlogged}TABLE ${quoteQualified(t.schema, t.name)} (\n  ${body.join(",\n  ")}\n)${partitionBy}`,
              verb: "create",
              kind: "table",
              produces: [id(t), ...cols.map((c) => id(c.id))],
              consumes: [
                id({ kind: "schema", schema: t.schema }),
                ...cols.flatMap((c) =>
                  desired
                    .outgoingEdges(c.id)
                    .filter((e) => e.kind === "depends" || e.kind === "evaluates")
                    .map((e) => id(e.to)),
                ),
              ],
              destroys: [],
              releases: [],
              transactionality: "transactional",
              lockClass: "none",
              idempotent: false,
              dataLoss: "none",
              rewrite: false,
              hazards: [],
              phase: PHASE.createTable,
            });
            if (p.rowSecurity) {
              statements.push(
                simple(`ALTER TABLE ${quoteQualified(t.schema, t.name)} ENABLE ROW LEVEL SECURITY`, {
                  verb: "alter",
                  kind: "table",
                  consumes: [id(t)],
                  phase: PHASE.alterTable,
                }),
              );
            }
            // Truthiness, not `!== null`: a payload can arrive from a serialized
            // checkpoint written before this field existed, or from a caller that
            // hand-built one, and `undefined !== null` is true — the same trap
            // `isPartitioned` exists for two fields up.
            if (p.clusterOn) statements.push(clusterOn(t, p.clusterOn));
            if (isPartitioned(p.partitionOf)) statements.push(attachPartition(t, p));
            break;
          }
          case "default": {
            // A default on a table or column THIS plan creates is already in its column
            // clause — see the `column` case for why it has to be inline there.
            if (createdTables.has(parentTableId(f.id)!)) break;
            if (createdColumns.has(id({ kind: "column", schema: f.id.schema, table: f.id.table, name: f.id.name })))
              break;
            statements.push(setDefault(f.id, String(f.payload["expression"]), desired));
            break;
          }
          case "typeAttribute": {
            if (createdTypes.has(id({ kind: "type", schema: f.id.schema, name: f.id.type }))) break;
            const a = f.payload as unknown as TypeAttributePayload;
            statements.push(
              simple(
                `ALTER TYPE ${quoteQualified(f.id.schema, f.id.type)} ADD ATTRIBUTE ${quoteIdent(f.id.name)} ${a.type}${a.collation ? ` COLLATE ${quoteIdent(a.collation)}` : ""} CASCADE`,
                {
                  verb: "alter",
                  kind: "typeAttribute",
                  produces: [id(f.id)],
                  consumes: [id({ kind: "type", schema: f.id.schema, name: f.id.type })],
                  phase: PHASE.alterType,
                },
              ),
            );
            break;
          }
          case "comment":
            statements.push(commentStatement(f.id, String(f.payload["text"])));
            break;
          case "extension": {
            const e = f.payload as unknown as ExtensionPayload;
            // Declare-only (design/06 §2.2): created if absent, NEVER dropped. The
            // `IF NOT EXISTS` is not politeness — an extension is frequently installed
            // by a DBA out of band, and failing on that is refusing to adopt a database.
            statements.push(
              simple(`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(f.id.name)} SCHEMA ${quoteIdent(e.schema)}`, {
                verb: "create",
                kind: "extension",
                produces: [id(f.id)],
                consumes: [id({ kind: "schema", schema: e.schema })],
                phase: PHASE.createExtension,
                lockClass: "none",
                idempotent: true,
              }),
            );
            break;
          }
          case "column": {
            if (createdTables.has(parentTableId(f.id)!)) break; // folded into CREATE TABLE
            const p = f.payload as unknown as ColumnPayload;
            const c = f.id as StableId & { kind: "column" };
            const def = defaultExprOf(desired, c);
            const hazards: string[] = [];
            const tableId = id({ kind: "table", schema: c.schema, name: c.table });
            if (p.notNull && def === null && !p.identity && p.generated !== "s" && !emptyTables.has(tableId)) {
              hazards.push("MF103");
            }
            // LK109: only a VOLATILE default rewrites the table. A constant one has used
            // `attmissingval` since PG 11 — pg-delta flags both and we do not inherit
            // that. Volatility is read off the expression's function calls, not guessed.
            const defaultId = id({ kind: "default", schema: c.schema, table: c.table, name: c.name });
            const volatileDefault = def !== null && isVolatile(defaultId, def);

            /* §3.5 row 7 — ADD COLUMN with a VOLATILE default, split.
             *
             *   ALTER TABLE t ADD COLUMN c <type>       -- nullable, no default: no rewrite
             *   ALTER TABLE t ALTER COLUMN c SET DEFAULT …   -- catalog only
             *   (a `-- pg-prime:data` file with a TODO backfills the existing rows)
             *
             * The split is refused when the desired column is NOT NULL, and that is not a
             * gap: a NOT NULL column with a per-row distinct value cannot exist without
             * writing every row, so no reordering of statements avoids the rewrite. §3.5's
             * own row puts `SET NOT NULL` in a *separate migration* for exactly that
             * reason — which this plan cannot contain and still converge on IR(desired),
             * so the literal form plus LK109 stays the honest answer and the diagnostic
             * below names the three-migration shape.
             */
            const splitVolatile =
              volatileDefault &&
              options.multiFile === true &&
              options.noSafeRewrite !== true &&
              !p.notNull &&
              !p.identity &&
              p.generated !== "s" &&
              !emptyTables.has(tableId);

            if (splitVolatile && def !== null) {
              const evaluates = desired
                .outgoingEdges(f.id)
                .filter((e) => e.kind === "depends" || e.kind === "evaluates")
                .map((e) => id(e.to));
              statements.push(
                {
                  sql: `ALTER TABLE ${quoteQualified(c.schema, c.table)} ADD COLUMN IF NOT EXISTS ${columnClause(c, p, null)}`,
                  verb: "alter",
                  kind: "column",
                  produces: [id(f.id)],
                  consumes: [tableId, ...evaluates],
                  destroys: [],
                  releases: [],
                  transactionality: "transactional",
                  lockClass: "accessExclusive",
                  idempotent: true,
                  dataLoss: "none",
                  rewrite: false,
                  hazards: [],
                  phase: PHASE.addColumn,
                },
                simple(
                  `ALTER TABLE ${quoteQualified(c.schema, c.table)} ALTER COLUMN ${quoteIdent(c.name)} SET DEFAULT ${def}`,
                  {
                    verb: "alter",
                    kind: "default",
                    produces: [defaultId],
                    consumes: [id(f.id), tableId, ...evaluates],
                    idempotent: true,
                    phase: PHASE.setDefault,
                  },
                ),
              );
              diagnostics.push({
                code: "volatile_default_split",
                severity: "info",
                subject: id(f.id),
                message:
                  `${c.schema}.${c.table}.${c.name} is added NULLABLE with its DEFAULT set afterwards ` +
                  `(design/06 §3.5 row 7), so the table is not rewritten under ACCESS EXCLUSIVE. ` +
                  `Existing rows are NOT backfilled: a -- pg-prime:data stub is written beside this ` +
                  `migration and must be completed before it is applied.`,
              });
              break;
            }
            if (volatileDefault) hazards.push("LK109");
            if (volatileDefault && p.notNull) {
              diagnostics.push({
                code: "volatile_default_not_null",
                severity: "warning",
                subject: id(f.id),
                message:
                  `${c.schema}.${c.table}.${c.name} is NOT NULL with a volatile DEFAULT, so PostgreSQL ` +
                  `rewrites the whole table under ACCESS EXCLUSIVE and no statement ordering avoids it. ` +
                  `The lock-safe shape is three migrations (design/06 §3.5 row 7, §7 lane 2): add the ` +
                  `column nullable with its DEFAULT, backfill it in a -- pg-prime:data migration, then ` +
                  `SET NOT NULL.`,
              });
            }
            statements.push({
              // The DEFAULT stays INLINE even though it is now a fact of its own: on a
              // populated table `ADD COLUMN … NOT NULL` followed by a separate
              // `SET DEFAULT` fails, because the NOT NULL is checked against the rows the
              // second statement has not reached yet.
              sql: `ALTER TABLE ${quoteQualified(c.schema, c.table)} ADD COLUMN IF NOT EXISTS ${columnClause(c, p, def)}`,
              verb: "alter",
              kind: "column",
              produces: [
                id(f.id),
                ...(def === null ? [] : [id({ kind: "default", schema: c.schema, table: c.table, name: c.name })]),
              ],
              consumes: [
                id({ kind: "table", schema: c.schema, name: c.table }),
                ...desired
                  .outgoingEdges(f.id)
                  .filter((e) => e.kind === "depends" || e.kind === "evaluates")
                  .map((e) => id(e.to)),
              ],
              destroys: [],
              releases: [],
              transactionality: "transactional",
              lockClass: "accessExclusive",
              idempotent: true,
              dataLoss: "none",
              rewrite: p.generated === "s" || !!p.identity || volatileDefault,
              hazards,
              phase: PHASE.addColumn,
            });
            break;
          }
          case "constraint": {
            // A constraint on a table THIS plan creates cannot fail on existing
            // data and cannot block anybody: the table is provably empty
            // (design/06 §3.4, "unless the table is proven empty").
            statements.push(
              ...addConstraint(f, desired, {
                onFreshTable: createdTables.has(parentTableId(f.id)!),
                provenEmpty: emptyTables.has(parentTableId(f.id)!),
                noSafeRewrite: options.noSafeRewrite ?? false,
                concurrent: concurrentOk(parentTableId(f.id)),
              }),
            );
            break;
          }
          case "index": {
            statements.push(...createIndex(f, desired, [], concurrentOk(indexTableId(desired, f.id))));
            break;
          }
          default:
            break;
        }
        break;
      }

      case "alter": {
        const { before, after } = d;
        switch (after.id.kind) {
          case "column":
            statements.push(...alterColumn(before, after, desired, diagnostics, emptyTables));
            break;
          case "index": {
            // PostgreSQL cannot ALTER an index's structure: drop and rebuild.
            const wasUnique = before.payload["unique"] === true;
            const isUnique = after.payload["unique"] === true;
            statements.push(
              dropIndex(before),
              // MF102: a non-unique index becoming unique fails on the first duplicate
              // the table already holds. Distinct from MF101 (a NEW uniqueness guarantee)
              // because the near-miss — rebuilding an index that was already unique — is
              // not a hazard at all, and a rule that cannot tell them apart is noise.
              ...createIndex(
                after,
                desired,
                !wasUnique && isUnique ? ["MF102"] : [],
                concurrentOk(indexTableId(desired, after.id)),
              ),
            );
            break;
          }
          case "constraint": {
            const b = before.payload as unknown as ConstraintPayload;
            const a = after.payload as unknown as ConstraintPayload;
            if (b.definition === a.definition && !b.validated && a.validated) {
              statements.push(validateConstraint(after));
            } else {
              statements.push(
                dropConstraint(before, current),
                ...addConstraint(after, desired, {
                  onFreshTable: false,
                  provenEmpty: emptyTables.has(parentTableId(after.id) ?? ""),
                  noSafeRewrite: options.noSafeRewrite ?? false,
                  concurrent: concurrentOk(parentTableId(after.id)),
                }),
              );
            }
            break;
          }
          case "default":
            statements.push(setDefault(after.id, String(after.payload["expression"]), desired));
            break;
          case "comment":
            statements.push(commentStatement(after.id, String(after.payload["text"])));
            break;
          case "typeAttribute": {
            const a = after.payload as unknown as TypeAttributePayload;
            const ta = after.id as StableId & { kind: "typeAttribute" };
            reportCompositeInUse(ta, current, diagnostics);
            statements.push(
              simple(
                `ALTER TYPE ${quoteQualified(ta.schema, ta.type)} ALTER ATTRIBUTE ${quoteIdent(ta.name)} SET DATA TYPE ${a.type}${a.collation ? ` COLLATE ${quoteIdent(a.collation)}` : ""} CASCADE`,
                {
                  verb: "alter",
                  kind: "typeAttribute",
                  consumes: [id(after.id), id({ kind: "type", schema: ta.schema, name: ta.type })],
                  phase: PHASE.alterType,
                  hazards: ["BC103"],
                },
              ),
            );
            break;
          }
          case "extension": {
            const b = before.payload as unknown as ExtensionPayload;
            const a = after.payload as unknown as ExtensionPayload;
            // The only extension attribute that is diffed at all (see `ExtensionPayload`),
            // and still never a DROP: declare-only means the object survives every plan.
            if (b.schema !== a.schema) {
              statements.push(
                simple(
                  `ALTER EXTENSION ${quoteIdent((after.id as { name: string }).name)} SET SCHEMA ${quoteIdent(a.schema)}`,
                  {
                    verb: "alter",
                    kind: "extension",
                    consumes: [id(after.id), id({ kind: "schema", schema: a.schema })],
                    phase: PHASE.alterExtension,
                    lockClass: "none",
                  },
                ),
              );
            }
            break;
          }
          case "type": {
            const b = before.payload as unknown as TypePayload;
            const a = after.payload as unknown as TypePayload;
            statements.push(...alterType(after.id as StableId & { kind: "type" }, b, a, desired, diagnostics));
            break;
          }
          case "table": {
            const b = before.payload as unknown as TablePayload;
            const a = after.payload as unknown as TablePayload;
            const t = after.id as StableId & { kind: "table" };
            if (b.partitionOf !== a.partitionOf || b.partitionBound !== a.partitionBound) {
              // A bound change is a DETACH + ATTACH; PostgreSQL has no `ALTER … FOR VALUES`.
              if (isPartitioned(b.partitionOf)) statements.push(detachPartition(t, b));
              if (isPartitioned(a.partitionOf)) statements.push(attachPartition(t, a));
            }
            if (b.partitionKey !== a.partitionKey || b.partitionStrategy !== a.partitionStrategy) {
              diagnostics.push({
                code: "unsupported_alter",
                severity: "error",
                message:
                  `table ${t.schema}.${t.name}: the partition key cannot be changed in place ` +
                  `(${b.partitionKey ?? "none"} -> ${a.partitionKey ?? "none"}); PostgreSQL requires a new table`,
                subject: id(t),
              });
            }
            if (b.persistence !== a.persistence) {
              statements.push(
                simple(
                  `ALTER TABLE ${quoteQualified(t.schema, t.name)} SET ${a.persistence === "u" ? "UNLOGGED" : "LOGGED"}`,
                  {
                    verb: "alter",
                    kind: "table",
                    consumes: [id(t)],
                    phase: PHASE.alterTable,
                    hazards: ["LK112"],
                    rewrite: true,
                  },
                ),
              );
            }
            if (b.rowSecurity !== a.rowSecurity) {
              statements.push(
                simple(
                  `ALTER TABLE ${quoteQualified(t.schema, t.name)} ${a.rowSecurity ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY`,
                  { verb: "alter", kind: "table", consumes: [id(t)], phase: PHASE.alterTable },
                ),
              );
            }
            if ((b.clusterOn ?? null) !== (a.clusterOn ?? null)) {
              statements.push(
                !a.clusterOn
                  ? simple(`ALTER TABLE ${quoteQualified(t.schema, t.name)} SET WITHOUT CLUSTER`, {
                      verb: "alter",
                      kind: "table",
                      consumes: [id(t)],
                      phase: PHASE.comment,
                      lockClass: "accessExclusive",
                    })
                  : clusterOn(t, a.clusterOn),
              );
            }
            if (b.relkind !== a.relkind) {
              diagnostics.push({
                code: "unsupported_alter",
                severity: "error",
                message: `table ${t.schema}.${t.name}: relkind ${b.relkind} -> ${a.relkind} cannot be altered in place`,
                subject: id(t),
              });
            }
            break;
          }
          case "sequence": {
            const p = after.payload as unknown as SequencePayload;
            statements.push(
              simple(sequenceDDL(after.id, p, "alter"), {
                verb: "alter",
                kind: "sequence",
                consumes: [id(after.id), ...(p.ownedBy ? [p.ownedBy] : [])],
                phase: PHASE.alterSequence,
              }),
            );
            break;
          }
          default:
            diagnostics.push({
              code: "unsupported_alter",
              severity: "error",
              message: `cannot alter ${after.id.kind} in place`,
              subject: id(after.id),
            });
        }
        break;
      }

      case "drop": {
        const f = d.fact;
        switch (f.id.kind) {
          case "index":
            if (droppedTables.has(indexTableId(current, f.id) ?? "")) break;
            statements.push(dropIndex(f));
            break;
          case "constraint":
            if (droppedTables.has(parentTableId(f.id)!)) break;
            statements.push(dropConstraint(f, current));
            break;
          case "default": {
            const c = f.id as StableId & { kind: "default" };
            if (droppedTables.has(parentTableId(f.id)!)) break;
            // The column may be going too; then the DROP DEFAULT is noise on an object
            // that no longer exists, and `releases` would order it after its own column.
            if (!current.has({ kind: "column", schema: c.schema, table: c.table, name: c.name })) break;
            if (droppedColumns.has(id({ kind: "column", schema: c.schema, table: c.table, name: c.name }))) break;
            statements.push(
              simple(
                `ALTER TABLE ${quoteQualified(c.schema, c.table)} ALTER COLUMN ${quoteIdent(c.name)} DROP DEFAULT`,
                {
                  verb: "drop",
                  kind: "default",
                  destroys: [id(f.id)],
                  consumes: [id({ kind: "column", schema: c.schema, table: c.table, name: c.name })],
                  releases: referencesHeldBy(current, f.id),
                  phase: PHASE.setDefault,
                  idempotent: true,
                },
              ),
            );
            break;
          }
          case "comment": {
            const target = parseId((f.id as StableId & { kind: "comment" }).target);
            // A comment on something this plan drops needs no statement of its own, and
            // `COMMENT ON` against a missing object is an error, not a no-op.
            if (target.kind === "table" && droppedTables.has(id(target))) break;
            if (
              (target.kind === "column" || target.kind === "constraint") &&
              droppedTables.has(id({ kind: "table", schema: target.schema, name: target.table }))
            )
              break;
            if (!current.has(target)) break;
            statements.push(commentStatement(f.id, null));
            break;
          }
          case "typeAttribute": {
            const ta = f.id as StableId & { kind: "typeAttribute" };
            if (droppedTypes.has(id({ kind: "type", schema: ta.schema, name: ta.type }))) break;
            statements.push(
              simple(
                `ALTER TYPE ${quoteQualified(ta.schema, ta.type)} DROP ATTRIBUTE IF EXISTS ${quoteIdent(ta.name)} CASCADE`,
                {
                  verb: "drop",
                  kind: "typeAttribute",
                  destroys: [id(f.id)],
                  consumes: [id({ kind: "type", schema: ta.schema, name: ta.type })],
                  phase: PHASE.alterType,
                  dataLoss: "destructive",
                  idempotent: true,
                  hazards: ["DS103"],
                },
              ),
            );
            break;
          }
          case "extension":
            // Unreachable: `diffIR` never emits a drop delta for an extension
            // (declare-only, design/06 §2.2) and reports the retention instead. Kept as
            // an explicit no-op so a future differ change cannot start dropping one
            // through the `default:` arm below without someone deleting this line.
            break;
          case "column": {
            if (droppedTables.has(parentTableId(f.id)!)) break;
            const c = f.id as StableId & { kind: "column" };
            statements.push({
              sql: `ALTER TABLE ${quoteQualified(c.schema, c.table)} DROP COLUMN IF EXISTS ${quoteIdent(c.name)}`,
              verb: "drop",
              kind: "column",
              produces: [],
              consumes: [id({ kind: "table", schema: c.schema, name: c.table })],
              destroys: [id(f.id)],
              releases: referencesHeldBy(current, f.id),
              transactionality: "transactional",
              lockClass: "accessExclusive",
              idempotent: true,
              dataLoss: "destructive",
              rewrite: false,
              hazards: ["DS103"],
              phase: PHASE.dropColumn,
            });
            break;
          }
          case "table": {
            const t = f.id as StableId & { kind: "table" };
            statements.push({
              sql: `DROP TABLE IF EXISTS ${quoteQualified(t.schema, t.name)}`,
              verb: "drop",
              kind: "table",
              produces: [],
              consumes: [],
              destroys: [id(f.id), ...current.descendantsOf(f.id).map((c) => id(c.id))],
              releases: referencesHeldBy(current, f.id),
              transactionality: "transactional",
              lockClass: "accessExclusive",
              idempotent: true,
              dataLoss: "destructive",
              rewrite: false,
              hazards: ["DS102"],
              phase: PHASE.dropTable,
            });
            break;
          }
          case "sequence":
            statements.push(
              simple(`DROP SEQUENCE IF EXISTS ${quoteQualified(f.id.schema, (f.id as { name: string }).name)}`, {
                verb: "drop",
                kind: "sequence",
                destroys: [id(f.id)],
                releases: referencesHeldBy(current, f.id),
                phase: PHASE.dropSequence,
                dataLoss: "destructive",
                idempotent: true,
              }),
            );
            break;
          case "type":
            statements.push(
              simple(`DROP TYPE IF EXISTS ${quoteQualified(f.id.schema, (f.id as { name: string }).name)}`, {
                verb: "drop",
                kind: "type",
                destroys: [id(f.id), ...current.descendantsOf(f.id).map((c) => id(c.id))],
                releases: referencesHeldBy(current, f.id),
                phase: PHASE.dropType,
                dataLoss: "destructive",
                idempotent: true,
                hazards: ["DS104"],
              }),
            );
            break;
          case "schema":
            statements.push(
              simple(`DROP SCHEMA IF EXISTS ${quoteIdent(f.id.schema)}`, {
                verb: "drop",
                kind: "schema",
                destroys: [id(f.id)],
                phase: PHASE.dropSchema,
                dataLoss: "destructive",
                idempotent: true,
                hazards: ["DS101"],
              }),
            );
            break;
          default:
            break;
        }
        break;
      }

      case "rename":
        break; // handled above, from diff.renames
    }
  }

  return { statements, diagnostics };
}

/* ----------------------------- helpers ------------------------------ */

function deltaId(d: Delta): StableId {
  return d.op === "rename" ? d.to : d.id;
}

/**
 * `ALTER TABLE … CLUSTER ON …` — `pg_index.indisclustered`, which `pg_dump` emits and the
 * IR did not model until AdventureWorks' 68 clustered primary keys showed up as D10 drift.
 *
 * It consumes BOTH spellings of the index's id — `index:…` and `constraint:…` — because
 * the clustered index is usually a constraint's backing index, which is not a fact of its
 * own; consuming a key nothing produces is inert, and consuming the right one is what
 * orders this statement after the object it names.
 */
function clusterOn(t: StableId & { kind: "table" }, index: string): Statement {
  return simple(`ALTER TABLE ${quoteQualified(t.schema, t.name)} CLUSTER ON ${quoteIdent(index)}`, {
    verb: "alter",
    kind: "table",
    consumes: [
      id(t),
      id({ kind: "index", schema: t.schema, name: index }),
      id({ kind: "constraint", schema: t.schema, table: t.name, name: index }),
    ],
    lockClass: "accessExclusive",
    phase: PHASE.comment,
  });
}

function simple(
  sql: string,
  o: Partial<Statement> & { verb: Statement["verb"]; kind: string; phase: number },
): Statement {
  return {
    sql,
    produces: [],
    consumes: [],
    destroys: [],
    releases: [],
    transactionality: "transactional",
    lockClass: "accessExclusive",
    idempotent: false,
    dataLoss: "none",
    rewrite: false,
    hazards: [],
    ...o,
  };
}

/**
 * A partition field that is actually set.
 *
 * Not `!== null`: a payload can arrive from a serialized checkpoint written before these
 * fields existed, or from a caller that hand-built one, and `undefined !== null` is true
 * — which sent `parseId(String(undefined))` into `attachPartition` and threw
 * "malformed StableId" on an ordinary table.
 */
const isPartitioned = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/* ------------------------- types: enum, domain, composite ------------------------- */

/**
 * PostgreSQL refuses `ALTER TYPE … {ADD,ALTER,DROP} ATTRIBUTE` while any table column has
 * the composite's type, and `CASCADE` does not rescue it — that keyword reaches typed
 * tables and nested composites, not plain columns. The refusal arrives as a 0A000 in the
 * middle of an apply, which is the worst place to learn it, so the plan says so first.
 */
function reportCompositeInUse(
  ta: StableId & { kind: "typeAttribute" },
  current: SchemaIR,
  diagnostics: Diagnostic[],
): void {
  const qualified = `${ta.schema}.${ta.type}`;
  const users = current
    .factsOfKind("column")
    .filter((f) => f.payload["type"] === qualified || f.payload["type"] === `${qualified}[]`)
    .map((f) => id(f.id));
  if (users.length === 0) return;
  diagnostics.push({
    code: "unsupported_alter",
    severity: "error",
    message:
      `composite type ${qualified} cannot have its attributes altered while ${users.join(", ")} ` +
      `use${users.length === 1 ? "s" : ""} it; PostgreSQL rejects ALTER TYPE … ATTRIBUTE with ` +
      `"cannot alter type … because column … uses it", and CASCADE does not cover plain columns`,
    subject: id(ta),
  });
}

function createType(t: StableId & { kind: "type" }, p: TypePayload, desired: SchemaIR): Statement[] {
  const name = quoteQualified(t.schema, t.name);
  const consumes = [id({ kind: "schema", schema: t.schema })];
  if (p.typtype === "e") {
    const labels = labelsOf(desired, t);
    return [
      simple(`CREATE TYPE ${name} AS ENUM (${labels.map(quoteLiteral).join(", ")})`, {
        verb: "create",
        kind: "type",
        produces: [id(t), ...labels.map((l) => id({ kind: "enumLabel", schema: t.schema, type: t.name, name: l }))],
        consumes,
        phase: PHASE.createType,
        lockClass: "none",
      }),
    ];
  }
  if (p.typtype === "d") {
    // The CHECKs are named in the payload and spelled out here rather than left to the
    // server: `CREATE DOMAIN … CHECK (…)` without a name gets `<domain>_check`, then
    // `<domain>_check1`, and the numbering depends on creation order — which is exactly
    // the drift `ChooseConstraintName` produces and the D10 witness reports.
    const bits = [`CREATE DOMAIN ${name} AS ${p.baseType ?? "text"}`];
    if (p.collation) bits.push(`COLLATE ${quoteIdent(p.collation)}`);
    if (p.default !== null) bits.push(`DEFAULT ${p.default}`);
    if (p.notNull) bits.push("NOT NULL");
    for (const c of p.checks ?? []) {
      const sp = c.indexOf(" ");
      bits.push(`CONSTRAINT ${quoteIdent(c.slice(0, sp))} ${c.slice(sp + 1)}`);
    }
    return [
      simple(bits.join(" "), {
        verb: "create",
        kind: "type",
        produces: [id(t)],
        consumes,
        phase: PHASE.createType,
        lockClass: "none",
      }),
    ];
  }
  const attrs = desired
    .childrenOf(t)
    .filter((a) => a.id.kind === "typeAttribute")
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  const body = attrs.map((a) => {
    const ap = a.payload as unknown as TypeAttributePayload;
    return `${quoteIdent((a.id as { name: string }).name)} ${ap.type}${ap.collation ? ` COLLATE ${quoteIdent(ap.collation)}` : ""}`;
  });
  return [
    simple(`CREATE TYPE ${name} AS (${body.join(", ")})`, {
      verb: "create",
      kind: "type",
      produces: [id(t), ...attrs.map((a) => id(a.id))],
      consumes,
      phase: PHASE.createType,
      lockClass: "none",
    }),
  ];
}

/**
 * An enum's labels are handled by `addEnumValue`; a composite's attributes are their own
 * facts. What is left is the domain, every part of which PostgreSQL can alter in place —
 * which is the reason a domain is Tier M at all rather than a repeatable.
 */
function alterType(
  t: StableId & { kind: "type" },
  b: TypePayload,
  a: TypePayload,
  desired: SchemaIR,
  diagnostics: Diagnostic[],
): Statement[] {
  const name = quoteQualified(t.schema, t.name);
  const out: Statement[] = [];
  const mk = (sql: string, extra: Partial<Statement> = {}): Statement =>
    simple(sql, { verb: "alter", kind: "type", consumes: [id(t)], phase: PHASE.alterType, ...extra });

  if (b.typtype !== a.typtype || (a.typtype === "d" && b.baseType !== a.baseType)) {
    // `ALTER DOMAIN … TYPE` does not exist, and an enum cannot become a composite.
    diagnostics.push({
      code: "unsupported_alter",
      severity: "error",
      message:
        `type ${t.schema}.${t.name}: ${b.typtype}${b.baseType ? ` (${b.baseType})` : ""} -> ` +
        `${a.typtype}${a.baseType ? ` (${a.baseType})` : ""} cannot be altered in place`,
      subject: id(t),
    });
    return out;
  }
  if (a.typtype !== "d") return out;

  if (b.default !== a.default) {
    out.push(
      mk(a.default === null ? `ALTER DOMAIN ${name} DROP DEFAULT` : `ALTER DOMAIN ${name} SET DEFAULT ${a.default}`, {
        idempotent: true,
      }),
    );
  }
  if (b.notNull !== a.notNull) {
    out.push(
      mk(`ALTER DOMAIN ${name} ${a.notNull ? "SET" : "DROP"} NOT NULL`, {
        idempotent: true,
        // Every column of the domain's type is scanned, on every table that uses it.
        hazards: a.notNull ? ["MF104", "LK107"] : [],
      }),
    );
  }
  const before = new Set(b.checks ?? []);
  const after = new Set(a.checks ?? []);
  const nameOf = (c: string): string => c.slice(0, c.indexOf(" "));
  for (const c of before) {
    if (after.has(c)) continue;
    out.push(
      mk(`ALTER DOMAIN ${name} DROP CONSTRAINT IF EXISTS ${quoteIdent(nameOf(c))}`, { verb: "drop", idempotent: true }),
    );
  }
  for (const c of after) {
    if (before.has(c)) continue;
    const sp = c.indexOf(" ");
    out.push(
      mk(`ALTER DOMAIN ${name} ADD CONSTRAINT ${quoteIdent(c.slice(0, sp))} ${c.slice(sp + 1)}`, {
        hazards: ["MF106"],
      }),
    );
  }
  // `desired` is unused for a domain, but the signature matches `createType`'s so a
  // future composite path has the IR it needs without another plumbing change.
  void desired;
  return out;
}

/* ------------------------------- partitions -------------------------------- */

function partitionParent(p: TablePayload): StableId & { kind: "table" } {
  const parsed = parseId(String(p.partitionOf));
  if (parsed.kind !== "table") throw new Error(`partitionOf is not a table id: ${String(p.partitionOf)}`);
  return parsed;
}

function attachPartition(t: StableId & { kind: "table" }, p: TablePayload): Statement {
  const parent = partitionParent(p);
  return simple(
    `ALTER TABLE ${quoteQualified(parent.schema, parent.name)} ATTACH PARTITION ${quoteQualified(t.schema, t.name)} ${p.partitionBound ?? "DEFAULT"}`,
    {
      verb: "alter",
      kind: "table",
      // The ATTACH is what makes the partition part of the parent, so it PRODUCES the
      // relationship the parent's indexes and constraints then propagate over.
      produces: [],
      consumes: [id(t), id(parent)],
      phase: PHASE.attachPartition,
      // ACCESS EXCLUSIVE on the partition, SHARE UPDATE EXCLUSIVE on the parent since 12,
      // plus a full scan of the partition to prove the bound — reported, never certified.
      lockClass: "accessExclusive",
      hazards: ["LK107"],
    },
  );
}

function detachPartition(t: StableId & { kind: "table" }, p: TablePayload): Statement {
  const parent = partitionParent(p);
  return simple(
    `ALTER TABLE ${quoteQualified(parent.schema, parent.name)} DETACH PARTITION ${quoteQualified(t.schema, t.name)}`,
    {
      verb: "alter",
      kind: "table",
      consumes: [id(t), id(parent)],
      phase: PHASE.detachPartition,
      lockClass: "accessExclusive",
    },
  );
}

/* --------------------------- defaults and comments --------------------------- */

function setDefault(d: StableId, expression: string, desired: SchemaIR): Statement {
  const c = d as StableId & { kind: "default" };
  const column: StableId = { kind: "column", schema: c.schema, table: c.table, name: c.name };
  return simple(
    `ALTER TABLE ${quoteQualified(c.schema, c.table)} ALTER COLUMN ${quoteIdent(c.name)} SET DEFAULT ${expression}`,
    {
      verb: "alter",
      kind: "default",
      produces: [id(d)],
      // The `evaluates` edges are what force a default naming a NEW enum label into the
      // segment after its `ADD VALUE` — the §1.3 bug, at the grain the default now has.
      consumes: [
        id(column),
        ...desired
          .outgoingEdges(d)
          .filter((e) => e.kind !== "owner")
          .map((e) => id(e.to)),
      ],
      phase: PHASE.setDefault,
      idempotent: true,
      // Since PG 11 a non-volatile default uses `attmissingval` and does not rewrite;
      // LK109 is attached in `addColumn`, where the volatility question actually arises.
      lockClass: "accessExclusive",
    },
  );
}

/** `COMMENT ON … IS NULL` is how PostgreSQL spells "remove the comment". */
function commentStatement(cid: StableId, text: string | null): Statement {
  const target = parseId((cid as StableId & { kind: "comment" }).target);
  const literal = text === null ? "NULL" : quoteLiteral(text);
  const [object, consumes] = commentTarget(target);
  return simple(`COMMENT ON ${object} IS ${literal}`, {
    verb: text === null ? "drop" : "alter",
    kind: "comment",
    ...(text === null ? { destroys: [id(cid)] } : { produces: [id(cid)] }),
    consumes,
    phase: PHASE.comment,
    lockClass: "none",
    // `COMMENT ON` is a pure catalog write and re-running it is a no-op, which is what
    // keeps a `txmode none` file TX201-clean when it carries one.
    idempotent: true,
  });
}

function commentTarget(target: StableId): [string, string[]] {
  switch (target.kind) {
    case "schema":
      return [`SCHEMA ${quoteIdent(target.schema)}`, [id(target)]];
    case "table":
      return [`TABLE ${quoteQualified(target.schema, target.name)}`, [id(target)]];
    case "column":
      return [
        `COLUMN ${quoteQualified(target.schema, target.table)}.${quoteIdent(target.name)}`,
        [id(target), id({ kind: "table", schema: target.schema, name: target.table })],
      ];
    case "constraint":
      return [
        `CONSTRAINT ${quoteIdent(target.name)} ON ${quoteQualified(target.schema, target.table)}`,
        [id(target), id({ kind: "table", schema: target.schema, name: target.table })],
      ];
    case "index":
      return [`INDEX ${quoteQualified(target.schema, target.name)}`, [id(target)]];
    case "type":
      return [`TYPE ${quoteQualified(target.schema, target.name)}`, [id(target)]];
    case "sequence":
      return [`SEQUENCE ${quoteQualified(target.schema, target.name)}`, [id(target)]];
    default:
      throw new Error(`no COMMENT ON syntax for ${target.kind}`);
  }
}

function sequenceDDL(sid: StableId, p: SequencePayload, mode: "create" | "alter", includeOwnedBy = true): string {
  const name = quoteQualified(idSchema(sid), (sid as { name: string }).name);
  const head = mode === "create" ? `CREATE SEQUENCE IF NOT EXISTS ${name}` : `ALTER SEQUENCE ${name}`;
  const body = `${head} AS ${p.dataType} INCREMENT BY ${p.increment} MINVALUE ${p.minValue} MAXVALUE ${p.maxValue} START WITH ${p.start} CACHE ${p.cache} ${p.cycle ? "CYCLE" : "NO CYCLE"}`;
  if (!includeOwnedBy) return body;
  return `${body} ${p.ownedBy ? ownedByClause(p.ownedBy) : "OWNED BY NONE"}`;
}

function ownedByClause(encodedColumn: string): string {
  const c = parseId(encodedColumn);
  if (c.kind !== "column") return "OWNED BY NONE";
  return `OWNED BY ${quoteQualified(c.schema, c.table)}.${quoteIdent(c.name)}`;
}

interface AddConstraintContext {
  /** created by THIS plan: nothing can be looking at it, and there are no rows */
  readonly onFreshTable: boolean;
  /** `probeEmptiness` said the existing table has no rows — suppresses MF, never LK */
  readonly provenEmpty: boolean;
  readonly noSafeRewrite: boolean;
  /** the caller can carry a `txmode none` companion file (design/06 §3.5 row 6) */
  readonly concurrent: boolean;
}

/**
 * A `pg_get_constraintdef` we are willing to rebuild as a `CREATE UNIQUE INDEX`.
 *
 * Deliberately narrow. `PRIMARY KEY (a, b)`, `UNIQUE (a)`, `UNIQUE NULLS NOT DISTINCT (a)`
 * and an `INCLUDE` list, and nothing else: a `DEFERRABLE`, a `WITH (fillfactor = …)`, a
 * `USING INDEX TABLESPACE` or an expression containing parentheses all fall through to
 * the literal `ADD CONSTRAINT`. The rewrite has to land on *byte-identical* catalog state
 * or D6 refuses the plan, and guessing at a definition grammar is how that stops being
 * true on a version we did not test.
 */
const PK_UNIQUE_DEF = /^(PRIMARY KEY|UNIQUE(?: NULLS NOT DISTINCT)?)\s*\(([^()]*)\)(?:\s+INCLUDE\s*\(([^()]*)\))?$/;

interface RebuildableUnique {
  readonly primary: boolean;
  readonly nullsNotDistinct: boolean;
  readonly columns: string;
  readonly include: string | null;
}

function rebuildableUnique(definition: string): RebuildableUnique | null {
  const m = PK_UNIQUE_DEF.exec(definition.trim());
  if (m === null) return null;
  const head = m[1]!;
  return {
    primary: head.startsWith("PRIMARY"),
    nullsNotDistinct: head.includes("NULLS NOT DISTINCT"),
    columns: m[2]!.trim(),
    include: m[3] === undefined ? null : m[3].trim(),
  };
}

function addConstraint(f: Fact, desired: SchemaIR, ctx: AddConstraintContext): Statement[] {
  const { onFreshTable, noSafeRewrite } = ctx;
  // design/06 §3.4: the MF family is `error` "unless the table is proven empty".
  const mayFail = !onFreshTable && !ctx.provenEmpty;
  const p = f.payload as unknown as ConstraintPayload;
  const c = f.id as StableId & { kind: "constraint" };
  const table = quoteQualified(c.schema, c.table);
  const refs = desired.outgoingEdges(f.id).map((e) => id(e.to));
  const uniquenessRefs = p.contype === "f" ? uniquenessProviders(desired, f.id) : [];
  const base = {
    verb: "alter" as const,
    kind: "constraint",
    produces: [id(f.id)],
    consumes: [id({ kind: "table", schema: c.schema, name: c.table }), ...refs, ...uniquenessRefs],
    destroys: [] as string[],
    releases: [] as string[],
    transactionality: "transactional" as const,
    idempotent: false,
    dataLoss: "none" as const,
    rewrite: false,
    phase: p.contype === "f" ? PHASE.addForeignKey : PHASE.addConstraint,
  };

  // §3.5 lock-safe rewriting: a validated FK/CHECK is emitted as
  // ADD … NOT VALID + VALIDATE, which converges on the same catalog state
  // while holding ACCESS EXCLUSIVE only for the (instant) catalog write.
  //
  // MF106 rides on the ADD half, not the VALIDATE: the ADD is where the plan commits to
  // a predicate the existing rows may violate, and it is the statement a reviewer has to
  // acknowledge. LK105/LK106 are what the rewrite ITSELF prevents, so they are recorded
  // only when `--no-safe-rewrite` puts the literal form back (see the fall-through).
  if ((p.contype === "f" || p.contype === "c") && p.validated && !noSafeRewrite) {
    return [
      {
        ...base,
        sql: `ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdent(c.name)} ${p.definition} NOT VALID`,
        lockClass: "accessExclusive",
        hazards: mayFail ? ["MF106"] : [],
      },
      {
        ...base,
        sql: `ALTER TABLE ${table} VALIDATE CONSTRAINT ${quoteIdent(c.name)}`,
        // the constraint leads: `consumes[0]` is what a reader (and the oracle
        // harness) treats as the statement's subject, and this statement is
        // about the constraint, not about its table
        consumes: [id(f.id), ...base.consumes],
        produces: [],
        lockClass: "shareUpdateExclusive",
        idempotent: true,
        hazards: [],
        phase: PHASE.validateConstraint,
      },
    ];
  }
  /* §3.5 row 6: ADD PRIMARY KEY / UNIQUE →
   *   ALTER TABLE … DROP CONSTRAINT IF EXISTS c      (robust prefix, §5.4 replay)
   *   DROP INDEX CONCURRENTLY IF EXISTS c            (robust prefix)
   *   CREATE UNIQUE INDEX CONCURRENTLY c ON …        (SHARE UPDATE EXCLUSIVE, not AE)
   *   ALTER TABLE … ADD CONSTRAINT c … USING INDEX c (instant catalog write)
   *
   * PostgreSQL names a constraint's backing index after the constraint, so the index and
   * the constraint share one name and the resulting catalog state is the same one the
   * literal `ADD CONSTRAINT` would have produced — which is what D6 and D10 check.
   *
   * The two `IF EXISTS` prefixes are why all four are marked idempotent: a `txmode none`
   * file resumes at statement 0 (§5.4), and from the top the group is replayable — the
   * DROP CONSTRAINT takes its own index with it, so the DROP INDEX after it can never hit
   * "cannot drop index … because constraint … requires it".
   */
  if ((p.contype === "p" || p.contype === "u") && !onFreshTable && !noSafeRewrite && ctx.concurrent) {
    const spec = rebuildableUnique(p.definition);
    if (spec !== null) {
      const idx = quoteQualified(c.schema, c.name);
      const bare = quoteIdent(c.name);
      const concurrentBase = { ...base, idempotent: true, stage: "concurrent" as const };
      return [
        {
          ...concurrentBase,
          sql: `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${bare}`,
          verb: "drop",
          produces: [],
          consumes: [id({ kind: "table", schema: c.schema, name: c.table })],
          lockClass: "accessExclusive",
          hazards: [],
          phase: PHASE.dropConstraint,
        },
        {
          ...concurrentBase,
          sql: `DROP INDEX CONCURRENTLY IF EXISTS ${idx}`,
          verb: "drop",
          produces: [],
          consumes: [],
          transactionality: "nonTransactional",
          lockClass: "shareUpdateExclusive",
          hazards: [],
          // After the DROP CONSTRAINT above, never before it — see the phase's own note.
          phase: PHASE.dropIndexConcurrently,
        },
        {
          ...concurrentBase,
          sql:
            `CREATE UNIQUE INDEX CONCURRENTLY ${bare} ON ${table} ` +
            `USING btree (${spec.columns})` +
            (spec.include === null ? "" : ` INCLUDE (${spec.include})`) +
            (spec.nullsNotDistinct ? " NULLS NOT DISTINCT" : ""),
          verb: "create",
          kind: "index",
          // The index is not a fact of its own (the extractor filters constraint-backed
          // indexes out), so it produces the CONSTRAINT's key: that is what makes the
          // `USING INDEX` statement below depend on this one.
          produces: [`${id(f.id)}#index`],
          consumes: [id({ kind: "table", schema: c.schema, name: c.table })],
          transactionality: "nonTransactional",
          lockClass: "shareUpdateExclusive",
          hazards: mayFail ? ["MF101"] : [],
          phase: PHASE.createIndex,
        },
        {
          ...concurrentBase,
          sql:
            `ALTER TABLE ${table} ADD CONSTRAINT ${bare} ` +
            `${spec.primary ? "PRIMARY KEY" : "UNIQUE"} USING INDEX ${bare}`,
          consumes: [...base.consumes, `${id(f.id)}#index`],
          lockClass: "accessExclusive",
          hazards: [],
          phase: PHASE.addConstraint,
        },
      ];
    }
  }

  const suffix = p.validated ? "" : " NOT VALID";
  const hazards: string[] = [];
  if (!onFreshTable) {
    // A PK/UNIQUE builds its index under ACCESS EXCLUSIVE (LK104) even on an empty table,
    // and fails outright if the column is not already unique (MF101) unless it is. §3.5's
    // safe form — CREATE UNIQUE INDEX CONCURRENTLY + ADD CONSTRAINT … USING INDEX — is
    // taken above when the caller can carry a second file; reaching here means it could
    // not, or `--no-safe-rewrite` asked for the literal diff, or the definition is one
    // `rebuildableUnique` refuses to reconstruct. Then the hazard is the honest answer.
    if (p.contype === "p" || p.contype === "u") hazards.push("LK104");
    if (p.contype === "x") hazards.push("LK104");
    if (mayFail && (p.contype === "p" || p.contype === "u")) hazards.push("MF101");
    // Only reachable with `--no-safe-rewrite`; the default path above never gets here
    // with `validated` set, which is exactly the point of these two codes.
    if (p.validated && p.contype === "f") hazards.push("LK105");
    if (p.validated && p.contype === "c") hazards.push("LK106");
    if (mayFail && p.validated && (p.contype === "f" || p.contype === "c")) hazards.push("MF106");
  }
  return [
    {
      ...base,
      sql: `ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdent(c.name)} ${p.definition}${suffix}`,
      lockClass: "accessExclusive",
      hazards,
    },
  ];
}

/**
 * Whatever supplies the uniqueness a FOREIGN KEY on `fk` binds to.
 *
 * On the ADD side it is an ordering requirement ("there is no unique constraint
 * matching given keys for referenced table"); on the DROP side it is the mirror
 * image - dropping the PK/UNIQUE while an FK still points at it fails with
 * "cannot drop constraint … because other objects depend on it". `pg_depend` on the
 * target TABLE implies neither, so the relationship is synthesized here and used by
 * both directions.
 */
function uniquenessProviders(ir: SchemaIR, fk: StableId): string[] {
  return ir
    .outgoingEdges(fk)
    .filter((e) => e.kind === "depends" && e.to.kind === "table")
    .flatMap((e) => ir.childrenOf(e.to))
    .filter(
      (x) =>
        (x.id.kind === "constraint" && (x.payload["contype"] === "p" || x.payload["contype"] === "u")) ||
        (x.id.kind === "index" && x.payload["unique"] === true),
    )
    .map((x) => id(x.id));
}

function validateConstraint(f: Fact): Statement {
  const c = f.id as StableId & { kind: "constraint" };
  return simple(`ALTER TABLE ${quoteQualified(c.schema, c.table)} VALIDATE CONSTRAINT ${quoteIdent(c.name)}`, {
    verb: "alter",
    kind: "constraint",
    consumes: [id(f.id)],
    lockClass: "shareUpdateExclusive",
    idempotent: true,
    phase: PHASE.validateConstraint,
  });
}

function dropConstraint(f: Fact, current: SchemaIR): Statement {
  const c = f.id as StableId & { kind: "constraint" };
  const p = f.payload as unknown as ConstraintPayload;
  const referenced = current
    .outgoingEdges(f.id)
    .filter((e) => e.kind === "depends" || e.kind === "evaluates")
    .map((e) => id(e.to));
  return {
    sql: `ALTER TABLE ${quoteQualified(c.schema, c.table)} DROP CONSTRAINT IF EXISTS ${quoteIdent(c.name)}`,
    verb: "drop",
    kind: "constraint",
    produces: [],
    consumes: [],
    destroys: [id(f.id)],
    // Dropping the constraint is what stops this table referencing the target,
    // so it must precede the target's destruction — including the destruction of
    // the PK/UNIQUE that provides the uniqueness this FK binds to.
    releases: [
      id({ kind: "table", schema: c.schema, name: c.table }),
      ...referenced,
      ...(p.contype === "f" ? uniquenessProviders(current, f.id) : []),
    ],
    transactionality: "transactional",
    lockClass: "accessExclusive",
    idempotent: true,
    dataLoss: "none",
    rewrite: false,
    hazards: p.contype === "p" || p.contype === "u" ? ["DS106"] : [],
    phase: PHASE.dropConstraint,
  };
}

/** `CREATE [UNIQUE] INDEX <rest>` → the same with `CONCURRENTLY`, or null if unrecognised. */
const INDEX_HEAD = /^CREATE\s+(UNIQUE\s+)?INDEX\s+/i;

function concurrentIndexSql(sql: string): string | null {
  const m = INDEX_HEAD.exec(sql);
  if (m === null) return null;
  return `CREATE ${m[1] ? "UNIQUE " : ""}INDEX CONCURRENTLY ${sql.slice(m[0].length)}`;
}

/**
 * design/06 §3.5 row 1 — `CREATE INDEX` becomes
 * `DROP INDEX CONCURRENTLY IF EXISTS x` + `CREATE INDEX CONCURRENTLY x`, in a
 * `txmode none` file.
 *
 * The `DROP … IF EXISTS` prefix is Squawk's `prefer-robust-stmts`, and it is what makes
 * the pair replayable: design/06 §5.4's resume restarts a `txmode none` file at statement
 * 0, so the prefix both cleans up the INVALID index a killed build leaves behind and
 * makes the CIC's second execution legal. That is the whole justification for marking the
 * CIC `idempotent` — the claim is about the file from its top, which is the only place a
 * resume can start.
 *
 * Ordering between the two comes from `phase` (dropIndex 15 < createIndex 60), not from a
 * synthetic produces/destroys pair: giving the prefix `destroys: [index:…]` would turn
 * every consumer of that index (a `COMMENT ON INDEX`, say) into an edge back INTO the
 * prefix and close a cycle.
 */
function createIndex(
  f: Fact,
  desired: SchemaIR,
  extraHazards: readonly string[] = [],
  concurrent = false,
): Statement[] {
  const p = f.payload as unknown as IndexPayload;
  const i = f.id as StableId & { kind: "index" };
  // A replacement STRING makes `$&`, `$\u0060`, `$'` and `$$` expansion patterns, and `$`
  // is a legal identifier character: an index named `x$&y` produced malformed DDL,
  // and one named `%ID%x` created an index literally called "idx%ID%x". A
  // replacement FUNCTION has no such syntax.
  const sql = p.definition.replace("%ID%", () => quoteIdent(i.name));
  const base = {
    verb: "create" as const,
    kind: "index",
    produces: [id(f.id)],
    consumes: desired.outgoingEdges(f.id).map((e) => id(e.to)),
    destroys: [] as string[],
    releases: [] as string[],
    dataLoss: "none" as const,
    rewrite: false,
    phase: PHASE.createIndex,
  };
  const cic = concurrent ? concurrentIndexSql(sql) : null;
  if (cic === null) {
    return [
      {
        ...base,
        sql,
        transactionality: "transactional",
        lockClass: "share",
        idempotent: false,
        // LK101 is what the rewrite PREVENTS, so it rides on the literal form only —
        // reachable under `--no-safe-rewrite`, on a single-file caller, and wherever the
        // rewrite is refused (a partitioned parent, a definition we will not rewrite).
        hazards: ["LK101", ...extraHazards],
      },
    ];
  }
  return [
    {
      ...base,
      sql: `DROP INDEX CONCURRENTLY IF EXISTS ${quoteQualified(i.schema, i.name)}`,
      verb: "drop",
      produces: [],
      consumes: [],
      transactionality: "nonTransactional",
      lockClass: "shareUpdateExclusive",
      idempotent: true,
      hazards: [],
      phase: PHASE.dropIndex,
      stage: "concurrent",
    },
    {
      ...base,
      sql: cic,
      transactionality: "nonTransactional",
      lockClass: "shareUpdateExclusive",
      idempotent: true,
      hazards: [...extraHazards],
      stage: "concurrent",
    },
  ];
}

function dropIndex(f: Fact): Statement {
  const i = f.id as StableId & { kind: "index" };
  return {
    sql: `DROP INDEX IF EXISTS ${quoteQualified(i.schema, i.name)}`,
    verb: "drop",
    kind: "index",
    produces: [],
    consumes: [],
    destroys: [id(f.id)],
    releases: f.parent ? [id(f.parent)] : [],
    transactionality: "transactional",
    lockClass: "accessExclusive",
    idempotent: true,
    dataLoss: "none",
    rewrite: false,
    hazards: ["LK102"],
    phase: PHASE.dropIndex,
  };
}

function alterColumn(
  before: Fact,
  after: Fact,
  desired: SchemaIR,
  diagnostics: Diagnostic[],
  emptyTables: ReadonlySet<string>,
): Statement[] {
  const b = before.payload as unknown as ColumnPayload;
  const a = after.payload as unknown as ColumnPayload;
  const c = after.id as StableId & { kind: "column" };
  const table = quoteQualified(c.schema, c.table);
  const col = quoteIdent(c.name);
  const out: Statement[] = [];
  const evaluates = evaluatesOf(desired, after.id);
  const mk = (sql: string, extra: Partial<Statement>): Statement =>
    simple(sql, {
      verb: "alter",
      kind: "column",
      consumes: [id(after.id), id({ kind: "table", schema: c.schema, name: c.table }), ...evaluates],
      phase: PHASE.alterColumn,
      ...extra,
    });

  if (b.type !== a.type || b.collation !== a.collation) {
    const collate = a.collation ? ` COLLATE ${quoteIdent(a.collation)}` : "";
    out.push(
      mk(`ALTER TABLE ${table} ALTER COLUMN ${col} TYPE ${a.type}${collate} USING ${col}::${a.type}`, {
        rewrite: true,
        hazards: ["LK108", "MF105", "BC103"],
      }),
    );
  }
  out.push(...notNullTransition(before, after, desired, mk, emptyTables));
  // A generated column cannot be converted in place: PostgreSQL offers only
  // DROP EXPRESSION (stored -> plain), never plain -> stored, and PG18's VIRTUAL
  // (`attgenerated = 'v'`) is not expressible by `columnClause` at all. Emitting
  // nothing here made the transition silently vanish from the plan.
  if (b.generated !== a.generated || a.generated === "v") {
    diagnostics.push({
      code: "unsupported_alter",
      severity: "error",
      message:
        `column ${c.schema}.${c.table}.${c.name}: generated ${b.generated ?? "none"} -> ` +
        `${a.generated ?? "none"} cannot be altered in place`,
      subject: id(after.id),
    });
  }
  if (b.identity !== a.identity) {
    out.push(
      a.identity === null
        ? mk(`ALTER TABLE ${table} ALTER COLUMN ${col} DROP IDENTITY IF EXISTS`, { idempotent: true })
        : b.identity === null
          ? mk(
              `ALTER TABLE ${table} ALTER COLUMN ${col} ADD GENERATED ${a.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`,
              { hazards: ["LK110"] },
            )
          : mk(
              `ALTER TABLE ${table} ALTER COLUMN ${col} SET GENERATED ${a.identity === "a" ? "ALWAYS" : "BY DEFAULT"}`,
              { idempotent: true },
            ),
    );
  }
  return out;
}

/**
 * `SET NOT NULL`, lock-safely — design/06 §3.5 rows 4 and 5, and the `convalidated` half
 * of §3.3's AS BUILT gap.
 *
 * A bare `ALTER COLUMN … SET NOT NULL` holds ACCESS EXCLUSIVE for a full sequential scan.
 * Both safe forms below hold it only for a catalog write and do the scan under
 * SHARE UPDATE EXCLUSIVE, which reads and writes can pass:
 *
 *  - **PG >= 18** — `ADD CONSTRAINT … NOT NULL <col> NOT VALID`, then
 *    `VALIDATE CONSTRAINT`. One catalog object, and `NOT VALID` is a state the catalog
 *    can hold, which is exactly what `notNullValidated` models;
 *  - **PG 15–17** — `ADD CONSTRAINT <tmp> CHECK (<col> IS NOT NULL) NOT VALID`, then
 *    `VALIDATE`, then `SET NOT NULL` (which PostgreSQL performs WITHOUT a scan, because
 *    the validated CHECK already proves it), then `DROP CONSTRAINT <tmp>`. The temporary
 *    constraint is named through `chooseConstraintName`, so a schema that already has a
 *    `<table>_<column>_not_null` gets `…_not_null1` — PostgreSQL's own rule, and the
 *    difference between a plan that applies and "constraint already exists".
 *
 * The choice is made per column from the CATALOG, never from `server_version_num`: the
 * desired side's `notNullConstraint` is non-null iff the server that produced this IR
 * catalogues NOT NULL constraints. A back-ported feature therefore needs no version table
 * — the same gate `Q_COLUMNS` uses.
 */
function notNullTransition(
  before: Fact,
  after: Fact,
  desired: SchemaIR,
  mk: (sql: string, extra: Partial<Statement>) => Statement,
  emptyTables: ReadonlySet<string>,
): Statement[] {
  const b = before.payload as unknown as ColumnPayload;
  const a = after.payload as unknown as ColumnPayload;
  const c = after.id as StableId & { kind: "column" };
  const table = quoteQualified(c.schema, c.table);
  const col = quoteIdent(c.name);
  const out: Statement[] = [];
  const catalogued = a.notNullConstraint !== null;
  // design/06 §3.4: MF104 is `error` unless the table is proven empty. `probeEmptiness`
  // is the only thing that can prove it, and offline it proves nothing.
  const mf104 = emptyTables.has(id({ kind: "table", schema: c.schema, name: c.table })) ? [] : ["MF104"];

  if (b.notNull && !a.notNull) {
    out.push(mk(`ALTER TABLE ${table} ALTER COLUMN ${col} DROP NOT NULL`, { idempotent: true }));
    return out;
  }

  if (!b.notNull && a.notNull) {
    const wanted = notNullConstraintName(c, a);
    if (catalogued && wanted !== null) {
      out.push(
        mk(`ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdent(wanted)} NOT NULL ${col} NOT VALID`, {
          kind: "constraint",
          idempotent: false,
          hazards: mf104,
        }),
      );
      if (a.notNullValidated !== false) {
        out.push(
          mk(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${quoteIdent(wanted)}`, {
            kind: "constraint",
            lockClass: "shareUpdateExclusive",
            idempotent: true,
            phase: PHASE.validateConstraint,
          }),
        );
      }
      return out;
    }
    // PG 15–17: the CHECK detour. The temporary constraint exists only inside this plan,
    // so its name never reaches the IR — but it does reach the server, which is why it
    // has to be a name the server would have been free to pick.
    const tmp = chooseConstraintName(
      c.table,
      c.name,
      "not_null",
      constraintNamesOn(desired, { kind: "table", schema: c.schema, name: c.table }),
    );
    out.push(
      mk(`ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdent(tmp)} CHECK (${col} IS NOT NULL) NOT VALID`, {
        kind: "constraint",
        hazards: mf104,
      }),
      mk(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${quoteIdent(tmp)}`, {
        kind: "constraint",
        lockClass: "shareUpdateExclusive",
        idempotent: true,
        phase: PHASE.validateConstraint,
      }),
      mk(`ALTER TABLE ${table} ALTER COLUMN ${col} SET NOT NULL`, {
        idempotent: true,
        phase: PHASE.validateConstraint,
      }),
      mk(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${quoteIdent(tmp)}`, {
        kind: "constraint",
        verb: "drop",
        idempotent: true,
        phase: PHASE.validateConstraint,
      }),
    );
    return out;
  }

  if (!a.notNull) return out;

  /* ---- already NOT NULL on both sides: name and validity are what can differ ---- */

  /*
   * PG >= 18 catalogues NOT NULL as a `pg_constraint` row, so its NAME is part of the
   * schema and `pg_dump` prints it whenever it is not the default. Reaching the desired
   * name is one catalog-only `RENAME CONSTRAINT` — never a DROP + ADD, which would cost
   * the full-table verification scan the column already paid for.
   *
   * On PG < 18 both sides are `null` and nothing is emitted, which is why the same
   * schema converges identically on 15/16/17.
   */
  const wantNotNullName = notNullConstraintName(c, a);
  const haveNotNullName = notNullConstraintName(c, b);
  if (wantNotNullName !== null && haveNotNullName !== null && haveNotNullName !== wantNotNullName) {
    out.push(
      mk(`ALTER TABLE ${table} RENAME CONSTRAINT ${quoteIdent(haveNotNullName)} TO ${quoteIdent(wantNotNullName)}`, {
        kind: "constraint",
        hazards: ["BC104"],
      }),
    );
  }
  const name = wantNotNullName ?? haveNotNullName;
  if (b.notNullValidated === false && a.notNullValidated === true && name !== null) {
    out.push(
      mk(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${quoteIdent(name)}`, {
        kind: "constraint",
        lockClass: "shareUpdateExclusive",
        idempotent: true,
        phase: PHASE.validateConstraint,
      }),
    );
  } else if (b.notNullValidated === true && a.notNullValidated === false && name !== null) {
    // PostgreSQL cannot un-validate: the only route is DROP + ADD NOT VALID, and dropping
    // the NOT NULL first is what makes the re-add legal.
    out.push(
      mk(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${quoteIdent(name)}`, {
        kind: "constraint",
        verb: "drop",
        idempotent: true,
      }),
      mk(`ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdent(name)} NOT NULL ${col} NOT VALID`, {
        kind: "constraint",
        hazards: mf104,
      }),
    );
  }
  return out;
}
