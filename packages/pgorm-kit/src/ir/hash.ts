import { createHash } from "node:crypto";

/** A payload is identity-free JSON: no functions, no undefined, no cycles. */
export type PayloadValue = string | number | boolean | null | PayloadValue[] | { [k: string]: PayloadValue };
export type Payload = { readonly [k: string]: PayloadValue };

/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped.
 * Two fact bases with the same content must serialize byte-identically
 * regardless of insertion order or provenance (D3 / I2).
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  switch (typeof value) {
    case "undefined":
      return "null";
    case "number":
      if (!Number.isFinite(value)) throw new Error(`non-finite number in payload: ${value}`);
      return JSON.stringify(value);
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "object": {
      const rec = value as Record<string, unknown>;
      const keys = Object.keys(rec)
        .filter((k) => rec[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(rec[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`unserializable payload member of type ${typeof value}`);
  }
}

export type Hash = string; // "sha256:<hex>"

export function sha256(text: string): Hash {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function contentHash(payload: unknown): Hash {
  return sha256(canonicalize(payload));
}
