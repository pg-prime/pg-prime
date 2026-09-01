/**
 * Reading PostgreSQL's own serializations back — `pg_get_constraintdef` and
 * `pg_get_indexdef` — so `pull` can turn them into DSL calls.
 *
 * This is a **recogniser, not a SQL parser**. Every function here returns `null` for
 * anything it does not recognise with certainty, and `pull` turns a `null` into a line in
 * the `-- pull: unsupported` block. That asymmetry is the whole design: a parser that
 * guesses produces a schema file which *looks* right and emits a migration that quietly
 * changes a constraint. A recogniser that gives up produces a gap somebody can see.
 *
 * The two inputs are PostgreSQL's own output, so the grammar is far narrower than SQL's:
 * identifiers are either bare lower-case or double-quoted, lists are `, `-separated, and
 * the clause order is fixed by `ruleutils.c`. What the functions below do NOT assume is
 * that a value inside a `CHECK (…)` is well-behaved — the expression is taken whole,
 * balanced on parentheses that are outside string literals, and handed to
 * `sql.unsafeRaw` untouched.
 */

/** Split `a, "b c", "d""e"` on top-level commas, unquoting as it goes. */
export function splitIdentifierList(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  let current = "";
  let inQuotes = false;
  let depth = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

/** The `(...)` starting at `from`, with its contents, respecting quotes and nesting. */
function balanced(text: string, from: number): { inner: string; end: number } | null {
  if (text[from] !== "(") return null;
  let depth = 0;
  let inQuotes = false;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') inQuotes = text[i + 1] === '"' ? (i++, true) : false;
      continue;
    }
    if (inString) {
      if (ch === "'") inString = text[i + 1] === "'" ? (i++, true) : false;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(from + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** `public.city` / `"My Schema"."My Table"` / `city` → `{ schema, name }`. */
function qualifiedName(text: string, fallbackSchema: string): { schema: string; name: string; end: number } | null {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    if (text[i] === '"') {
      let j = i + 1;
      let value = "";
      for (;;) {
        if (j >= text.length) return null;
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        value += text[j];
        j += 1;
      }
      parts.push(value);
      i = j;
    } else {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(i));
      if (m === null) return null;
      parts.push(m[0]);
      i += m[0].length;
    }
    if (text[i] === ".") {
      i += 1;
      continue;
    }
    break;
  }
  if (parts.length === 1) return { schema: fallbackSchema, name: parts[0]!, end: i };
  if (parts.length === 2) return { schema: parts[0]!, name: parts[1]!, end: i };
  return null;
}

/* ---------------------------- constraints -------------------------------- */

/** One `<element> WITH <operator>` pair of an `EXCLUDE`. Exactly one of the two names is set. */
export interface ExcludeItemSpec {
  readonly column: string | null;
  readonly expression: string | null;
  readonly operator: string;
}

export type ParsedConstraint =
  | { readonly kind: "primaryKey"; readonly columns: readonly string[] }
  | { readonly kind: "unique"; readonly columns: readonly string[]; readonly nullsNotDistinct: boolean }
  | { readonly kind: "check"; readonly expression: string }
  | {
      readonly kind: "exclude";
      readonly using: string | null;
      readonly items: readonly ExcludeItemSpec[];
      readonly where: string | null;
      readonly deferrable: boolean;
      readonly initiallyDeferred: boolean;
    }
  | {
      readonly kind: "foreignKey";
      readonly columns: readonly string[];
      readonly targetSchema: string;
      readonly targetTable: string;
      readonly targetColumns: readonly string[];
      readonly onDelete: string | undefined;
      readonly onUpdate: string | undefined;
      readonly deferrable: boolean;
      readonly initiallyDeferred: boolean;
    };

const ACTIONS: ReadonlyMap<string, string> = new Map([
  ["CASCADE", "cascade"],
  ["RESTRICT", "restrict"],
  ["NO ACTION", "no action"],
  ["SET NULL", "set null"],
  ["SET DEFAULT", "set default"],
]);

/**
 * `pg_get_constraintdef` output → the DSL's shape, or `null`.
 *
 * The trailing ` NOT VALID` has already been lifted out by the extractor
 * (`ConstraintPayload.validated`), so it is never seen here.
 */
export function parseConstraintDef(contype: string, definition: string): ParsedConstraint | null {
  const def = definition.trim();
  if (contype === "p") {
    const m = /^PRIMARY KEY\s*/.exec(def);
    if (m === null) return null;
    const list = balanced(def, m[0].length);
    if (list === null || def.slice(list.end).trim() !== "") return null;
    return { kind: "primaryKey", columns: splitIdentifierList(list.inner) };
  }
  if (contype === "u") {
    const m = /^UNIQUE(\s+NULLS\s+NOT\s+DISTINCT)?\s*/.exec(def);
    if (m === null) return null;
    const list = balanced(def, m[0].length);
    if (list === null || def.slice(list.end).trim() !== "") return null;
    return { kind: "unique", columns: splitIdentifierList(list.inner), nullsNotDistinct: m[1] !== undefined };
  }
  if (contype === "c") {
    const m = /^CHECK\s*/.exec(def);
    if (m === null) return null;
    const list = balanced(def, m[0].length);
    if (list === null) return null;
    // `NO INHERIT` is the only legal tail, and the DSL cannot say it.
    if (def.slice(list.end).trim() !== "") return null;
    return { kind: "check", expression: list.inner };
  }
  if (contype === "x") return parseExcludeDef(def);
  if (contype === "f") {
    const head = /^FOREIGN KEY\s*/.exec(def);
    if (head === null) return null;
    const local = balanced(def, head[0].length);
    if (local === null) return null;
    const afterLocal = def.slice(local.end).trimStart();
    if (!afterLocal.startsWith("REFERENCES ")) return null;
    const target = qualifiedName(afterLocal.slice("REFERENCES ".length), "public");
    if (target === null) return null;
    const afterTargetStart = "REFERENCES ".length + target.end;
    const remoteStart = afterLocal.indexOf("(", afterTargetStart);
    if (remoteStart === -1) return null;
    if (afterLocal.slice(afterTargetStart, remoteStart).trim() !== "") return null;
    const remote = balanced(afterLocal, remoteStart);
    if (remote === null) return null;
    let tail = afterLocal.slice(remote.end).trim();

    let onDelete: string | undefined;
    let onUpdate: string | undefined;
    let deferrable = false;
    let initiallyDeferred = false;
    // MATCH FULL / MATCH PARTIAL change the semantics and the DSL cannot say them.
    if (/^MATCH\s+(FULL|PARTIAL)\b/i.test(tail)) return null;
    for (;;) {
      const on = /^ON\s+(DELETE|UPDATE)\s+(CASCADE|RESTRICT|NO ACTION|SET NULL|SET DEFAULT)\b/i.exec(tail);
      if (on !== null) {
        const action = ACTIONS.get(on[2]!.toUpperCase());
        if (action === undefined) return null;
        if (on[1]!.toUpperCase() === "DELETE") onDelete = action;
        else onUpdate = action;
        tail = tail.slice(on[0].length).trim();
        continue;
      }
      const def2 = /^DEFERRABLE(\s+INITIALLY\s+DEFERRED)?\b/i.exec(tail);
      if (def2 !== null) {
        deferrable = true;
        initiallyDeferred = def2[1] !== undefined;
        tail = tail.slice(def2[0].length).trim();
        continue;
      }
      const notDeferrable = /^NOT\s+DEFERRABLE\b/i.exec(tail);
      if (notDeferrable !== null) {
        tail = tail.slice(notDeferrable[0].length).trim();
        continue;
      }
      const initiallyImmediate = /^INITIALLY\s+IMMEDIATE\b/i.exec(tail);
      if (initiallyImmediate !== null) {
        tail = tail.slice(initiallyImmediate[0].length).trim();
        continue;
      }
      break;
    }
    if (tail !== "") return null;
    // `SET NULL (col, …)` and `SET DEFAULT (col, …)` (PG 15+) would have left a tail.
    return {
      kind: "foreignKey",
      columns: splitIdentifierList(local.inner),
      targetSchema: target.schema,
      targetTable: target.name,
      targetColumns: splitIdentifierList(remote.inner),
      onDelete,
      onUpdate,
      deferrable,
      initiallyDeferred,
    };
  }
  return null;
}

/**
 * `EXCLUDE USING gist (during WITH &&) WHERE (NOT cancelled) DEFERRABLE INITIALLY DEFERRED`.
 *
 * An EXCLUDE element is an INDEX element, so PostgreSQL may print an opclass, a collation or a
 * direction before the `WITH`. The DSL's `exclude(...).on([ref|sql, op])` carries an element and
 * an operator and nothing else, so an element with any of those is residue with the text in the
 * reason — the recogniser's rule, not a shrug: an exclusion whose opclass was silently dropped
 * is a different constraint.
 */
function parseExcludeDef(def: string): ParsedConstraint | null {
  const head = /^EXCLUDE\s*(?:USING\s+([A-Za-z_][A-Za-z0-9_$]*|"(?:[^"]|"")*")\s*)?/.exec(def);
  if (head === null) return null;
  const rawUsing = head[1];
  const using =
    rawUsing === undefined ? null : rawUsing.startsWith('"') ? rawUsing.slice(1, -1).replace(/""/g, '"') : rawUsing;
  const list = balanced(def, head[0].length);
  if (list === null) return null;

  const items: ExcludeItemSpec[] = [];
  for (const entry of splitIdentifierListPreservingQuotes(list.inner)) {
    // ` WITH ` at depth 0 is the split point; an operator is never an identifier, so the
    // rightmost one cannot be part of the element.
    const at = topLevelWith(entry);
    if (at === -1) return null;
    const element = entry.slice(0, at).trim();
    const operator = entry.slice(at + " WITH ".length).trim();
    if (operator === "" || /[A-Za-z_"\s]/.test(operator)) return null;
    if (element.startsWith("(")) {
      const inner = balanced(element, 0);
      if (inner === null || inner.end !== element.length) return null;
      items.push({ column: null, expression: inner.inner, operator });
      continue;
    }
    const name = qualifiedName(element, "");
    if (name === null || name.schema !== "" || element.slice(name.end).trim() !== "") return null;
    items.push({ column: name.name, expression: null, operator });
  }
  if (items.length === 0) return null;

  let tail = def.slice(list.end).trim();
  let where: string | null = null;
  const whereMatch = /^WHERE\s*/.exec(tail);
  if (whereMatch !== null) {
    const pred = balanced(tail, whereMatch[0].length);
    if (pred === null) return null;
    where = pred.inner;
    tail = tail.slice(pred.end).trim();
  }
  let deferrable = false;
  let initiallyDeferred = false;
  const def2 = /^DEFERRABLE(\s+INITIALLY\s+DEFERRED)?\b/i.exec(tail);
  if (def2 !== null) {
    deferrable = true;
    initiallyDeferred = def2[1] !== undefined;
    tail = tail.slice(def2[0].length).trim();
  }
  if (tail !== "") return null;
  return { kind: "exclude", using, items, where, deferrable, initiallyDeferred };
}

/** The index of the ` WITH ` that separates an EXCLUDE element from its operator, or -1. */
function topLevelWith(text: string): number {
  let depth = 0;
  let inQuotes = false;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') inQuotes = text[i + 1] === '"' ? (i++, true) : false;
      continue;
    }
    if (inString) {
      if (ch === "'") inString = text[i + 1] === "'" ? (i++, true) : false;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === "'") inString = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0 && text.startsWith(" WITH ", i)) return i;
  }
  return -1;
}

