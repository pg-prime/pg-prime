/**
 * The two renderers.
 *
 * design/06 §6.1: "`--output json` is always non-interactive and always emits
 * `{ status, exitCode, … }`". So the JSON envelope is the contract and the text is the
 * courtesy — the text form is for a human reading a deploy log and is deliberately NOT
 * pinned byte-for-byte by any test (design/11 §2 R17 goldens the envelope, not the prose).
 *
 * Envelopes are built as object literals in a fixed key order, because `JSON.stringify`
 * preserves insertion order and a golden that reorders on every run is not a golden.
 */

export type OutputFormat = "text" | "json";

export interface CommandOutput {
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly text: string;
  readonly exitCode: number;
}

export function render(out: CommandOutput, format: OutputFormat): string {
  return format === "json"
    ? `${JSON.stringify(out.envelope, null, 2)}\n`
    : out.text.endsWith("\n")
      ? out.text
      : `${out.text}\n`;
}

/** Millisecond precision, always UTC, always the same width — one `at` field everywhere. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** `  key   value` pairs, aligned. */
export function pairs(rows: readonly (readonly [string, string])[]): string {
  const width = Math.max(0, ...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`).join("\n");
}

export function bullets(title: string, items: readonly string[]): string {
  if (items.length === 0) return "";
  return `\n${title}\n${items.map((i) => `  - ${i}`).join("\n")}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
