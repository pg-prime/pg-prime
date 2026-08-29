/**
 * The command: parse, ask, write, and then the two optional side effects (`git init`, an install).
 *
 * Returns an exit CODE rather than calling `process.exit()`, for the reason the kit's `src/cli.ts`
 * gives: `exit()` truncates a pipe that has not drained.
 */

import { spawnSync } from 'node:child_process'
import { relative } from 'node:path'
import { HELP, VERSION, parseArgs } from './args.js'
import { resolveOptions, type ProjectPlan, type PromptIo } from './prompts.js'
import { scaffold } from './scaffold.js'

/**
 * Where the command writes. Two functions, not two streams — see the note on `PromptIo`: nothing
 * in this package's declarations may name a module outside it.
 */
export interface MainIo extends PromptIo {
  readonly out: (text: string) => void
  readonly err: (text: string) => void
}

const NEXT_STEP_ENV = 'export DATABASE_URL=postgres://postgres:postgres@localhost:5432/app'

function runCommand(command: string, args: readonly string[], cwd: string): boolean {
  const result = spawnSync(command, [...args], {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    // On Windows a package manager is a `.cmd`, which `spawn` cannot execute directly.
    shell: process.platform === 'win32',
  })
  return result.status === 0
}

function nextSteps(plan: ProjectPlan, cwd: string): readonly string[] {
  const where = relative(cwd, plan.dir) || '.'
  const exec = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' }[plan.packageManager]
  const run = { npm: 'npm run', pnpm: 'pnpm', yarn: 'yarn', bun: 'bun run' }[plan.packageManager]
  return [
    `  cd ${where}`,
    ...(plan.install ? [] : [`  ${plan.packageManager} install`]),
    `  ${NEXT_STEP_ENV}`,
    `  ${exec} pg-prime migrate generate --name init`,
    `  ${exec} pg-prime migrate apply`,
    `  ${run} build && ${run} start`,
  ]
}

export async function main(argv: readonly string[], io: MainIo): Promise<number> {
  const { options, errors } = parseArgs(argv)

  if (options.help) io.out(`${HELP}\n`)
  if (errors.length > 0) {
    for (const error of errors) io.err(`create-pg-prime: ${error}\n`)
    if (!options.help) io.err('create-pg-prime: run with --help for the options\n')
    return 1
  }
  if (options.help) return 0
  if (options.version) {
    io.out(`${VERSION}\n`)
    return 0
  }

  const plan = await resolveOptions(options, io)

  let result
  try {
    result = scaffold(plan)
  } catch (error) {
    io.err(`create-pg-prime: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  io.out(
    `\ncreate-pg-prime — wrote ${String(result.files.length)} files to ` +
      `${relative(io.cwd, plan.dir) || '.'}\n`,
  )

  if (plan.git && !runCommand('git', ['init', '--quiet'], plan.dir)) {
    // Not fatal: the project is written, and a missing `git` is not a reason to fail a scaffold.
    io.err('create-pg-prime: `git init` failed — the project is written anyway\n')
  }
  if (plan.install) {
    io.out(`\n${plan.packageManager} install\n`)
    if (!runCommand(plan.packageManager, ['install'], plan.dir)) {
      io.err(`create-pg-prime: \`${plan.packageManager} install\` failed\n`)
      return 1
    }
  }

  io.out(`\nNext:\n${nextSteps(plan, io.cwd).join('\n')}\n`)
  return 0
}
