import type { Diagnostic } from "../catalog/extract.js";
import { GENERATED_NAME } from "../catalog/payloads.js";
import type {
  ColumnPayload,
  ConstraintPayload,
  IndexPayload,
  SequencePayload,
  TablePayload,
} from "../catalog/payloads.js";
import type { Fact, SchemaIR } from "../ir/fact.js";
import { encodeId, parseId, type StableId } from "../ir/stable-id.js";
import { defaultNotNullName, quoteIdent, quoteLiteral, quoteQualified } from "../sql/ident.js";
import type { Delta } from "./delta.js";
import type { DiffResult } from "./diff.js";
import { labelsOf } from "./diff.js";
import { PHASE, type Statement } from "./statement.js";

export interface BuildResult {
  readonly statements: Statement[];
  readonly diagnostics: Diagnostic[];
}

const id = encodeId;

function evaluatesOf(ir: SchemaIR, subject: StableId): string[] {
  return ir
    .outgoingEdges(subject)
    .filter((e) => e.kind === "evaluates")
    .map((e) => id(e.to));
}

/* -------------------------- column clause -------------------------- */

export function columnClause(colId: StableId & { kind: "column" }, p: ColumnPayload): string {
  const bits = [quoteIdent(colId.name), p.type];
  if (p.collation) bits.push(`COLLATE ${quoteIdent(p.collation)}`);
  if (p.generated === "s" && p.default) {
    bits.push(`GENERATED ALWAYS AS (${p.default}) STORED`);
  } else if (p.identity) {
    bits.push(`GENERATED ${p.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`);
  } else if (p.default !== null) {
    bits.push(`DEFAULT ${p.default}`);
  }
  // A generated name is what an unnamed `NOT NULL` produces anyway (PG >= 18), so it is
  // never spelled out — spelling it would make the DDL depend on a name we derived.
  if (p.notNull) {
    bits.push(
      p.notNullConstraint !== null && p.notNullConstraint !== GENERATED_NAME
        ? `CONSTRAINT ${quoteIdent(p.notNullConstraint)} NOT NULL`
        : "NOT NULL",
    );
  }
  return bits.join(" ");
}

/**
 * The name the NOT NULL constraint carries in the database, resolving `%GENERATED%`
 * against the column's identity. `null` when the server does not catalogue one.
 */
function notNullConstraintName(c: StableId & { kind: "column" }, p: ColumnPayload): string | null {
  if (!p.notNull || p.notNullConstraint === null) return null;
  return p.notNullConstraint === GENERATED_NAME ? defaultNotNullName(c.table, c.name) : p.notNullConstraint;
}

/* ---------------------------- the builder --------------------------- */

