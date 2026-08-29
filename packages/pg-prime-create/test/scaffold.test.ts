/** What lands on disk, what is refused, and what a terminal is asked for. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { resolveOptions, DEFAULT_DIR, type PromptIo } from '../src/prompts.js'
import { packageNameFor, scaffold } from '../src/scaffold.js'

const temps: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-prime-create-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true })
})

/**
 * A `PromptIo` over strings: `answers` are what a terminal would type, one per question.
 *
 * `ask` is one function rather than a stream pair (see `src/prompts.ts`), which is also why this
 * fake is six lines: a readable that already holds every answer ends after the first question and
 * `readline` then rejects the second with "readline was closed".
 */
function fakeIo(
  answers: readonly string[],
  terminal: boolean,
): PromptIo & { asked: () => string[] } {
  const pending = [...answers]
  const questions: string[] = []
  return {
    ask: terminal
      ? (question: string): Promise<string> => {
          questions.push(question)
          return Promise.resolve(pending.shift() ?? '')
        }
      : undefined,
    cwd: '/workspace',
    env: {},
    asked: () => questions,
  }
}

const BASE_FILES = [
  '.env.example',
  '.gitignore',
  'README.md',
  'db.ts',
  'index.ts',
  'migrations/.gitkeep',
  'package.json',
  'pg-prime.config.ts',
  'schema.ts',
  'tsconfig.json',
]

describe('scaffold', () => {
  it('writes the getting-started project and nothing else', () => {
    const dir = join(temp(), 'app')
    const result = scaffold({ dir, name: 'app', testing: false, packageManager: 'npm' })
    expect(result.files).toEqual(BASE_FILES)
    expect(result.dir).toBe(dir)
  })

  it('adds three files with --testing', () => {
    const dir = join(temp(), 'app')
    const result = scaffold({ dir, name: 'app', testing: true, packageManager: 'pnpm' })
    expect(result.files).toEqual(
      [...BASE_FILES, 'test/index.test.ts', 'test/setup.ts', 'vitest.config.ts'].sort(),
    )
  })

  it('writes `.gitignore` under its dotted name, which npm will not ship as one', () => {
    const dir = join(temp(), 'app')
    scaffold({ dir, name: 'app', testing: false, packageManager: 'npm' })
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('node_modules/')
    expect(existsSync(join(dir, 'gitignore'))).toBe(false)
  })

  it('resolves every token in every file it writes', () => {
    const dir = join(temp(), 'my-app')
    const result = scaffold({ dir, name: 'my-app', testing: true, packageManager: 'pnpm' })
    for (const file of result.files) {
      expect(readFileSync(join(dir, file), 'utf8'), file).not.toContain('{{')
    }
  })

  it('pins the workspace versions in package.json, and only adds test deps with --testing', () => {
    const plain = join(temp(), 'a')
    scaffold({ dir: plain, name: 'a', testing: false, packageManager: 'npm' })
    const withTests = join(temp(), 'b')
    scaffold({ dir: withTests, name: 'b', testing: true, packageManager: 'npm' })

    const read = (
      dir: string,
    ): {
      name: string
      scripts: Record<string, string>
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    } => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

    const a = read(plain)
    expect(a.name).toBe('a')
    expect(Object.keys(a.dependencies)).toEqual(['pg', 'pg-prime'])
    expect(Object.keys(a.devDependencies)).toEqual(['@pg-prime/kit', '@types/node', 'typescript'])
    expect(a.scripts['test']).toBeUndefined()
    for (const range of Object.values({ ...a.dependencies, ...a.devDependencies })) {
      expect(range).toMatch(/^[~^]?\d+\.\d+\.\d+/)
    }

    const b = read(withTests)
    expect(Object.keys(b.devDependencies)).toEqual([
      '@electric-sql/pglite',
      '@pg-prime/kit',
      '@pg-prime/testing',
      '@types/node',
      'typescript',
      'vitest',
    ])
    expect(b.scripts['test']).toBe('vitest run')
  })

  it("keeps the README's test section only when the tests are there", () => {
    const withTests = join(temp(), 'a')
    scaffold({ dir: withTests, name: 'a', testing: true, packageManager: 'pnpm' })
    const readme = readFileSync(join(withTests, 'README.md'), 'utf8')
    expect(readme).toContain('## Tests')
    expect(readme).toContain('pnpm exec pg-prime migrate generate --name init')
    expect(readme).not.toContain('testing:start')

    const plain = join(temp(), 'b')
    scaffold({ dir: plain, name: 'b', testing: false, packageManager: 'npm' })
    const bare = readFileSync(join(plain, 'README.md'), 'utf8')
    expect(bare).not.toContain('## Tests')
    expect(bare).toContain('npx pg-prime migrate generate --name init')
  })

  it('refuses a directory that already has something in it', () => {
    const dir = join(temp(), 'app')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.ts'), 'console.log(1)\n')
    expect(() => scaffold({ dir, name: 'app', testing: false, packageManager: 'npm' })).toThrow(
      /is not empty \(index\.ts\) — pick a directory that does not exist yet/,
    )
  })

  it('does not count `.git` as content: `git init && npm create @pg-prime .` is a real order', () => {
    const dir = join(temp(), 'app')
    mkdirSync(join(dir, '.git'), { recursive: true })
    expect(scaffold({ dir, name: 'app', testing: false, packageManager: 'npm' }).files).toEqual(
      BASE_FILES,
    )
  })
})

