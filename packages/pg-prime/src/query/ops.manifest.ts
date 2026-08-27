/**
 * The operator manifest — **one list, four consumers** (design/09 WS3).
 *
 *   1. `test/query/ops.test.ts`         — every row must have a byte-exact SQL + binds golden.
 *   2. `test/live-query/ops.test.ts`    — every expression row must have its result codec's OID
 *                                          confirmed by `select <expr>`'s own `RowDescription`.
 *   3. the same file                     — every predicate row must match a hand-written SQL
 *                                          oracle on the seeded fixture.
 *   4. `test/query/ops-table.test.ts`   — `03` §2.9's table is generated from here and compared
 *                                          against the checked-in markdown, so the docs cannot
 *                                          drift from the code.
 *
 * Adding an operator without adding a row fails (1); adding a row without a golden fails (1);
 * without a probe fails (2); without an oracle fails (3); and either one without regenerating
 * fails (4). That is the "every op is covered" assertion `09` WS3 asks for, made total.
 *
 * This file holds **no implementation** — it is data, so it can be imported by the docs test
 * without dragging the codec registry in, and so a reviewer reads the vocabulary as a table.
 */

/** `03` §2.9's rows, in `03` §2.9's order. */
export type OpClass =
  | 'all'
  | 'text'
  | 'array'
  | 'jsonb'
  | 'numeric'
  | 'tsvector'
  | 'range'
  | 'net'
  | 'vector'
  | 'boolean'
  | 'aggregate'

export interface OpSpec {
  /** The exported function name (`fn.` prefixed for the aggregate namespace). */
  readonly name: string
  readonly class: OpClass
  /** The SQL it emits, with `$n` for every parameterised position. */
  readonly sql: string
  /** The result codec's name, or the rule when it is derived from the operand. */
  readonly result: string
  /**
   * `expr`  — is an expression: `select <it>` executes, so its result OID is confirmable.
   * `order` — is an `ORDER BY` item, not an expression; goldens only.
   */
  readonly kind: 'expr' | 'order'
  /** Set when the live differential cannot run yet, with the reason and the owning workstream. */
  readonly deferred?: string
}

