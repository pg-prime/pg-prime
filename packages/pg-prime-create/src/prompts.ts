/**
 * Turning `argv` plus a terminal into a plan (design/13 decision 8).
 *
 * `node:readline/promises` and nothing else: four questions do not need a prompt library, and this
 * package's one hard promise is that `npm create @pg-prime` downloads no dependency tree to write
 * eleven files. There is no colour for the same reason — no `chalk`, and no hand-rolled ANSI that
 * would have to grow a `NO_COLOR` check.
 */

import { createInterface } from 'node:readline/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { CliOptions, PackageManager } from './types.js'
import { detectPackageManager } from './args.js'
import { packageNameFor } from './scaffold.js'

/**
 * Where the prompts read and write, and what the defaults are read from. Injected, so it tests.
 *
 * `node:stream` rather than the `NodeJS.*` globals: `tools/check-dts.mjs` compiles the emitted
 * declarations with `types: []`, where `NodeJS.WritableStream` is a missing namespace. An imported
 * type resolves there; an ambient one does not.
 */
export interface PromptIo {
  readonly input: Readable & { readonly isTTY?: boolean | undefined }
  readonly output: Writable
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
}

/** Everything `main` needs after the questions: `ScaffoldOptions` plus the two side effects. */
export interface ProjectPlan {
  readonly dir: string
  readonly name: string
  readonly testing: boolean
  readonly packageManager: PackageManager
  readonly install: boolean
  readonly git: boolean
}

/** The directory a `--yes` run with no positional writes into. */
export const DEFAULT_DIR = 'pg-prime-app'

/**
 * `y`/`yes` and `n`/`no`, case-insensitively; empty takes the default.
 *
 * Anything else is also the default rather than a re-ask: a scaffolder that argues with a typo is
 * worse than one that shows what it decided, and the last thing `main` prints is the plan.
 */
function yesNo(answer: string, fallback: boolean): boolean {
  const value = answer.trim().toLowerCase()
  if (value === 'y' || value === 'yes') return true
  if (value === 'n' || value === 'no') return false
  return fallback
}

/**
 * Resolve the plan, asking only for what `argv` did not say.
 *
 * A non-TTY stdin implies `--yes` — a CI job, a `| sh`, or an editor task runner has nobody to
 * answer, and blocking on a question nothing will ever answer is a hang rather than an error.
 */
export async function resolveOptions(cli: CliOptions, io: PromptIo): Promise<ProjectPlan> {
  const packageManager = cli.packageManager ?? detectPackageManager(io.env['npm_config_user_agent'])
  const interactive = io.input.isTTY === true && !cli.yes

  let dir = cli.dir
  let testing = cli.testing
  let install = cli.install
  let git = cli.git

  if (interactive) {
    const rl = createInterface({ input: io.input, output: io.output })
    try {
      if (dir === undefined) {
        dir = (await rl.question(`Directory (${DEFAULT_DIR}): `)).trim() || DEFAULT_DIR
      }
      if (testing === undefined) {
        testing = yesNo(await rl.question('Add a vitest + PGlite test fixture? (Y/n) '), true)
      }
      if (install === undefined) {
        install = yesNo(
          await rl.question(`Install dependencies with ${packageManager}? (Y/n) `),
          true,
        )
      }
      if (git === undefined) {
        git = yesNo(await rl.question('Initialise a git repository? (Y/n) '), true)
      }
    } finally {
      rl.close()
    }
  }

  // Resolved before the name is taken from it, so `create-pg-prime .` is named after the directory
  // the user is standing in rather than after `.`.
  const target = dir ?? DEFAULT_DIR
  const absolute = isAbsolute(target) ? target : resolve(io.cwd, target)
  return {
    dir: absolute,
    name: packageNameFor(absolute),
    testing: testing ?? true,
    packageManager,
    install: install ?? true,
    git: git ?? true,
  }
}
