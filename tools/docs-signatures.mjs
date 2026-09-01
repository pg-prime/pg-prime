// design/12 §4 D named this "the obvious next gate" and design/14 builds it: a reference page's
// `{/* docs: signature */}` block already COMPILES against the page's `apiEntry` types
// (`tools/docs-typecheck.mjs`), but a signature that compiles while having drifted from the real
// declaration — a widened parameter, a dropped overload, a member the build no longer has — was
// not caught. This gate reads the BUILT `.d.ts` through the TypeScript 5.9.3 compiler API (the
// same `typescript59` floor the other docs gates use), resolves every name a signature block
// declares, and compares canonicalized declarations.
//
//   node tools/docs-signatures.mjs           # the gate
//   node tools/docs-signatures.mjs --list    # every checked declaration, page by page
//
// What "equal" means, per declaration kind:
//
//   functions            the block's declaration must equal ONE of the real overloads (a page may
//                        show fewer overloads than exist; it may not show one that does not).
//   type aliases, consts canonical text equality.
//   interfaces, classes, structural: the declaration HEAD (name, type parameters, heritage) must
//   enums                match, and every member the page shows must be one of the real members —
//                        own OR inherited, since a page may re-display what a base class provides.
//                        A body elided with a `…` / `// …` line means "a subset, verbatim"; a
//                        body without one must also show every own member the build has, except
//                        constructors (the reference documents what a caller uses; the runtime
//                        constructs its own errors).
//
// Three deliberate accommodations, all bounded:
//
//   - A block may declare LOCAL helper names (`type Sc<H> = …`) purely to keep the shown
//     signature readable. A declared name the apiEntry set does not export is context, not a
//     claim, and is skipped — but a page-side REFERENCE to it is expanded with the block's own
//     definition (or the built one, if the same name exists unexported in the build), so the
//     shown signature is still compared in full.
//   - The built `.d.ts` routes through UNEXPORTED aliases/interfaces (`Base<T, P>`,
//     `PgLikeField`) that a page cannot name; comparison retries with such references expanded
//     (aliases substituted, parameter-free interfaces inlined), to depth 3.
//   - The build turns misuse into `…TypeError<'sentence'>` sentinel arms of conditional types
//     (`NullableFn`, `valuesMany`'s return). The page may show the HAPPY-PATH arm; the sentinel
//     arms are the prose's job. Comparison reduces such conditionals to their non-sentinel arm,
//     and normalizes a property-of-function-type to the method spelling the page uses.
//
// A block that deliberately paraphrases beyond all that opts out per block with
// `signature-drift="<why>"` — the same reason-required shape as `no-run` (R22) and `skip-check`.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { ROOT, readAllPages } from './docs-blocks.mjs'

const require = createRequire(import.meta.url)
const ts = require('typescript59')
const LIST = process.argv.includes('--list')

const PACKAGE_DIRS = {
  'pg-prime': 'pg-prime',
  '@pg-prime/kit': 'pg-prime-kit',
  '@pg-prime/create': 'pg-prime-create',
  '@pg-prime/testing': 'pg-prime-testing',
}

/** `pg-prime#./codecs` → the built `.d.ts` path, from the package's own exports map. */
function entryDtsPaths() {
  const out = new Map()
  for (const file of [
    'pg-prime.json',
    'pg-prime-kit.json',
    'pg-prime-create.json',
    'pg-prime-testing.json',
  ]) {
    const golden = JSON.parse(readFileSync(join(ROOT, 'tools', 'api-snapshot', file), 'utf8'))
    const dir = join(ROOT, 'packages', PACKAGE_DIRS[golden.package])
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    for (const subpath of Object.keys(golden.entries)) {
      const exp = pkg.exports?.[subpath]
      // `types@<5.9` is the stub; `types` is the real surface — the one the docs describe.
      const types = exp?.types
      if (typeof types !== 'string') continue
      out.set(`${golden.package}#${subpath}`, join(dir, types))
    }
  }
  return out
}

