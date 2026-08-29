// The docs gates' shared front end (design/12 §4 D): find every fenced code block under
// `docs/src/content/docs/**`, read its directives, and compose the module a block is checked or
// executed as. `docs-typecheck.mjs`, `docs-examples.mjs` and `docs-coverage.mjs` all start here so
// that "what is a block" is defined once; the convention itself is documented in `docs/README.md`.
//
// A block's directives live in an MDX comment on the line immediately above the fence:
//
//     {/* docs: use=blog title-is-not-here */}
//     ```ts title="hello.ts"
//
// and `title=` is read off the fence itself, because Expressive Code renders it as the file name.
// Nothing else is invented: a page without a directive comment is an ordinary page whose `ts`
// blocks are compiled as written.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DOCS = join(ROOT, 'docs')
export const CONTENT = join(DOCS, 'src', 'content', 'docs')
export const SNIPPETS = join(DOCS, 'src', 'snippets')

/** Languages whose blocks are type-checked. Everything else is prose. */
export const CHECKED_LANGS = new Set(['ts', 'tsx'])

export function walk(dir, exts = ['.md', '.mdx']) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full, exts))
    else if (exts.some((e) => name.endsWith(e))) out.push(full)
  }
  return out
}

/**
 * `key`, `key=value` and `key="value with spaces"`, in the order written.
 *
 * Unknown keys are kept rather than rejected: Expressive Code has its own vocabulary on the fence
 * (`frame`, `ins`, `collapse`, …) and this parser reads the same string.
 */
export function parseAttrs(text) {
  const attrs = {}
  const re = /([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g
  let m
  while ((m = re.exec(text)) !== null) {
    attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? true
  }
  return attrs
}

const DIRECTIVE_MDX = /^\s*\{\/\*\s*docs:(.*?)\*\/\}\s*$/
const DIRECTIVE_HTML = /^\s*<!--\s*docs:(.*?)-->\s*$/
const FENCE = /^(\s*)(`{3,})\s*(\S*)\s*(.*)$/

/**
 * Every fenced block of one page, in order, with its 1-based line numbers and directives.
 *
 * `line` is the line of the opening fence; `bodyLine` the first line of code. Both are what the
 * gates print, so a failure points at the page rather than at a temp file.
 */
export function readPage(file) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const frontmatter = readFrontmatter(lines)
  const blocks = []
  let pending = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const dir = DIRECTIVE_MDX.exec(line) ?? DIRECTIVE_HTML.exec(line)
    if (dir) {
      pending = { ...pending, ...parseAttrs(dir[1]) }
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence && fence[3]) {
      const indent = fence[1]
      const ticks = fence[2]
      const lang = fence[3]
      const meta = parseAttrs(fence[4] ?? '')
      const body = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const close = FENCE.exec(lines[j])
        if (lines[j].trim().startsWith(ticks) && !lines[j].trim().slice(ticks.length).trim()) break
        if (close && close[2].length >= ticks.length && !close[3]) break
        body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j])
      }
      blocks.push({
        file,
        page: relative(CONTENT, file),
        lang,
        attrs: { ...meta, ...pending },
        line: i + 1,
        bodyLine: i + 2,
        text: body.join('\n'),
      })
      pending = {}
      i = j + 1
      continue
    }
    if (line.trim() !== '') pending = {}
    i++
  }
  return { file, page: relative(CONTENT, file), frontmatter, blocks, lines }
}

/** The frontmatter as a flat record of strings and string arrays. Enough for `apiEntry`. */
export function readFrontmatter(lines) {
  if (lines[0]?.trim() !== '---') return {}
  const out = {}
  let key = null
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '---') break
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && key) {
      const arr = Array.isArray(out[key]) ? out[key] : []
      arr.push(unquote(item[1]))
      out[key] = arr
      continue
    }
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) {
      key = kv[1]
      out[key] = kv[2] === '' ? [] : unquote(kv[2])
    }
  }
  return out
}

function unquote(s) {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

/** Every page under `docs/src/content/docs`, parsed. */
export function readAllPages() {
  return walk(CONTENT).map(readPage)
}

/** The named `.ts` preludes under `docs/src/snippets`, by bare name. */
export function readSnippets() {
  const out = new Map()
  let files = []
  try {
    files = walk(SNIPPETS, ['.ts'])
  } catch {
    return out
  }
  for (const f of files) {
    const name = relative(SNIPPETS, f).replace(/\.ts$/, '')
    out.set(name, { file: f, text: readFileSync(f, 'utf8') })
  }
  return out
}

/**
 * The composed module for one block: its `use=` preludes, then the block.
 *
 * Composition is textual, not `import`-based, so a block reads on the page exactly as it runs: the
 * prelude's `const db = …` really is in scope, and no line of the block is rewritten. The returned
 * `map` is one entry per composed line — `{ file, line }` of where it came from — which is how a
 * `tsc` or Node diagnostic is reported against the page instead of against a temp file.
 */
export function compose(block, snippets, pageSetups) {
  const out = []
  const map = []
  const used = []
  const seen = new Set()

  const useList = String(block.attrs.use ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  for (const name of useList) {
    if (seen.has(name)) continue
    seen.add(name)
    const snippet = snippets.get(name)
    const setup = pageSetups.get(name)
    const source = snippet ?? setup
    if (!source) {
      throw new Error(
        `${block.page}:${block.line}: use=${name} names no snippet ` +
          `(docs/src/snippets/${name}.ts) and no setup= block on this page`,
      )
    }
    used.push(name)
    const lines = stripExportMarker(source.text).split('\n')
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i])
      map.push({ file: source.file, line: (source.startLine ?? 1) + i, snippet: name })
    }
  }

  const body = block.text.split('\n')
  for (let i = 0; i < body.length; i++) {
    out.push(body[i])
    map.push({ file: block.file, line: block.bodyLine + i })
  }
  return { text: out.join('\n'), map, used }
}

/** A snippet file ends with `export {}` so it is a module on its own; concatenation does not need it. */
function stripExportMarker(text) {
  return text.replace(/^export \{\}\s*$/gm, '')
}

/** The `setup=<id>` blocks of one page, keyed by id. */
export function pageSetupsOf(page) {
  const setups = new Map()
  for (const b of page.blocks) {
    if (typeof b.attrs.setup === 'string') {
      setups.set(b.attrs.setup, { file: b.file, text: b.text, startLine: b.bodyLine })
    }
  }
  return setups
}

/** Blocks the gates act on: `ts`/`tsx`, minus the ones a directive excludes. */
export function checkedBlocks(page) {
  return page.blocks.filter((b) => CHECKED_LANGS.has(b.lang) && !b.attrs['skip-check'])
}

export function isExample(block) {
  return typeof block.attrs.title === 'string' && !block.attrs['no-run']
}
