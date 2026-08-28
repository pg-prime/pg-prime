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
import type { ObservedObject } from "../catalog/payloads.js";
import type { Diagnostic } from "../catalog/extract.js";
import { quoteIdent } from "../sql/ident.js";

/** A bare identifier PostgreSQL prints unquoted. Anything else has to come back quoted. */
const BARE_IDENT = /^[a-z_][a-z0-9_$]*$/;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every string in every payload is rewritten, recursively — `column.type`, `default.expression`,
 * `constraint.definition`, `index.definition`, `typeAttribute.type`, `type.baseType` / `checks`,
 * `table.partitionKey` / `partitionOf` / `partitionBound`, `extension.schema`, and whatever the
 * next fact kind adds. An enumerated field list was the first version of this file, and design/11
 * K3 made it stale the day it landed (tier-3 fingerprints diverged on `default.expression`).
 *
 * Rewriting blindly is safe *by construction*: the only text ever replaced is a shadow schema
 * name, `pgprime_shadow_<8 random hex>_<schema>`, matched as a whole identifier. Nothing in the
 * user's desired schema can spell a token minted after the schema was written, so a collation or
 * a sequence data type "literally named after a shadow schema" cannot exist on the desired side.
 */
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
  const pairs = [...reverse.entries()].filter(([from, to]) => from !== to).sort((a, b) => b[0].length - a[0].length);
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
    // `comment` is keyed by its TARGET's encoded id (`comment:column:pgprime_shadow_…\.users…`),
    // so the schema lives one level down: parse, remap the target, re-encode.
    if (input.kind === "comment") return { kind: "comment", target: encodeId(id(parseId(input.target))) };
    // `extension` is keyed `[name]` alone (05 §7.2): nothing to remap, and no `schema` to read.
    if (!("schema" in input)) return input;
    const to = reverse.get(input.schema);
    return to === undefined || to === input.schema ? input : ({ ...input, schema: to } as StableId);
  };

  return { text, id };
}

function remapValue(value: PayloadValue, r: Remapper): PayloadValue {
  if (typeof value === "string") return r.text(value);
  if (Array.isArray(value)) return value.map((v) => remapValue(v, r));
  if (value !== null && typeof value === "object") {
    const out: Record<string, PayloadValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = remapValue(v, r);
    return out;
  }
  return value;
}

function remapPayload(kind: string, payload: Payload, r: Remapper): Payload {
  const out: Record<string, PayloadValue> = {};
  for (const [key, value] of Object.entries(payload)) out[key] = remapValue(value, r);
  // `ownedBy` is an ENCODED StableId, not free text: parsed and re-encoded so the escaping rules
  // of `stable-id.ts` stay the single definition of that string's shape.
  if (kind === "sequence") {
    const owned = payload["ownedBy"];
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
  const edges: DependencyEdge[] = ir.edges().map((e) => ({ from: r.id(e.from), to: r.id(e.to), kind: e.kind }));
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

/**
 * Tier-O observations (roles, ACLs, publications, …) carry their identity as text, so the same
 * spelling rule applies: a grant on `pgprime_shadow_ab_public.users` is reported against
 * `public.users`, the name the user wrote.
 */
export function remapObserved(
  observed: readonly ObservedObject[],
  reverse: ReadonlyMap<string, string>,
): ObservedObject[] {
  const r = makeRemapper(reverse);
  return observed.map((o) => ({ ...o, name: r.text(o.name), detail: r.text(o.detail) }));
}
