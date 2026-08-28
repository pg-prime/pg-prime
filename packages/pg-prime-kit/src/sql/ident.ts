/**
 * Identifier / literal quoting. Mirrors PostgreSQL's `format('%I')` / `%L`.
 *
 * This is a deliberate, self-contained PORT of `pg-prime`'s `sql/ident.ts` rather than an
 * import: `pg-prime` has no build output or entry point yet, and the kit must not take a
 * dependency on one spike's internals to sanitize the other's DDL. The rules below are
 * the ones that file justifies at length (design/03 §3.4); the divergences it used to
 * have here were all in the permissive direction, which is the wrong direction for a
 * function whose output goes straight into `ALTER TABLE`.
 *
 *  - **reject rather than mangle.** An identifier over 63 UTF-8 bytes is silently
 *    truncated by PostgreSQL (`NAMEDATALEN - 1`), so two distinct names can collapse into
 *    one catalog name and DDL then addresses the wrong object.
 *  - **the empty string is not `""`.** PostgreSQL rejects a zero-length quoted identifier.
 *  - **U+0000 cannot be transmitted** in the wire protocol, and a lone surrogate has no
 *    UTF-8 encoding — both are errors, never substitutions.
 *  - **`quoteLiteral` switches to `E'…'` when a backslash is present**, so the result means
 *    the same thing under either setting of `standard_conforming_strings`. Doubling `'`
 *    alone is exactly the gap behind Kysely's GHSA-8cpq-38p9-67gx.
 */

/** `NAMEDATALEN - 1`. The maximum number of UTF-8 bytes PostgreSQL stores in a `name`. */
export const MAX_IDENT_BYTES = 63;

export type IdentifierProblem = "not-a-string" | "empty" | "nul-byte" | "lone-surrogate" | "too-long";

export class InvalidIdentifierError extends Error {
  readonly code = "PG_PRIME_INVALID_IDENTIFIER";
  constructor(
    readonly problem: IdentifierProblem,
    readonly value: unknown,
    detail: string,
  ) {
    super(`invalid identifier (${problem}): ${detail}`);
    this.name = "InvalidIdentifierError";
  }
}

/** UTF-8 byte length, computed rather than delegated so a lone surrogate cannot mask it. */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4; // a paired high surrogate: one 4-byte astral character
      i++;
    } else n += 3;
  }
  return n;
}

/** True iff `s` contains an unpaired UTF-16 surrogate code unit. */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // low surrogate with no preceding high surrogate
    }
  }
  return false;
}

/** True iff `s` contains U+0000, written as a code-unit scan so no source file holds a NUL. */
export function hasNul(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0) return true;
  }
  return false;
}

export function quoteIdent(name: string): string {
  if (typeof name !== "string") {
    throw new InvalidIdentifierError("not-a-string", name, `expected a string, received ${typeof name}`);
  }
  if (name.length === 0) {
    throw new InvalidIdentifierError("empty", name, 'PostgreSQL rejects the zero-length identifier ""');
  }
  if (hasNul(name)) {
    throw new InvalidIdentifierError("nul-byte", name, "contains U+0000, which the wire protocol cannot carry");
  }
  if (hasLoneSurrogate(name)) {
    throw new InvalidIdentifierError("lone-surrogate", name, "contains an unpaired UTF-16 surrogate");
  }
  const bytes = utf8ByteLength(name);
  if (bytes > MAX_IDENT_BYTES) {
    throw new InvalidIdentifierError(
      "too-long",
      name,
      `is ${bytes} UTF-8 bytes; PostgreSQL truncates to ${MAX_IDENT_BYTES}, which can silently ` +
        `collide two distinct names`,
    );
  }
  // PostgreSQL performs NO backslash processing inside a quoted identifier (unlike
  // MySQL, whose differing rule is the root of GHSA-8cpq-38p9-67gx), so `"` is the
  // only character that needs escaping.
  return `"${name.replaceAll('"', '""')}"`;
}

export function quoteQualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

export function quoteLiteral(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`quoteLiteral: expected a string, received ${typeof value}`);
  }
  if (hasNul(value)) throw new RangeError("quoteLiteral: string contains U+0000");
  if (hasLoneSurrogate(value)) throw new RangeError("quoteLiteral: string contains an unpaired UTF-16 surrogate");
  const quoted = value.replaceAll("'", "''");
  return value.includes("\\") ? `E'${quoted.replaceAll("\\", "\\\\")}'` : `'${quoted}'`;
}

/** Non-throwing probe, for tooling that wants to report rather than throw. */
export function isValidIdent(name: unknown): name is string {
  try {
    quoteIdent(name as string);
    return true;
  } catch {
    return false;
  }
}

/* ------------------- PostgreSQL's own auto-naming rule ------------------- */

/** `NAMEDATALEN`. `MAX_IDENT_BYTES` is this minus the terminating NUL. */
const NAMEDATALEN = MAX_IDENT_BYTES + 1;

