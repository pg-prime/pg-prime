// The measuring instrument for the runtime bench (design/09 WS7, R9).
//
// Three things live here and nothing else: how a sample is taken, how allocation is counted, and
// how the machine's own speed is measured so a wall-clock budget can survive a shared CI runner.
//
// ─── Why a gate cannot be a raw microsecond number ──────────────────────────
//
// design/08 §5 is explicit that "a wall-clock database benchmark on a shared CI runner is noise,
// and gating PRs on noise trains people to re-run CI until it passes", and its answer for the DB
// cases is to gate a RATIO (`orm_p50 / raw_p50`) rather than an absolute. The same reasoning
// applies to the no-I/O compile bench: the absolute number on an M1 Pro and the absolute number on
// a 4-vCPU GitHub runner differ by ~2x, so a budget loose enough not to flake there is too loose to
// notice the 30% regression design/09 WS7's exit gate demands.
//
// So every timed gate here is expressed against {@link calibrate}: a fixed, self-contained
// reference workload measured with the same sampler in the same process. It is deliberately shaped
// like the thing under test — allocate a small object tree, freeze it, walk it, push strings into
// an array, `join('')` once — so that it moves with allocation speed, minor-GC cost, string
// building and polymorphic property access, which is what the compiler's cost actually is (25% of
// the compile profile is `mkNode`'s `Object.freeze` + `WeakSet.add`; 20% is GC).
//
// The absolute microseconds are still reported, and one of them — the emitter's p50 against
// design/03 §1.1's 25 µs — is gated absolutely, because it has 5x headroom and is therefore safe on
// any runner. Everything tighter than that is a ratio.
//
// ─── Why allocation is the other gate ───────────────────────────────────────
//
// design/08 §5: "allocation count is where ORM overhead actually hides". Bytes per operation is
// also the one number here that is machine-INDEPENDENT — the same V8 allocates the same objects on
// a laptop and on a runner — so it is gated tightly (±10%) where time is gated loosely. An extra
// intermediate SQL string shows up here before it shows up in the clock.

import { performance } from 'node:perf_hooks'

/** p-th percentile of an already-sorted array, nearest-rank. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return NaN
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}

/**
 * `samples` timings of `iters` calls each, reported as microseconds per call.
 *
 * WS7's brief asks for ≥ 30 samples after warm-up; the default is 60 because the p99 of a 30-sample
 * set is its maximum, and a maximum on a laptop that is also running a test suite is a coin flip.
 * Warm-up is a whole extra `iters * warmupFactor` calls so that V8 has tiered up and the inline
 * caches have seen the real shapes before the clock starts.
 */
export function sample(fn, { iters = 2000, samples = 60, warmup = 5000 } = {}) {
  for (let i = 0; i < warmup; i++) fn()
  const us = []
  for (let s = 0; s < samples; s++) {
    const t0 = performance.now()
    for (let i = 0; i < iters; i++) fn()
    us.push(((performance.now() - t0) * 1000) / iters)
  }
  us.sort((a, b) => a - b)
  return {
    iters,
    samples,
    p50: percentile(us, 50),
    p95: percentile(us, 95),
    p99: percentile(us, 99),
    min: us[0],
    max: us[us.length - 1],
  }
}

/**
 * Two functions measured ALTERNATELY, one sample each, in one process (design/08 §5: "interleaved
 * in the same process to cancel drift").
 *
 * A sequential a-then-b measurement on a laptop that thermally throttles, or on a runner whose
 * neighbour starts a build halfway through, reports the drift as a ratio. Interleaving cannot fix
 * noise but it does stop noise from having a *direction*.
 */
export function samplePaired(a, b, { iters = 20, samples = 60, warmup = 10 } = {}) {
  for (let i = 0; i < warmup; i++) {
    a()
    b()
  }
  const ax = []
  const bx = []
  for (let s = 0; s < samples; s++) {
    let t0 = performance.now()
    for (let i = 0; i < iters; i++) a()
    ax.push(((performance.now() - t0) * 1000) / iters)
    t0 = performance.now()
    for (let i = 0; i < iters; i++) b()
    bx.push(((performance.now() - t0) * 1000) / iters)
  }
  ax.sort((x, y) => x - y)
  bx.sort((x, y) => x - y)
  const stat = (xs) => ({
    p50: percentile(xs, 50),
    p95: percentile(xs, 95),
    p99: percentile(xs, 99),
    min: xs[0],
  })
  const A = stat(ax)
  const B = stat(bx)
  return {
    a: A,
    b: B,
    ratioP50: A.p50 / B.p50,
    ratioP95: A.p95 / B.p95,
    ratioP99: A.p99 / B.p99,
    iters,
    samples,
  }
}