function fail(msg) {
  process.exitCode = 1
  console.error(`FAIL  ${msg}`)
}

/** Canonical text: no comments, no keyword noise, one quote style, one field spelling. */
function canon(text) {
  return (
    text
      .replace(/\bexport\s+/g, '')
      .replace(/\bdeclare\s+/g, '')
      // `.d.ts` spells a literal-typed field `readonly code = "X"`; a page (and an ambient
      // namespace) spells it `readonly code: "X"`. One canonical spelling.
      .replace(/'((?:[^'\\\n]|\\.)*)'/g, (m, inner) => `"${inner}"`)
      .replace(/\b(readonly\s+\w+|const\s+\w+)\s*=\s*("[^"]*"|\d+(?:\.\d+)?)/g, '$1: $2')
      .replace(/#private;?/g, '')
      .replace(/\s+/g, ' ')
      .replace(/;\s*\}/g, ' }')
      .replace(/;\s*$/, '')
      .trim()
  )
}

const printer = ts.createPrinter({ removeComments: true })
function printNode(node) {
  return canon(printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile() ?? undefined))
}

/**
 * AST pass: a conditional type whose false branch is a `…TypeError<…>` sentinel collapses to its
 * true branch (and vice versa when the sentinel is the true branch).
 */
function reduceSentinelsAst(node) {
  const isSentinel = (t) =>
    t !== undefined &&
    ts.isTypeReferenceNode(t) &&
    ts.isIdentifier(t.typeName) &&
    t.typeName.text.endsWith('TypeError')
  const transformer = (ctx) => {
    const visit = (n) => {
      if (ts.isConditionalTypeNode(n)) {
        if (isSentinel(n.falseType)) return visit(n.trueType)
        if (isSentinel(n.trueType)) return visit(n.falseType)
      }
      return ts.visitEachChild(n, visit, ctx)
    }
    return (root) => visit(root)
  }
  return ts.transform(node, [transformer]).transformed[0]
}

/** Text pass for sentinel arms that only exist after alias expansion: `cond ? Err<"…"> : ` drops. */
function reduceSentinelsText(text) {
  let prev
  do {
    prev = text
    text = text.replace(/[^?:]*? extends [^?]*? \? \w*TypeError<"[^"]*"> : /, ' ')
  } while (text !== prev)
  return text
}

/** `name: (args) => R` (property of function type) → `name(args): R` (method spelling). */
function propFnToMethod(text) {
  const m = /^([\w$]+)(\?)?: ?\(/.exec(text)
  if (!m) return text
  let depth = 0
  let i = text.indexOf('(')
  for (; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') {
      depth--
      if (depth === 0) break
    }
  }
  const after = text.slice(i + 1)
  const arrow = /^ => /.exec(after)
  if (!arrow) return text
  const params = text.slice(text.indexOf('(') + 1, i)
  return `${m[1]}${m[2] ?? ''}(${params}): ${after.slice(arrow[0].length)}`
}

/** Split `A, B<C, D>, E` at depth-0 commas. */
function splitArgs(s) {
  const out = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '<' || c === '(' || c === '[' || c === '{') depth++
    else if ((c === '>' && s[i - 1] !== '=') || c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(s.slice(start).trim())
  return out
}

/** Expand references to expandable aliases/interfaces in canonical text, one pass. */
function expandOnce(text, expandables) {
  let out = ''
  let i = 0
  let changed = false
  while (i < text.length) {
    const rest = text.slice(i)
    const m = /^[A-Za-z_$][\w$]*/.exec(rest)
    if (!m || (i > 0 && /[\w$.]/.test(text[i - 1]))) {
      out += text[i]
      i++
      continue
    }
    const name = m[0]
    const exp = expandables.get(name)
    if (!exp) {
      out += name
      i += name.length
      continue
    }
    let j = i + name.length
    let args = []
    if (text[j] === '<') {
      let depth = 0
      let k = j
      for (; k < text.length; k++) {
        if (text[k] === '<') depth++
        else if (text[k] === '>' && text[k - 1] !== '=') {
          depth--
          if (depth === 0) break
        }
      }
      if (depth !== 0) {
        out += name
        i += name.length
        continue
      }
      args = splitArgs(text.slice(j + 1, k))
      j = k + 1
    }
    if (exp.params.length !== args.length) {
      out += name
      i += name.length
      continue
    }
    let body = exp.body
    // Longest-first so `TExtra` is not clobbered by `T`.
    const order = exp.params
      .map((p, idx) => [p, args[idx]])
      .sort((a, b) => b[0].length - a[0].length)
    for (const [param, arg] of order) {
      body = body.replace(new RegExp(`\\b${param}\\b`, 'g'), arg)
    }
    out += body
    i = j
    changed = true
  }
  return { text: out, changed }
}