/* ------------------------------- indexes ---------------------------------- */

export interface IndexItemSpec {
  /** The column's name, or `null` when this key is an {@link IndexItemSpec.expression}. */
  readonly column: string | null;
  /** The expression's text, verbatim, or `null` for a column key. Exactly one of the two is set. */
  readonly expression: string | null;
  readonly desc: boolean;
  readonly nulls: "first" | "last" | null;
  readonly opclass: string | null;
}

export interface ParsedIndex {
  readonly schema: string;
  readonly table: string;
  readonly unique: boolean;
  readonly using: string | null;
  readonly items: readonly IndexItemSpec[];
  readonly include: readonly string[];
  readonly nullsNotDistinct: boolean;
  readonly where: string | null;
  /** `WITH (…)` storage parameters, already split into `{ key: value }`; `null` when absent. */
  readonly with: Readonly<Record<string, string>> | null;
  readonly tablespace: string | null;
}

/**
 * `CREATE [UNIQUE] INDEX %ID% ON s.t USING m (keys) [INCLUDE (…)] [NULLS NOT DISTINCT]
 *  [WITH (…)] [TABLESPACE ts] [WHERE …]`
 *
 * `%ID%` is the extractor's identity-free placeholder for the index's own name (I1), so the
 * caller supplies the real one.
 *
 * An **expression** key is recognised rather than refused (design/14 G, design/01 row 50): it
 * comes back as the text `pg_get_indexdef` printed and goes back out through
 * `sql.unsafeRaw(...)`, which the shadow re-normalises — the same treatment every other
 * definition text gets. What still returns `null` is a key this recogniser cannot split into
 * "expression" and "modifiers" with certainty (a trailing `COLLATE`, say), because a key whose
 * collation was silently dropped is a different index.
 */
