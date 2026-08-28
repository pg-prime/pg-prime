/**
 * TX201 — every statement of a repeatable must be idempotent (design/06 §3.8, §5.4).
 *
 * A repeatable is re-applied on every deploy whose bytes changed, and `txmode none` resume
 * re-executes the one statement whose outcome the crash left unknown (`06` §5.4). A
 * `CREATE INDEX x` that succeeded once and raises 42P07 on the next run is therefore not a
 * style nit: it wedges the deploy at exactly the moment nobody wants to debug SQL.
 *
 * The check is syntactic, and the two ways a syntactic check gets this wrong are both
 * eliminated by lexing instead of regexing the raw text (`sql/statements.ts`):
 *
 *   - a leading `-- CREATE OR REPLACE …` comment must not launder a bare `CREATE`;
 *   - `DROP TABLE public.decoy` inside a `$$…$$` body belongs to the body, not to us — the
 *     enclosing statement is a `CREATE OR REPLACE FUNCTION`, which is idempotent, and
 *     flagging it would make the design's own canonical example unlintable.
 *
 * An unrecognised leading verb passes. Not knowing a verb is not evidence of
 * non-idempotence, and a lint rule that fails closed on the unknown is a rule people disable.
 */

import { lexSql } from "../sql/statements.js";

export interface IdempotenceViolation {
  /** Index into the `statements` array that was checked. */
  readonly index: number;
  readonly sql: string;
  readonly reason: string;
}

export interface IdempotenceResult {
  readonly ok: boolean;
  readonly violations: readonly IdempotenceViolation[];
}

/* ---- normalisation ---- */

/**
 * Comments dropped, value literals masked, whitespace collapsed, quoted identifiers kept.
 *
 * `splitStatements` already drops comments and collapses CODE whitespace, so on its output
 * only the masking is left to do — but `checkIdempotence` is also handed hand-written
 * statements (by `lint`, and by every unit test), so it does the whole job itself rather than
 * trusting its caller to have pre-canonicalised.
 */
function normalize(sql: string): string {
  let out = "";
  for (const seg of lexSql(sql)) {
    if (seg.kind === "comment") {
      out += " "; // a comment still separates tokens
      continue;
    }
    // A `"quoted identifier"` lexes as a literal too, and it can BE the object name the
    // drop-then-create pairing below compares, so only value literals are masked. Masking
    // them is what stops `INSERT INTO t VALUES ('ON CONFLICT')` from reading as idempotent.
    out += seg.kind === "literal" && !seg.text.startsWith('"') ? " '' " : seg.text;
  }
  return out.replace(/\s+/g, " ").trim().replace(/;$/, "").trim();
}

/* ---- the rules ---- */

/**
 * Verbs that converge by nature: running them twice leaves the database where running them
 * once did. Checked before the `CREATE`/`DROP` rules so that tightening the default for
 * unknown verbs later cannot start flagging them by accident.
 */
const NATURALLY_REPEATABLE = /^(COMMENT\s+ON|GRANT|REVOKE|SET|SELECT|DO|SECURITY\s+LABEL|ANALYZE|REINDEX|TRUNCATE)\b/i;

/** Words that can sit between the verb and the object kind without changing which object it is. */
const NOISE = new Set(["OR", "REPLACE", "IF", "NOT", "EXISTS", "CONCURRENTLY", "UNIQUE"]);

/**
 * `(kind, name)` of a `CREATE`/`DROP`, e.g. `TRIGGER USERS_BUMP`, or null if unreadable.
 *
 * The schema qualifier is dropped, because the two halves of a legitimate pair do not carry
 * the same one: `DROP INDEX IF EXISTS public.users_email_idx` qualifies the index, while
 * `CREATE UNIQUE INDEX users_email_idx ON public.users` cannot.
 */
function objectRef(n: string): string | null {
  const tokens: string[] = [];
  for (const raw of n.split(" ").slice(1)) {
    const t = raw.replace(/[(,;].*$/, "").toUpperCase();
    if (t === "" || NOISE.has(t)) continue;
    tokens.push(t.slice(t.lastIndexOf(".") + 1));
    if (tokens.length === 2) break;
  }
  return tokens.length === 2 ? tokens.join(" ") : null;
}

/**
 * `DROP TRIGGER IF EXISTS users_bump ON public.users;` followed by `CREATE TRIGGER users_bump …`
 * is the idempotent idiom design/06 §3.8 prescribes, for the object kinds PostgreSQL gives no
 * `OR REPLACE` (policies) or gave none before 14 (triggers). Read one statement at a time the
 * `CREATE` half looks bare, so without this TX201 would reject the exact spelling the design
 * mandates — a false alarm on correct SQL, which is the failure mode that gets a linter turned
 * off. The pair is matched on kind and name only, after the noise words: matching more buys
 * nothing, and erring this way costs at most a missed warning.
 */
function droppedEarlier(n: string, all: readonly string[], index: number): boolean {
  const ref = objectRef(n);
  if (ref === null) return false;
  for (let i = 0; i < index; i++) {
    const other = all[i]!;
    if (!/^DROP\b/i.test(other) || !/\bIF\s+EXISTS\b/i.test(other)) continue;
    if (objectRef(other) === ref) return true;
  }
  return false;
}

function violationOf(n: string, all: readonly string[], index: number): string | null {
  if (n === "") return null;
  if (NATURALLY_REPEATABLE.test(n)) return null;

  if (/^CREATE\b/i.test(n)) {
    if (/^CREATE\s+OR\s+REPLACE\b/i.test(n)) return null;
    if (/\bIF\s+NOT\s+EXISTS\b/i.test(n)) return null;
    if (droppedEarlier(n, all, index)) return null;
    return 'bare CREATE: the second apply raises "already exists" — use OR REPLACE, IF NOT EXISTS, or DROP … IF EXISTS the same object first';
  }

  if (/^DROP\b/i.test(n)) {
    return /\bIF\s+EXISTS\b/i.test(n) ? null : 'bare DROP: the second apply raises "does not exist" — add IF EXISTS';
  }

  if (/^ALTER\b/i.test(n)) {
    // `ADD VALUE` is the one ALTER with a repeatability trap of its own. Every other ALTER
    // either converges (`VALIDATE CONSTRAINT` above all, which is idempotent by definition)
    // or is a schema change that has no business in a repeatable and is caught by the diff.
    if (/^ALTER\s+TYPE\b/i.test(n) && /\bADD\s+VALUE\b/i.test(n) && !/\bADD\s+VALUE\s+IF\s+NOT\s+EXISTS\b/i.test(n)) {
      return "ALTER TYPE … ADD VALUE without IF NOT EXISTS: the second apply raises 42710";
    }
    return null;
  }

  if (/^INSERT\b/i.test(n)) {
    return /\bON\s+CONFLICT\b/i.test(n)
      ? null
      : "INSERT without ON CONFLICT: the second apply inserts the rows a second time";
  }

  const rowChange = /^(UPDATE|DELETE)\b/i.exec(n);
  if (rowChange) {
    return `${rowChange[1]!.toUpperCase()} in a repeatable: a row-changing statement belongs in a versioned migration, whose history records that it already ran`;
  }

  return null; // unrecognised verb — see the file header
}

export function checkIdempotence(statements: readonly string[]): IdempotenceResult {
  const normalized = statements.map(normalize);
  const violations: IdempotenceViolation[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const reason = violationOf(normalized[i]!, normalized, i);
    if (reason !== null) violations.push({ index: i, sql: statements[i]!, reason });
  }
  return { ok: violations.length === 0, violations };
}