function expandFully(text, expandables) {
  let t = text
  for (let round = 0; round < 3; round++) {
    const r = expandOnce(t, expandables)
    t = r.text
    if (!r.changed) break
  }
  return canon(t)
}

/** All canonical forms a node can honestly take, most-literal first. */
function candidatesOf(node, expandables) {
  // `bases` is a fixed snapshot: the derivation loop must NOT see its own additions, or a shape
  // whose expansion keeps producing new text derives forever.
  const bases = [printNode(node)]
  try {
    bases.push(printNode(reduceSentinelsAst(node)))
  } catch {
    /* synthesized-node printing can fail on exotic shapes; the text passes still run */
  }
  const texts = new Set(bases)
  for (const t of bases) {
    const expanded = expandFully(t, expandables)
    texts.add(expanded)
    const reduced = canon(reduceSentinelsText(expanded))
    texts.add(reduced)
    texts.add(canon(propFnToMethod(reduced)))
  }
  return texts
}

function matches(shownSet, realSets) {
  for (const set of realSets) for (const t of set) if (shownSet.has(t)) return true
  return false
}

/** Members of a class/interface/enum node, with constructors kept apart. */
function membersOf(node) {
  const members = []
  const constructors = []
  for (const m of node.members ?? []) {
    if (ts.isConstructorDeclaration(m) || ts.isConstructSignatureDeclaration(m))
      constructors.push(m)
    else members.push(m)
  }
  return { members, constructors }
}

function headOf(canonText) {
  const i = canonText.indexOf('{')
  return (i === -1 ? canonText : canonText.slice(0, i)).trim()
}

/** Every named top-level declaration of a parsed block. */
function blockDecls(source) {
  const out = []
  for (const stmt of source.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) out.push({ name: d.name.text, node: stmt, kind: 'value' })
      }
      continue
    }
    const name = stmt.name && ts.isIdentifier(stmt.name) ? stmt.name.text : undefined
    if (!name) continue
    if (ts.isFunctionDeclaration(stmt)) out.push({ name, node: stmt, kind: 'function' })
    else if (
      ts.isInterfaceDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    )
      out.push({ name, node: stmt, kind: 'membered', stmt })
    else if (ts.isTypeAliasDeclaration(stmt)) out.push({ name, node: stmt, kind: 'type', stmt })
  }
  return out
}

/** Strip elision-only lines (`…`, `// …`, `...`) before parsing; report whether any existed. */
function preprocess(text) {
  let elided = false
  const lines = text.split('\n').filter((l) => {
    if (/^\s*(\/\/\s*)?(…|\.\.\.)\s*$/.test(l)) {
      elided = true
      return false
    }
    return true
  })
  return { text: lines.join('\n'), elided }
}

