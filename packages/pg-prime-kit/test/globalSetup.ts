/**
 * Build `dist/` once per run.
 *
 * design/11 §2 R17: "a CLI test spawns `node dist/cli.js …` (built)". Node's native type
 * stripping does not rewrite a `./cli/main.js` specifier to `./cli/main.ts`, so the ESM
 * source tree is not directly runnable and there is no `tsx` to reach for — the binary
 * under test is the emitted one, which is also the one users get.
 *
 * It lives in `globalSetup` rather than in a memoised helper because vitest runs test
 * files in separate workers, and two workers each doing `rm -rf dist` + `tsc` race.
 */

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "..");
const repoRoot = resolve(pkgDir, "../..");

export default function setup(): void {
  // `pg-prime` first: the kit's publish emit (tsconfig.build.json, `paths: {}`) resolves the peer
  // dependency through its export map to packages/pg-prime/dist, which a fresh checkout — and
  // CI's `pg` / nightly `pg-matrix` jobs, which run `pnpm test:pg` with no build in front of it —
  // does not have. Building the kit alone then fails with TS2307 on `src/schema/types.ts`.
  for (const dir of [resolve(pkgDir, "../pg-prime"), pkgDir]) {
    execFileSync(process.execPath, [join(repoRoot, "tools", "build-package.mjs"), dir, "--quiet"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  }
}
