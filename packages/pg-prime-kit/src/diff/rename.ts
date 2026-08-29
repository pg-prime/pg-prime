import { GENERATED_NAME } from "../catalog/payloads.js";
import type { Payload } from "../ir/hash.js";
import { SchemaIR, type DependencyEdge, type Fact } from "../ir/fact.js";
import { encodeId, parseId, type StableId } from "../ir/stable-id.js";
import { defaultNotNullName } from "../sql/ident.js";
import { lexSql } from "../sql/statements.js";
import type { RenameHint, RenameRecord } from "./delta.js";

export interface RenameApplication {
  /** the CURRENT ir, rewritten as if every accepted rename had already happened */
  readonly ir: SchemaIR;
  readonly accepted: RenameRecord[];
  readonly rejected: { hint: RenameHint; reason: string }[];
}

const asId = (v: StableId | string): StableId => (typeof v === "string" ? parseId(v) : v);

/**
 * Rewrite an identifier under a rename. Table renames cascade to the ids of
 * their columns and constraints — hierarchy is a view, so the cascade is a pure
 * id rewrite with no structural surgery.
 */
function remapId(id: StableId, from: StableId, to: StableId): StableId {
  if (encodeId(id) === encodeId(from)) return to;
  if (from.kind === "table" && to.kind === "table") {
    if ((id.kind === "column" || id.kind === "constraint") && id.schema === from.schema && id.table === from.name) {
      return { ...id, schema: to.schema, table: to.name };
    }
  }
  return id;
}

/* ------------------------ definitions under a rename ------------------------ */

/**
 * Definitions are NOT rewritten.
 *
 * The old implementation regex-substituted the new name into every stored definition on
 * the renamed table. Four things were wrong with that, and all four are load-bearing:
 *
 *  1. it always emitted the QUOTED form, while `pg_get_indexdef`/`pg_get_constraintdef`
 *     emit a bare name when they legally can — so the hashes still differed and every
 *     dependent index and constraint was planned as a DROP + CREATE. For an FK that
 *     means `NOT VALID` + a full-table `VALIDATE`; for a PK, a DROP that PostgreSQL
 *     refuses while anything depends on it;
 *  2. it substituted inside string literals, silently editing a CHECK body;
 *  3. it never looked at FKs on OTHER tables that reference the renamed table;
 *  4. an auto-named PK became a drop+add instead of a `RENAME CONSTRAINT`.
 *
 * Instead, the definition is taken from the DESIRED side — PostgreSQL's own spelling —
 * whenever the two agree once the rename is accounted for. Agreement is decided on a
 * TOKEN stream, so a literal is compared verbatim and only identifier tokens can match
 * across the rename.
 */
type Token = { readonly ident: string } | { readonly text: string };

const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c) || c.charCodeAt(0) > 127;
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 127;

/**
 * Split a stored definition into identifier tokens and everything else.
 *
 * The lexer classifies string literals, dollar-quoted bodies and comments, so those can
 * never be treated as names — that is what stopped the textual rewriter from editing a
 * CHECK body. A DOUBLE-quoted identifier yields the same token as the bare spelling of
 * the same name, so `"full_name"` and `full_name` compare equal; bridging exactly that
 * difference is why the old rewriter's always-quoted output still produced a phantom
 * diff against `pg_get_indexdef`'s bare output.
 */
