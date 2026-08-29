/** design/13 decision 8: the flags, the refusals, and the package manager that ran us. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HELP, PACKAGE_MANAGERS, VERSION, detectPackageManager, parseArgs } from '../src/args.js'

describe('parseArgs', () => {
  it('defaults to nothing: every flag is undefined until it is given', () => {
    const { options, errors } = parseArgs([])
    expect(errors).toEqual([])
    expect(options).toEqual({
      dir: undefined,
      help: false,
      version: false,
      yes: false,
      packageManager: undefined,
      testing: undefined,
      install: undefined,
      git: undefined,
    })
  })

  it('takes the directory as the one positional', () => {
    expect(parseArgs(['my-app']).options.dir).toBe('my-app')
    expect(parseArgs(['--yes', 'my-app']).options.dir).toBe('my-app')
    expect(parseArgs(['my-app', 'other']).errors).toEqual([
      'expected one directory, got 2: my-app other',
    ])
  })

  it('reads the booleans and their --no- forms', () => {
    const { options } = parseArgs(['--yes', '--no-testing', '--no-install', '--no-git'])
    expect(options.yes).toBe(true)
    expect(options.testing).toBe(false)
    expect(options.install).toBe(false)
    expect(options.git).toBe(false)
    const on = parseArgs(['--testing', '--install', '--git']).options
    expect([on.testing, on.install, on.git]).toEqual([true, true, true])
  })

  it('has -y and -h', () => {
    expect(parseArgs(['-y']).options.yes).toBe(true)
    expect(parseArgs(['-h']).options.help).toBe(true)
  })

  it('takes --pm as a value or with an equals sign', () => {
    expect(parseArgs(['--pm', 'pnpm']).options.packageManager).toBe('pnpm')
    expect(parseArgs(['--pm=bun']).options.packageManager).toBe('bun')
  })

  it('names the four package managers when it refuses a fifth', () => {
    expect(parseArgs(['--pm', 'deno']).errors).toEqual([
      '--pm "deno" is not one of npm, pnpm, yarn, bun',
    ])
    expect(parseArgs(['--pm']).errors).toEqual(['--pm needs a value (npm, pnpm, yarn or bun)'])
  })

  it('refuses an unknown flag rather than reading it as the directory', () => {
    const { options, errors } = parseArgs(['--no-instal', 'my-app'])
    expect(errors).toEqual(['unknown option --no-instal'])
    expect(options.install).toBeUndefined()
    expect(options.dir).toBe('my-app')
  })

  it('refuses a value on a boolean', () => {
    expect(parseArgs(['--git=maybe']).errors).toEqual(['--git does not take a value'])
  })

  it('stops parsing at --', () => {
    expect(parseArgs(['--', '--weird-dir']).options.dir).toBe('--weird-dir')
  })
})

describe('detectPackageManager', () => {
  it('reads npm_config_user_agent', () => {
    expect(detectPackageManager('pnpm/10.33.0 npm/? node/v24.14.1 darwin arm64')).toBe('pnpm')
    expect(detectPackageManager('yarn/4.1.0 npm/? node/v22.12.0 linux x64')).toBe('yarn')
    expect(detectPackageManager('bun/1.1.0')).toBe('bun')
  })

  it('falls back to npm rather than failing: the value is only ever printed', () => {
    expect(detectPackageManager(undefined)).toBe('npm')
    expect(detectPackageManager('deno/2.0.0')).toBe('npm')
  })
})

describe('--help', () => {
  it('documents every flag the parser accepts', () => {
    for (const flag of [
      '--yes',
      '--pm',
      '--testing',
      '--no-testing',
      '--install',
      '--no-install',
      '--git',
      '--no-git',
      '--help',
      '--version',
    ]) {
      expect(HELP, flag).toContain(flag)
    }
    for (const pm of PACKAGE_MANAGERS) expect(HELP).toContain(pm)
  })

  it("ends with the version, as the kit's help does", () => {
    expect(HELP.trimEnd().endsWith(`Version ${VERSION}`)).toBe(true)
  })

  it('is what the package README shows', () => {
    // `docs/reference/create` is goldened against the binary by `tools/docs-coverage.mjs`; the
    // README is the other copy, and npm ships it, so it is checked here rather than left to rot.
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    const options = HELP.split('\n')
      .slice(HELP.split('\n').indexOf('Options:') + 1)
      .filter((line) => line.startsWith('  --'))
    expect(options.length).toBeGreaterThan(8)
    for (const line of options) expect(readme, line.trim()).toContain(line)
  })
})