function main() {
  const pages = readAllPages()
  const dtsByEntry = entryDtsPaths()

  const rootFiles = [...new Set(dtsByEntry.values())]
  const program = ts.createProgram(rootFiles, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    skipLibCheck: true,
    noEmit: true,
  })
  const checker = program.getTypeChecker()

  /** entry key → Map(exported name → its declarations, alias-resolved). */
  const exportsByEntry = new Map()
  const exportedNames = new Set()
  for (const [key, dts] of dtsByEntry) {
    const sf = program.getSourceFile(dts)
    if (!sf) {
      fail(`${key}: built declaration file missing (${dts}) — run pnpm build first`)
      continue
    }
    const moduleSymbol = checker.getSymbolAtLocation(sf)
    if (!moduleSymbol) continue
    const names = new Map()
    for (let sym of checker.getExportsOfModule(moduleSymbol)) {
      const exported = sym.name
      exportedNames.add(exported)
      while (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym)
      const decls = (sym.getDeclarations() ?? []).filter((d) => !ts.isExportSpecifier(d))
      if (decls.length > 0) names.set(exported, decls)
    }
    exportsByEntry.set(key, names)
  }

  /**
   * Unexported aliases/parameter-free interfaces across the packages' own `.d.ts`, for the
   * expansion retry — and every membered declaration by name, for inherited-member lookups.
   */
  const expandables = new Map()
  const memberedByName = new Map()
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.includes('/packages/')) continue
    for (const stmt of sf.statements) {
      const name = stmt.name && ts.isIdentifier(stmt.name) ? stmt.name.text : undefined
      if (!name) continue
      if (
        (ts.isInterfaceDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
        !memberedByName.has(name)
      ) {
        memberedByName.set(name, stmt)
      }
      if (exportedNames.has(name) || expandables.has(name)) continue
      // Sentinel aliases must survive expansion by NAME, or the sentinel-arm reducer that runs
      // after expansion has nothing left to recognize.
      if (/TypeError$|Msg$/.test(name)) continue
      if (ts.isTypeAliasDeclaration(stmt)) {
        expandables.set(name, {
          params: (stmt.typeParameters ?? []).map((p) => p.name.text),
          body: canon(printer.printNode(ts.EmitHint.Unspecified, stmt.type, sf)),
        })
      } else if (ts.isInterfaceDeclaration(stmt) && (stmt.typeParameters ?? []).length === 0) {
        // An interface with heritage expands to the intersection a page would have to write.
        const bases = (stmt.heritageClauses ?? []).flatMap((h) => h.types.map((t) => printNode(t)))
        const body = `{ ${(stmt.members ?? []).map((m) => printNode(m)).join('; ')} }`
        expandables.set(name, { params: [], body: [...bases, body].join(' & ') })
      }
    }
  }

  /** Own + inherited (depth ≤ 4) members of a built class/interface. */
  function allRealMembers(decl) {
    const out = { members: [], constructors: [] }
    const seen = new Set()
    const walk = (d, depth) => {
      if (d === undefined || depth > 4 || seen.has(d)) return
      seen.add(d)
      const { members, constructors } = membersOf(d)
      out.members.push(...members)
      if (depth === 0) out.constructors.push(...constructors)
      for (const h of d.heritageClauses ?? []) {
        for (const t of h.types) {
          if (ts.isIdentifier(t.expression)) walk(memberedByName.get(t.expression.text), depth + 1)
        }
      }
    }
    walk(decl, 0)
    return out
  }

  let checked = 0
  let blocks = 0
  let localHelpers = 0
  const optedOut = []
  for (const page of pages) {
    const apiEntries = [page.frontmatter.apiEntry ?? []].flat().filter(Boolean)
    for (const block of page.blocks) {
      if (!block.attrs.signature || !['ts', 'tsx'].includes(block.lang)) continue
      blocks++
      const where = `${page.page}:${block.line}`
      if (block.attrs['signature-drift']) {
        if (typeof block.attrs['signature-drift'] !== 'string') {
          fail(`${where}: signature-drift needs a reason (signature-drift="…")`)
        } else optedOut.push({ where, reason: block.attrs['signature-drift'] })
        continue
      }
      const { text, elided } = preprocess(block.text)
      const source = ts.createSourceFile(`${where}.ts`, text, ts.ScriptTarget.ES2023, true)
      const decls = blockDecls(source)

      // The page side may reference its own local aliases; expand those too — but the built
      // definition wins when the same name exists there, so a stub cannot weaken the check.
      const pageExpandables = new Map(expandables)
      for (const d of decls) {
        if (d.kind !== 'type' || expandables.has(d.name) || exportedNames.has(d.name)) continue
        const found = apiEntries.some((k) => exportsByEntry.get(k)?.has(d.name))
        if (found) continue
        pageExpandables.set(d.name, {
          params: (d.stmt.typeParameters ?? []).map((p) => p.name.text),
          body: canon(printer.printNode(ts.EmitHint.Unspecified, d.stmt.type, source)),
        })
      }

      for (const decl of decls) {
        const real = (() => {
          for (const key of apiEntries) {
            const found = exportsByEntry.get(key)?.get(decl.name)
            if (found) return found
          }
          return undefined
        })()
        if (!real) {
          // Local helper context, not a claim — `docs-coverage` polices name existence.
          localHelpers++
          continue
        }
        checked++
        if (LIST) console.log(`      ${where} ${decl.name}`)
        const realNodes = real.map((d) =>
          ts.isVariableDeclaration(d) && d.parent?.parent ? d.parent.parent : d,
        )
        const shownSet = candidatesOf(decl.node, pageExpandables)
        if (
          matches(
            shownSet,
            realNodes.map((n) => candidatesOf(n, expandables)),
          )
        )
          continue

        if (decl.kind === 'membered') {
          const realMembered = realNodes.find(
            (d) =>
              ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d) || ts.isEnumDeclaration(d),
          )
          if (realMembered) {
            const shownHead = headOf(expandFully(printNode(decl.node), pageExpandables))
            const realHead = headOf(expandFully(printNode(realMembered), expandables))
            if (shownHead !== realHead) {
              fail(
                `${where}: \`${decl.name}\` declaration head drifted\n      page:  ${shownHead}\n      built: ${realHead}`,
              )
              continue
            }
            const shownM = membersOf(decl.node)
            const realAll = allRealMembers(realMembered)
            const realSets = [...realAll.members, ...realAll.constructors].map((m) =>
              candidatesOf(m, expandables),
            )
            let bad = false
            for (const m of [...shownM.members, ...shownM.constructors]) {
              if (!matches(candidatesOf(m, pageExpandables), realSets)) {
                const mName = m.name && ts.isIdentifier(m.name) ? m.name.text : undefined
                const twin = realAll.members.find(
                  (r) => r.name && ts.isIdentifier(r.name) && r.name.text === mName,
                )
                const hint = twin
                  ? `\n      built (all forms):\n        ${[...candidatesOf(twin, expandables)].join('\n        ')}`
                  : ''
                fail(
                  `${where}: \`${decl.name}\` shows a member the built declaration does not have (or spells differently):\n      page:  ${printNode(m)}${hint}`,
                )
                bad = true
              }
            }
            if (bad || elided) continue
            // Full-body mode: no OWN member may be missing from the page — except constructors.
            const shownSets = shownM.members.map((m) => candidatesOf(m, pageExpandables))
            for (const m of membersOf(realMembered).members) {
              if (!matches(candidatesOf(m, expandables), shownSets)) {
                fail(
                  `${where}: \`${decl.name}\` is missing a member the built declaration has (add it, or elide with a \`// …\` line):\n      built: ${printNode(m)}`,
                )
              }
            }
            continue
          }
        }

        fail(
          `${where}: \`${decl.name}\` drifted from the built declaration\n      page:  ${printNode(decl.node)}\n      built: ${realNodes.map(printNode).join('\n             ')}`,
        )
      }
    }
  }

  const drifted = process.exitCode === 1
  console.log(
    `docs-signatures: ${checked} declarations across ${blocks} signature blocks checked against the built .d.ts` +
      ` (${localHelpers} block-local helper declarations skipped)` +
      (optedOut.length > 0
        ? `; ${optedOut.length} opted out with a reason${LIST ? optedOut.map((o) => `\n      ${o.where}: ${o.reason}`).join('') : ''}`
        : ''),
  )
  if (drifted) {
    console.error(
      'docs-signatures: drift found — fix the page or, for an honest paraphrase, add signature-drift="why"',
    )
  }
}

main()