export function tokenizeDefinition(def: string): Token[] {
  const out: Token[] = [];
  let text = "";
  const flush = (): void => {
    if (text) {
      out.push({ text });
      text = "";
    }
  };
  const pushText = (chunk: string): void => {
    for (const c of chunk) {
      // A whitespace run is one separator: PostgreSQL's own reflowing is not a change.
      text += /\s/.test(c) ? (text.endsWith(" ") ? "" : " ") : c;
    }
  };

  for (const seg of lexSql(def)) {
    if (seg.kind === "comment") continue;
    if (seg.kind === "literal") {
      if (seg.text.startsWith('"')) {
        // a quoted IDENTIFIER, not a string: unquote it so it compares with the bare form
        const body = seg.text.replace(/^"/, "").replace(/"$/, "");
        flush();
        out.push({ ident: body.replaceAll('""', '"') });
      } else {
        flush();
        out.push({ text: seg.text }); // a string literal, compared byte for byte
      }
      continue;
    }
    let i = 0;
    while (i < seg.text.length) {
      const c = seg.text[i]!;
      if (isIdentStart(c)) {
        let j = i;
        let value = "";
        while (j < seg.text.length && isIdentPart(seg.text[j]!)) {
          value += seg.text[j];
          j += 1;
        }
        flush();
        out.push({ ident: value });
        i = j;
        continue;
      }
      pushText(c);
      i += 1;
    }
  }
  flush();
  return out;
}

/** old identifier -> new identifier, accumulated over every accepted rename */
type RenameMap = ReadonlyMap<string, string>;

/**
 * Do two definitions say the same thing, once the accepted renames are applied?
 *
 * Note the asymmetry: an identifier is allowed to differ ONLY in the renamed
 * direction. A definition that changed for any other reason still produces a real
 * `alter` delta, which is what keeps this from being a way to hide a diff.
 */
export function definitionsAgreeUnderRename(currentDef: string, desiredDef: string, renames: RenameMap): boolean {
  if (currentDef === desiredDef) return true;
  const a = tokenizeDefinition(currentDef);
  const b = tokenizeDefinition(desiredDef);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if ("ident" in x !== "ident" in y) return false;
    if ("ident" in x && "ident" in y) {
      if (x.ident === y.ident) continue;
      if (renames.get(x.ident) === y.ident) continue;
      return false;
    }
    if ("text" in x && "text" in y && x.text !== y.text) return false;
  }
  return true;
}

const definitionOf = (f: Fact): string | null =>
  typeof f.payload["definition"] === "string" ? f.payload["definition"] : null;

/* --------------------- enum labels, which live in literals -------------------- */

interface LabelRename {
  readonly from: string;
  readonly to: string;
  readonly schema: string;
  readonly type: string;
}

/** Every payload field that holds server-rendered expression text an enum constant can sit in. */
const RENDERED_TEXT_KEYS = ["definition", "expression", "default"] as const;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `'user'` → `'member'`, but **only** where it is immediately cast to the renamed enum type.
 *
 * PostgreSQL renders an enum constant as `'label'::[schema.]type` everywhere it appears — a
 * DEFAULT, a CHECK body, a partial index predicate — and rewrites all of them itself when the
 * label is renamed, because the constant holds the `pg_enum` row's oid rather than the text. The
 * cast is what makes this a safe substitution and not the textual rewriting design/06 §3.3 threw
 * out: a plain `note <> 'user'` on a text column has no cast, is not touched, and stays a real
 * difference.
 */
function substituteLabel(text: string, r: LabelRename): string {
  const lit = escapeRe(r.from.replaceAll("'", "''"));
  const part = (name: string): string => `(?:"${escapeRe(name.replaceAll('"', '""'))}"|${escapeRe(name)})`;
  const cast = `::(?:${part(r.schema)}\\.)?${part(r.type)}(?![\\w$])`;
  return text.replace(new RegExp(`'${lit}'(?=${cast})`, "g"), `'${r.to.replaceAll("'", "''")}'`);
}

/**
 * Adopt the desired side's rendering of a fact whose ONLY difference is a renamed label.
 *
 * The adoption is conditional on landing **exactly** on PostgreSQL's own desired text, so this
 * can never hide a difference: if the substitution does not reproduce the desired string, the
 * original stays and the differ plans the change it really is.
 */
