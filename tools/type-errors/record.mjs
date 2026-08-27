// Records the `tsc --pretty false` output of every case in `cases/` as a golden, per compiler.
//
//   node tools/type-errors/record.mjs [--check]
//
// `--check` is what the vitest runner uses: it recomputes and reports drift instead of writing.
// The two are the same code path on purpose — a recorder that does not share the reader's
// normalisation records a golden that can never match.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

/**
 * Goldens must not depend on where the checkout lives or on the OS: TS2719-style diagnostics spell
 * `import("/abs/path/to/repo/packages/…")`, and tsc on Windows prints `C:/…` with CRLF. Both the
 * recorder and the checker pass every line through this, so the golden is the same on a laptop,
 * on ubuntu-latest and on windows-latest.
 */
const ROOT_FORMS = [...new Set([ROOT, ROOT.replaceAll('\\', '/'), ROOT.replaceAll('/', '\\')])]
function portable(line) {
  let out = line.replace(/\r$/, '')
  for (const form of ROOT_FORMS) out = out.split(form).join('<repo>')
  // `import("<file>").T` is how the checker spells a type whose short name would be ambiguous
  // (TS2719 "two different types with this name"). A closed specifier is a path and nothing more.
  out = out.replace(/import\("[^"]*"\)/g, 'import("<module>")')
  // An ELIDED type string is cut at a fixed character offset, so how much of it is visible — and
  // therefore its text — depends on the length of the checkout path on that machine. The visible
  // part carries no information a golden should pin; collapse it, keep the tail that does.
  out = out.replace(/import\("[^']*?\.\.\./g, '<elided>...')
  return out
}

export const COMPILERS = {
  /** The consumer floor (design/00 sign-off #2). */
  '5.9.3': join(ROOT, 'node_modules', 'typescript59', 'bin', 'tsc'),
  /** The build compiler (tsgo). */
  '7.0.2': join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
}

const CASES = join(HERE, 'cases')
const GOLDEN = join(HERE, '__golden__')

export function caseNames() {
  return readdirSync(CASES)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort()
}

/**
 * One compile of the whole `cases/` project, split per case file.
 *
 * A diagnostic is `path(line,col): error TSxxxx: message`, and TypeScript continues a multi-line
 * message on following indented lines — those belong to the diagnostic above them, and counting
 * them is the entire point of design/04 §4's line count.
 */
export function collect(bin) {
  let out
  try {
    out = execFileSync(process.execPath, [bin, '-p', join(HERE, 'tsconfig.json'), '--pretty', 'false'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`
  }

  const byCase = Object.fromEntries(caseNames().map((n) => [n, []]))
  let current = null
  for (const rawLine of out.split(/\r?\n/)) {
    const raw = portable(rawLine)
    if (!raw.trim()) continue
    // `cases/x.ts(6,42): error TS2551: ...` — path is absolute or relative depending on the compiler.
    const m = /^(?:.*[/\\])?cases[/\\]([\w.-]+)\.ts\((\d+),(\d+)\): (error TS\d+: .*)$/.exec(raw)
    if (m) {
      current = m[1]
      if (!byCase[current]) byCase[current] = []
      byCase[current].push(`${m[1]}.ts(${m[2]},${m[3]}): ${m[4]}`)
    } else if (current && /^\s/.test(raw)) {
      byCase[current].push(raw.replace(/\s+$/, ''))
    } else {
      current = null
    }
  }
  return byCase
}

/** design/04 D9's budget, measured the way §4's table measures it. */
export function budgetOf(lines) {
  return { lines: lines.length, chars: lines.join('\n').length }
}

const goldenPath = (name, version) => join(GOLDEN, `${name}.${version}.txt`)

export function readGolden(name, version) {
  try {
    return readFileSync(goldenPath(name, version), 'utf8').replace(/\n$/, '')
  } catch {
    return null
  }
}

if (process.argv[1] && process.argv[1].endsWith('record.mjs')) {
  const check = process.argv.includes('--check')
  let drift = 0
  for (const [version, bin] of Object.entries(COMPILERS)) {
    const byCase = collect(bin)
    console.log(`\nTypeScript ${version}`)
    for (const name of caseNames()) {
      const lines = byCase[name] ?? []
      const text = lines.join('\n')
      const { lines: n, chars } = budgetOf(lines)
      const flag = n === 0 ? 'NO ERROR' : n === 1 && chars < 300 ? 'ok' : 'OVER D9'
      console.log(`  ${name.padEnd(28)} ${String(n).padStart(2)} line(s) ${String(chars).padStart(5)} ch  ${flag}`)
      if (check) {
        if (readGolden(name, version) !== text) {
          drift++
          console.log(`    DRIFT vs golden`)
        }
      } else {
        writeFileSync(goldenPath(name, version), text + '\n')
      }
    }
  }
  if (check && drift) process.exit(1)
  console.log(check ? '\nno drift' : `\nrecorded → ${GOLDEN}`)
}