/** Clip to at most `maxBytes` UTF-8 bytes without splitting a character (`pg_mbcliplen`). */
function clipToBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let n = maxBytes;
  // 0b10xxxxxx is a UTF-8 continuation byte: cutting there would split a character.
  while (n > 0 && (buf[n]! & 0xc0) === 0x80) n -= 1;
  return buf.subarray(0, n).toString("utf8");
}

/**
 * A port of PostgreSQL's `makeObjectName` (`src/backend/commands/indexcmds.c`), which is
 * how the server names every object you do not name yourself.
 *
 * The truncation is the whole reason this is a port and not a template string. Names
 * are clipped to `NAMEDATALEN - 1` BYTES, and when the pieces do not fit the server
 * shortens the LONGER of the two, one byte at a time, until they do — so
 * `<30 chars>_<30 chars>_not_null` becomes `<27>_<26>_not_null`, not a right-truncation
 * of the concatenation. Getting that wrong means `cascadeNotNullRenames` renames a
 * constraint to a name a fresh `CREATE TABLE` would never have produced, and the D10
 * dump oracle fails on the very drift this code exists to remove.
 *
 * The uniquifying suffix lives in `chooseConstraintName` below, which calls this in a
 * loop exactly as the server does.
 */
export function makeObjectName(name1: string, name2: string | null, label: string): string {
  let overhead = utf8ByteLength(label) + 1;
  let name1bytes = utf8ByteLength(name1);
  let name2bytes = 0;
  if (name2 !== null) {
    name2bytes = utf8ByteLength(name2);
    overhead += 1; // the separating underscore
  }
  const availBytes = NAMEDATALEN - 1 - overhead;
  while (name1bytes + name2bytes > availBytes && name1bytes + name2bytes > 0) {
    if (name1bytes > name2bytes) name1bytes -= 1;
    else name2bytes -= 1;
  }
  const first = clipToBytes(name1, name1bytes);
  const second = name2 === null ? "" : `_${clipToBytes(name2, name2bytes)}`;
  return `${first}${second}_${label}`;
}

/**
 * More passes than any real schema needs. A `taken` predicate that answers `true`
 * unconditionally is a caller bug, and looping forever hides it.
 */
const MAX_NAME_PASSES = 1000;

/**
 * A port of `ChooseConstraintName` (`src/backend/catalog/index.c`) — `makeObjectName`
 * in a loop, with a **uniquifying suffix on the LABEL**, not on the finished name.
 *
 * The distinction matters twice. The suffix goes inside the truncation window, so the
 * server re-derives the whole name at every pass (`<27>_<26>_not_null1`, not
 * `<27>_<26>_not_null` + `1`, which would be 64 bytes and get clipped somewhere else).
 * And it has no underscore: PostgreSQL writes `t_a_key1`, never `t_a_key_1`.
 *
 * `taken` is the caller's view of the namespace, because the two server functions that
 * wrap this loop consult different catalogs and we need both:
 *
 *  - `ChooseConstraintName` — `pg_constraint` rows in the relation's namespace. This is
 *    what names an unnamed NOT NULL (PG >= 18) and an unnamed CHECK;
 *  - `ChooseRelationName` — `pg_class` names in the namespace, plus `pg_constraint`
 *    when the name is also a constraint's. This is what names `t_a_key` / `t_pkey` /
 *    `t_a_idx` / `t_a_excl`.
 *
 * The consumer that makes this load-bearing rather than decorative is §3.5's lock-safe
 * `SET NOT NULL` rewrite on PG 15–17: it INVENTS a temporary CHECK constraint, and a
 * schema that already has a constraint under the plain name is exactly the case where a
 * blind `makeObjectName` emits DDL PostgreSQL rejects with "constraint … already exists"
 * (`fixtures/diff/name-collision`).
 */
export function chooseConstraintName(
  name1: string,
  name2: string | null,
  label: string,
  taken: (candidate: string) => boolean,
): string {
  for (let pass = 0; pass <= MAX_NAME_PASSES; pass++) {
    const candidate = makeObjectName(name1, name2, pass === 0 ? label : `${label}${pass}`);
    if (!taken(candidate)) return candidate;
  }
  throw new Error(
    `chooseConstraintName: ${MAX_NAME_PASSES} candidates for ${name1}/${name2 ?? "-"}/${label} were all reported taken`,
  );
}

/**
 * The name PostgreSQL >= 18 gives a column's NOT NULL constraint when you do not name
 * it — `ChooseConstraintName(relname, attname, "not_null", …)` with nothing in the way.
 *
 * Deliberately the *unsuffixed* form, and deliberately what the extractor compares
 * against. A suffixed name does not compare equal, so the extractor classifies it as a
 * USER name and carries it verbatim — the safe direction, and the only one that
 * converges: PostgreSQL picks the suffix from the catalog state at the moment the
 * constraint is created, which for a plan is the middle of an apply, not the end of it.
 * We never invent a name we cannot also spell out.
 */
export function defaultNotNullName(table: string, column: string): string {
  return makeObjectName(table, column, "not_null");
}