export function buildStatements(diff: DiffResult, desired: SchemaIR): BuildResult {
  const statements: Statement[] = [];
  const diagnostics: Diagnostic[] = [...diff.diagnostics];
  const current = diff.current;

  const createdTables = new Set(
    diff.deltas.filter((d) => d.op === "create" && d.id.kind === "table").map((d) => id(deltaId(d))),
  );
  const droppedTables = new Set(
    diff.deltas.filter((d) => d.op === "drop" && d.id.kind === "table").map((d) => id(deltaId(d))),
  );
  const createdTypes = new Set(
    diff.deltas.filter((d) => d.op === "create" && d.id.kind === "type").map((d) => id(deltaId(d))),
  );
  const parentTableId = (x: StableId): string | null =>
    x.kind === "column" || x.kind === "constraint"
      ? id({ kind: "table", schema: x.schema, name: x.table })
      : null;
  const indexTableId = (ir: SchemaIR, x: StableId): string | null => {
    const f = ir.get(x);
    return f?.parent ? id(f.parent) : null;
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
    out.push(id({ kind: "schema", schema: subject.schema }));
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
      statements.push(simple(
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
      ));
    } else if (from.kind === "index" && to.kind === "index") {
      statements.push(simple(
        `ALTER INDEX ${quoteQualified(from.schema, from.name)} RENAME TO ${quoteIdent(to.name)}`,
        {
          verb: "alter",
          kind: "index",
          produces: [id(to)],
          consumes: [id({ kind: "schema", schema: to.schema })],
          destroys: [id(from)],
          hazards: ["BC104"],
          phase: PHASE.rename,
        },
      ));
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
            statements.push(simple(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(f.id.schema)}`, {
              verb: "create",
              kind: "schema",
              produces: [id(f.id)],
              phase: PHASE.createSchema,
              lockClass: "none",
              idempotent: true,
            }));
            break;
          case "type": {
            const labels = labelsOf(desired, f.id);
            statements.push(simple(
              `CREATE TYPE ${quoteQualified(f.id.schema, f.id.name)} AS ENUM (${labels.map(quoteLiteral).join(", ")})`,
              {
                verb: "create",
                kind: "type",
                produces: [
                  id(f.id),
                  ...labels.map((l) => id({ kind: "enumLabel", schema: f.id.schema, type: (f.id as { name: string }).name, name: l })),
                ],
                consumes: [id({ kind: "schema", schema: f.id.schema })],
                phase: PHASE.createType,
                lockClass: "none",
              },
            ));
            break;
          }
          case "sequence": {
            const p = f.payload as unknown as SequencePayload;
            // `CREATE SEQUENCE … OWNED BY t.id` CONSUMES the column that the
            // CREATE TABLE produces, so the table gets ordered first - but a
            // `serial` table's own DEFAULT `nextval('t_id_seq')` needs the
            // sequence to exist, and the plan died with `relation "t_id_seq"
            // does not exist`. Ownership is therefore a separate statement:
            // the CREATE consumes only its schema, the ALTER consumes the column.
            statements.push(simple(sequenceDDL(f.id, p, "create", false), {
              verb: "create",
              kind: "sequence",
              produces: [id(f.id)],
              consumes: [id({ kind: "schema", schema: f.id.schema })],
              phase: PHASE.createSequence,
              lockClass: "none",
              idempotent: true,
            }));
            if (p.ownedBy) {
              statements.push(simple(
                `ALTER SEQUENCE ${quoteQualified(f.id.schema, f.id.name)} ${ownedByClause(p.ownedBy)}`,
                {
                  verb: "alter",
                  kind: "sequence",
                  consumes: [id(f.id), p.ownedBy],
                  phase: PHASE.alterSequence,
                  lockClass: "none",
                  idempotent: true,
                },
              ));
            }
            break;
          }
          case "table": {
            const p = f.payload as unknown as TablePayload;
            const cols = desired
              .childrenOf(f.id)
              .filter((c) => c.id.kind === "column")
              .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
            const body = cols.map((c) =>
              columnClause(c.id as StableId & { kind: "column" }, c.payload as unknown as ColumnPayload),
            );
            const unlogged = p.persistence === "u" ? "UNLOGGED " : "";
            statements.push({
              sql: `CREATE ${unlogged}TABLE ${quoteQualified(f.id.schema, f.id.name)} (\n  ${body.join(",\n  ")}\n)`,
              verb: "create",
              kind: "table",
              produces: [id(f.id), ...cols.map((c) => id(c.id))],
              consumes: [
                id({ kind: "schema", schema: f.id.schema }),
                ...cols.flatMap((c) =>
                  desired.outgoingEdges(c.id).filter((e) => e.kind === "depends" || e.kind === "evaluates").map((e) => id(e.to)),
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
              statements.push(simple(
                `ALTER TABLE ${quoteQualified(f.id.schema, f.id.name)} ENABLE ROW LEVEL SECURITY`,
                { verb: "alter", kind: "table", consumes: [id(f.id)], phase: PHASE.alterTable },
              ));
            }
            break;
          }
          case "column": {
            if (createdTables.has(parentTableId(f.id)!)) break; // folded into CREATE TABLE
            const p = f.payload as unknown as ColumnPayload;
            const c = f.id as StableId & { kind: "column" };
            const hazards: string[] = [];
            if (p.notNull && p.default === null && !p.identity && p.generated !== "s") hazards.push("MF103");
            statements.push({
              sql: `ALTER TABLE ${quoteQualified(c.schema, c.table)} ADD COLUMN IF NOT EXISTS ${columnClause(c, p)}`,
              verb: "alter",
              kind: "column",
              produces: [id(f.id)],
              consumes: [
                id({ kind: "table", schema: c.schema, name: c.table }),
                ...desired.outgoingEdges(f.id).filter((e) => e.kind === "depends" || e.kind === "evaluates").map((e) => id(e.to)),
              ],
              destroys: [],
              releases: [],
              transactionality: "transactional",
              lockClass: "accessExclusive",
              idempotent: true,
              dataLoss: "none",
              // LK109: only a VOLATILE default rewrites. A constant default has
              // used attmissingval since PG 11 — we do not inherit pg-delta's
              // over-conservative flag here.
              rewrite: p.generated === "s" || !!p.identity,
              hazards,
              phase: PHASE.addColumn,
            });
            break;
          }
          case "constraint": {
            // A constraint on a table THIS plan creates cannot fail on existing
            // data and cannot block anybody: the table is provably empty
            // (design/06 §3.4, "unless the table is proven empty").
            statements.push(...addConstraint(f, desired, createdTables.has(parentTableId(f.id)!)));
            break;
          }
          case "index": {
            statements.push(createIndex(f, desired));
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
            statements.push(...alterColumn(before, after, desired, diagnostics));
            break;
          case "index":
            // PostgreSQL cannot ALTER an index's structure: drop and rebuild.
            statements.push(dropIndex(before), createIndex(after, desired));
            break;
          case "constraint": {
            const b = before.payload as unknown as ConstraintPayload;
            const a = after.payload as unknown as ConstraintPayload;
            if (b.definition === a.definition && !b.validated && a.validated) {
              statements.push(validateConstraint(after));
            } else {
              statements.push(dropConstraint(before, current), ...addConstraint(after, desired, false));
            }
            break;
          }
          case "table": {
            const b = before.payload as unknown as TablePayload;
            const a = after.payload as unknown as TablePayload;
            const t = after.id as StableId & { kind: "table" };
            if (b.persistence !== a.persistence) {
              statements.push(simple(
                `ALTER TABLE ${quoteQualified(t.schema, t.name)} SET ${a.persistence === "u" ? "UNLOGGED" : "LOGGED"}`,
                { verb: "alter", kind: "table", consumes: [id(t)], phase: PHASE.alterTable, hazards: ["LK112"], rewrite: true },
              ));
            }
            if (b.rowSecurity !== a.rowSecurity) {
              statements.push(simple(
                `ALTER TABLE ${quoteQualified(t.schema, t.name)} ${a.rowSecurity ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY`,
                { verb: "alter", kind: "table", consumes: [id(t)], phase: PHASE.alterTable },
              ));
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
            statements.push(simple(sequenceDDL(after.id, p, "alter"), {
              verb: "alter",
              kind: "sequence",
              consumes: [id(after.id), ...(p.ownedBy ? [p.ownedBy] : [])],
              phase: PHASE.alterSequence,
            }));
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
            statements.push(simple(`DROP SEQUENCE IF EXISTS ${quoteQualified(f.id.schema, (f.id as { name: string }).name)}`, {
              verb: "drop",
              kind: "sequence",
              destroys: [id(f.id)],
              releases: referencesHeldBy(current, f.id),
              phase: PHASE.dropSequence,
              dataLoss: "destructive",
              idempotent: true,
            }));
            break;
          case "type":
            statements.push(simple(`DROP TYPE IF EXISTS ${quoteQualified(f.id.schema, (f.id as { name: string }).name)}`, {
              verb: "drop",
              kind: "type",
              destroys: [id(f.id), ...current.descendantsOf(f.id).map((c) => id(c.id))],
              releases: referencesHeldBy(current, f.id),
              phase: PHASE.dropType,
              dataLoss: "destructive",
              idempotent: true,
              hazards: ["DS104"],
            }));
            break;
          case "schema":
            statements.push(simple(`DROP SCHEMA IF EXISTS ${quoteIdent(f.id.schema)}`, {
              verb: "drop",
              kind: "schema",
              destroys: [id(f.id)],
              phase: PHASE.dropSchema,
              dataLoss: "destructive",
              idempotent: true,
              hazards: ["DS101"],
            }));
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

function sequenceDDL(
  sid: StableId,
  p: SequencePayload,
  mode: "create" | "alter",
  includeOwnedBy = true,
): string {
  const name = quoteQualified(sid.schema, (sid as { name: string }).name);
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

function addConstraint(f: Fact, desired: SchemaIR, onFreshTable = false): Statement[] {
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
  if ((p.contype === "f" || p.contype === "c") && p.validated) {
    return [
      {
        ...base,
        sql: `ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdent(c.name)} ${p.definition} NOT VALID`,
        lockClass: "accessExclusive",
        hazards: [],
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
  const suffix = p.validated ? "" : " NOT VALID";
  return [
    {
      ...base,
      sql: `ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdent(c.name)} ${p.definition}${suffix}`,
      lockClass: "accessExclusive",
      hazards: !onFreshTable && (p.contype === "p" || p.contype === "u") ? ["LK104", "MF101"] : [],
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
  return simple(
    `ALTER TABLE ${quoteQualified(c.schema, c.table)} VALIDATE CONSTRAINT ${quoteIdent(c.name)}`,
    {
      verb: "alter",
      kind: "constraint",
      consumes: [id(f.id)],
      lockClass: "shareUpdateExclusive",
      idempotent: true,
      phase: PHASE.validateConstraint,
    },
  );
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

function createIndex(f: Fact, desired: SchemaIR): Statement {
  const p = f.payload as unknown as IndexPayload;
  const i = f.id as StableId & { kind: "index" };
  // A replacement STRING makes `$&`, `$\u0060`, `$'` and `$$` expansion patterns, and `$`
  // is a legal identifier character: an index named `x$&y` produced malformed DDL,
  // and one named `%ID%x` created an index literally called "idx%ID%x". A
  // replacement FUNCTION has no such syntax.
  const sql = p.definition.replace("%ID%", () => quoteIdent(i.name));
  return {
    sql,
    verb: "create",
    kind: "index",
    produces: [id(f.id)],
    consumes: desired.outgoingEdges(f.id).map((e) => id(e.to)),
    destroys: [],
    releases: [],
    transactionality: "transactional",
    lockClass: "share",
    idempotent: false,
    dataLoss: "none",
    rewrite: false,
    // LK101: a lock-safe rewrite to CREATE INDEX CONCURRENTLY (+ txmode none)
    // is the v1 behaviour; the spike reports the hazard and emits the literal form.
    hazards: ["LK101"],
    phase: PHASE.createIndex,
  };
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
  if (b.default !== a.default) {
    out.push(
      a.default === null
        ? mk(`ALTER TABLE ${table} ALTER COLUMN ${col} DROP DEFAULT`, { idempotent: true })
        : mk(`ALTER TABLE ${table} ALTER COLUMN ${col} SET DEFAULT ${a.default}`, { idempotent: true }),
    );
  }
  if (b.notNull !== a.notNull) {
    out.push(
      a.notNull
        ? mk(`ALTER TABLE ${table} ALTER COLUMN ${col} SET NOT NULL`, { idempotent: true, hazards: ["LK107", "MF104"] })
        : mk(`ALTER TABLE ${table} ALTER COLUMN ${col} DROP NOT NULL`, { idempotent: true }),
    );
  }
  /*
   * PG >= 18 catalogues NOT NULL as a `pg_constraint` row, so its NAME is part of the
   * schema and `pg_dump` prints it whenever it is not the default. Whatever the
   * transition above left behind carries the generated name, so reaching the desired
   * name is one catalog-only `RENAME CONSTRAINT` — never a DROP + ADD, which would cost
   * the full-table verification scan `SET NOT NULL` already paid for.
   *
   * On PG < 18 both sides are `null` and nothing is emitted, which is why the same
   * schema converges identically on 15/16/17.
   */
  const wantNotNullName = notNullConstraintName(c, a);
  if (wantNotNullName !== null) {
    const haveNotNullName = b.notNull ? notNullConstraintName(c, b) : defaultNotNullName(c.table, c.name);
    if (haveNotNullName !== null && haveNotNullName !== wantNotNullName) {
      out.push(
        mk(`ALTER TABLE ${table} RENAME CONSTRAINT ${quoteIdent(haveNotNullName)} TO ${quoteIdent(wantNotNullName)}`, {
          kind: "constraint",
          hazards: ["BC104"],
        }),
      );
    }
  }
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
