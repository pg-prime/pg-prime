/**
 * `migrate lint` as a pure function (design/11 §3, K3 item 6) — no database, no
 * filesystem, no clock. It takes a `Plan` and the bytes of the `.sql` beside it and
 * returns everything the command needs to print and to exit with.
 *
 * Two rules of this module exist because of specific ways a linter goes quiet:
 *
 *   1. Severity is re-derived from `hazardSeverity(code)`, never read off the plan.
 *      `.plan.json` is a file on disk that an older engine — or a text editor — wrote,
 *      and a `DS103` sitting at `"severity": "warn"` would otherwise walk straight past
 *      `--fail-on error`. The plan is evidence about *what changed*; it is not authority
 *      about how bad that is.
 *   2. A `nolint` without a reason is a hard failure, not a suppression. design/06 §3.4
 *      makes the reason mandatory precisely so the suppression is reviewable; accepting
 *      a bare `-- pg-prime:nolint DS102` would let a destructive change disappear from
 *      CI with nothing in the diff for a reviewer to argue with.
 */

import { hazardSeverity, type Plan } from "../plan/plan.js";
import { lexSql } from "../sql/statements.js";
import { isStyleCode, planRules } from "./rules.js";

export interface LintOptions {
  /** only these codes are considered; empty/absent = all */
  readonly rules?: readonly string[];
  /** default "error" */
  readonly failOn?: "error" | "warn" | "off";
  /**
   * Run the `ST101–ST106` style family, whose `06` §3.4 default is `off`. Implied when
   * `rules` names a style code, so `--rules ST103` does what it says without a second flag.
   */
  readonly style?: boolean;
}

export interface LintFinding {
  readonly code: string;
  readonly severity: "error" | "warn";
  /** plan statement index, or -1 for a plan-level finding */
  readonly statement: number;
  readonly subject: string;
  readonly message: string;
  /** the hazard was signed off in `plan.acknowledged.dataLoss` (or a blanket ack) */
  readonly acknowledged: boolean;
  /** the reason string from a `-- pg-prime:nolint CODE "reason"` directive, else null */
  readonly suppressedBy: string | null;
}

export interface NolintDirective {
  readonly code: string;
  readonly reason: string;
  /** 1-based line in the .sql text */
  readonly line: number;
  /** the statement index it applies to, or null for a file-wide directive */
  readonly statement: number | null;
}

export interface DirectiveError {
  readonly line: number;
  readonly text: string;
  readonly message: string;
}

export interface LintResult {
  readonly findings: readonly LintFinding[];
  readonly directives: readonly NolintDirective[];
  /** malformed `nolint` lines — a missing reason is itself a lint failure */
  readonly directiveErrors: readonly DirectiveError[];
  /** 0 = clean, 3 = lint failure (design/06 §6.1) */
  readonly exitCode: 0 | 3;
}

/**
 * design/06 §6.2 lists `--format text|json|sarif`. SARIF is K2b's — it needs the
 * migration's path and a rule catalogue, neither of which this module is given — so the
 * union is declared here as the place it will land rather than as a second vocabulary
 * invented later. `formatFindings` switches exhaustively, so adding `"sarif"` here is a
 * compile error until it is handled.
 */
export type LintFormat = "text" | "json";

/**
 * `-- pg-prime:` is the v1 namespace (design/11 §1.1). `renderSql` in `plan/plan.ts`
 * still writes the legacy `-- pg-orm:` prefix — the rename is another workstream's file
 * this round — so both are accepted. That is not only a transition kindness: a
 * hand-written migration committed before the rename keeps its suppressions, and a
 * linter that silently stopped recognising half the corpus's markers would report every
 * per-statement `nolint` as file-wide.
 */
const DIRECTIVE_LINE = /^--\s*(?:pg-prime|pg-orm):\s*(.*)$/;

/** `-- pg-prime:stmt 3 lock=… hazards=…` — the marker that scopes a following `nolint`. */
const STMT_MARKER = /^stmt\s+(\d+)(?:\s|$)/;

/**
 * A hazard code as design/06 §3.4 spells them (`LK101`), plus the snake_case diagnostic
 * codes `buildPlan` folds into `plan.hazards` (`unmodeled_kind`). Anything else — a
 * quoted string where the code should be, `LK101,LK102`, a bare `-- pg-prime:nolint` —
 * is a malformed directive rather than a suppression of nothing.
 */
