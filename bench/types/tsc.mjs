// Shared `tsc --extendedDiagnostics` plumbing for the type benches. Extracted from run.mjs so
// forks.mjs (design/09 §3.0) measures with exactly the same instrument.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

export const COMPILERS = {
  '5.9.3': join(ROOT, 'node_modules', 'typescript59', 'bin', 'tsc'),
  '7.0.2': join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
}

const NUM = /^([A-Za-z][A-Za-z /]*?):\s+([\d.]+)(s|K)?\s*$/

export function parseDiagnostics(text) {
  const m = {}
  for (const line of text.split('\n')) {
    const hit = NUM.exec(line)
    if (!hit) continue
    const [, label, value, unit] = hit
    m[label.trim()] = { value: Number(value), unit: unit ?? '' }
  }
  const get = (k) => m[k]?.value
  return {
    instantiations: get('Instantiations'),
    types: get('Types'),
    symbols: get('Symbols'),
    checkTime: get('Check time'),
    totalTime: get('Total time'),
    memoryMb: get('Memory used') !== undefined ? Math.round(get('Memory used') / 1024) : undefined,
  }
}

export function runTsc(tscPath, dir) {
  let out
  try {
    out = execFileSync(
      process.execPath,
      [
        tscPath,
        '-p',
        join(dir, 'tsconfig.json'),
        '--noEmit',
        '--extendedDiagnostics',
        '--pretty',
        'false',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
  const errors = out.split('\n').filter((l) => /error TS\d+/.test(l))
  if (errors.length) throw new Error(`${dir} did not typecheck:\n${errors.slice(0, 5).join('\n')}`)
  const parsed = parseDiagnostics(out)
  if (parsed.instantiations === undefined) {
    throw new Error(`${dir}: no --extendedDiagnostics output:\n${out.slice(0, 400)}`)
  }
  return parsed
}

/** Best-of-N on check time; instantiation counts are deterministic. */
export function measure(tscPath, dir, repeats = 1) {
  let best = null
  for (let i = 0; i < repeats; i++) {
    const r = runTsc(tscPath, dir)
    if (!best || r.checkTime < best.checkTime) best = r
  }
  return best
}
