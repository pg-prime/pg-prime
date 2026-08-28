/**
 * Reversing the tier-3 schema map on the extracted IR (design/11 §1.6, §3 K2a item 4).
 *
 * The desired state is loaded into `pgprime_shadow_<rand>_public`, so everything the extractor
 * reads back says `pgprime_shadow_<rand>_public` — and the IR it produces would diff against the
 * target's `public` as "drop 12 tables, create 12 tables". This module renames it back.
 *
 * Two kinds of place carry a schema name, and missing either one is silent:
 *
 *  1. **Identity.** Every `StableId` has a `schema` part (design/06 D2: a fact's name lives in its
 *     id, never in its hashed payload), and so does every edge endpoint. Rewriting these is
 *     mechanical.
 *  2. **Payload text produced by the server.** `format_type`, `pg_get_expr`,
 *     `pg_get_constraintdef` and `pg_get_indexdef` all print user objects schema-qualified — the
 *     extractor runs with `search_path = pg_catalog` precisely so that they always do — so
 *     `ColumnPayload.type`, `ColumnPayload.default`, `ConstraintPayload.definition` and
 *     `IndexPayload.definition` each embed the shadow schema's name. These are *hashed*, so a
 *     missed one is not a cosmetic wart: it is a content hash that never matches the target's and
 *     a plan that rewrites an object that did not change. The round-trip test is what proves the
 *     list above is complete.
 */

import { SchemaIR, type DependencyEdge, type Fact } from "../ir/fact.js";
import type { Payload, PayloadValue } from "../ir/hash.js";
import { encodeId, parseId, type StableId } from "../ir/stable-id.js";
import type { Diagnostic } from "../catalog/extract.js";
import { quoteIdent } from "../sql/ident.js";

/** A bare identifier PostgreSQL prints unquoted. Anything else has to come back quoted. */
const BARE_IDENT = /^[a-z_][a-z0-9_$]*$/;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Payload members that can embed a schema-qualified name, by payload `kind`.
 *
 * Enumerated rather than "rewrite every string in the payload", because rewriting blindly would
 * also touch `ColumnPayload.collation` and `SequencePayload.dataType`, and a collation literally
 * named after a shadow schema is a bug we would then create rather than avoid.
 */
const TEXT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  column: ["type", "default"],
  constraint: ["definition"],
  index: ["definition"],
};

export interface Remapper {
  /** Rewrite one piece of server-produced SQL text. */
  readonly text: (s: string) => string;
  readonly id: (id: StableId) => StableId;
}

/**
 * Build the rewriter for `shadow schema → user schema`.
 *
 * The quoted spelling is replaced first, so that the bare rule cannot leave a stray `"` behind;
 * both spellings exist because `pg_get_*def` quotes an identifier only when it has to.
 */
export function makeRemapper(reverse: ReadonlyMap<string, string>): Remapper {
  const rules: { readonly re: RegExp; readonly to: string }[] = [];
  // Longest first: `pgprime_shadow_ab_public` must not be half-matched by a rule for
  // `pgprime_shadow_ab` if both are in the map.
  const pairs = [...reverse.entries()]
    .filter(([from, to]) => from !== to)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of pairs) {
    const spelled = BARE_IDENT.test(to) ? to : quoteIdent(to);
    rules.push({ re: new RegExp(`"${escapeRe(from)}"`, "g"), to: spelled });
    // No `"` on either side: the quoted form is already handled, and a bare match must not eat
    // half of a longer identifier (`pgprime_shadow_ab_public_extra`).
    rules.push({
      re: new RegExp(`(?<![A-Za-z0-9_$"])${escapeRe(from)}(?![A-Za-z0-9_$"])`, "g"),
      to: spelled,
    });
  }

  const text = (s: string): string => {
    let out = s;
    // A function replacement, not a string: `$&` / `$1` in a schema name would otherwise be
    // interpreted as a capture reference, and `$` is legal in a PostgreSQL identifier.
    for (const r of rules) out = out.replace(r.re, () => r.to);
    return out;
  };

  const id = (input: StableId): StableId => {
    const to = reverse.get(input.schema);
    return to === undefined || to === input.schema
      ? input
      : ({ ...input, schema: to } as StableId);
  };

  return { text, id };
}

function remapPayload(kind: string, payload: Payload, r: Remapper): Payload {
  const fields = TEXT_FIELDS[kind];
  const out: Record<string, PayloadValue> = { ...payload };
  for (const key of fields ?? []) {
    const value = out[key];
    if (typeof value === "string") out[key] = r.text(value);
  }
  // `ownedBy` is an ENCODED StableId, not free text: parsed and re-encoded so the escaping rules
  // of `stable-id.ts` stay the single definition of that string's shape.
  if (kind === "sequence") {
    const owned = out["ownedBy"];
    if (typeof owned === "string" && owned !== "") out["ownedBy"] = encodeId(r.id(parseId(owned)));
  }
  return out;
}

/** Rewrite a whole IR from shadow schema names back into the caller's own. */
export function remapIr(ir: SchemaIR, reverse: ReadonlyMap<string, string>): SchemaIR {
  const r = makeRemapper(reverse);
  const facts: Fact[] = ir.facts().map((f) => {
    const kind = typeof f.payload["kind"] === "string" ? f.payload["kind"] : f.id.kind;
    const next: Fact = {
      id: r.id(f.id),
      payload: remapPayload(kind, f.payload, r),
      provenance: f.provenance,
      ...(f.parent === undefined ? {} : { parent: r.id(f.parent) }),
      ...(f.ordinal === undefined ? {} : { ordinal: f.ordinal }),
    };
    return next;
  });
  const edges: DependencyEdge[] = ir
    .edges()
    .map((e) => ({ from: r.id(e.from), to: r.id(e.to), kind: e.kind }));
  return SchemaIR.build(facts, edges);
}

/** The same rename applied to diagnostics, so a message never names a schema the user has not got. */
export function remapDiagnostics(
  diagnostics: readonly Diagnostic[],
  reverse: ReadonlyMap<string, string>,
): Diagnostic[] {
  const r = makeRemapper(reverse);
  return diagnostics.map((d) => ({
    ...d,
    message: r.text(d.message),
    ...(d.subject === undefined ? {} : { subject: r.text(d.subject) }),
  }));
}
