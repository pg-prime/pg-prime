/**
 * The `06` §3.4 rules that are properties of the FILE rather than of a delta.
 *
 * `diff/ddl.ts` attaches a hazard when it knows something the catalog told it — this
 * column is populated, that constraint is validated, this default calls a volatile
 * function. Six codes cannot be known there, because they are statements about the
 * assembled migration rather than about the change it makes:
 *
 *  - **TX101 / TX102 / TX201** are about `txmode` and segment framing. `buildStatements`
 *    emits statements; `orderStatements` decides the segments; only the finished plan
 *    knows whether a `CONCURRENTLY` build ended up inside a transaction;
 *  - **LK103** is the same question asked of a single statement;
 *  - **LK111** and **DS105** are about triggers and materialised views, which are Tier R
 *    (`06` §2.2) — never diffed, so never a delta, but very much present in a
 *    hand-written `.sql` or a repeatable, which is exactly what `migrate lint` is pointed
 *    at;
 *  - **ST101–ST106** are style, `off` by default (`06` §3.4), and a plan that carried
 *    them as hazards would put opt-in advice into every `.plan.json` in the repo.
 *
 * All of them are computed from `Plan` + statement text, so `migrate lint` stays a pure
 * function and `migrate generate` does not have to run the style pass to write a file.
 */

import type { Plan, PlanStatement } from "../plan/plan.js";
import { codeMask } from "../sql/statements.js";
import { MAX_IDENT_BYTES, utf8ByteLength } from "../sql/ident.js";

/** A rule finding before suppression and acknowledgement are applied. */
export interface RuleHit {
  readonly code: string;
  readonly statement: number;
  readonly subject: string;
  readonly message: string;
}

/**
 * The style family's severities, which `plan/plan.ts`'s table deliberately does not
 * carry: `hazardSeverity` answers `error` for anything it does not know, and that is the
 * right default for a hazard code but the wrong one for advice nobody asked for. Keeping
 * them here also keeps `ST` out of `.plan.json` entirely.
 */
export const STYLE_CODES: readonly string[] = ["ST101", "ST102", "ST103", "ST104", "ST105", "ST106"];

const STYLE = new Set(STYLE_CODES);
export const isStyleCode = (code: string): boolean => STYLE.has(code);

/** Text with string literals, dollar-quoted bodies and comments blanked out. */
function codeOnly(sql: string): string {
  const mask = codeMask(sql);
  let out = "";
  for (let i = 0; i < sql.length; i++) out += mask[i] ? sql[i] : " ";
  return out;
}

/** Every double-quoted identifier in a statement, unquoted. */
function quotedIdents(sql: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"]|"")*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) out.push(m[1]!.replaceAll('""', '"'));
  return out;
}

const CONCURRENTLY = /\bCONCURRENTLY\b/i;
const CREATE_TRIGGER = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/i;
const DROP_MATVIEW = /\bDROP\s+MATERIALIZED\s+VIEW\b/i;
const SERIAL = /\b(?:small|big)?serial\b/i;
const CHAR_N = /\bchar(?:acter)?\s*\(\s*\d+\s*\)/i;
const BARE_TIMESTAMP =
  /\btimestamp\b(?!\s+with\s+time\s+zone)(?!\s*\()|\btimestamp\s*\(\s*\d+\s*\)(?!\s+with\s+time\s+zone)/i;
const INT4_PK = /\b(?:int|int4|integer)\b[^,)]*\bPRIMARY\s+KEY\b/i;
/** `ALTER TABLE users` / `ON users` — a relation named with no schema in front of it. */
const UNQUALIFIED =
  /\b(?:ALTER\s+TABLE(?:\s+ONLY)?|CREATE\s+TABLE|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|ON)\s+(?!ONLY\b)("?[A-Za-z_][A-Za-z0-9_$]*"?)(?!\s*\.)/gi;

/**
 * `06` §3.4's file-level rules over one plan.
 *
 * `style` is opt-in twice over: the caller must ask, AND `06` §3.4 sets the family's
 * default to `off`. Passing `--rules ST103` is the other way in, which `lintPlan` handles
 * by asking for style whenever a selected code is a style code.
 */