/** The same, for `async` functions — the end-to-end cases (design/08 §5). */
export async function samplePairedAsync(a, b, { iters = 1, samples = 60, warmup = 10 } = {}) {
  for (let i = 0; i < warmup; i++) {
    await a()
    await b()
  }
  const ax = []
  const bx = []
  for (let s = 0; s < samples; s++) {
    let t0 = performance.now()
    for (let i = 0; i < iters; i++) await a()
    ax.push((performance.now() - t0) / iters)
    t0 = performance.now()
    for (let i = 0; i < iters; i++) await b()
    bx.push((performance.now() - t0) / iters)
  }
  ax.sort((x, y) => x - y)
  bx.sort((x, y) => x - y)
  const stat = (xs) => ({
    p50: percentile(xs, 50),
    p95: percentile(xs, 95),
    p99: percentile(xs, 99),
    min: xs[0],
  })
  const A = stat(ax)
  const B = stat(bx)
  return {
    a: A,
    b: B,
    ratioP50: A.p50 / B.p50,
    ratioP95: A.p95 / B.p95,
    ratioP99: A.p99 / B.p99,
    iters,
    samples,
  }
}

/**
 * Bytes allocated per call, as the median of `batches` batches.
 *
 * `heapUsed` before and after a batch, with no GC in between, is the total the batch allocated
 * INCLUDING the garbage — which is the number we want, because garbage is what costs.
 *
 * ─── Three ways this measurement lies ───────────────────────────────────────
 *
 * 1. **The caller throws the result away.** This is the one that actually bit, and it is the
 *    caller's to fix, not this function's: with the result unused, escape analysis sinks the
 *    allocation and a stage of a builder chain can read *less* than the stage before it. Every
 *    caller here stores what it measures — see the `keep()` sink in `profile.mjs`, which exists
 *    because the first version of that file did not.
 *
 * 2. **A scavenge inside the batch.** The instant a minor GC runs mid-batch the delta stops being
 *    "what was allocated" and becomes "what survived", which is near zero for a pure function. So
 *    the batch is **sized from a probe** to keep each batch's allocation near `targetBatchBytes`
 *    (256 KB, comfortably inside any nursery V8 will give us) — eight calls for a 31 KB/op
 *    workload, thirty for an 8 KB one — and the result carries `stable`: the same measurement
 *    repeated at a quarter of the batch size, agreeing within 3 %. A `stable: false` means the
 *    number is a floor, not a measurement, and `run.mjs` prints it as one.
 *
 *    How much this was worth is worth writing down, because it is less than it looks: measured on
 *    the reference machine, the fixed batch of 500 this function used to use and the probe-sized
 *    batch agree to **~1 %** on all three gated workloads (31 904 vs 31 530 B for the heavy
 *    build-and-compile, 8 830 vs 8 729 B for the builder chain alone). The value of the change is
 *    the `stable` flag and the small-batch honesty, not a correction to the numbers — which is
 *    also why the pre- and post-perf-pass allocation figures in design/09 §3.7 are comparable.
 *
 * 3. **The instrument's own allocation.** `process.memoryUsage()` returns a fresh object, so the
 *    two calls that bracket a batch allocate ~256 B between them. At batch 500 that is half a byte
 *    per op and invisible; at the batch sizes point 2 forces (single digits for a 31 KB workload)
 *    it is tens of bytes per op. It is measured once, with an empty body, and subtracted.
 *
 * `globalThis.gc?.()` is called ONCE before the batches rather than before each one, because at
 * these batch sizes a full GC between batches empties the `WeakSet` of AST nodes and the `WeakMap`
 * memos and every batch re-pays their backing-store growth. One collection up front, then
 * consecutive batches, and the median absorbs the natural collections along the way; the ~1 %
 * agreement above is with the per-batch-`gc()` version, so this is a wash on accuracy.
 */
