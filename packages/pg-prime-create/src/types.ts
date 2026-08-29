/**
 * The package's public vocabulary, in one file so that `src/versions.ts` — which is generated and
 * git-ignored — carries data and no declarations.
 */

/** The four package managers `--pm` accepts. Detected from `npm_config_user_agent` by default. */
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

/**
 * The dependency ranges written into a scaffolded `package.json`.
 *
 * Generated at build time from the workspace (design/13 decision 6), so a released scaffolder pins
 * the exact versions it shipped beside rather than a range someone typed once.
 */
export interface Versions {
  readonly pgPrime: string
  readonly kit: string
  readonly testing: string
  readonly pg: string
  readonly typescript: string
  readonly typesNode: string
  readonly vitest: string
  readonly pglite: string
}

/** Everything `scaffold()` needs. Nothing here is prompted for, read from `argv` or defaulted. */
export interface ScaffoldOptions {
  /** The target directory, absolute. Created if it does not exist; refused if it is not empty. */
  readonly dir: string
  /** The `name` field of the generated `package.json`. */
  readonly name: string
  /** Write `vitest.config.ts`, `test/setup.ts` and `test/index.test.ts`. */
  readonly testing: boolean
  /** Only ever printed — in the README and in the "next steps" the CLI ends with. */
  readonly packageManager: PackageManager
}

/** What was written, for the CLI to print and for a test to assert on. */
export interface ScaffoldResult {
  readonly dir: string
  /** Every file written, relative to `dir`, sorted. Directories are not listed. */
  readonly files: readonly string[]
}

/**
 * `argv`, parsed and not yet resolved: a flag that was not given is `undefined` rather than its
 * default, because "not given" is what decides whether the prompt runs.
 */
export interface CliOptions {
  /** The positional directory as written, or `undefined` — resolved against the cwd later. */
  readonly dir: string | undefined
  readonly help: boolean
  readonly version: boolean
  readonly yes: boolean
  readonly packageManager: PackageManager | undefined
  readonly testing: boolean | undefined
  readonly install: boolean | undefined
  readonly git: boolean | undefined
}

/** `parseArgs`'s result. Errors are collected rather than thrown, so `--help` still prints. */
export interface ParseResult {
  readonly options: CliOptions
  readonly errors: readonly string[]
}