const NOLINT_HEAD = /^([A-Za-z][A-Za-z0-9_]*)(?:\s+(.*))?$/;

/** A double-quoted reason, `\"` and `\\` escaped, occupying the whole remainder. */
const NOLINT_REASON = /^"((?:[^"\\]|\\.)*)"$/;

function countNewlines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}

export function parseNolint(sqlText: string): { directives: NolintDirective[]; errors: DirectiveError[] } {
  const directives: NolintDirective[] = [];
  const errors: DirectiveError[] = [];

  let line = 1;
  // Null until the first `stmt` marker: a directive in the header block is file-wide.
  let statement: number | null = null;

  // Lexed, not split on `/\n/`. A `-- pg-prime:nolint` inside a string literal or a
  // `$$ … $$` function body is data that happens to look like a directive, and honouring
  // it would let `INSERT INTO audit(note) VALUES ('-- pg-prime:nolint DS102 "x"')`
  // silence a DROP TABLE elsewhere in the same file. Only line comments count: a
  // directive wrapped in `/* … */` has been commented out by whoever wrapped it.
  for (const seg of lexSql(sqlText)) {
    if (seg.kind === "comment" && seg.text.startsWith("--")) {
      const text = seg.text.trimEnd();
      const body = DIRECTIVE_LINE.exec(text)?.[1]?.trim();
      if (body !== undefined && body !== "") {
        const marker = STMT_MARKER.exec(body);
        if (marker) {
          statement = Number(marker[1]);
        } else if (/^nolint(?:\s|$)/.test(body)) {
          const parsed = parseOneNolint(body.slice("nolint".length).trim(), line, text, statement);
          if ("message" in parsed) errors.push(parsed);
          else directives.push(parsed);
        }
      }
    }
    line += countNewlines(seg.text);
  }

  return { directives, errors };
}

function parseOneNolint(
  rest: string,
  line: number,
  text: string,
  statement: number | null,
): NolintDirective | DirectiveError {
  const fail = (message: string): DirectiveError => ({ line, text, message });

  if (rest === "") return fail('nolint needs a code and a quoted reason: -- pg-prime:nolint LK101 "why"');

  const head = NOLINT_HEAD.exec(rest);
  if (head === null) return fail(`nolint code ${JSON.stringify(rest.split(/\s/)[0] ?? rest)} is not a hazard code`);

  const code = head[1] ?? "";
  const tail = head[2]?.trim() ?? "";
  if (tail === "") return fail(`nolint ${code} has no reason — design/06 §3.4 makes it mandatory so the suppression is reviewable`);

  const quoted = NOLINT_REASON.exec(tail);
  if (!quoted) return fail(`nolint ${code} reason must be a single double-quoted string, received ${JSON.stringify(tail)}`);

  const reason = (quoted[1] ?? "").replace(/\\(.)/g, "$1");
  // `""` and `"   "` are the same evasion as no reason at all, one keystroke longer.
  if (reason.trim() === "") return fail(`nolint ${code} reason is empty`);

  return { code, reason, line, statement };
}

/**
 * The directive that suppresses a finding, or null.
 *
 * Narrowest wins: when both a header-block directive and a per-statement one name the
 * code, the per-statement reason is the one worth printing, because it is the one whose
 * author was looking at this statement. A plan-level finding (`statement === -1`) is
 * only ever reachable by a file-wide directive — there is no `-- pg-prime:stmt -1`.
 */
function suppressorFor(
  directives: readonly NolintDirective[],
  code: string,
  statement: number,
): NolintDirective | null {
  return (
    directives.find((d) => d.code === code && d.statement === statement) ??
    directives.find((d) => d.code === code && d.statement === null) ??
    null
  );
}

/** design/06 §3.6 — the destructive family is gated on a recorded acknowledgement. */
function isDestructive(code: string): boolean {
  return code.startsWith("DS");
}