export function parseIndexDef(definition: string, _name: string): ParsedIndex | null {
  const m = /^CREATE (UNIQUE )?INDEX %ID% ON /.exec(definition);
  if (m === null) return null;
  const rest = definition.slice(m[0].length);
  const target = qualifiedName(rest, "public");
  if (target === null) return null;
  let tail = rest.slice(target.end).trimStart();

  let using: string | null = null;
  const usingMatch = /^USING\s+([A-Za-z_][A-Za-z0-9_$]*|"(?:[^"]|"")*")\s*/.exec(tail);
  if (usingMatch !== null) {
    using = usingMatch[1]!.startsWith('"') ? usingMatch[1]!.slice(1, -1).replace(/""/g, '"') : usingMatch[1]!;
    tail = tail.slice(usingMatch[0].length);
  }

  const keys = balanced(tail, 0);
  if (keys === null) return null;
  tail = tail.slice(keys.end).trim();

  const items: IndexItemSpec[] = [];
  for (const raw of splitIdentifierListPreservingQuotes(keys.inner)) {
    const item = parseIndexItem(raw) ?? parseIndexExpressionItem(raw);
    if (item === null) return null;
    items.push(item);
  }
  if (items.length === 0) return null;

  let include: string[] = [];
  const includeMatch = /^INCLUDE\s*/.exec(tail);
  if (includeMatch !== null) {
    const list = balanced(tail, includeMatch[0].length);
    if (list === null) return null;
    include = splitIdentifierList(list.inner);
    tail = tail.slice(list.end).trim();
  }

  let nullsNotDistinct = false;
  const nnd = /^NULLS NOT DISTINCT\b/.exec(tail);
  if (nnd !== null) {
    nullsNotDistinct = true;
    tail = tail.slice(nnd[0].length).trim();
  }

  let withParams: Record<string, string> | null = null;
  const withMatch = /^WITH\s*/.exec(tail);
  if (withMatch !== null) {
    const list = balanced(tail, withMatch[0].length);
    if (list === null) return null;
    withParams = {};
    for (const entry of splitIdentifierList(list.inner)) {
      // `pg_get_indexdef` prints every reloption as `k='v'`, quotes and all, whatever the
      // CREATE INDEX wrote. The value goes back out as the string it is: `.with()` quotes a
      // string and leaves a number bare, and PostgreSQL accepts both spellings for the
      // numeric ones — so the round-trip is through the catalog, not through the text.
      const eq = entry.indexOf("=");
      if (eq === -1) return null;
      const key = entry.slice(0, eq).trim();
      const raw = entry.slice(eq + 1).trim();
      // A reloption value CAN contain a comma inside its quotes, which `splitIdentifierList`
      // does not track — so the key is re-checked as an identifier and a mis-split becomes
      // residue instead of a storage parameter named `'7`.
      if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(key)) return null;
      withParams[key] = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw;
    }
    tail = tail.slice(list.end).trim();
  }

  let tablespace: string | null = null;
  const tsMatch = /^TABLESPACE\s+([A-Za-z_][A-Za-z0-9_$]*|"(?:[^"]|"")*")\s*/.exec(tail);
  if (tsMatch !== null) {
    const raw = tsMatch[1]!;
    tablespace = raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw;
    tail = tail.slice(tsMatch[0].length).trim();
  }

  // Anything left before the WHERE is a property the DSL cannot carry.
  let where: string | null = null;
  const whereMatch = /^WHERE\s+/.exec(tail);
  if (whereMatch !== null) {
    where = tail.slice(whereMatch[0].length).trim();
    tail = "";
  }
  if (tail !== "") return null;

  return {
    schema: target.schema,
    table: target.name,
    unique: m[1] !== undefined,
    using,
    items,
    include,
    nullsNotDistinct,
    where,
    with: withParams === null || Object.keys(withParams).length === 0 ? null : withParams,
    tablespace,
  };
}

