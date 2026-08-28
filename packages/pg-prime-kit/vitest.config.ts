import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * `pg-prime` resolves to its SOURCE here, mirroring `tsconfig.json`'s `paths` for the typecheck
 * project. The kit imports only types from `pg-prime` (design/11 §1.3), but its tests declare
 * real schemas with `pgTable(...)` and so need the runtime. Without this alias the workspace link
 * resolves through `pg-prime`'s export map to `dist/`, which exists only after `pnpm build` — and
 * CI's `pg` and nightly `pg-matrix` jobs run `pnpm test:pg` on a fresh checkout with no build in
 * front of it (that is how run 33150450284 went red). The published shape is exercised by
 * `tools/pack-smoke.mjs`, not by these tests.
 */
const PG_PRIME_SRC = resolve(import.meta.dirname, "../pg-prime/src");

export default defineConfig({
  resolve: {
    alias: [
      { find: /^pg-prime$/, replacement: resolve(PG_PRIME_SRC, "index.ts") },
      { find: /^pg-prime\/schema$/, replacement: resolve(PG_PRIME_SRC, "schema/index.ts") },
      { find: /^pg-prime\/sql$/, replacement: resolve(PG_PRIME_SRC, "sql/index.ts") },
      { find: /^pg-prime\/codecs$/, replacement: resolve(PG_PRIME_SRC, "codec/index.ts") },
      { find: /^pg-prime\/driver$/, replacement: resolve(PG_PRIME_SRC, "entry/driver.ts") },
    ],
  },
  test: {
    setupFiles: ["./test/setup.ts"],
    // Builds `dist/` once, for the CLI tests that spawn the real binary (R17).
    globalSetup: ["./test/globalSetup.ts"],
  },
});