export function lintPlan(plan: Plan, sqlText: string, options?: LintOptions): LintResult {
  const { directives, errors } = parseNolint(sqlText);
  const failOn = options?.failOn ?? "error";
  const rules = options?.rules;
  const selected = rules !== undefined && rules.length > 0 ? new Set(rules) : null;

  // design/06 §3.6: the acknowledgement lives in the plan so it shows up as a diff line
  // in the pull request. `blanket` is `--allow-data-loss`, which covers every subject.
  const ack = plan.acknowledged;
  const blanket = ack?.blanket === true;
  const signedOff = new Set(ack?.dataLoss ?? []);

  // Style is `off` by default (design/06 §3.4). Naming a style code in `--rules` is a
  // request for it — otherwise `--rules ST103` would select nothing and exit 0, which
  // reads as "the rule passed".
  const style = options?.style === true || (selected !== null && [...selected].some(isStyleCode));

  const findings: LintFinding[] = [];
  const record = (
    code: string,
    statement: number,
    subject: string,
    message: string,
  ): void => {
    if (selected !== null && !selected.has(code)) return;
    const suppressor = suppressorFor(directives, code, statement);
    findings.push({
      code,
      // Re-derived, never `hazard.severity`. See this file's header. The style family is
      // absent from `hazardSeverity`'s table on purpose — it answers `error` for an
      // unknown code, which is right for a hazard and wrong for opt-in advice.
      severity: isStyleCode(code) ? "warn" : hazardSeverity(code),
      statement,
      subject,
      message,
      acknowledged: blanket || signedOff.has(subject),
      suppressedBy: suppressor === null ? null : suppressor.reason,
    });
  };

  for (const hazard of plan.hazards) {
    record(hazard.code, hazard.statement, hazard.subject, hazard.message);
  }
  // The codes that are properties of the FILE rather than of a delta (see `rules.ts`):
  // TX101/TX102/TX201, LK103, LK111, DS105 and the style family.
  for (const hit of planRules(plan, { style })) {
    record(hit.code, hit.statement, hit.subject, hit.message);
  }

  const failsSeverity = (severity: "error" | "warn"): boolean =>
    failOn === "off" ? false : failOn === "warn" ? true : severity === "error";

  const failing = findings.some((f) => {
    if (f.suppressedBy !== null) return false;
    // design/06 §3.6: "`migrate lint` fails on any DS-class hazard whose subject is not
    // in `acknowledged.dataLoss`" — so an unacknowledged one fails at every `--fail-on`,
    // including `off` (which turns the advisory rules down, not the data-loss gate), and
    // an acknowledged one is a decision that has already been reviewed in the PR diff.
    if (isDestructive(f.code)) return !f.acknowledged;
    // The same logic generalises to the rest of the error family: `buildPlan` records an
    // acknowledgement for every error-severity subject the operator signed off on, and
    // re-failing on one would make `--allow-data-loss` unable to produce a green lint.
    if (f.severity === "error" && f.acknowledged) return false;
    return failsSeverity(f.severity);
  });

  return {
    findings,
    directives,
    directiveErrors: errors,
    exitCode: errors.length > 0 || failing ? 3 : 0,
  };
}

/**
 * Directives that suppressed nothing in this run — a `nolint` for a hazard the schema no
 * longer produces. Not an error (that is how a file stays quiet across regenerations),
 * but worth reporting, and worth computing here rather than making every caller
 * re-implement the scope rule and get it subtly different.
 */
export function unusedDirectives(result: LintResult): readonly NolintDirective[] {
  const used = new Set<NolintDirective>();
  for (const f of result.findings) {
    if (f.suppressedBy === null) continue;
    const d = suppressorFor(result.directives, f.code, f.statement);
    if (d !== null) used.add(d);
  }
  return result.directives.filter((d) => !used.has(d));
}

export function formatFindings(result: LintResult, format: LintFormat): string {
  switch (format) {
    case "json":
      return JSON.stringify(result, null, 2);
    case "text": {
      const lines: string[] = [];
      // Malformed directives are printed first and unconditionally. They are the reason
      // for exit 3 in a run that may have no findings at all, and an exit code with no
      // output is the failure mode this whole module is trying to avoid.
      for (const e of result.directiveErrors) lines.push(`error nolint [line ${e.line}] ${e.text}: ${e.message}`);
      for (const f of result.findings) {
        const prefix = f.suppressedBy === null ? "" : "suppressed ";
        lines.push(`${prefix}${f.severity} ${f.code} [stmt ${f.statement}] ${f.subject}: ${f.message}`);
      }
      return lines.join("\n");
    }
    default: {
      // Unreachable today; here so `"sarif"` cannot be added to LintFormat without
      // someone deciding what it renders.
      const exhaustive: never = format;
      throw new Error(`unknown lint format ${JSON.stringify(exhaustive)}`);
    }
  }
}
