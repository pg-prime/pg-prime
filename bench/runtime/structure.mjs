// The two *structural* claims of design/03 §1.1, checked rather than asserted in prose:
//
//   "zero intermediate SQL strings (chunks are pushed to a `string[]` and `join('')`d once)"
//   "one params array allocation"
//
// ─── How, and why not the obvious way ───────────────────────────────────────
//
// design/09 WS7 asks for "a counting emitter in a test build". The literal reading — a second copy
// of `compiler.ts` with counters in it — is the wrong build: it would be a fork of the file whose
// behaviour is the thing under test, and the fork would be free to drift from production while
// still reporting `1`. Adding counters to the production emitter is worse: it puts bench
// instrumentation on every user's hot path.
//
// So the counting happens *outside* the compiler, on the two array primitives it uses. For the
// duration of exactly one `compile()` call:
//
//   `Array.prototype.join` is wrapped, recording every call with its receiver and its result.
//   Exactly one call, with separator `''`, whose result is byte-identical to `compiled.sql`, is
//   what "assembled once from the chunk array" means. Any intermediate SQL string — a subquery
//   `join`ed and then re-pushed, a `map().join(', ')` over a projection — is a second call, and the
//   check names it.
//
//   `Array.prototype.push` is wrapped, recording which receiver each pushed value went into. The
//   array that received the `Bind` objects is captured by identity, and `compiled.binds` is then
//   compared to it with `===`. That is a *direct* proof of "one params array allocation": the array
//   the caller gets back is the same object the emitter pushed into, so nothing sliced, spread or
//   re-collected it along the way.
//
// Patching a prototype makes V8 fall off every fast path for arrays, so this runs once, outside
// every timing loop, and the numbers it produces are counts and identities — not durations.

/** Recognises a `Bind` (`../packages/pg-prime/src/compile/contract.ts`) without importing it. */
const isBind = (v) =>
  typeof v === 'object' && v !== null && (v.k === 'value' || v.k === 'slot') && !Array.isArray(v)

/**
 * Run `compileOnce()` with the array primitives instrumented.
 *
 * @param {() => {sql: string, binds: readonly unknown[]}} compileOnce
 * @returns a report: how many `join`s happened, how many arrays received `Bind`s, and whether the
 *          returned `binds` is the very array that was pushed into.
 */
export function probeEmitterStructure(compileOnce) {
  const realJoin = Array.prototype.join
  const realPush = Array.prototype.push
  const joins = []
  const bindArrays = new Set()
  const chunkArrays = new Set()

  Array.prototype.join = function join(sep) {
    const result = realJoin.call(this, sep)
    joins.push({ sep, length: this.length, receiver: this, result })
    return result
  }
  Array.prototype.push = function push(...values) {
    for (const v of values) {
      if (isBind(v)) bindArrays.add(this)
      else if (typeof v === 'string') chunkArrays.add(this)
    }
    return realPush.apply(this, values)
  }

  let compiled
  try {
    compiled = compileOnce()
  } finally {
    Array.prototype.join = realJoin
    Array.prototype.push = realPush
  }

  // Only the joins that produced the statement itself are interesting; a `join(', ')` over three
  // identifier parts inside `quoteIdentPath` is not an intermediate SQL string, it is an
  // identifier. The discriminator is the separator: the emitter assembles with `''`.
  const emptySepJoins = joins.filter((j) => j.sep === '' || j.sep === undefined)
  const sqlJoins = emptySepJoins.filter((j) => j.result === compiled.sql)
  const bindArray = [...bindArrays].find((a) => a.length === compiled.binds.length)

  // The gate that actually says "no INTERMEDIATE SQL string": a `join` whose result is a
  // non-trivial *piece* of the finished statement. Sixteen characters is the floor because
  // `quoteIdentPath` joins `["pgprime_bench", "posts"]` into an identifier that is legitimately a
  // substring of the SQL, and an identifier is not a statement fragment. A hoisted subquery, a
  // pre-rendered projection list or a `map(...).join(' and ')` predicate is longer than that and is
  // exactly what this catches.
  const intermediate = joins.filter(
    (j) =>
      j.result !== compiled.sql &&
      typeof j.result === 'string' &&
      j.result.length > 16 &&
      compiled.sql.includes(j.result),
  )

  return {
    /** Every `join()` that ran, by separator — for the report, so a new one is visible. */
    joinsBySeparator: joins.reduce((m, j) => {
      const k = JSON.stringify(j.sep ?? ',')
      m[k] = (m[k] ?? 0) + 1
      return m
    }, {}),
    /** design/03 §1.1: chunks are `join('')`d ONCE. */
    emptySeparatorJoins: emptySepJoins.length,
    /** …and that one join is the statement. */
    joinsProducingTheSql: sqlJoins.length,
    /** design/03 §1.1: ZERO intermediate SQL strings. See the filter above for what counts. */
    intermediateSqlStrings: intermediate.length,
    intermediateSample: intermediate
      .slice(0, 3)
      .map((j) => ({ sep: j.sep, text: j.result.slice(0, 60) })),
    /** The chunk array's length at assembly time — informational, and it moves with the emitter. */
    chunkCount: sqlJoins[0]?.length ?? null,
    /** design/03 §1.1: ONE params array. */
    bindArrays: bindArrays.size,
    /** The proof: the array handed back is the array that was pushed into. */
    bindsArrayIsTheOnePushedInto: bindArray !== undefined && compiled.binds === bindArray,
    binds: compiled.binds.length,
    sqlBytes: compiled.sql.length,
    /**
     * Arrays that received strings. More than the chunk array is expected — `quoteIdentPath` builds
     * one, the hoist builds projection key lists — so this is reported, never gated.
     */
    stringArrays: chunkArrays.size,
  }
}