/** Like `splitIdentifierList` but keeps the quotes, so an item can be re-inspected. */
function splitIdentifierListPreservingQuotes(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      current += ch;
      if (ch === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i += 1;
          continue;
        }
        inQuotes = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      current += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

/** `last_name`, `"Last Name" DESC`, `email text_pattern_ops`, `x DESC NULLS LAST`. */
function parseIndexItem(text: string): IndexItemSpec | null {
  const trimmed = text.trim();
  const name = qualifiedName(trimmed, "");
  // A qualified name in a key position is an expression (`(a).b`), and a bare `(` is one too.
  if (name === null || name.schema !== "") return null;
  let tail = trimmed.slice(name.end).trim();

  let opclass: string | null = null;
  const opclassMatch = /^([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?)\b/.exec(tail);
  if (opclassMatch !== null && !/^(ASC|DESC|NULLS|COLLATE)$/i.test(opclassMatch[1]!)) {
    opclass = opclassMatch[1]!;
    tail = tail.slice(opclassMatch[0].length).trim();
  }

  let desc = false;
  const dir = /^(ASC|DESC)\b/i.exec(tail);
  if (dir !== null) {
    desc = dir[1]!.toUpperCase() === "DESC";
    tail = tail.slice(dir[0].length).trim();
  }

  let nulls: "first" | "last" | null = null;
  const nullsMatch = /^NULLS\s+(FIRST|LAST)\b/i.exec(tail);
  if (nullsMatch !== null) {
    nulls = nullsMatch[1]!.toUpperCase() === "FIRST" ? "first" : "last";
    tail = tail.slice(nullsMatch[0].length).trim();
  }

  if (tail !== "") return null;
  return { column: name.name, expression: null, desc, nulls, opclass };
}

/**
 * An **expression** key: `lower((email)::text)`, `((a || ' ') || b) DESC NULLS LAST`.
 *
 * Peeled from the RIGHT, because that is the only end whose grammar is fixed: `ruleutils.c`
 * appends `[opclass] [ASC|DESC] [NULLS FIRST|LAST]` after the expression and prints the
 * expression itself either bare (when it "looks like a function") or wrapped in parentheses.
 * Both of those end in `)`, which is the anchor this uses — a remainder that does not is a key
 * shape the recogniser will not guess at, and `pull` records it as residue.
 */
function parseIndexExpressionItem(text: string): IndexItemSpec | null {
  let rest = text.trim();
  let nulls: "first" | "last" | null = null;
  const nullsMatch = /\s+NULLS\s+(FIRST|LAST)$/i.exec(rest);
  if (nullsMatch !== null) {
    nulls = nullsMatch[1]!.toUpperCase() === "FIRST" ? "first" : "last";
    rest = rest.slice(0, nullsMatch.index).trimEnd();
  }
  let desc = false;
  const dirMatch = /\s+(ASC|DESC)$/i.exec(rest);
  if (dirMatch !== null) {
    desc = dirMatch[1]!.toUpperCase() === "DESC";
    rest = rest.slice(0, dirMatch.index).trimEnd();
  }
  let opclass: string | null = null;
  const opclassMatch = /\s+([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?)$/.exec(rest);
  if (opclassMatch !== null && !/^(ASC|DESC|NULLS|COLLATE)$/i.test(opclassMatch[1]!)) {
    opclass = opclassMatch[1]!;
    rest = rest.slice(0, opclassMatch.index).trimEnd();
  }
  // The anchor: once the modifiers are peeled, the expression is either parenthesised or a
  // function call, and both end in `)`. Anything else is a shape this will not guess at.
  if (!rest.endsWith(")")) return null;
  return { column: null, expression: rest, desc, nulls, opclass };
}
