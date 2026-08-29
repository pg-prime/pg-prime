/**
 * The scaffold, end to end, against a real PostgreSQL (design/13 decision 9, second half).
 *
 * Tier 0 proves the templates are byte-equal to `docs/guides/getting-started`. That is a claim
 * about text. This is the claim that matters: the project those templates make, installed from the
 * TARBALLS this checkout builds, migrates a real database with the real `pg-prime` binary, prints
 * what the page says it prints, and produces the transcripts the page shows — modulo the volatile
 * fields the kit's own CLI goldens already mask (`packages/pg-prime-kit/test/cli/_mask.ts`: wall
 * clock, database name, fingerprints).
 *
 * It needs `PG_PRIME_TEST_URL`. Without one it skips loudly rather than passing vacuously.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CONTENT, readPage } from '../../../../tools/docs-blocks.mjs'
import { packInto, useTarballs } from '../../../../tools/create-smoke.mjs'
import { PKG_DIR } from '../globalSetup.js'

const ADMIN_URL = process.env['PG_PRIME_TEST_URL']

/**
 * `@pg-prime/testing` is another workstream's (design/13 §5 lands T before X). Until it is on the
 * branch with a build, the scaffold's `--testing` half cannot be installed from a tarball, so the
 * project under test here is the `--no-testing` one and the vitest-on-PGlite leg of decision 9 is
 * reported as not run.
 */
const TESTING_DIST = resolve(PKG_DIR, '..', 'pg-prime-testing', 'dist')
const withTesting = existsSync(TESTING_DIST)

const PAGE = readPage(join(CONTENT, 'guides', 'getting-started.mdx'))

/** The four `text frame="terminal"` blocks, in page order. */
function transcripts(): readonly string[] {
  const found = PAGE.blocks
    .filter(
      (b: { lang: string; attrs: Record<string, unknown> }) =>
        b.lang === 'text' && b.attrs['frame'] === 'terminal',
    )
    .map((b: { text: string }) => b.text)
  if (found.length !== 4) {
    throw new Error(
      `getting-started.mdx has ${String(found.length)} terminal transcripts, expected 4`,
    )
  }
  return found
}

/**
 * What a transcript may differ in and still be the same transcript.
 *
 * The list is the kit's own (`test/cli/_mask.ts`), narrowed to what these four commands print:
 * the scratch database's name, the server's host:port, wall-clock milliseconds, and the sha256
 * fingerprints — which depend on the server version and on the oids it hands out. Everything else
 * — the statement counts, `proof passed`, `witness passed`, `1 file, 0 pending`, `lock free` — is
 * evidence and is compared verbatim.
 */
function maskTranscript(text: string, database: string, hostPort: string): string {
  return text
    .replaceAll(database, 'app')
    .replaceAll(hostPort, 'localhost:5432')
    .replace(/sha256:[0-9a-f]{64}/g, 'sha256:<fingerprint>')
    .replace(/\b\d+(?:\.\d+)?\s+ms\b/g, '<n> ms')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .trim()
}

interface Ran {
  readonly code: number
  readonly out: string
}

const suite = ADMIN_URL === undefined ? describe.skip : describe
if (ADMIN_URL === undefined) {
  process.stderr.write(
    '[test] skip: the scaffold e2e needs PG_PRIME_TEST_URL ' +
      '(e.g. postgres://postgres:postgres@127.0.0.1:54333/postgres)\n',
  )
}

