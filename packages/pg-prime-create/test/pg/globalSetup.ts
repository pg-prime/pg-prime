/**
 * Build what the tier-2 scaffold e2e installs.
 *
 * CI's `pg` job and every nightly `pg-matrix` leg run `pnpm test:pg` on a fresh checkout with no
 * build in front of it (that is how run 33150450284 went red for the kit), and this suite packs
 * three tarballs. `pg-prime` first: the kit's publish emit resolves its peer dependency through the
 * export map to `packages/pg-prime/dist`.
 */

import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { PKG_DIR, generateVersions } from '../globalSetup.js'

const REPO_ROOT = resolve(PKG_DIR, '../..')

export default function setup(): void {
  generateVersions()
  for (const dir of ['packages/pg-prime', 'packages/pg-prime-kit', 'packages/pg-prime-create']) {
    execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'tools', 'build-package.mjs'), join(REPO_ROOT, dir), '--quiet'],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    )
  }
}