export function bytesPerOp(
  fn,
  { targetBatchBytes = 262144, batches = 25, warmup = 20000, maxBatch = 2000 } = {},
) {
  for (let i = 0; i < warmup; i++) fn()
  const overhead = harnessOverhead()
  globalThis.gc?.()
  // A tiny batch to size the real one. It over-reads slightly (the overhead correction is itself
  // ±64 B), which only ever makes the chosen batch smaller, i.e. safer.
  const probe = batchMedian(fn, 4, 9, overhead)
  const batch = Math.max(1, Math.min(maxBatch, Math.round(targetBatchBytes / Math.max(probe, 64))))
  const main = batchMedian(fn, batch, batches, overhead)
  // The cross-check: a quarter of the batch cannot be scavenging where the full one is not.
  const quarter =
    batch > 4 ? batchMedian(fn, Math.max(1, batch >> 2), Math.ceil(batches / 2), overhead) : main
  const worst = Math.max(main, quarter)
  return {
    median: Math.round(worst),
    batch,
    stable: worst === 0 ? true : Math.abs(main - quarter) / worst <= 0.03,
    exact: typeof globalThis.gc === 'function',
  }
}

/** The median per-op delta of `batches` batches of `batch` calls, minus the harness's own bytes. */
function batchMedian(fn, batch, batches, overhead) {
  const xs = []
  for (let s = 0; s < batches; s++) {
    const before = process.memoryUsage().heapUsed
    for (let i = 0; i < batch; i++) fn()
    const after = process.memoryUsage().heapUsed
    xs.push((after - before - overhead) / batch)
  }
  xs.sort((a, b) => a - b)
  return percentile(xs, 50)
}

/** What two bracketing `process.memoryUsage()` calls allocate between them, with nothing in between. */
function harnessOverhead() {
  const xs = []
  for (let s = 0; s < 41; s++) {
    const before = process.memoryUsage().heapUsed
    xs.push(process.memoryUsage().heapUsed - before)
  }
  xs.sort((a, b) => a - b)
  return percentile(xs, 50)
}

/**
 * The machine-speed reference. See the module docblock for why it exists.
 *
 * Shaped like the compiler on purpose: build a frozen node tree, register it in a `WeakSet` (that
 * is `mkNode`, the top frame of the compile profile), walk it, push chunks into a `string[]`, and
 * `join('')` once. It has no dependency on anything in `pg-prime`, so it can never move when the
 * library changes — which is the entire point: a change in the ratio is a change in `pg-prime`.
 *
 * **Never edit this function.** Editing it silently re-bases every ratio budget in `budget.json`.
 * If it ever must change, every ratio has to be re-measured and the change reviewed as a budget
 * change (R9).
 */
const REF_SET = new WeakSet()
const REF_WORDS = ['select', '"users"', '.', '"id"', ' as ', '"k"', ', ', 'from', ' where ', '$1']

export function referenceWorkload() {
  const nodes = []
  for (let i = 0; i < 24; i++) {
    const n = {
      k: 'ref',
      i,
      name: REF_WORDS[i % REF_WORDS.length],
      child: i > 0 ? nodes[i - 1] : null,
    }
    Object.freeze(n)
    REF_SET.add(n)
    nodes.push(n)
  }
  const chunks = []
  for (const n of nodes) {
    if (!REF_SET.has(n)) throw new Error('unreachable')
    chunks.push(n.name)
    chunks.push(n.child === null ? '' : String(n.i))
  }
  return chunks.join('')
}

/**
 * Microseconds for one {@link referenceWorkload} call on this machine. Every timed budget in
 * `budget.json` that is expressed as `…RefRatio` is divided by this.
 *
 * `run.mjs` calls it three times — before, between and after the measured sections — and keeps the
 * smallest, because the *minimum* is the only statistic here that is not contaminated by whatever
 * else the machine was doing. Measured on the reference machine it is stable to ~1 % across runs
 * (3.75-3.88 µs), and it drifts by tens of percent when the heap is full of bench garbage, which is
 * exactly the contamination the minimum removes.
 */
export function calibrate() {
  return sample(referenceWorkload, { iters: 5000, samples: 40, warmup: 50000 })
}
