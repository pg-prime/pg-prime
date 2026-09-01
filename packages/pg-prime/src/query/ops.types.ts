/**
 * The per-type-class operand tables (design/03 §2.9, design/04 §2.2, design/09 WS3).
 *
 * ## What this file is for
 *
 * `kysely.md` §5.2(3): Kysely types an operator's right-hand operand from the **column's** type.
 * That is wrong for most of PostgreSQL's interesting operators — `jsonb ? text` takes text,
 * `tsvector @@ tsquery` takes a tsquery, `int4range @> int4` takes the range's *element* — so
 * Kysely is either wrong or accidentally right on each of them. `03` §2.9's fix is that the
 * operand comes from the **operator**, via a small per-operator table. This is that table.
 *
 * ## Two gates, one door
 *
 * A class-specific operator takes a {@link ClassOperand}: something that declares both what it
 * yields (`[OUT]`) and which PostgreSQL type it *is* (`[META]['pg']`). Two kinds of value reach
 * that door:
 *
 *  - a schema `Ref`, whose `[META]` is the column's `ColMeta` and whose `pg` is the declared PG
 *    type name (`'text'`, `'int4'`, `'text[]'`);
 *  - a `` sql`…`.as(codec) `` fragment, whose `pg` is the **codec's own `name`** — the same
 *    string, because `metaOf` resolves a column's codec by `registry.byName(ddl.pgType)`.
 *
 * The second one is `09` §3.0's open item ("the gate reads `[META]`, which only a `Ref` carries …
 * WS3 must close it"), and it is closed by `TypedFragment` in `src/sql/fragment.ts`. Note that
 * `09` §3.0 guessed `sqlName` for the slot; `sqlName` is the DDL spelling (`int4` → `'integer'`,
 * `int8` → `'bigint'`), which is in **no** gate below. `name` is the field that agrees.
 *
 * ## Cost
 *
 * Every gate here is a non-generic interface, so an operator that uses one instantiates nothing
 * per call — measured at parity with the method arm in `09` §3.0. The three conditional maps at
 * the bottom (`SumOut`, `AvgOut`, `RangeElem`) are the exception, and they live on operators that
 * appear at most once or twice in a query, which is design/04 §1.3 rule 3's whole allowance.
 */

import type { META, OUT } from '../schema/index.js'
import type { PgDateString } from '../codec/index.js'
import type { ExprOf } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// The door
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "A `T` that PostgreSQL calls `P`." Satisfied by a column ref, by any expression this module
 * builds, and by a typed `sql` fragment — and by nothing a user can hand-write, because both
 * keys are `unique symbol`s.
 */
export interface ClassOperand<T, P extends string> {
  readonly [OUT]: T
  readonly [META]: { readonly pg: P }
}

/** Anything with a PG type at all: the operand of `min`/`max`/`cast`/`asc`/`desc`. */
export type AnyOperand<T = unknown> = ClassOperand<T, string>

/**
 * A right-hand operand that may not be the literal `null`.
 *
 * `& {}` removes `null` and `undefined` from the value half of the union while leaving the
 * expression half untouched, so `eq(u.deletedAt, null)` is a compile error while
 * `eq(u.deletedAt, u.createdAt)` — two nullable columns, three-valued logic understood — is not.
 * See `eq` in `./ops.ts` for why `= NULL` is rejected rather than rewritten to `IS NULL`.
 */
export type NonNullOperand<T> = (T | ExprOf<T>) & {}

/**
 * An `ORDER BY` item — `asc(x)` / `desc(x, 'last')`.
 *
 * Opaque and distinct from `Projectable`, so `select(() => ({ x: desc(u.id) }))` is a type error:
 * a sort direction is not a value a row can carry. WS1 declared these as returning `Projectable`,
 * which made that mistake compile.
 */
export interface Order {
  readonly dir: 'asc' | 'desc'
}

/** What `orderBy` accepts: bare expressions sort ascending, `asc`/`desc` say so explicitly. */
export type OrderArg = Order | { readonly [OUT]: unknown }
export type OrderBy = OrderArg | readonly OrderArg[]

// ─────────────────────────────────────────────────────────────────────────────
// The classes
// ─────────────────────────────────────────────────────────────────────────────

/** `citext` is an EXTENSION type, so its codec has no static OID (design/01 §3 rows 44/61) — but
 *  it is text in every way an operator cares about, and `t.citext()` declares one. */
export type TextPg = 'text' | 'varchar' | 'citext' | 'bpchar' | 'name'
export type NumPg = 'int2' | 'int4' | 'int8' | 'float4' | 'float8' | 'numeric' | 'money'
export type JsonPg = 'json' | 'jsonb'
export type NetPg = 'inet' | 'cidr'
export type RangePg = 'int4range' | 'int8range' | 'numrange' | 'tsrange' | 'tstzrange' | 'daterange'

/** A `bool` column or a `bool`-typed expression — the operand of `isTrue` and friends. */
export type BoolOperand = ClassOperand<boolean | null, 'bool'>