export const OPS: readonly OpSpec[] = [
  // ── every class ────────────────────────────────────────────────────────────
  { name: 'eq', class: 'all', sql: 'a = $n', result: 'bool', kind: 'expr' },
  { name: 'neq', class: 'all', sql: 'a <> $n', result: 'bool', kind: 'expr' },
  { name: 'lt', class: 'all', sql: 'a < $n', result: 'bool', kind: 'expr' },
  { name: 'lte', class: 'all', sql: 'a <= $n', result: 'bool', kind: 'expr' },
  { name: 'gt', class: 'all', sql: 'a > $n', result: 'bool', kind: 'expr' },
  { name: 'gte', class: 'all', sql: 'a >= $n', result: 'bool', kind: 'expr' },
  { name: 'isNull', class: 'all', sql: 'a is null', result: 'bool', kind: 'expr' },
  { name: 'isNotNull', class: 'all', sql: 'a is not null', result: 'bool', kind: 'expr' },
  {
    name: 'isDistinctFrom',
    class: 'all',
    sql: 'a is distinct from $n',
    result: 'bool',
    kind: 'expr',
  },
  {
    name: 'isNotDistinctFrom',
    class: 'all',
    sql: 'a is not distinct from $n',
    result: 'bool',
    kind: 'expr',
  },
  { name: 'between', class: 'all', sql: 'a between $n and $n', result: 'bool', kind: 'expr' },
  { name: 'inList', class: 'all', sql: 'a = any($n)  ·  [] ⇒ false', result: 'bool', kind: 'expr' },
  {
    name: 'notInList',
    class: 'all',
    sql: 'a <> all($n)  ·  [] ⇒ true',
    result: 'bool',
    kind: 'expr',
  },
  { name: 'inQuery', class: 'all', sql: 'a in (select …)', result: 'bool', kind: 'expr' },
  { name: 'coalesce', class: 'all', sql: 'coalesce(a, $n)', result: "a's codec", kind: 'expr' },
  { name: 'cast', class: 'all', sql: 'a::<codec.sqlName>', result: 'the given codec', kind: 'expr' },
  { name: 'val', class: 'all', sql: '$n', result: 'the given codec', kind: 'expr' },

  // ── text / citext ──────────────────────────────────────────────────────────
  { name: 'like', class: 'text', sql: 'a like $n', result: 'bool', kind: 'expr' },
  { name: 'ilike', class: 'text', sql: 'a ilike $n', result: 'bool', kind: 'expr' },
  { name: 'notLike', class: 'text', sql: 'a not like $n', result: 'bool', kind: 'expr' },
  { name: 'notILike', class: 'text', sql: 'a not ilike $n', result: 'bool', kind: 'expr' },
  { name: 'startsWith', class: 'text', sql: 'a ^@ $n', result: 'bool', kind: 'expr' },
  { name: 'regex', class: 'text', sql: 'a ~ $n', result: 'bool', kind: 'expr' },
  { name: 'iregex', class: 'text', sql: 'a ~* $n', result: 'bool', kind: 'expr' },
  { name: 'notRegex', class: 'text', sql: 'a !~ $n', result: 'bool', kind: 'expr' },
  { name: 'notIRegex', class: 'text', sql: 'a !~* $n', result: 'bool', kind: 'expr' },
  { name: 'similarTo', class: 'text', sql: 'a similar to $n', result: 'bool', kind: 'expr' },
  { name: 'concat', class: 'text', sql: 'a || $n', result: 'text', kind: 'expr' },

  // ── array T[] ──────────────────────────────────────────────────────────────
  { name: 'overlaps', class: 'array', sql: 'a && $n', result: 'bool', kind: 'expr' },
  { name: 'arrayContains', class: 'array', sql: 'a @> $n', result: 'bool', kind: 'expr' },
  { name: 'arrayContainedBy', class: 'array', sql: 'a <@ $n', result: 'bool', kind: 'expr' },
  { name: 'has', class: 'array', sql: '$n = any(a)', result: 'bool', kind: 'expr' },
  { name: 'hasAll', class: 'array', sql: 'a @> $n', result: 'bool', kind: 'expr' },
  { name: 'arrayLength', class: 'array', sql: 'array_length(a, 1)', result: 'int4', kind: 'expr' },
  { name: 'arrayConcat', class: 'array', sql: 'a || $n', result: "a's codec", kind: 'expr' },
  { name: 'anyOf', class: 'array', sql: 'any(a)', result: "a's element codec", kind: 'expr' },
  { name: 'allOf', class: 'array', sql: 'all(a)', result: "a's element codec", kind: 'expr' },

  // ── jsonb (accessors also accept json) ─────────────────────────────────────
  { name: 'jsonGet', class: 'jsonb', sql: 'a -> $n', result: "a's json codec", kind: 'expr' },
  { name: 'jsonGetText', class: 'jsonb', sql: 'a ->> $n', result: 'text', kind: 'expr' },
  { name: 'jsonPath', class: 'jsonb', sql: 'a #> $n', result: "a's json codec", kind: 'expr' },
  { name: 'jsonPathText', class: 'jsonb', sql: 'a #>> $n', result: 'text', kind: 'expr' },
  { name: 'jsonContains', class: 'jsonb', sql: 'a @> $n', result: 'bool', kind: 'expr' },
  { name: 'jsonContainedBy', class: 'jsonb', sql: 'a <@ $n', result: 'bool', kind: 'expr' },
  { name: 'hasKey', class: 'jsonb', sql: 'a ? $n', result: 'bool', kind: 'expr' },
  { name: 'hasAnyKey', class: 'jsonb', sql: 'a ?| $n', result: 'bool', kind: 'expr' },
  { name: 'hasAllKeys', class: 'jsonb', sql: 'a ?& $n', result: 'bool', kind: 'expr' },
  { name: 'jsonPathExists', class: 'jsonb', sql: 'a @? $n', result: 'bool', kind: 'expr' },
  { name: 'jsonPathMatch', class: 'jsonb', sql: 'a @@ $n', result: 'bool', kind: 'expr' },
  { name: 'jsonConcat', class: 'jsonb', sql: 'a || $n', result: 'jsonb', kind: 'expr' },
  { name: 'jsonDelete', class: 'jsonb', sql: 'a - $n', result: 'jsonb', kind: 'expr' },
  { name: 'jsonDeletePath', class: 'jsonb', sql: 'a #- $n', result: 'jsonb', kind: 'expr' },

  // ── numeric / int ──────────────────────────────────────────────────────────
  { name: 'add', class: 'numeric', sql: 'a + $n', result: "a's codec", kind: 'expr' },
  { name: 'sub', class: 'numeric', sql: 'a - $n', result: "a's codec", kind: 'expr' },
  { name: 'mul', class: 'numeric', sql: 'a * $n', result: "a's codec", kind: 'expr' },
  { name: 'div', class: 'numeric', sql: 'a / $n', result: "a's codec", kind: 'expr' },
  { name: 'mod', class: 'numeric', sql: 'a % $n', result: "a's codec", kind: 'expr' },
  { name: 'abs', class: 'numeric', sql: 'abs(a)', result: "a's codec", kind: 'expr' },

  // ── tsvector ───────────────────────────────────────────────────────────────
  { name: 'matches', class: 'tsvector', sql: 'a @@ q', result: 'bool', kind: 'expr' },
  { name: 'tsRank', class: 'tsvector', sql: 'ts_rank(a, q)', result: 'float4', kind: 'expr' },
  { name: 'tsRankCd', class: 'tsvector', sql: 'ts_rank_cd(a, q)', result: 'float4', kind: 'expr' },

  // ── range ──────────────────────────────────────────────────────────────────
  { name: 'rangeOverlaps', class: 'range', sql: 'a && $n', result: 'bool', kind: 'expr' },
  { name: 'rangeContains', class: 'range', sql: 'a @> $n', result: 'bool', kind: 'expr' },
  { name: 'rangeContainedBy', class: 'range', sql: 'a <@ $n', result: 'bool', kind: 'expr' },
  { name: 'strictlyLeft', class: 'range', sql: 'a << $n', result: 'bool', kind: 'expr' },
  { name: 'strictlyRight', class: 'range', sql: 'a >> $n', result: 'bool', kind: 'expr' },
  { name: 'adjacent', class: 'range', sql: 'a -|- $n', result: 'bool', kind: 'expr' },
  { name: 'rangeUnion', class: 'range', sql: 'a + $n', result: "a's codec", kind: 'expr' },
  { name: 'rangeIntersection', class: 'range', sql: 'a * $n', result: "a's codec", kind: 'expr' },
  { name: 'rangeLower', class: 'range', sql: 'lower(a)', result: "a's subtype", kind: 'expr' },
  { name: 'rangeUpper', class: 'range', sql: 'upper(a)', result: "a's subtype", kind: 'expr' },

  // ── net (inet / cidr) ──────────────────────────────────────────────────────
  { name: 'containsNet', class: 'net', sql: 'a >> $n', result: 'bool', kind: 'expr' },
  { name: 'containedByNet', class: 'net', sql: 'a << $n', result: 'bool', kind: 'expr' },
  { name: 'overlapsNet', class: 'net', sql: 'a && $n', result: 'bool', kind: 'expr' },

  // ── boolean combinators / ordering (03 §2.4) ───────────────────────────────
  { name: 'and', class: 'boolean', sql: '(a and b and …)  ·  () ⇒ true', result: 'bool', kind: 'expr' },
  { name: 'or', class: 'boolean', sql: '(a or b or …)  ·  () ⇒ false', result: 'bool', kind: 'expr' },
  { name: 'not', class: 'boolean', sql: 'not a', result: 'bool', kind: 'expr' },
  { name: 'isTrue', class: 'boolean', sql: 'a is true', result: 'bool', kind: 'expr' },
  { name: 'isNotTrue', class: 'boolean', sql: 'a is not true', result: 'bool', kind: 'expr' },
  { name: 'isFalse', class: 'boolean', sql: 'a is false', result: 'bool', kind: 'expr' },
  { name: 'isNotFalse', class: 'boolean', sql: 'a is not false', result: 'bool', kind: 'expr' },
  { name: 'exists', class: 'boolean', sql: 'exists (select …)', result: 'bool', kind: 'expr' },
  { name: 'notExists', class: 'boolean', sql: 'not exists (select …)', result: 'bool', kind: 'expr' },
  { name: 'asc', class: 'boolean', sql: 'a asc [nulls first|last]', result: '—', kind: 'order' },
  { name: 'desc', class: 'boolean', sql: 'a desc [nulls first|last]', result: '—', kind: 'order' },

  // ── aggregates and full-text helpers ───────────────────────────────────────
  { name: 'fn.count', class: 'aggregate', sql: 'count(*) · count(a)', result: 'int8', kind: 'expr' },
  {
    name: 'fn.sum',
    class: 'aggregate',
    sql: 'sum(a)',
    result: 'int2/int4 ⇒ int8 · int8/numeric ⇒ numeric · float4 ⇒ float4 · float8 ⇒ float8',
    kind: 'expr',
  },
  {
    name: 'fn.avg',
    class: 'aggregate',
    sql: 'avg(a)',
    result: 'float4/float8 ⇒ float8 · everything else ⇒ numeric',
    kind: 'expr',
  },
  { name: 'fn.min', class: 'aggregate', sql: 'min(a)', result: "a's codec", kind: 'expr' },
  { name: 'fn.max', class: 'aggregate', sql: 'max(a)', result: "a's codec", kind: 'expr' },
  {
    name: 'fn.rank',
    class: 'aggregate',
    sql: 'rank()',
    result: 'int8',
    kind: 'expr',
    deferred: 'WS4 — `rank()` is legal only inside OVER (…), which the emitter does not build yet',
  },
  {
    name: 'fn.toTsvector',
    class: 'aggregate',
    sql: 'to_tsvector($n::regconfig, a)',
    result: 'tsvector',
    kind: 'expr',
  },
  {
    name: 'fn.toTsquery',
    class: 'aggregate',
    sql: 'to_tsquery($n::regconfig, $n)',
    result: 'tsquery',
    kind: 'expr',
  },
  {
    name: 'fn.plaintoTsquery',
    class: 'aggregate',
    sql: 'plainto_tsquery($n::regconfig, $n)',
    result: 'tsquery',
    kind: 'expr',
  },
  {
    name: 'fn.phrasetoTsquery',
    class: 'aggregate',
    sql: 'phraseto_tsquery($n::regconfig, $n)',
    result: 'tsquery',
    kind: 'expr',
  },
  {
    name: 'fn.websearchToTsquery',
    class: 'aggregate',
    sql: 'websearch_to_tsquery($n::regconfig, $n)',
    result: 'tsquery',
    kind: 'expr',
  },

  // ── vector (pgvector) ──────────────────────────────────────────────────────
  //
  // Deferred wholesale, and for exactly the reason `citext` is (09 §3.2 deviation 3): `vector` is
  // an EXTENSION type, so its OID is per-database and it belongs on the `resolveDynamic` path
  // rather than in `builtinCodecs()`. PGlite does not ship pgvector, so there is also no target to
  // run the differential against. Shipping the six operators with no codec and no live test would
  // be four rows of `03` §2.9 that look covered and are not.
  ...(
    ['l2', 'cosine', 'innerProduct', 'l1', 'hamming', 'jaccard'] as const
  ).map((name, i) => ({
    name,
    class: 'vector' as const,
    sql: (['a <-> $n', 'a <=> $n', 'a <#> $n', 'a <+> $n', 'a <~> $n', 'a <%> $n'] as const)[i]!,
    result: 'float8',
    kind: 'expr' as const,
    deferred:
      'WS5 — `vector` is a pgvector EXTENSION type: per-database OID, resolveDynamic path, and ' +
      'not present in PGlite, so neither a codec nor a live differential exists yet',
  })),
]

/** Rows whose result codec a live server can confirm today. */
export const CONFIRMABLE: readonly OpSpec[] = OPS.filter(
  (o) => o.kind === 'expr' && o.deferred === undefined,
)
