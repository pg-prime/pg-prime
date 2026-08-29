/**
 * design/13 decision 5: **the scaffold IS the getting-started page.**
 *
 * Every template that has a code block on `docs/guides/getting-started` is byte-equal to it, and
 * the page wins. The blocks are read with `tools/docs-blocks.mjs` — the same parser
 * `docs:typecheck` and `docs:examples` use — so "the block" means exactly what those gates mean by
 * it, and a template that drifts fails here rather than in a user's first five minutes.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTENT, readPage } from '../../../tools/docs-blocks.mjs'
import { templatesDir } from '../src/scaffold.js'

const PAGE = join(CONTENT, 'guides', 'getting-started.mdx')
const page = readPage(PAGE)
const templates = templatesDir()

const template = (name: string): string => readFileSync(join(templates, name), 'utf8')

function blockTitled(title: string): { text: string; line: number } {
  const found = page.blocks.filter(
    (b: { attrs: Record<string, unknown> }) => b.attrs['title'] === title,
  )
  if (found.length !== 1) {
    throw new Error(`getting-started.mdx has ${String(found.length)} blocks titled ${title}`)
  }
  return found[0] as { text: string; line: number }
}

/** `templates/<file>` ⇔ the block titled `<title>`. `index.ts` is the page's `first-query.ts`. */
const BYTE_EQUAL: readonly (readonly [string, string])[] = [
  ['schema.ts', 'schema.ts'],
  ['pg-prime.config.ts', 'pg-prime.config.ts'],
  ['db.ts', 'db.ts'],
  ['index.ts', 'first-query.ts'],
]

describe('the templates are the page', () => {
  for (const [file, title] of BYTE_EQUAL) {
    it(`templates/${file} is byte-equal to the \`${title}\` block`, () => {
      const block = blockTitled(title)
      // The only difference a fence cannot carry: a file ends with a newline.
      expect(template(file)).toBe(`${block.text}\n`)
    })
  }

  it("templates/tsconfig.json is the page's JSON block plus outDir and include", () => {
    const json = page.blocks.filter((b: { lang: string }) => b.lang === 'json')
    expect(json).toHaveLength(1)
    const onPage = JSON.parse((json[0] as { text: string }).text) as {
      compilerOptions: Record<string, unknown>
    }
    const scaffolded = JSON.parse(template('tsconfig.json')) as {
      compilerOptions: Record<string, unknown>
      include: readonly string[]
    }

    // Same options, same order, same values — then exactly one addition, because a project that
    // `tsc`s needs somewhere to put the output and something to compile.
    const pageKeys = Object.keys(onPage.compilerOptions)
    expect(Object.keys(scaffolded.compilerOptions).slice(0, pageKeys.length)).toEqual(pageKeys)
    for (const key of pageKeys) {
      expect(scaffolded.compilerOptions[key]).toEqual(onPage.compilerOptions[key])
    }
    expect(Object.keys(scaffolded.compilerOptions).slice(pageKeys.length)).toEqual(['outDir'])
    expect(scaffolded.include).toContain('*.ts')
  })

  it('.env.example carries the URL pg-prime.config.ts falls back to', () => {
    const fallback = /\?\?\s*'([^']+)'/.exec(template('pg-prime.config.ts'))?.[1]
    expect(fallback).toBeTypeOf('string')
    expect(template('env.example')).toContain(`DATABASE_URL=${String(fallback)}`)
  })

  it('every template renders with the tokens the scaffolder has', () => {
    // A `{{typo}}` throws at scaffold time; this is the same check one directory earlier, so the
    // failure names the template rather than the run.
    const known = new Set([
      'name',
      'pm',
      'pmRun',
      'pmExec',
      'pgPrime',
      'kit',
      'testing',
      'pg',
      'typescript',
      'typesNode',
      'vitest',
      'pglite',
    ])
    for (const file of ['package.json', 'package.testing.json', 'README.md', 'env.example']) {
      for (const [, token] of template(file).matchAll(/\{\{(\w+)\}\}/g)) {
        expect(known, `${file} uses {{${token}}}`).toContain(token)
      }
    }
  })
})
