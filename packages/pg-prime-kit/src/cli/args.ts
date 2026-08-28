/**
 * The argument parser. ~150 lines, no dependency.
 *
 * design/11 §3 K1.4 and design/08 §1.1's dependency budget: the kit's runtime deps are
 * `pg` and nothing else. A CLI framework would be the third-largest thing in the tarball
 * and would buy nothing this file does not do — the surface is four commands with about
 * a dozen flags, all long-form.
 *
 * The specs are also the `--help` text, so a flag cannot exist without being documented.
 */

export type OptionType = "string" | "boolean" | "duration";

export interface OptionSpec {
  readonly name: string;
  readonly type: OptionType;
  readonly describe: string;
  /** `--schema public --schema app` */
  readonly repeatable?: boolean;
  readonly placeholder?: string;
  readonly defaultText?: string;
}

export interface ParseResult {
  readonly values: Readonly<Record<string, string | readonly string[] | boolean | number>>;
  readonly positionals: readonly string[];
  readonly errors: readonly string[];
}

/** `500`, `500ms`, `30s`, `2m` → milliseconds. */
export function parseDuration(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case undefined:
    case "ms":
      return Math.round(n);
    case "s":
      return Math.round(n * 1000);
    case "m":
      return Math.round(n * 60_000);
    default:
      return Math.round(n * 3_600_000);
  }
}

/**
 * Long flags only, `--flag value` or `--flag=value`, `--no-flag` for booleans, `--` ends
 * option parsing. An unknown flag is an ERROR rather than a positional: a typo in
 * `--dry-run` that silently applied a migration is the exact failure this refuses.
 */
export function parseArgs(argv: readonly string[], specs: readonly OptionSpec[]): ParseResult {
  const byName = new Map(specs.map((s) => [s.name, s]));
  const values: Record<string, string | string[] | boolean | number> = {};
  const positionals: string[] = [];
  const errors: string[] = [];

  const set = (spec: OptionSpec, raw: string | true): void => {
    if (spec.type === "boolean") {
      values[spec.name] = raw === true ? true : raw !== "false";
      return;
    }
    if (raw === true) {
      errors.push(`--${spec.name} needs a value`);
      return;
    }
    if (spec.type === "duration") {
      const ms = parseDuration(raw);
      if (ms === null) errors.push(`--${spec.name} ${JSON.stringify(raw)} is not a duration (e.g. 30s, 500ms, 2m)`);
      else values[spec.name] = ms;
      return;
    }
    if (spec.repeatable === true) {
      const prior = values[spec.name];
      values[spec.name] = Array.isArray(prior) ? [...prior, raw] : [raw];
      return;
    }
    values[spec.name] = raw;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h") {
      values["help"] = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim();
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    let spec = byName.get(name);
    if (!spec && name.startsWith("no-")) {
      const positive = byName.get(name.slice(3));
      if (positive?.type === "boolean") {
        if (inline !== undefined) errors.push(`--${name} does not take a value`);
        values[positive.name] = false;
        continue;
      }
    }
    if (!spec) {
      errors.push(`unknown option --${name}`);
      continue;
    }
    if (inline !== undefined) {
      set(spec, inline);
      continue;
    }
    if (spec.type === "boolean") {
      set(spec, true);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || (next.startsWith("--") && next.length > 2)) {
      set(spec, true);
      continue;
    }
    i += 1;
    set(spec, next);
  }

  return { values, positionals, errors };
}

/* -------------------------- typed reads of the bag ------------------------- */

export const str = (v: ParseResult["values"], name: string): string | undefined => {
  const x = v[name];
  return typeof x === "string" ? x : undefined;
};

export const bool = (v: ParseResult["values"], name: string): boolean => v[name] === true;

export const ms = (v: ParseResult["values"], name: string): number | undefined => {
  const x = v[name];
  return typeof x === "number" ? x : undefined;
};

export const list = (v: ParseResult["values"], name: string): readonly string[] | undefined => {
  const x = v[name];
  if (Array.isArray(x)) return x as readonly string[];
  return typeof x === "string" ? [x] : undefined;
};

/** `--help` rendering, from the same specs the parser uses. */
export function renderOptions(specs: readonly OptionSpec[]): string {
  const left = specs.map((s) => `  --${s.name}${s.placeholder ? ` <${s.placeholder}>` : ""}`);
  const width = Math.max(0, ...left.map((l) => l.length));
  return specs
    .map((s, i) => `${left[i]!.padEnd(width)}  ${s.describe}${s.defaultText ? ` (default ${s.defaultText})` : ""}`)
    .join("\n");
}
