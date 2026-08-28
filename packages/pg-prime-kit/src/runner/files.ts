/**
 * The migrations directory, read the way design/06 §4.1–§4.2 specify it.
 *
 * Three things here are decisions rather than plumbing:
 *
 *  1. **Ordering comes from the files, not from a journal.** `(seq, name)`, resolved on
 *     every run. Duplicate `seq` is legal — two branches both numbered `0007` both apply
 *     (pgmigrate's insight, design/06 §4.1) — and there is no `_journal.json` to desync.
 *  2. **`-- pg-prime:stmt N` markers are the statement index, not the splitter.** Partial
 *     application resumes at a statement index; deriving that index by re-splitting the
 *     file at resume time would make correctness depend on splitter determinism across
 *     releases. The splitter is the FALLBACK for hand-written files, and taking it emits
 *     a diagnostic.
 *  3. **Directives are recognised only where the SQL lexer says "comment".** A line
 *     scanner would read `-- pg-prime:stmt 9` inside a `$$…$$` function body as a marker.
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic } from "../catalog/extract.js";
import type { Segment } from "../diff/order.js";
import type { LockClass } from "../diff/statement.js";
import type { Plan, PlanStatement } from "../plan/plan.js";
import { canonicalize, lexSql, splitStatements } from "../sql/statements.js";

/** `NNNN_name.sql`, with `name` restricted exactly as `plan.ts`'s `MIGRATION_NAME` is. */
export const MIGRATION_FILE: RegExp = /^(\d{4,})_([a-z0-9_]+)\.sql$/;

export type TxMode = "transactional" | "none" | "segmented";

export interface FileDirective {
  readonly name: string;
  readonly args: string;
  /** 1-based, for diagnostics */
  readonly line: number;
}

export interface FileDirectives {
  readonly migration: string | null;
  readonly plan: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly txmode: TxMode | null;
  readonly lockTimeout: string | null;
  readonly statementTimeout: string | null;
  readonly requiresPg: number | null;
  readonly checkpoint: boolean;
  readonly data: boolean;
  /** every directive as it was written, including the ones this release ignores */
  readonly all: readonly FileDirective[];
}

export interface FileStatement {
  readonly index: number;
  readonly sql: string;
  readonly lockClass: LockClass;
  readonly idempotent: boolean;
  readonly hazards: readonly string[];
  /** the segment the `-- pg-prime:segment` marker put it in, when there was one */
  readonly segment: number | null;
}