function adoptRenamedLabels(f: Fact, desired: SchemaIR, labels: readonly LabelRename[]): Fact {
  const target = desired.get(f.id);
  if (!target) return f;
  let payload = f.payload;
  for (const key of RENDERED_TEXT_KEYS) {
    const have = payload[key];
    const want = target.payload[key];
    if (typeof have !== "string" || typeof want !== "string" || have === want) continue;
    if (labels.reduce((text, r) => substituteLabel(text, r), have) !== want) continue;
    payload = { ...payload, [key]: want };
  }
  return payload === f.payload ? f : { ...f, payload };
}

/** Payload equality ignoring `definition`, which is compared through the rename map. */
function payloadAgrees(a: Payload, b: Payload, renames: RenameMap): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (k === "definition") {
      const da = a[k];
      const db = b[k];
      if (typeof da !== "string" || typeof db !== "string") return da === db;
      if (!definitionsAgreeUnderRename(da, db, renames)) return false;
      continue;
    }
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * D5 — annotation is the only authority. A hint applies iff the old id exists
 * on the CURRENT side and the new id does not (the `renamedFrom` firing rule
 * from design/05); anything else is rejected with a reason rather than guessed.
 */
export function applyRenameHints(
  current: SchemaIR,
  desired: SchemaIR,
  hints: readonly RenameHint[],
): RenameApplication {
  const accepted: RenameRecord[] = [];
  const rejected: { hint: RenameHint; reason: string }[] = [];
  let facts = current.facts();
  let edges = current.edges();
  const renames = new Map<string, string>();
  /** enum-label renames, which the definition comparison above cannot see (see §1b below) */
  const labelRenames: LabelRename[] = [];
  /** `schema.table` of every table a rename touched — the blast radius of the cascade */
  const affectedTables = new Set<string>();
  /**
   * Current (post-remap) encoded id -> the id that fact had BEFORE any rename.
   *
   * `remapId` is destructive: once `column:public.tenants.id` has become
   * `column:public.accounts.id` there is nothing left to say what PostgreSQL actually
   * named its auto-named dependents. The NOT NULL cascade needs both endpoints, so the
   * origin is carried alongside instead of being reconstructed by inverting the hints.
   */
  let originOf = new Map<string, StableId>(facts.map((f) => [encodeId(f.id), f.id]));

  for (const hint of hints) {
    const from = asId(hint.from);
    const to = asId(hint.to);
    if (from.kind !== to.kind) {
      rejected.push({ hint, reason: `kind mismatch: ${from.kind} -> ${to.kind}` });
      continue;
    }
    if (!facts.some((f) => encodeId(f.id) === encodeId(from))) {
      rejected.push({ hint, reason: `no such fact on the current side: ${encodeId(from)}` });
      continue;
    }
    if (facts.some((f) => encodeId(f.id) === encodeId(to))) {
      rejected.push({ hint, reason: `target already exists on the current side: ${encodeId(to)}` });
      continue;
    }
    if (!desired.has(to)) {
      rejected.push({ hint, reason: `target absent from the desired side: ${encodeId(to)}` });
      continue;
    }

    const oldName = from.kind === "schema" ? from.schema : (from as { name: string }).name;
    const newName = to.kind === "schema" ? to.schema : (to as { name: string }).name;
    // A label is not an identifier: it is rendered as `'label'::the_type`, so putting it in
    // `renames` would make the token comparison treat two literals as interchangeable.
    if (from.kind === "enumLabel" && to.kind === "enumLabel") {
      labelRenames.push({ from: from.name, to: to.name, schema: from.schema, type: from.type });
    } else {
      renames.set(oldName, newName);
    }
    if (from.kind === "table" && to.kind === "table") affectedTables.add(`${to.schema}.${to.name}`);
    if (from.kind === "column") affectedTables.add(`${from.schema}.${from.table}`);

    const nextOrigin = new Map<string, StableId>();
    facts = facts.map((f): Fact => {
      const id = remapId(f.id, from, to);
      const parent = f.parent ? remapId(f.parent, from, to) : undefined;
      nextOrigin.set(encodeId(id), originOf.get(encodeId(f.id)) ?? f.id);
      return { ...f, id, ...(parent ? { parent } : {}) };
    });
    originOf = nextOrigin;
    edges = edges.map((e): DependencyEdge => ({ ...e, from: remapId(e.from, from, to), to: remapId(e.to, from, to) }));

    accepted.push({
      kind: from.kind,
      from: encodeId(from),
      to: encodeId(to),
      source: "annotation",
      confidence: "unambiguous",
    });
  }

  if (accepted.length === 0) return { ir: current, accepted, rejected };

  /* ---- 1. adopt PostgreSQL's own spelling for every id-matched definition ---- */
  facts = facts.map((f): Fact => {
    const def = definitionOf(f);
    if (def === null) return f;
    const target = desired.get(f.id);
    const targetDef = target ? definitionOf(target) : null;
    if (targetDef === null || targetDef === def) return f;
    if (!definitionsAgreeUnderRename(def, targetDef, renames)) return f;
    return { ...f, payload: { ...f.payload, definition: targetDef } };
  });

  /* ---- 1b. an enum LABEL lives inside a literal, not in an identifier ---- */
  if (labelRenames.length > 0) facts = facts.map((f) => adoptRenamedLabels(f, desired, labelRenames));

  /* ---- 2. auto-named dependents: RENAME, not drop + add ---- */
  const cascade = cascadeRenames(facts, desired, renames, affectedTables);
  if (cascade.length > 0) {
    const remap = new Map(cascade.map((c) => [encodeId(c.from), c] as const));
    facts = facts.map((f): Fact => {
      const hit = remap.get(encodeId(f.id));
      if (!hit) return f;
      return {
        ...f,
        id: hit.to,
        ...(hit.definition === null ? {} : { payload: { ...f.payload, definition: hit.definition } }),
      };
    });
    edges = edges.map((e): DependencyEdge => {
      const a = remap.get(encodeId(e.from));
      const b = remap.get(encodeId(e.to));
      return { ...e, ...(a ? { from: a.to } : {}), ...(b ? { to: b.to } : {}) };
    });
    for (const c of cascade) {
      accepted.push({
        kind: c.to.kind,
        from: encodeId(c.from),
        to: encodeId(c.to),
        source: "cascade",
        confidence: "unambiguous",
      });
    }
  }

  /* ---- 3. the NOT NULL constraints PostgreSQL 18 gave names to ---- */
  for (const c of cascadeNotNullRenames(facts, desired, originOf, affectedTables)) {
    accepted.push({
      kind: "constraint",
      from: encodeId(c.from),
      to: encodeId(c.to),
      source: "cascade",
      confidence: "unambiguous",
    });
  }

  return { ir: SchemaIR.build(facts, edges), accepted, rejected };
}