suite('the scaffolded project, installed from tarballs', () => {
  const database = `pgprime_create_${randomBytes(4).toString('hex')}`
  let tmp = ''
  let app = ''
  let cli = ''
  let url = ''
  let hostPort = ''
  let env: Record<string, string> = {}

  const run = (command: string, args: readonly string[], cwd = app): Ran => {
    try {
      return {
        code: 0,
        out: execFileSync(command, [...args], {
          cwd,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...env },
        }),
      }
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string }
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
    }
  }

  const admin = async <T>(fn: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new pg.Client({ connectionString: ADMIN_URL })
    await client.connect()
    try {
      return await fn(client)
    } finally {
      await client.end()
    }
  }

  beforeAll(async () => {
    const started = Date.now()
    tmp = mkdtempSync(join(tmpdir(), 'pg-prime-create-e2e-'))
    const tars = join(tmp, 'tarballs')
    mkdirSync(tars)
    const packages = [
      { dir: 'packages/pg-prime', name: 'pg-prime' },
      { dir: 'packages/pg-prime-kit', name: '@pg-prime/kit' },
      { dir: 'packages/pg-prime-create', name: '@pg-prime/create' },
      ...(withTesting ? [{ dir: 'packages/pg-prime-testing', name: '@pg-prime/testing' }] : []),
    ]
    const tarballs = packInto(tars, packages)

    const work = join(tmp, 'work')
    mkdirSync(work)
    // The BUILT binary, as `tools/create-smoke.mjs` runs it out of an installed tarball; here it is
    // run from `dist/` so a failure points at this checkout rather than at an install.
    execFileSync(
      process.execPath,
      [
        join(PKG_DIR, 'dist', 'cli.js'),
        'app',
        '--yes',
        '--no-install',
        '--no-git',
        ...(withTesting ? [] : ['--no-testing']),
      ],
      { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    app = join(work, 'app')
    useTarballs(join(app, 'package.json'), tarballs)
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: app,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
    cli = join(app, 'node_modules', '.bin', 'pg-prime')

    await admin(async (client) => {
      await client.query(`CREATE DATABASE "${database}"`)
    })
    const parsed = new URL(ADMIN_URL as string)
    hostPort = `${parsed.hostname}:${parsed.port || '5432'}`
    parsed.pathname = `/${database}`
    url = parsed.toString()
    env = {
      DATABASE_URL: url,
      // The witness (`pg_dump`) is what the page's transcript says "passed". CI puts a client on
      // the PATH; a laptop usually has the server in a container and nothing on the PATH, and the
      // kit's own harness solves that the same way (`test/setup.ts`).
      ...(process.env['PG_PRIME_PG_DUMP'] === undefined && process.env['PG_PRIME_SPIKE_CONTAINER']
        ? {
            PGPASSWORD: decodeURIComponent(parsed.password),
            PG_PRIME_PG_DUMP: JSON.stringify([
              'docker',
              'exec',
              '-e',
              'PGPASSWORD',
              '-i',
              process.env['PG_PRIME_SPIKE_CONTAINER'],
              'pg_dump',
            ]),
            PG_PRIME_PG_DUMP_URI: `postgresql://${encodeURIComponent(decodeURIComponent(parsed.username))}@127.0.0.1:5432/{db}`,
          }
        : {}),
    }
    process.stderr.write(
      `[e2e] scaffolded, installed and created ${database} in ${String(Date.now() - started)} ms\n`,
    )
  })

  afterAll(async () => {
    if (ADMIN_URL !== undefined && database) {
      await admin(async (client) => {
        await client.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [database],
        )
        await client.query(`DROP DATABASE IF EXISTS "${database}"`)
      })
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  it('`migrate generate --name init` prints what the page prints', () => {
    const result = run(cli, ['migrate', 'generate', '--name', 'init'])
    expect(result.out).toBeTruthy()
    expect(result.code).toBe(0)
    expect(maskTranscript(result.out, database, hostPort)).toBe(
      maskTranscript(transcripts()[0] as string, database, hostPort),
    )
  })

  it('writes the SQL the page shows: a NOT VALID foreign key and its VALIDATE', () => {
    const sql = readFileSync(join(app, 'migrations', '0000_init.sql'), 'utf8')
    const onPage = PAGE.blocks.find(
      (b: { attrs: Record<string, unknown> }) => b.attrs['title'] === 'migrations/0000_init.sql',
    ) as { text: string }
    // The block elides the middle ("… users, then the primary keys …"), so what is compared is
    // every line of it that is not the elision and not a fingerprint.
    for (const line of onPage.text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('-- …') || /sha256:/.test(trimmed)) continue
      expect(sql, `the page shows this line`).toContain(trimmed)
    }
  })

  it('`migrate apply` prints what the page prints', () => {
    const result = run(cli, ['migrate', 'apply'])
    expect(result.code).toBe(0)
    expect(maskTranscript(result.out, database, hostPort)).toBe(
      maskTranscript(transcripts()[1] as string, database, hostPort),
    )
  })

  it('`migrate status` exits 0 and prints what the page prints', () => {
    const result = run(cli, ['migrate', 'status'])
    expect(result.code).toBe(0)
    expect(maskTranscript(result.out, database, hostPort)).toBe(
      maskTranscript(transcripts()[2] as string, database, hostPort),
    )
  })

  it('compiles and runs index.ts, and prints the line the page says it prints', () => {
    const built = run(join(app, 'node_modules', '.bin', 'tsc'), [])
    expect(built.out, 'tsc').toBe('')
    expect(built.code).toBe(0)

    const ran = run(process.execPath, [join(app, 'dist', 'index.js')])
    expect(ran.code, ran.out).toBe(0)

    // The expectation is the page's own trailing comment on `first-query.ts`, not a copy of it.
    const block = PAGE.blocks.find(
      (b: { attrs: Record<string, unknown> }) => b.attrs['title'] === 'first-query.ts',
    ) as { text: string }
    const expected = /console\.log\(published\)\s*\/\/\s*(.+)$/m.exec(block.text)?.[1]
    expect(expected).toBeTypeOf('string')
    expect(ran.out.trim()).toBe(String(expected).trim())
  })

  it('generates the second migration the page shows when the schema changes', () => {
    const schema = join(app, 'schema.ts')
    const before = readFileSync(schema, 'utf8')
    // The page's "schema.ts (excerpt)" is a fragment — it drops `authorId` and `createdAt` — so
    // what is applied here is the one line the prose is about: a nullable `summary` on `posts`.
    const after = before.replace(
      '  published: t.boolean().default(false),\n',
      '  summary: t.text().nullable(),\n  published: t.boolean().default(false),\n',
    )
    expect(after, 'the summary column was inserted').not.toBe(before)
    writeFileSync(schema, after)

    const result = run(cli, ['migrate', 'generate', '--name', 'post_summary'])
    expect(result.code).toBe(0)
    expect(maskTranscript(result.out, database, hostPort)).toBe(
      maskTranscript(transcripts()[3] as string, database, hostPort),
    )
  })

  it.skipIf(!withTesting)("runs the scaffold's own vitest on PGlite", () => {
    const result = run(join(app, 'node_modules', '.bin', 'vitest'), ['run'])
    expect(result.code, result.out).toBe(0)
    expect(result.out).toContain('2 passed')
  })
})