export interface MigrationFile {
  readonly id: string;
  readonly seq: number;
  readonly name: string;
  readonly path: string;
  readonly planPath: string | null;
  /** `sha256:<hex>` over the raw bytes of the `.sql` */
  readonly checksum: string;
  readonly text: string;
  readonly directives: FileDirectives;
  readonly statements: readonly FileStatement[];
  readonly statementSource: "markers" | "splitter";
  readonly plan: Plan | null;
  readonly txmode: TxMode;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ReadMigrationsResult {
  readonly files: readonly MigrationFile[];
  readonly diagnostics: readonly Diagnostic[];
}

const DIRECTIVE = /^--\s*pg-prime:([A-Za-z][A-Za-z0-9_-]*)[ \t]*(.*)$/;

interface Hit {
  readonly name: string;
  readonly args: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
}

/**
 * Every `-- pg-prime:` directive, with byte offsets, found through the lexer.
 *
 * The lexer classifies a `--` inside a string literal or a dollar-quoted body as part of
 * that literal, so this cannot mistake documentation inside a `plpgsql` body for a marker.
 */
export function findDirectives(text: string): Hit[] {
  const hits: Hit[] = [];
  let offset = 0;
  for (const seg of lexSql(text)) {
    if (seg.kind === "comment") {
      const m = DIRECTIVE.exec(seg.text.trimEnd());
      if (m) {
        // `line` is derived rather than counted alongside: the lexer walks bytes, not lines.
        const line = text.slice(0, offset).split("\n").length;
        hits.push({ name: m[1]!.toLowerCase(), args: (m[2] ?? "").trim(), start: offset, end: offset + seg.text.length, line });
      }
    }
    offset += seg.text.length;
  }
  return hits;
}

function parseTimeout(args: string): { lock: string | null; statement: string | null } {
  const lock = /(?:^|\s)lock=(\S+)/.exec(args)?.[1] ?? null;
  const statement = /(?:^|\s)statement=(\S+)/.exec(args)?.[1] ?? null;
  return { lock, statement };
}

const LOCK_CLASSES = new Set<string>([
  "accessExclusive", "shareRowExclusive", "share", "shareUpdateExclusive", "rowExclusive", "none",
]);

function parseStmtFlags(args: string): { index: number; lockClass: LockClass; idempotent: boolean; hazards: string[] } {
  const parts = args.split(/\s+/).filter(Boolean);
  const index = Number(parts[0]);
  let lockClass: LockClass = "accessExclusive";
  let idempotent = false;
  let hazards: string[] = [];
  for (const p of parts.slice(1)) {
    if (p.startsWith("lock=")) {
      const v = p.slice(5);
      if (LOCK_CLASSES.has(v)) lockClass = v as LockClass;
    } else if (p === "idempotent") idempotent = true;
    else if (p === "non-idempotent") idempotent = false;
    else if (p.startsWith("hazards=")) hazards = p.slice(8).split(",").filter(Boolean);
  }
  return { index, lockClass, idempotent, hazards };
}

/** Count top-level statements without canonicalising — used only for a diagnostic. */
function topLevelStatementCount(sql: string): number {
  let n = 0;
  for (const seg of lexSql(sql)) {
    if (seg.kind !== "code") continue;
    for (const c of seg.text) if (c === ";") n++;
  }
  const tail = canonicalize(lexSql(sql));
  return tail && !sql.trimEnd().endsWith(";") ? n + 1 : n;
}

const trimStatement = (s: string): string => s.trim().replace(/;\s*$/, "").trim();

export interface ParsedSql {
  readonly directives: FileDirectives;
  readonly statements: readonly FileStatement[];
  readonly statementSource: "markers" | "splitter";
  readonly diagnostics: readonly Diagnostic[];
}

/** Parse one migration `.sql`: header directives, then statements. */
export function parseMigrationSql(text: string, subject: string): ParsedSql {
  const hits = findDirectives(text);
  const diagnostics: Diagnostic[] = [];
  const all: FileDirective[] = hits.map((h) => ({ name: h.name, args: h.args, line: h.line }));

  const first = (name: string): Hit | undefined => hits.find((h) => h.name === name);
  const timeout = parseTimeout(first("timeout")?.args ?? "");
  const txmodeRaw = first("txmode")?.args ?? null;
  const txmode: TxMode | null =
    txmodeRaw === "transactional" || txmodeRaw === "none" || txmodeRaw === "segmented" ? txmodeRaw : null;
  if (txmodeRaw !== null && txmode === null) {
    diagnostics.push({
      code: "directive_unknown_txmode",
      severity: "error",
      subject,
      message: `-- pg-prime:txmode ${JSON.stringify(txmodeRaw)} is not one of transactional|none|segmented`,
    });
  }
  const requiresPgRaw = first("requires-pg")?.args;
  const directives: FileDirectives = {
    migration: first("migration")?.args ?? null,
    plan: first("plan")?.args ?? null,
    from: first("from")?.args ?? null,
    to: first("to")?.args ?? null,
    txmode,
    lockTimeout: timeout.lock,
    statementTimeout: timeout.statement,
    requiresPg: requiresPgRaw === undefined ? null : Number(requiresPgRaw),
    checkpoint: hits.some((h) => h.name === "checkpoint"),
    data: hits.some((h) => h.name === "data"),
    all,
  };

  const markers = hits.filter((h) => h.name === "stmt" || h.name === "segment");
  const stmtMarkers = markers.filter((h) => h.name === "stmt");

  if (stmtMarkers.length === 0) {
    // design/06 §4.2: the splitter is the fallback for hand-written files, and it is
    // loud about it — canonicalisation drops the comments and reflows the whitespace,
    // so what runs is not byte-identical to what was reviewed.
    const parts = splitStatements(text);
    diagnostics.push({
      code: "statements_from_splitter",
      severity: "info",
      subject,
      message:
        `no -- pg-prime:stmt markers; split ${parts.length} statement(s) with the SQL lexer. ` +
        `Statement indices (and therefore crash resume) depend on the splitter for this file.`,
      count: parts.length,
    });
    return {
      directives,
      statementSource: "splitter",
      diagnostics,
      statements: parts.map((sql, index) => ({
        index,
        sql,
        lockClass: "accessExclusive" as LockClass,
        idempotent: false,
        hazards: [],
        segment: null,
      })),
    };
  }

  let segment: number | null = null;
  const statements: FileStatement[] = [];
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]!;
    if (marker.name === "segment") {
      segment = Number(marker.args.split(/\s+/)[0]);
      continue;
    }
    const next = markers[i + 1];
    const body = trimStatement(text.slice(marker.end, next ? next.start : text.length));
    const flags = parseStmtFlags(marker.args);
    if (!Number.isInteger(flags.index) || flags.index !== statements.length) {
      diagnostics.push({
        code: "stmt_marker_out_of_order",
        severity: "error",
        subject,
        message: `-- pg-prime:stmt ${marker.args.split(/\s+/)[0]} on line ${marker.line} should be ${statements.length}`,
      });
    }
    if (body === "") {
      diagnostics.push({
        code: "stmt_marker_empty",
        severity: "error",
        subject,
        message: `-- pg-prime:stmt ${flags.index} on line ${marker.line} has no statement under it`,
      });
    } else if (topLevelStatementCount(body) > 1) {
      diagnostics.push({
        code: "stmt_marker_multi",
        severity: "warning",
        subject,
        message:
          `-- pg-prime:stmt ${flags.index} on line ${marker.line} covers more than one statement; ` +
          `they will be sent as one, which PostgreSQL runs in an implicit transaction`,
      });
    }
    statements.push({
      index: statements.length,
      sql: body,
      lockClass: flags.lockClass,
      idempotent: flags.idempotent,
      hazards: flags.hazards,
      segment,
    });
  }
  return { directives, statements, statementSource: "markers", diagnostics };
}

