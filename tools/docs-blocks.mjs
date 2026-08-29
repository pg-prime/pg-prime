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
    const raw = readFileSync(f, 'utf8')
    // A snippet may itself compose others: `// docs: use=blog` on a line of its own. That is how
    // `blog-ddl` is the single copy of the DDL both it and `blog` need.
    const uses = []
    const lines = raw.split('\n')
    const kept = []
    for (const line of lines) {
      const m = /^\s*\/\/\s*docs:\s*use=(\S+)\s*$/.exec(line)
      if (m) {
        uses.push(
          ...m[1]
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
        )
        kept.push('')
        continue
      }
      kept.push(line)
    }
    out.set(name, { file: f, text: kept.join('\n'), uses })
  }
  return out
}

/** A `title=` that is a plain file name is emitted as that file; anything else is prose. */
const FILE_TITLE = /^[\w.-]+\.tsx?$/

/**
 * What one block is checked and run as: an entry module, plus the sibling files it imports.
 *
 * `use=` means "this code is in scope", and there are two ways to be in scope, chosen by whether
 * the thing being used has a file name of its own:
 *
 *  - a `setup=` block **with** a `title="schema.ts"` becomes the file `schema.ts` next to the
 *    entry, and the block imports it exactly as a reader's project would (`./schema.js` resolves to
 *    `schema.ts`, which is what NodeNext does and what the bundler the examples runner uses does);
 *  - a snippet, or a `setup=` block with no file name, is **prepended** textually, so an invisible
 *    prelude's `const db = …` is simply in scope with nothing on the page to explain.
 *
 * Either way no line of the block is rewritten. `map` is one entry per line of the entry module —
 * `{ file, line }` of where it came from — which is how a diagnostic points at the page.
 */
export function compose(block, snippets, pageSetups) {
  const out = []
  const map = []
  const used = []
  const files = []
  const seen = new Set()

  const useListOf = (attrs) =>
    String(attrs.use ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

  /** Collects into `sink` (an entry-module accumulator) or emits a file, depending on the source. */
  const include = (name, sink, where) => {
    if (seen.has(name)) return
    const snippet = snippets.get(name)
    const setup = pageSetups.get(name)
    const source = snippet ?? setup
    if (!source) {
      throw new Error(
        `${where}: use=${name} names no snippet ` +
          `(docs/src/snippets/${name}.ts) and no setup= block on this page`,
      )
    }
    seen.add(name)
    used.push(name)

    if (source.fileName) {
      // File mode: its own `use=` is resolved against the same rules, into its own text.
      const inner = { out: [], map: [] }
      for (const dep of useListOf(source.attrs ?? {})) include(dep, inner, where)
      appendText(inner, source, name)
      files.push({ name: source.fileName, text: inner.out.join('\n'), map: inner.map })
      return
    }
    for (const dep of source.uses ?? []) include(dep, sink, where)
    appendText(sink, source, name)
  }

  const appendText = (sink, source, name) => {
    const lines = stripExportMarker(source.text).split('\n')
    for (let i = 0; i < lines.length; i++) {
      sink.out.push(lines[i])
      sink.map.push({ file: source.file, line: (source.startLine ?? 1) + i, snippet: name })
    }
  }

  const entry = { out, map }
  for (const name of useListOf(block.attrs)) {
    include(name, entry, `${block.page}:${block.line}`)
  }

  const body = block.text.split('\n')
  for (let i = 0; i < body.length; i++) {
    out.push(body[i])
    map.push({ file: block.file, line: block.bodyLine + i })
  }
  return { text: out.join('\n'), map, used, files }
}

/** A snippet file ends with `export {}` so it is a module on its own; concatenation does not need it. */
function stripExportMarker(text) {
  return text.replace(/^export \{\}\s*$/gm, '')
}

/** The `setup=<id>` blocks of one page, keyed by id. */
export function pageSetupsOf(page) {
  const setups = new Map()
  for (const b of page.blocks) {
    if (typeof b.attrs.setup !== 'string') continue
    const title = typeof b.attrs.title === 'string' ? b.attrs.title : undefined
    setups.set(b.attrs.setup, {
      file: b.file,
      text: b.text,
      startLine: b.bodyLine,
      attrs: b.attrs,
      ...(title && FILE_TITLE.test(title) ? { fileName: title } : {}),
    })
  }
  return setups
}

/** Blocks the gates act on: `ts`/`tsx`, minus the ones a directive excludes. */
export function checkedBlocks(page) {
  return page.blocks.filter((b) => CHECKED_LANGS.has(b.lang) && !b.attrs['skip-check'])
}

/**
 * A block the PGlite tier runs: it has a file name and nothing excludes it.
 *
 * `pg-only` excludes it here and includes it in `isPgExample` — the two tiers partition the
 * `title=` blocks, so an example runs on exactly one of them.
 */
export function isExample(block) {
  return (
    typeof block.attrs.title === 'string' && !block.attrs['no-run'] && isPgExample(block) === null
  )
}

/**
 * The real-server tier (design/13 decision 10): `'pg'`, `'pgbouncer'`, or `null` for a block that
 * is not on it.
 *
 * `pg-only` is a bare attribute for an example that needs a real PostgreSQL — COPY, two sessions,
 * a `CancelRequest` somebody honours — and `pg-only="pgbouncer"` for one that needs a transaction
 * pooler in front of it. `tools/docs-examples.mjs --pg` runs them; `docs-typecheck` compiles them
 * like any other `ts` block, because the reason they cannot run is never that they do not compile.
 */
export function isPgExample(block) {
  const raw = block.attrs['pg-only']
  if (raw === undefined || raw === false) return null
  const value = raw === true ? 'pg' : String(raw)
  if (value !== 'pg' && value !== 'pgbouncer') {
    throw new Error(
      `${block.page}:${block.line}: pg-only="${value}" is not a tier — ` +
        'write `pg-only` (a real PostgreSQL) or `pg-only="pgbouncer"` (through the pooler)',
    )
  }
  return value
}
