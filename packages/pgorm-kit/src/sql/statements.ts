/**
 * A PostgreSQL-aware SQL lexer, statement splitter and canonicalizer.
 *
 * This exists for the `pg_dump` oracle (design/06 3.2, sign-off item 7 amendment):
 * comparing two dumps line-by-line is wrong, because a semicolon inside a dollar-quoted
 * function body is not a statement boundary and a `--` inside a string literal is not a
 * comment. Getting either wrong turns the oracle into a noise generator.
 *
 * The lexer classifies every byte as CODE, COMMENT or LITERAL. Canonicalization then
 * collapses whitespace in CODE only: a function body is stored verbatim by PostgreSQL,
 * so reflowing it would manufacture a difference that does not exist.
 */

export type SegmentKind = "code" | "comment" | "literal";

export interface Segment {
  readonly kind: SegmentKind;
  readonly text: string;
}

// PostgreSQL identifiers admit any non-ASCII byte, so the high range is folded in
// wholesale rather than spelled out as a character class.
const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c) || c.charCodeAt(0) > 127;
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_]/.test(c) || c.charCodeAt(0) > 127;

/**
 * `$$`, `$tag$` - but NOT `$1` (a bind placeholder). Returns the full opening
 * delimiter including both dollars, or null.
 */
export function dollarTagAt(sql: string, i: number): string | null {
  if (sql[i] !== "$") return null;
  let j = i + 1;
  while (j < sql.length && isIdentPart(sql[j]!)) {
    if (j === i + 1 && !isIdentStart(sql[j]!)) return null; // $1 - a parameter
    j++;
  }
  if (sql[j] !== "$") return null;
  return sql.slice(i, j + 1);
}

/** True when only whitespace separates `i` from the start of its line. */
function atLineStart(sql: string, i: number): boolean {
  for (let k = i - 1; k >= 0; k--) {
    const c = sql[k]!;
    if (c === "\n") return true;
    if (c !== " " && c !== "\t" && c !== "\r") return false;
  }
  return true;
}

/**
 * Was the quote at `i` introduced by an `E` prefix? Only then does a backslash
 * escape the following character.
 */
function isEscapeString(sql: string, i: number): boolean {
  const prev = sql[i - 1];
  if (prev !== "e" && prev !== "E") return false;
  const before = sql[i - 2];
  return before === undefined || !isIdentPart(before);
}

export function lexSql(sql: string): Segment[] {
  const out: Segment[] = [];
  let code = "";
  const flush = (): void => {
    if (code) {
      out.push({ kind: "code", text: code });
      code = "";
    }
  };

  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;

    // psql meta-command (`\restrict <token>`). pg_dump >= 17.6 emits these with a RANDOM
    // token, so they must never reach a comparison. They are not SQL and end at the line.
    if (c === "\\" && atLineStart(sql, i)) {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      flush();
      out.push({ kind: "comment", text: sql.slice(i, stop) });
      i = stop;
      continue;
    }

    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      flush();
      out.push({ kind: "comment", text: sql.slice(i, stop) });
      i = stop;
      continue;
    }

    if (c === "/" && sql[i + 1] === "*") {
      let depth = 1; // PostgreSQL block comments NEST
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      flush();
      out.push({ kind: "comment", text: sql.slice(i, j) });
      i = j;
      continue;
    }

    const tag = dollarTagAt(sql, i);
    if (tag) {
      const close = sql.indexOf(tag, i + tag.length);
      const j = close === -1 ? sql.length : close + tag.length;
      flush();
      out.push({ kind: "literal", text: sql.slice(i, j) });
      i = j;
      continue;
    }

    if (c === "'") {
      const escapes = isEscapeString(sql, i);
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      flush();
      out.push({ kind: "literal", text: sql.slice(i, j) });
      i = j;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      flush();
      out.push({ kind: "literal", text: sql.slice(i, j) });
      i = j;
      continue;
    }

    code += c;
    i++;
  }
  flush();
  return out;
}

/** Collapse CODE whitespace, drop COMMENTs, keep LITERALs byte-for-byte. */
export function canonicalize(segments: readonly Segment[]): string {
  let out = "";
  const appendCode = (text: string): void => {
    // Collapsing runs per segment is not enough: a comment between two code segments
    // leaves a space on each side, so the boundary itself has to be collapsed too.
    const collapsed = text.replace(/\s+/g, " ");
    out += out.endsWith(" ") && collapsed.startsWith(" ") ? collapsed.slice(1) : collapsed;
  };

  for (const s of segments) {
    if (s.kind === "comment") {
      // A comment still separates tokens: `a/**/b` is two tokens, not `ab`.
      if (out && !out.endsWith(" ")) out += " ";
      continue;
    }
    if (s.kind === "code") appendCode(s.text);
    else out += s.text; // literal, byte-for-byte
  }
  return out.trim().replace(/\s*;$/, "");
}

/**
 * Split into statements at top-level semicolons - i.e. semicolons the lexer classified
 * as CODE. Returns canonical text; empty statements are dropped.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current: Segment[] = [];

  for (const seg of lexSql(sql)) {
    if (seg.kind !== "code" || !seg.text.includes(";")) {
      current.push(seg);
      continue;
    }
    const parts = seg.text.split(";");
    for (let k = 0; k < parts.length; k++) {
      current.push({ kind: "code", text: parts[k]! });
      if (k < parts.length - 1) {
        const text = canonicalize(current);
        if (text) statements.push(text);
        current = [];
      }
    }
  }
  const tail = canonicalize(current);
  if (tail) statements.push(tail);
  return statements;
}

/**
 * Per-character mask of "this byte is CODE" (not inside a literal or comment).
 *
 * Lets a caller walk a statement counting parentheses or commas without a second lexer,
 * and without mistaking a `(` inside `DEFAULT '('` for structure.
 */
export function codeMask(sql: string): boolean[] {
  const mask = new Array<boolean>(sql.length).fill(false);
  let i = 0;
  for (const seg of lexSql(sql)) {
    if (seg.kind === "code") for (let k = 0; k < seg.text.length; k++) mask[i + k] = true;
    i += seg.text.length;
  }
  return mask;
}