export function planRules(plan: Plan, options: { readonly style: boolean }): RuleHit[] {
  const hits: RuleHit[] = [];
  const subjectOf = (s: PlanStatement): string => s.destroys[0] ?? s.produces[0] ?? s.consumes[0] ?? "";

  /* ---- transaction framing ---- */
  const segmentOf = new Map<number, (typeof plan.segments)[number]>();
  for (const seg of plan.segments) for (const i of seg.statements) segmentOf.set(i, seg);

  for (const s of plan.statements) {
    const subject = subjectOf(s);
    const seg = segmentOf.get(s.index);
    const inTransaction = seg?.transactional ?? plan.txmode !== "none";

    if (s.transactionality === "nonTransactional" && plan.txmode === "transactional") {
      hits.push({
        code: "TX101",
        statement: s.index,
        subject,
        message: `statement ${s.index} cannot run inside a transaction, but the file is txmode transactional`,
      });
    }
    if (s.transactionality === "nonTransactional" && inTransaction) {
      hits.push({
        code: "TX102",
        statement: s.index,
        subject,
        message: `statement ${s.index} is non-transactional but shares segment ${seg?.index ?? "?"} with transactional statements; it needs a segment boundary`,
      });
    }
    if (plan.txmode === "none" && !s.idempotent) {
      hits.push({
        code: "TX201",
        statement: s.index,
        subject,
        message: `statement ${s.index} is not idempotent, and a txmode-none file must be safe to re-execute after a crash (design/06 §5.4)`,
      });
    }
    if (CONCURRENTLY.test(codeOnly(s.sql)) && inTransaction) {
      hits.push({
        code: "LK103",
        statement: s.index,
        subject,
        message: `statement ${s.index} uses CONCURRENTLY inside a transaction block, which PostgreSQL rejects with 25001`,
      });
    }
    if (CREATE_TRIGGER.test(codeOnly(s.sql))) {
      hits.push({
        code: "LK111",
        statement: s.index,
        subject,
        message: `CREATE TRIGGER takes SHARE ROW EXCLUSIVE on the table, which blocks writes for the duration`,
      });
    }
    if (DROP_MATVIEW.test(codeOnly(s.sql))) {
      hits.push({
        code: "DS105",
        statement: s.index,
        subject,
        message: `dropping a materialized view destroys the data it holds; recreating it costs a full refresh`,
      });
    }

    if (!options.style) continue;
    const bare = codeOnly(s.sql);
    if (SERIAL.test(bare)) {
      hits.push({ code: "ST101", statement: s.index, subject, message: "prefer GENERATED … AS IDENTITY over serial" });
    }
    if (CHAR_N.test(bare)) {
      hits.push({
        code: "ST102",
        statement: s.index,
        subject,
        message: "prefer text over char(n): PostgreSQL pads and there is no performance gain",
      });
    }
    if (BARE_TIMESTAMP.test(bare)) {
      hits.push({
        code: "ST103",
        statement: s.index,
        subject,
        message: "prefer timestamptz over timestamp without time zone",
      });
    }
    if (INT4_PK.test(bare)) {
      hits.push({
        code: "ST104",
        statement: s.index,
        subject,
        message: "prefer bigint for a primary key: an int4 sequence runs out at 2.1 billion",
      });
    }
    for (const ident of quotedIdents(s.sql)) {
      if (utf8ByteLength(ident) > MAX_IDENT_BYTES) {
        hits.push({
          code: "ST105",
          statement: s.index,
          subject,
          message: `identifier ${JSON.stringify(ident)} is ${utf8ByteLength(ident)} UTF-8 bytes; PostgreSQL truncates to ${MAX_IDENT_BYTES}`,
        });
      }
    }
    UNQUALIFIED.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = UNQUALIFIED.exec(bare)) !== null) {
      hits.push({
        code: "ST106",
        statement: s.index,
        subject,
        message: `unqualified relation reference ${m[1]}; the name resolves through search_path, which the runner does not control`,
      });
    }
  }
  return hits;
}
