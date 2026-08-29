/**
 * Writing the project (design/13 decision 5).
 *
 * `templates/` is the source of truth for every file that has one, and four of those files are
 * BYTE-EQUAL to the code blocks of `docs/guides/getting-started` — `test/templates.test.ts` fails
 * if they drift, with the page winning. That is the whole design: the scaffold is not "like" the
 * getting-started guide, it is the guide, so a doc that is wrong is a scaffold that is broken and
 * a gate that is red.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PackageManager, ScaffoldOptions, ScaffoldResult } from './types.js'
import { VERSIONS } from './versions.js'

/**
 * `dist/templates` (published) or `templates` beside `src` (this repository).
 *
 * `tools/build-package.mjs` copies the directory into `dist/` on build, so the first branch is
 * what a user gets and the second is what the tests and `pnpm dev` see.
 */
export function templatesDir(): string {
  const built = fileURLToPath(new URL('./templates/', import.meta.url))
  if (existsSync(built)) return built
  return fileURLToPath(new URL('../templates/', import.meta.url))
}

interface TemplateFile {
  /** Path under `templates/`. */
  readonly from: string
  /** Path under the target directory. */
  readonly to: string
}

/**
 * `gitignore` → `.gitignore` is not a style choice: **npm strips a file named `.gitignore` out of
 * the tarball** (measured — `.env.example` and `.gitkeep` survive, `.gitignore` does not), so a
 * dot-named template would be missing from every published copy of this package and present in
 * every local test of it. Storing it undotted is how every scaffolder solves this. `env.example`
 * follows the same rule for one reason: one rule.
 */
const BASE: readonly TemplateFile[] = [
  { from: 'gitignore', to: '.gitignore' },
  { from: 'env.example', to: '.env.example' },
  { from: 'README.md', to: 'README.md' },
  { from: 'db.ts', to: 'db.ts' },
  { from: 'index.ts', to: 'index.ts' },
  { from: 'pg-prime.config.ts', to: 'pg-prime.config.ts' },
  { from: 'schema.ts', to: 'schema.ts' },
  { from: 'tsconfig.json', to: 'tsconfig.json' },
]

const TESTING: readonly TemplateFile[] = [
  { from: 'vitest.config.ts', to: 'vitest.config.ts' },
  { from: 'test/index.test.ts', to: 'test/index.test.ts' },
  { from: 'test/setup.ts', to: 'test/setup.ts' },
]

/** `run` is how the project's own scripts are invoked; `exec` how a `bin` in it is. */
const PM_COMMANDS: Readonly<
  Record<PackageManager, { readonly run: string; readonly exec: string }>
> = {
  npm: { run: 'npm run', exec: 'npx' },
  pnpm: { run: 'pnpm', exec: 'pnpm exec' },
  yarn: { run: 'yarn', exec: 'yarn' },
  bun: { run: 'bun run', exec: 'bunx' },
}

/** A `{{token}}` a template may use. An unknown one throws, which is how a typo is found. */
function tokensFor(options: ScaffoldOptions): Readonly<Record<string, string>> {
  const pm = PM_COMMANDS[options.packageManager]
  return {
    name: options.name,
    pm: options.packageManager,
    pmRun: pm.run,
    pmExec: pm.exec,
    ...VERSIONS,
  }
}

function render(text: string, tokens: Readonly<Record<string, string>>, where: string): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, token: string) => {
    const value = tokens[token]
    if (value === undefined) throw new Error(`${where}: no value for {{${token}}}`)
    return value
  })
}

/**
 * `<!-- testing:start -->` … `<!-- testing:end -->`, on lines of their own, delimit the part of a
 * template that only exists when the tests do. The markers are always removed; the lines between
 * them survive only with `--testing`.
 */
function applyTestingBlocks(text: string, testing: boolean): string {
  const out: string[] = []
  let inside = false
  for (const line of text.split('\n')) {
    const marker = line.trim()
    if (marker === '<!-- testing:start -->') {
      inside = true
      continue
    }
    if (marker === '<!-- testing:end -->') {
      inside = false
      continue
    }
    if (inside && !testing) continue
    out.push(line)
  }
  return out.join('\n')
}

/** Merge the `--testing` fragment into the base `package.json`: scripts and devDependencies. */
function mergePackageJson(
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const key of ['scripts', 'dependencies', 'devDependencies']) {
    const a = base[key]
    const b = extra[key]
    if (b === undefined) continue
    const merged = { ...(a as Record<string, string>), ...(b as Record<string, string>) }
    // Dependencies are sorted, scripts are not: npm writes dependency maps sorted, and a script
    // list reads in the order you use it (build, start, test).
    out[key] =
      key === 'scripts'
        ? merged
        : Object.fromEntries(Object.entries(merged).sort(([x], [y]) => x.localeCompare(y)))
  }
  return out
}

/**
 * The npm name for a directory: `My App` → `my-app`. Anything that is not a valid name character
 * becomes a dash, and a name that survives as nothing at all becomes `app` rather than an
 * unpublishable `package.json`.
 */
export function packageNameFor(dir: string): string {
  const base =
    dir
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? ''
  const name = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
  return name === '' ? 'app' : name
}

/**
 * Entries that do not make a directory "not empty".
 *
 * `.git` because `git init && npm create @pg-prime .` is a reasonable order to do things in, and
 * `.DS_Store` because on macOS it appears in any directory that has been looked at in Finder. Both
 * would otherwise turn the refusal below into a refusal nobody can explain.
 */
const IGNORED_WHEN_EMPTY: ReadonlySet<string> = new Set(['.git', '.DS_Store'])

/** Write the project. Throws if `dir` exists and has anything in it. */
export function scaffold(options: ScaffoldOptions): ScaffoldResult {
  const { dir, testing } = options
  if (existsSync(dir)) {
    const entries = readdirSync(dir).filter((e) => !IGNORED_WHEN_EMPTY.has(e))
    if (entries.length > 0) {
      throw new Error(
        `${dir} is not empty (${entries.slice(0, 5).join(', ')}${entries.length > 5 ? ', …' : ''}) — ` +
          `pick a directory that does not exist yet, or empty this one first`,
      )
    }
  }

  const templates = templatesDir()
  const tokens = tokensFor(options)
  const read = (name: string): string => readFileSync(join(templates, name), 'utf8')
  const written: string[] = []

  // `to` is always written with `/`, so the file list a test asserts on is the same on every
  // platform; only the path handed to the filesystem is joined natively.
  const write = (to: string, text: string): void => {
    const target = join(dir, ...to.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
    written.push(to)
  }

  for (const file of [...BASE, ...(testing ? TESTING : [])]) {
    const raw = applyTestingBlocks(read(file.from), testing)
    write(file.to, render(raw, tokens, `templates/${file.from}`))
  }

  const pkg = JSON.parse(render(read('package.json'), tokens, 'templates/package.json')) as Record<
    string,
    unknown
  >
  const full = testing
    ? mergePackageJson(
        pkg,
        JSON.parse(
          render(read('package.testing.json'), tokens, 'templates/package.testing.json'),
        ) as Record<string, unknown>,
      )
    : pkg
  write('package.json', `${JSON.stringify(full, null, 2)}\n`)

  // `migrations/` ships empty and `pg-prime migrate generate` fills it; git does not track a
  // directory, so the placeholder is the directory.
  write('migrations/.gitkeep', '')

  return { dir, files: [...written].sort() }
}
