// design/08 §5's last sentence: "a >25% regression opens an issue automatically".
//
//   node tools/bench-regression.mjs --before <report.json> --after <report.json> [--out <md>]
//
// Compares two `bench/runtime/report.json` artifacts and prints a Markdown body naming every
// gated ratio that worsened by more than the threshold. Exit codes:
//
//   0  no regression (or nothing comparable) — the nightly does nothing
//   3  at least one regression — the nightly opens an issue with the printed body
//
// ─── Which lines this is allowed to report, and why it is an ALLOW-list ─────
//
// A > 25 % rule is only meaningful on a line whose run-to-run spread is comfortably under 25 %,
// and most of `budget.json`'s lines are not. Measured across the six nightly `bench` artifacts
// after the 2026-08-27 perf pass — the same distribution design/12 §4 P item 1 sized the budgets
// from — the spread of each family, worst case:
//
//   bytes/op (build+compile, emitter, simple)   0.1 – 3.9 %   reportable
//   e2e p50, all nine cases                     2   – 14  %   reportable
//   decode ratios, both builders                10  – 19  %   reportable
//   decode rows/sec, both builders              14  %         reportable
//   e2e p95, all nine cases                     27  – 57  %   NOT reportable
//   e2e p99, all nine cases                     up to 3.5x    NOT reportable
//   absolute µs and the …RefRatio lines         35  – 46  %   NOT reportable
//   simple selects/sec                          51  %         NOT reportable
//
// Written as a deny-list this would rot the first time a gate is added; written as an allow-list
// it fails safe — a new gate is silent until somebody decides it reproduces. The excluded lines
// are still GATED: `budget.json` catches a catastrophe on every one of them. What they are not is
// *regression* material, and an automation that opens an issue on a line with a 57 % natural
// spread is an automation somebody switches off in a fortnight.
//
// The proof that the exclusions are needed rather than cautious: run this over two CONSECUTIVE
// green nightlies of unchanged code (33162423166 → 33184536648) with the tails included and it
// reports `insert 1 000 (batch) · p95` up 56.7 % and `insert one · p95` up 36.8 %.
//
// ─── And the honest limit of the rule itself ────────────────────────────────
//
// design/12 §3 S's regression — point select p50 1.286 → 1.603 — is **+24.6 %**, and this tool
// would NOT have opened an issue for it. That is not a bug in the threshold; 25 % is design/08
// §5's own number and lowering it to catch one case would be fitting a rule to a sample of one.
// It is the reason the two mechanisms are both needed: the per-case BUDGET is what caught that
// regression, on the same night, and this is what catches the one that stays inside its budget.
//
// **Direction matters.** A throughput floor (`rows/sec`) regresses when it goes DOWN; every other
// line regresses when it goes UP. Getting that backwards would open an issue every time the code
// got faster, which is the sort of automation that gets switched off.
//
// **Relative, not absolute.** > 25 % worse than the previous successful run, per design/08 §5.
// A line that is inside its budget can still regress by 25 %, and that is the point: the budget
// says "not broken" and this says "something changed".

import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

const THRESHOLD = Number(arg('--threshold') ?? 0.25)
const SELF_TEST = argv.includes('--self-test')
const beforePath = arg('--before')
const afterPath = arg('--after')
if (!SELF_TEST && (beforePath === undefined || afterPath === undefined)) {
  console.error(
    'usage: bench-regression.mjs --before a.json --after b.json [--out body.md]\n' +
      '       bench-regression.mjs --self-test',
  )
  process.exit(2)
}

/** Lines whose measurement is a FLOOR: bigger is better, so a regression is a fall. */
const FLOORS = /rows\/sec/

/** The allow-list. Every entry earned its place with a measured runner spread — see the docblock. */
const REPORTABLE = [
  /^compile · bytes\/op/,
  /^e2e · .* · p50 orm\/raw$/,
  /^decode · (vs|codegen vs) .* hand mapper \(p50\)$/,
  /^decode · (codegen )?rows\/sec/,
  /^decode · codegen is faster than the closure tree$/,
  /^statement · production \/ pre-session path$/,
  /^statement · production bytes over the pre-session path$/,
  /^structure · /,
]

function load(path) {
  return index(JSON.parse(readFileSync(path, 'utf8')))
}

function index(r) {
  const map = new Map()
  for (const c of r.checks ?? []) {
    if (c.skipped === true || typeof c.measured !== 'number') continue
    if (!REPORTABLE.some((re) => re.test(c.name))) continue
    map.set(c.name, c.measured)
  }
  return { report: r, checks: map }
}

/** The comparison itself, factored out so `--self-test` can drive it without files. */
function regressions(before, after, threshold) {
  const out = []
  for (const [name, now] of after.checks) {
    const was = before.checks.get(name)
    if (was === undefined || was === 0) continue
    const floor = FLOORS.test(name)
    // `worse` is always "how much further from good", whichever direction good is.
    const worse = floor ? was / now - 1 : now / was - 1
    if (worse > threshold) out.push({ name, was, now, worse, floor })
  }
  return out.sort((a, b) => b.worse - a.worse)
}

if (SELF_TEST) selfTest()

const before = load(beforePath)
const after = load(afterPath)
const rows = regressions(before, after, THRESHOLD)

