/**
 * design/11 §1.3: the kit imports `pg-prime` for **types only**.
 *
 * A `peerDependency` that is value-imported is a runtime dependency with a friendlier name — it
 * would make `@pg-prime/kit` fail to load when the peer is absent or a different major, and it
 * would put a second copy of the DSL's `Symbol.for` slots in the graph. `import type` is the rule
 * and this is its enforcement: a lint-grade grep over `src/`, because a convention with no check
 * survives exactly one refactor.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/** Every `import … from 'pg-prime…'` / `export … from 'pg-prime…'` line, with its file. */
function pgPrimeImports(): { file: string; line: string }[] {
  const out: { file: string; line: string }[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/^\s*(?:import|export)\b[\s\S]*?from\s+["']pg-prime[^"']*["']/gm)) {
      out.push({ file, line: m[0].replace(/\s+/g, " ").trim() });
    }
    // `await import('pg-prime')` and `require('pg-prime')` are value imports the regex above
    // cannot see, and they are exactly how a type-only rule gets quietly circumvented.
    for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*["']pg-prime[^"']*["']/g)) {
      out.push({ file, line: m[0] });
    }
  }
  return out;
}

describe("the kit imports pg-prime for types only (design/11 §1.3)", () => {
  it("finds at least one import, so the test cannot pass by looking at nothing", () => {
    expect(pgPrimeImports().length).toBeGreaterThan(0);
  });

  it("has no value import of pg-prime anywhere in src/", () => {
    const offenders = pgPrimeImports().filter(
      (i) => !/^\s*(?:import|export)\s+type\b/.test(i.line),
    );
    expect(
      offenders.map((o) => `${o.file.slice(SRC.length + 1)}: ${o.line}`),
      "pg-prime is a peerDependency; only `import type` / `export type` may name it",
    ).toEqual([]);
  });

  it("declares pg-prime as a peerDependency and a workspace devDependency, not a dependency", () => {
    const pkg = JSON.parse(
      readFileSync(join(SRC, "..", "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["pg-prime"]).toBeUndefined();
    expect(pkg.peerDependencies?.["pg-prime"]).toBe(">=0.0.0");
    expect(pkg.devDependencies?.["pg-prime"]).toBe("workspace:*");
  });
});
