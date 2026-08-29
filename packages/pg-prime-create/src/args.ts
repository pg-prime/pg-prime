/**
 * The argument parser and the `--help` text (design/13 decision 8).
 *
 * ~120 lines and no dependency, for the reason the kit's `src/cli/args.ts` gives: the surface is
 * one command with eight long flags, and a CLI framework would be the largest thing in a package
 * whose whole point is that it has nothing in it.
 *
 * The help text is goldened on `docs/reference/create` by `tools/docs-coverage.mjs`, so a flag
 * cannot exist without being documented and cannot be documented without existing.
 */

import { readFileSync } from 'node:fs'
import type { CliOptions, PackageManager, ParseResult } from './types.js'

/** `dist/cli.js` → `dist/../package.json`; `src/args.ts` → the same file. */
const SELF: { readonly version: string } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { readonly version: string }

export const VERSION: string = SELF.version

export const PACKAGE_MANAGERS: readonly PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun']

export const HELP: string = `create-pg-prime — scaffold a pg-prime project

Usage: npm create @pg-prime@latest [directory]
       create-pg-prime [directory] [options]

Options:
  --yes, -y         accept every default and ask nothing (implied when stdin is not a TTY)
  --pm <manager>    npm | pnpm | yarn | bun (default: the one that ran this command)
  --testing         write the vitest + PGlite fixture (default)
  --no-testing      leave the tests out
  --install         install dependencies when the files are written (default)
  --no-install      write the files and stop
  --git             run \`git init\` in the new directory (default)
  --no-git          do not initialise a repository
  --help, -h        print this help
  --version         print the version

The directory is created if it does not exist and must be empty if it does. What lands in it is
the getting-started guide, file for file: schema.ts, db.ts, pg-prime.config.ts, index.ts, an empty
migrations/, and — unless --no-testing — a transaction-per-test fixture on PGlite.

Version ${VERSION}`

/**
 * The package manager that invoked us. `npm_config_user_agent` is `pnpm/10.33.0 npm/? node/v24…`,
 * and every one of the four sets it, which is why this needs no `--pm` to be right most of the
 * time. Anything unrecognised falls back to npm rather than erroring: the value is only ever
 * printed.
 */
export function detectPackageManager(userAgent: string | undefined): PackageManager {
  const name = (userAgent ?? '').split(/\s+/)[0]?.split('/')[0]
  return PACKAGE_MANAGERS.find((pm) => pm === name) ?? 'npm'
}

/** Every flag that is only ever on or off, and so has a `--no-` form. */
const BOOLEANS = ['yes', 'help', 'version', 'testing', 'install', 'git'] as const
type BooleanFlag = (typeof BOOLEANS)[number]
const isBooleanFlag = (name: string): name is BooleanFlag =>
  (BOOLEANS as readonly string[]).includes(name)

const EMPTY: CliOptions = {
  dir: undefined,
  help: false,
  version: false,
  yes: false,
  packageManager: undefined,
  testing: undefined,
  install: undefined,
  git: undefined,
}

/**
 * Long flags, `--flag`, `--no-flag` and `--flag value` / `--flag=value`; `-y` and `-h` are the two
 * short ones a `npm create` user reaches for. One positional, the directory.
 *
 * An unknown flag is an ERROR rather than a positional, for the kit's reason: a typo in
 * `--no-install` that silently ran an install is exactly what this refuses. Errors are collected,
 * so `create-pg-prime --oops --help` still prints the help that would have prevented it.
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  const options: {
    -readonly [K in keyof CliOptions]: CliOptions[K]
  } = { ...EMPTY }
  const errors: string[] = []
  const positionals: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (arg === '-y') {
      options.yes = true
      continue
    }
    if (arg === '-h') {
      options.help = true
      continue
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    const takesNo = name.startsWith('no-') ? name.slice(3) : null

    const flag = takesNo ?? name
    if (isBooleanFlag(flag)) {
      if (inline !== undefined) errors.push(`--${name} does not take a value`)
      options[flag] = takesNo === null
      continue
    }
    if (flag === 'pm' && takesNo === null) {
      const value = inline ?? argv[++i]
      if (value === undefined) {
        errors.push('--pm needs a value (npm, pnpm, yarn or bun)')
        continue
      }
      const pm = PACKAGE_MANAGERS.find((candidate) => candidate === value)
      if (pm === undefined) {
        errors.push(`--pm ${JSON.stringify(value)} is not one of ${PACKAGE_MANAGERS.join(', ')}`)
        continue
      }
      options.packageManager = pm
      continue
    }
    errors.push(`unknown option --${name}`)
  }

  if (positionals.length > 1) {
    errors.push(
      `expected one directory, got ${String(positionals.length)}: ${positionals.join(' ')}`,
    )
  }
  options.dir = positionals[0]

  return { options, errors }
}