const pct = (x) => `${(x * 100).toFixed(1)} %`
const num = (x) => (Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-US') : x.toFixed(3))

const table = (label, side) =>
  [
    `### ${label}`,
    '',
    `\`${side.report.platform ?? '?'}\` · node ${side.report.node ?? '?'} · generated ${side.report.generatedAt ?? '?'}` +
      (side.report.e2e?.serverVersion === undefined
        ? ''
        : ` · PostgreSQL ${side.report.e2e.serverVersion}` +
          (side.report.e2e.mode === undefined ? '' : ` · mode ${side.report.e2e.mode}`)),
    '',
    '| gate | measured | budget |',
    '|---|---|---|',
    ...(side.report.checks ?? [])
      .filter((c) => typeof c.measured === 'number' && !c.name.startsWith('budget · '))
      .map((c) => `| ${c.name} | ${num(c.measured)}${c.unit ?? ''} | ${c.limit} |`),
  ].join('\n')

/**
 * The issue title, and therefore the deduplication key.
 *
 * It names the WORST gate and nothing else — no count, no percentage. Both of those move from
 * night to night while the regression stays the same, and a title that moves opens a new issue
 * every night until somebody mutes the automation. Naming the gate means the same regression
 * dedupes and a *different* one still gets its own issue.
 */
const title = rows.length === 0 ? '' : `perf regression: ${rows[0].name}`

const body = [
  `design/08 §5: "a >${Math.round(THRESHOLD * 100)}% regression opens an issue automatically". This is that issue.`,
  '',
  `Comparing the nightly \`bench\` job's report with the previous successful run's artifact.`,
  '',
  '## What moved',
  '',
  '| gate | previous | this run | worse by |',
  '|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.name}${r.floor ? ' *(a floor — lower is worse)*' : ''} | ${num(r.was)} | ${num(r.now)} | **${pct(r.worse)}** |`,
  ),
  '',
  'Both full tables follow, because a single line out of context is how a perf issue gets closed as flaky.',
  '',
  table('This run', after),
  '',
  table('Previous run', before),
  '',
  '---',
  '',
  'Reported by `tools/bench-regression.mjs` from `.github/workflows/ci-nightly.yml`. It reports on an',
  'ALLOW-list of lines whose runner spread is comfortably under the threshold — the e2e tails, the',
  'absolute microseconds and the reference ratios are gated but not reported, and that file explains',
  'the measurement behind each exclusion.',
].join('\n')

const out = arg('--out')
if (out !== undefined) writeFileSync(out, `${body}\n`)
console.log(`::title::${title}`)
console.log(body)
process.exit(rows.length > 0 ? 3 : 0)

/**
 * `--self-test`: eight controls over a synthetic report, four of which must FIRE and four of which
 * must NOT. A regression rule with no test is a rule that quietly stops reporting, and the failure
 * mode is silence — nobody notices an issue that was never opened. Run it by hand or from CI; it
 * needs no database, no artifacts and no network.
 */
function selfTest() {
  const base = {
    checks: [
      { name: 'e2e · point select by PK · p50 orm/raw', measured: 1.286, limit: 1.45 },
      { name: 'e2e · delete by PK · p95 orm/raw', measured: 1.089, limit: 1.75 },
      { name: 'decode · vs unchecked hand mapper (p50)', measured: 2.519, limit: 2.95 },
      { name: 'decode · rows/sec (machine-normalised)', measured: 1322101, limit: 1150000 },
      { name: 'compile · bytes/op, build+compile', measured: 31292, limit: 32000 },
      { name: 'compile · emitter p50 (design/03 §1.1)', measured: 6.644, limit: 25 },
      { name: 'statement · production / pre-session path', measured: 1.95, limit: 2.4 },
    ],
  }
  const moved = (name, factor) => ({
    checks: base.checks.map((c) => (c.name === name ? { ...c, measured: c.measured * factor } : c)),
  })
  const cases = [
    ['e2e p50 +30 %', moved('e2e · point select by PK · p50 orm/raw', 1.3), true],
    [
      'e2e p50 +24 % — design/08 §5\u2019s threshold is 25',
      moved('e2e · point select by PK · p50 orm/raw', 1.24),
      false,
    ],
    ['decode ratio +30 %', moved('decode · vs unchecked hand mapper (p50)', 1.3), true],
    ['a FLOOR down 30 %', moved('decode · rows/sec (machine-normalised)', 0.7), true],
    [
      'the same floor UP 30 % \u2014 faster is not a regression',
      moved('decode · rows/sec (machine-normalised)', 1.3),
      false,
    ],
    ['bytes/op +30 %', moved('compile · bytes/op, build+compile', 1.3), true],
    ['statement path +30 %', moved('statement · production / pre-session path', 1.3), true],
    [
      'an e2e TAIL +80 % \u2014 not reportable, spread is 57 %',
      moved('e2e · delete by PK · p95 orm/raw', 1.8),
      false,
    ],
    [
      'absolute µs +80 % \u2014 not reportable, spread is 46 %',
      moved('compile · emitter p50 (design/03 §1.1)', 1.8),
      false,
    ],
  ]
  let bad = 0
  for (const [label, after, shouldFire] of cases) {
    const fired = regressions(index(base), index(after), 0.25).length > 0
    const ok = fired === shouldFire
    if (!ok) bad++
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} ${fired ? 'fires' : 'quiet'} (wanted ${shouldFire ? 'fires' : 'quiet'})`,
    )
  }
  console.log(bad === 0 ? `\n${cases.length}/${cases.length} controls behaved` : `\n${bad} FAILED`)
  process.exit(bad === 0 ? 0 : 1)
}