function parsePlan(text: string, subject: string): { plan: Plan | null; diagnostic?: Diagnostic } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      plan: null,
      diagnostic: {
        code: "plan_unreadable",
        severity: "error",
        subject,
        message: `${subject} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  const p = parsed as Partial<Plan> | null;
  if (!p || typeof p !== "object" || p.formatVersion !== 1 || !Array.isArray(p.statements)) {
    return {
      plan: null,
      diagnostic: {
        code: "plan_unreadable",
        severity: "error",
        subject,
        message: `${subject} is not a formatVersion 1 plan`,
      },
    };
  }
  return { plan: p as Plan };
}

function checksumOf(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Read and order the migrations directory. A missing directory is an empty one. */
export async function readMigrationsDir(dir: string): Promise<ReadMigrationsResult> {
  const diagnostics: Diagnostic[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return { files: [], diagnostics };
    throw err;
  }

  const files: MigrationFile[] = [];
  for (const entry of names.sort()) {
    if (!entry.endsWith(".sql")) continue;
    const m = MIGRATION_FILE.exec(entry);
    if (!m) {
      diagnostics.push({
        code: "migration_filename_ignored",
        severity: "warning",
        subject: entry,
        message: `${entry} is not NNNN_name.sql (name must match [a-z0-9_]+) and was ignored`,
      });
      continue;
    }
    const seq = Number(m[1]);
    const name = m[2]!;
    const id = `${m[1]}_${name}`;
    const path = join(dir, entry);
    const bytes = await readFile(path);
    const text = bytes.toString("utf8");
    const parsed = parseMigrationSql(text, entry);
    const fileDiags: Diagnostic[] = [...parsed.diagnostics];

    let plan: Plan | null = null;
    let planPath: string | null = join(dir, `${id}.plan.json`);
    try {
      const planText = await readFile(planPath, "utf8");
      const result = parsePlan(planText, `${id}.plan.json`);
      plan = result.plan;
      if (result.diagnostic) fileDiags.push(result.diagnostic);
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
      planPath = null;
      fileDiags.push({
        code: "plan_missing",
        severity: "info",
        subject: entry,
        message:
          `${id}.plan.json is absent; ${entry} is treated as hand-written — no fingerprint gate, ` +
          `no checksum gate, and statement metadata comes from the file's own directives`,
      });
    }

    const txmode: TxMode = plan?.txmode ?? parsed.directives.txmode ?? "transactional";
    files.push({
      id, seq, name, path, planPath,
      checksum: checksumOf(bytes),
      text,
      directives: parsed.directives,
      statements: parsed.statements,
      statementSource: parsed.statementSource,
      plan,
      txmode,
      diagnostics: fileDiags,
    });
  }

  files.sort((a, b) => (a.seq - b.seq) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { files, diagnostics };
}