export type TextOperand = ClassOperand<string | null, TextPg>
export type NumOperand<T, P extends NumPg = NumPg> = ClassOperand<T, P>
/**
 * The four **accessors** (`->`, `->>`, `#>`, `#>>`) exist for both `json` and `jsonb`.
 *
 * Nothing else does. `@>`, `<@`, `?`, `?|`, `?&`, `@?`, `@@`, `||`, `-` and `#-` are jsonb-only —
 * `json @> json` is not an operator PostgreSQL has — so those take {@link JsonbOperand} and a
 * `json` column is a compile error rather than a 42883. Splitting the two is the same move `03`
 * §2.9 makes for `jsonb ? text`: the operand comes from the operator.
 */
export type JsonOperand = ClassOperand<unknown, JsonPg>
export type JsonbOperand = ClassOperand<unknown, 'jsonb'>
export type NetOperand = ClassOperand<string | null, NetPg>
export type TsvectorOperand = ClassOperand<unknown, 'tsvector'>
export type TsqueryOperand = ClassOperand<unknown, 'tsquery'>

/**
 * pgvector's `vector` — the operand of `l2` / `cosine` / `innerProduct` / `l1` (design/01 §3
 * row 62, `03` §2.9's vector class).
 *
 * `halfvec` and `sparsevec` carry the same four operators in pgvector 0.8 and are deliberately
 * NOT members: neither has a codec here, so admitting the name would type-check a query no codec
 * could decode. `t.raw('halfvec(1024)')` declares the column; the operator gate is v1.x.
 */
export type VectorOperand = ClassOperand<number[] | null, 'vector'>

/**
 * `bit` — the operand of `hamming` and `jaccard`.
 *
 * MEASURED against pgvector 0.8.6, not assumed: `<~>` and `<%>` are declared `bit`/`bit`, while
 * the other four are `vector`/`vector` (and `halfvec`/`sparsevec`). `03` §2.9 files all six under
 * one "vector" row, which is true of the *class* and not of the operands — so a binary-quantized
 * embedding is a `bit(n)` column and Hamming distance takes it, not a `vector`. `varbit` is not a
 * member for the same reason `halfvec` is not: pgvector declares no `varbit` overload.
 */
export type BitOperand = ClassOperand<string | null, 'bit'>
export type RangeOperand<P extends RangePg = RangePg> = ClassOperand<string | null, P>

/**
 * `E` is inferred from the element type, not from the `[]` suffix, because `pg` is only
 * `` `${string}[]` `` — PostgreSQL has one array type per element type and no multi-dimensional
 * array type at all (09 §3.2), so the *shape* of the name carries no more information than that.
 */
export type ArrayOperand<E> = ClassOperand<readonly E[] | null, `${string}[]`>

// ─────────────────────────────────────────────────────────────────────────────
// Result maps — the three places PostgreSQL's answer is not the operand's type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `sum` widens, and the widening is the reason `03` §2.9 insists on exact result codecs:
 * `sum(int4)` is **bigint**, `sum(int8)` and `sum(numeric)` are **numeric**. Kysely returns
 * `string | number | bigint` for all of them because it cannot know the driver (kysely.md §5.2(2)).
 * Confirmed against `RowDescription` per row of the `OPS` manifest in `test/live-query/ops.test.ts`.
 */
export type SumPg<P extends NumPg> = P extends 'int2' | 'int4'
  ? 'int8'
  : P extends 'int8' | 'numeric'
    ? 'numeric'
    : P
export type SumOut<P extends NumPg> = P extends 'int2' | 'int4'
  ? bigint
  : P extends 'float4' | 'float8'
    ? number
    : string

/**
 * `avg` is `numeric` for every exact type and `float8` for the two inexact ones.
 *
 * `03` §2.9 says "avg(anything) → numeric", which is wrong for `float4`/`float8`: PostgreSQL's
 * `avg(double precision)` returns `double precision`. Measured, not argued — the OID differential
 * fails on the design's version. `03` §2.9 is corrected from this table by `tools/ops-table`.
 */
export type AvgPg<P extends NumPg> = P extends 'float4' | 'float8' ? 'float8' : 'numeric'
export type AvgOut<P extends NumPg> = P extends 'float4' | 'float8' ? number : string

/** `lower(r)` / `upper(r)` yield the range's **subtype**, which is a property of the range type. */
export type RangeElemPg<P extends RangePg> = P extends 'int4range'
  ? 'int4'
  : P extends 'int8range'
    ? 'int8'
    : P extends 'numrange'
      ? 'numeric'
      : P extends 'tsrange'
        ? 'timestamp'
        : P extends 'tstzrange'
          ? 'timestamptz'
          : 'date'
export type RangeElem<P extends RangePg> = P extends 'int4range'
  ? number
  : P extends 'int8range'
    ? bigint
    : P extends 'numrange'
      ? string
      : P extends 'tsrange'
        ? string
        : P extends 'tstzrange'
          ? Date
          : PgDateString
