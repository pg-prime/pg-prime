// Every published package under packages/, read from its package.json. The gates iterate this.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** `pg-prime` first, then the rest by directory name. */
export const PACKAGES = readdirSync(join(ROOT, 'packages'))
  .sort((a, b) => (a === 'pg-prime' ? -1 : b === 'pg-prime' ? 1 : a.localeCompare(b)))
  .flatMap((d) => {
    const file = join(ROOT, 'packages', d, 'package.json')
    if (!existsSync(file)) return []
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    return pkg.private ? [] : [{ dir: `packages/${d}`, name: pkg.name, golden: `${d}.json`, pkg }]
  })