interface CascadeRename {
  readonly from: StableId;
  readonly to: StableId;
  readonly definition: string | null;
}

/**
 * PostgreSQL does not rename `users_first_name_idx` when you rename the column, but a
 * freshly-built desired database calls it `users_name_idx`. Left alone that is a phantom
 * DROP + CREATE of every dependent index and constraint.
 *
 * The pairing is I1's hash join, narrowed twice so it can never become rename
 * *inference*: only constraints and indexes on a table an accepted rename actually
 * touched are considered, and a candidate is accepted only when it is the UNIQUE match
 * on both sides. Two indistinguishable indexes stay a drop+create.
 */
function cascadeRenames(
  facts: readonly Fact[],
  desired: SchemaIR,
  renames: RenameMap,
  affectedTables: ReadonlySet<string>,
): CascadeRename[] {
  const onAffectedTable = (f: Fact): boolean =>
    f.parent?.kind === "table" && affectedTables.has(`${f.parent.schema}.${f.parent.name}`);
  const eligible = (f: Fact): boolean => (f.id.kind === "constraint" || f.id.kind === "index") && onAffectedTable(f);

  const currentKeys = new Set(facts.map((f) => encodeId(f.id)));
  const currentOnly = facts.filter((f) => eligible(f) && !desired.has(f.id));
  const desiredOnly = desired.facts().filter((f) => eligible(f) && !currentKeys.has(encodeId(f.id)));
  if (currentOnly.length === 0 || desiredOnly.length === 0) return [];

  const out: CascadeRename[] = [];
  const claimed = new Set<string>();
  for (const from of currentOnly) {
    const matches = desiredOnly.filter(
      (to) =>
        to.id.kind === from.id.kind &&
        !claimed.has(encodeId(to.id)) &&
        payloadAgrees(from.payload, to.payload, renames),
    );
    if (matches.length !== 1) continue;
    const to = matches[0]!;
    // Symmetry: the target must not be an equally good match for someone else.
    const reverse = currentOnly.filter(
      (other) => other.id.kind === to.id.kind && payloadAgrees(other.payload, to.payload, renames),
    );
    if (reverse.length !== 1) continue;
    claimed.add(encodeId(to.id));
    out.push({ from: from.id, to: to.id, definition: definitionOf(to) });
  }
  return out;
}