export interface ExecutionPlan {
  readonly statements: readonly PlanStatement[];
  readonly segments: readonly Segment[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * What the runner actually executes: the FILE's statement text, carrying the PLAN's
 * metadata.
 *
 * The `.sql` is the executable artifact (design/06 §4.2, "runnable by psql if our tooling
 * ever fails"), so the text comes from it; the plan supplies lock class, timeouts and
 * segment framing. When the two disagree on a statement's text — a hand-edited file whose
 * checksum gate was waived with `--dev` — that is a warning, not a silent preference.
 */
export function executionPlan(file: MigrationFile): ExecutionPlan {
  const diagnostics: Diagnostic[] = [];
  const plan = file.plan;
  const statements: PlanStatement[] = file.statements.map((s, index) => {
    const fromPlan = plan?.statements[index];
    if (fromPlan && canonicalize(lexSql(fromPlan.sql)) !== canonicalize(lexSql(s.sql))) {
      diagnostics.push({
        code: "statement_text_drift",
        severity: "warning",
        subject: file.id,
        message: `statement ${index} in ${file.id}.sql does not match the same index in the plan; the file wins`,
      });
    }
    if (fromPlan) return { ...fromPlan, index, sql: s.sql };
    return {
      index,
      sql: s.sql,
      verb: "alter",
      kind: "unknown",
      produces: [], consumes: [], destroys: [], releases: [],
      transactionality: file.txmode === "none" ? "nonTransactional" : "transactional",
      lockClass: s.lockClass,
      idempotent: s.idempotent,
      timeouts: {
        lock: file.directives.lockTimeout === "per-statement" ? null : file.directives.lockTimeout,
        statement:
          file.directives.statementTimeout === null || file.directives.statementTimeout === "per-statement"
            ? s.lockClass === "shareUpdateExclusive"
              ? null
              : "30s"
            : file.directives.statementTimeout,
      },
      dataLoss: "none",
      rewrite: false,
      hazards: s.hazards,
    } satisfies PlanStatement;
  });

  if (plan && plan.statements.length !== statements.length) {
    diagnostics.push({
      code: "statement_count_drift",
      severity: "error",
      subject: file.id,
      message: `${file.id}.sql has ${statements.length} statement(s), its plan has ${plan.statements.length}`,
    });
  }

  const all = statements.map((s) => s.index);
  let segments: readonly Segment[];
  if (plan && plan.segments.length > 0) segments = plan.segments;
  else if (file.statements.some((s) => s.segment !== null)) {
    const byIndex = new Map<number, number[]>();
    for (const s of file.statements) {
      const key = s.segment ?? 0;
      const list = byIndex.get(key);
      if (list) list.push(s.index);
      else byIndex.set(key, [s.index]);
    }
    segments = [...byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, indices]) => ({ index, transactional: file.txmode !== "none", statements: indices }));
  } else segments = [{ index: 0, transactional: file.txmode !== "none", statements: all }];

  return { statements, segments, diagnostics };
}