describe('packageNameFor', () => {
  it('makes an npm name out of a directory', () => {
    expect(packageNameFor('/tmp/My App')).toBe('my-app')
    expect(packageNameFor('/tmp/app/')).toBe('app')
    expect(packageNameFor('/')).toBe('app')
  })
})

describe('resolveOptions', () => {
  it('asks nothing when stdin is not a TTY — a non-TTY implies --yes', async () => {
    const io = fakeIo([], false)
    const plan = await resolveOptions(parseArgs([]).options, io)
    expect(io.asked()).toEqual([])
    expect(plan).toEqual({
      dir: join('/workspace', DEFAULT_DIR),
      name: DEFAULT_DIR,
      testing: true,
      packageManager: 'npm',
      install: true,
      git: true,
    })
  })

  it('asks nothing with --yes on a TTY either', async () => {
    const io = fakeIo([], true)
    const plan = await resolveOptions(parseArgs(['--yes', 'my-app']).options, io)
    expect(io.asked()).toEqual([])
    expect(plan.dir).toBe(join('/workspace', 'my-app'))
    expect(plan.name).toBe('my-app')
  })

  it('asks for what argv did not say, and takes n for an answer', async () => {
    const io = fakeIo(['other-app', 'n', 'n', ''], true)
    const plan = await resolveOptions(parseArgs([]).options, io)
    expect(io.asked()).toEqual([
      `Directory (${DEFAULT_DIR}): `,
      'Add a vitest + PGlite test fixture? (Y/n) ',
      'Install dependencies with npm? (Y/n) ',
      'Initialise a git repository? (Y/n) ',
    ])
    expect(plan.dir).toBe(join('/workspace', 'other-app'))
    expect(plan.testing).toBe(false)
    expect(plan.install).toBe(false)
    // The empty answer takes the default, which is yes.
    expect(plan.git).toBe(true)
  })

  it('does not ask about anything argv already decided', async () => {
    const io = fakeIo([''], true)
    const plan = await resolveOptions(
      parseArgs(['app', '--no-testing', '--no-install', '--git']).options,
      io,
    )
    expect(io.asked()).toEqual([])
    expect(plan.testing).toBe(false)
    expect(plan.install).toBe(false)
    expect(plan.git).toBe(true)
  })

  it('takes the package manager from npm_config_user_agent, and --pm over it', async () => {
    const io = { ...fakeIo([], false), env: { npm_config_user_agent: 'pnpm/10.0.0 npm/?' } }
    expect((await resolveOptions(parseArgs([]).options, io)).packageManager).toBe('pnpm')
    expect((await resolveOptions(parseArgs(['--pm', 'bun']).options, io)).packageManager).toBe(
      'bun',
    )
  })
})