/**
 * PostgreSQL 18 gave NOT NULL a `pg_constraint` row, and therefore a name — and did not
 * teach `RENAME COLUMN` / `RENAME TO` to carry that name along, exactly as it never
 * carried an auto-named PK or index. `pg_dump` 18 prints `CONSTRAINT <name> NOT NULL`
 * whenever the name is not the default for the column, so a rename that leaves
 * `users_first_name_not_null` sitting on `users.name` dumps differently from a fresh
 * `CREATE TABLE` and D10's oracle — correctly — calls the plan unconverged. This is
 * PostgreSQL 18's only behavioural change that reaches the differ.
 *
 * Unlike `cascadeRenames` this is not a hash join and cannot become rename *inference*:
 * both endpoints are COMPUTED from identity. The old name is the server's default for
 * the id the column had before the rename, the new one is its default for the id it has
 * after, and nothing is emitted unless the payload says the constraint carried a
 * generated name on BOTH sides. A user-named NOT NULL keeps its name — it is the user's,
 * and a rename is not permission to change it.
 *
 * The `from` id names the constraint on the NEW table, because that is what
 * `ALTER TABLE … RENAME CONSTRAINT` has to address once the table rename in the same
 * phase has run; the dependency on the renamed table is what orders the two.
 */
function cascadeNotNullRenames(
  facts: readonly Fact[],
  desired: SchemaIR,
  originOf: ReadonlyMap<string, StableId>,
  affectedTables: ReadonlySet<string>,
): { readonly from: StableId; readonly to: StableId }[] {
  const out: { from: StableId; to: StableId }[] = [];
  for (const f of facts) {
    if (f.id.kind !== "column") continue;
    if (!affectedTables.has(`${f.id.schema}.${f.id.table}`)) continue;
    // Only a generated name is ours to fix, and only when the desired side wants a
    // generated one too — otherwise this is a real alter, not a cascade.
    if (f.payload["notNullConstraint"] !== GENERATED_NAME) continue;
    if (desired.get(f.id)?.payload["notNullConstraint"] !== GENERATED_NAME) continue;
    const origin = originOf.get(encodeId(f.id));
    if (origin === undefined || origin.kind !== "column") continue;
    const from = defaultNotNullName(origin.table, origin.name);
    const to = defaultNotNullName(f.id.table, f.id.name);
    if (from === to) continue;
    out.push({
      from: { kind: "constraint", schema: f.id.schema, table: f.id.table, name: from },
      to: { kind: "constraint", schema: f.id.schema, table: f.id.table, name: to },
    });
  }
  return out;
}
