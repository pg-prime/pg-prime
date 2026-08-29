// R9's other half, and the only part of this bench that gates the BUDGETS rather than the code.
//
// Every check in `run.mjs` compares a measurement with a budget. None of them notices the other
// way a perf gate dies: someone edits `budget.json`, the run goes green, and the design number
// quietly stops being the target. `_designLinked` names which budget corresponds to which figure
// in `_design`, and a budget looser than its design figure has to be listed in `_overDesign` with
// a reason — which turns "loosening a budget is a reviewed change with a reason" from a convention
// into a gate.
//
// ─── Why it is a module with controls rather than thirty lines inside run.mjs ─
//
// It was thirty lines inside `run.mjs`, and design/12 §4 P's R10 pass mutated it three ways —
// treat every budget as waived, check only the first entry of a per-case map, forget which metrics
// are floors — and **all three survived every check in the repository**. A gate whose own logic is
// untested is a gate that can stop gating in silence, which is exactly the failure it exists to
// prevent one level up. So the logic is a pure function of a budget object, and
// {@link budgetGateSelfTest} feeds it budgets that MUST be refused. `run.mjs` runs the controls on
// every invocation, including `--compile-only`, so they cost nothing and cannot rot.

/** `at(o, 'a.b.c')` — the `_designLinked` keys are dotted paths into the budget. */
const at = (obj, path) =>
  path.split('.').reduce((o, k) => (o === undefined ? undefined : o[k]), obj)

/**
 * Metrics whose measurement is a FLOOR, where a SMALLER budget is the looser one.
 *
 * One entry today. It is a set rather than a heuristic on the name because "per second" in a
 * metric name is a convention and this is a gate.
 */
export const LOWER_IS_LOOSER = new Set(['compile.simpleSelectsPerSecond'])

/**
 * One check per `_designLinked` entry: is this budget looser than the design number it is linked
 * to, and if so is it named in `_overDesign`?
 *
 * A per-case map (the nine e2e budgets) is reduced to its WORST entry, so widening one of the nine
 * is exactly as visible as widening a scalar.
 */
export function budgetLinkChecks(B) {
  const out = []
  for (const [metric, designKey] of Object.entries(B._designLinked)) {
    if (metric.startsWith('_')) continue
    const budgeted = at(B, metric)
    const designed = B._design[designKey]
    if (budgeted === undefined || designed === undefined) {
      out.push({
        name: `budget · ${metric} is linked to a design number`,
        measured: null,
        limit: designKey,
        ok: false,
      })
      continue
    }
    const floor = LOWER_IS_LOOSER.has(metric)
    const entries = typeof budgeted === 'object' ? Object.values(budgeted) : [budgeted]
    const worst = entries.reduce(
      (acc, v) => (floor ? Math.min(acc, v) : Math.max(acc, v)),
      floor ? Infinity : -Infinity,
    )
    const looser = floor ? worst < designed : worst > designed
    const justified = Object.prototype.hasOwnProperty.call(B._overDesign, metric)
    out.push({
      name: `budget · ${metric} vs design (${designed})`,
      measured: worst,
      limit: justified ? `${designed} — waived in _overDesign` : designed,
      ok: !looser || justified,
    })
  }
  return out
}

/**
 * The controls. Each is a budget object the gate MUST accept or MUST refuse; the return value is
 * the list of failures, which `run.mjs` turns into checks of its own.
 */
export function budgetGateSelfTest() {
  const ok = (B) => budgetLinkChecks(B).every((c) => c.ok)
  const base = (over = {}) => ({
    _design: { ratio: 1.15, perSecond: 200000 },
    _designLinked: { 'x.ratio': 'ratio' },
    _overDesign: over,
    x: { ratio: 1.15 },
  })
  const map = (over = {}, cases = { a: 1.15, b: 1.15, c: 1.15 }) => ({
    _design: { ratio: 1.15 },
    _designLinked: { 'x.perCase': 'ratio' },
    _overDesign: over,
    x: { perCase: cases },
  })
  const floor = (over = {}, value = 200000) => ({
    _design: { perSecond: 200000 },
    _designLinked: { 'compile.simpleSelectsPerSecond': 'perSecond' },
    _overDesign: over,
    compile: { simpleSelectsPerSecond: value },
  })

  const controls = [
    ['a budget AT its design number is accepted', ok(base()), true],
    ['a budget OVER design with no waiver is REFUSED', ok({ ...base(), x: { ratio: 2 } }), false],
    [
      'a budget OVER design WITH a waiver is accepted',
      ok({ ...base({ 'x.ratio': 'because' }), x: { ratio: 2 } }),
      true,
    ],
    ['a per-case map with every case at design is accepted', ok(map()), true],
    [
      'a per-case map with the LAST case over design is REFUSED',
      ok(map({}, { a: 1.15, b: 1.15, c: 2 })),
      false,
    ],
    [
      'a per-case map with the FIRST case over design is REFUSED',
      ok(map({}, { a: 2, b: 1.15, c: 1.15 })),
      false,
    ],
    ['a FLOOR at its design number is accepted', ok(floor()), true],
    ['a FLOOR LOWERED past design with no waiver is REFUSED', ok(floor({}, 120000)), false],
    ['a FLOOR RAISED past design is accepted — tighter is not looser', ok(floor({}, 300000)), true],
    [
      'a `_designLinked` entry naming a metric that does not exist is REFUSED',
      ok({ _design: { ratio: 1 }, _designLinked: { 'nope.here': 'ratio' }, _overDesign: {} }),
      false,
    ],
  ]

  return controls
    .filter(([, got, want]) => got !== want)
    .map(([label, got]) => `${label} — the gate ${got ? 'accepted' : 'refused'} it`)
}
