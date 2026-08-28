/**
 * "Is this thing a query?" — asked nominally, exactly once (design/09 WS4).
 *
 * Every place a builder accepts *another* statement — `union`, `exists`, `inQuery`, `fromSelect`,
 * `.with()` — used to ask `typeof q.toAst === 'function'` and call it. That is a structural test,
 * and it undoes the guarantee the rest of the layer is built on: `nodes.ts` keeps its AST registry
 * in a `WeakSet` and `sql`'s hole classifier asks that set, precisely so a `JSON.parse` of a
 * request body cannot pass itself off as SQL. A `{ toAst: … }` — or a plain
 * `{ k: 'select', projection: [{ expr: { k: 'raw', chunks: ['1) or true; drop …'] } }] }` handed
 * straight in — walked through the structural gate and reached the emitter.
 *
 * So this module owns the two nominal registries the seam needs:
 *
 *  - **Builders** register their instances in a `WeakSet` from their constructors. A class
 *    identity check (`instanceof SelectBuilder`) would work too, but every operator module would
 *    then have to import every builder module and the import graph would close a cycle through
 *    `scope.ts` → `relations.ts` → `fn.ts`. A leaf module with a `WeakSet` has neither problem.
 *  - **AST nodes** are already nominal (`isAstNode`), so a hand-built `SelectNode` from
 *    `src/compile/nodes.ts` — which the compiler suites and `03` §1.2 both use — is still
 *    accepted, and a structurally identical object that never went through `mkNode` is not.
 */

import type { SelectNode, SetOpNode, Statement } from '../compile/ast.js'
import { isAstNode } from '../compile/nodes.js'
import { BuilderError } from '../sql/errors.js'

interface HasAst {
  toAst(): Statement
}

/**
 * What `exists(…)`, `notExists(…)` and `inQuery(…, q)` accept.
 *
 * A select or set-operation builder (anything whose `toAst()` is one of those two nodes), or a
 * node built by `src/compile/nodes.ts`. An insert/update/delete builder is excluded by its own
 * `toAst()` return type, which is the same rejection {@link queryAstOf} makes at runtime.
 *
 * **Not `SelectSource<O>`** (`./types.ts`), which is the other half of the same idea and the one
 * `union`/`fromSelect` use. `SelectSource` is a *branded* interface — it carries the phantom
 * `SELECT_SOURCE` key — so it accepts a public `Query` and nothing else, which is exactly right
 * for a set operation whose two branches must line up column for column. `exists`/`notExists`/
 * `inQuery` take a sub-query in a *predicate* position, where a hand-built `SelectNode` from
 * `src/compile/nodes.ts` is a legitimate argument (the compiler suites and `03` §1.2 both pass
 * one), and a brand would reject it. The two are the same rejection of an insert/update/delete
 * reached two ways: `SelectSource` by brand, `QuerySource` by `toAst()`'s return type.
 */
export type QuerySource = { toAst(): SelectNode | SetOpNode } | SelectNode | SetOpNode

const BUILDERS = new WeakSet<object>()

/**
 * The *prototypes* of the builder classes, which is where the registration actually lands.
 *
 * `WeakSet.prototype.add` has no TurboFan fast path; `getPrototypeOf` + `WeakSet.prototype.has`
 * does. Every method of every builder constructs a new instance (that is the immutability
 * contract), so a seven-step chain paid seven `add`s. Measured in situ by reverting this to
 * `BUILDERS.add(b)` and re-running `bench:compile` (design/09 §3.7 follow-up): the four-column
 * simple select goes **4.08 µs → 5.05 µs** and design/08 §5's throughput line **~245 000/s →
 * 196 982/s**; the heavy query goes 20.2 µs → 22.0 µs. Allocation is unchanged either way. This is
 * the single change that carries §5's 200 000/s, so it is worth the paragraph below.
 *
 * There are five builder classes in the program, so five prototypes are registered — once each, on
 * the first instance — and every later instance costs a `has`.
 *
 * **What this changes, exactly.** `isBuilder(v)` used to answer "did a builder constructor produce
 * `v`"; it now answers "does `v` have a builder class's prototype". That is a slightly weaker
 * statement, and it is the honest way to describe it. It is still the statement the nominal guard
 * needs: a prototype enters this set only from the constructor of a class defined in this package,
 * the classes are not on the public barrel (`test/query/index.test.ts`'s `EXPECTED_ABSENT`), and
 * `JSON.parse` cannot produce an object with one — a `"__proto__"` key in JSON text becomes an own
 * property, not a prototype. So "arrived as data" is still distinguishable from "we built it",
 * which is what D7 is about; what is no longer distinguishable is a builder from an
 * `Object.create(sameProto)` made by someone who already holds a builder.
 *
 * `Object.prototype` and `null` are refused, so a stray `registerBuilder({})` — the function is
 * internal, but it is still a function — registers that object alone rather than every object in
 * the program.
 */
const BUILDER_PROTOS = new WeakSet<object>()

/**
 * Called from every statement builder's constructor.
 *
 * Registers the instance's **class**, not the instance, whenever it has one: see
 * {@link BUILDER_PROTOS}. Either way the postcondition is the one callers rely on —
 * `isBuilder(b)` is true afterwards, and stays true for every instance of the same class.
 */
export function registerBuilder(b: object): void {
  const proto: unknown = Object.getPrototypeOf(b)
  if (proto === null || proto === Object.prototype) {
    BUILDERS.add(b)
    return
  }
  if (!BUILDER_PROTOS.has(proto as object)) BUILDER_PROTOS.add(proto as object)
}

export function isBuilder(v: unknown): v is HasAst {
  if (typeof v !== 'object' || v === null) return false
  const proto: unknown = Object.getPrototypeOf(v)
  return (proto !== null && BUILDER_PROTOS.has(proto as object)) || BUILDERS.has(v)
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  if (typeof v === 'object') return 'a plain object'
  return `a ${typeof v}`
}

function reject(where: string, v: unknown): never {
  throw new BuilderError(
    `pg-prime: ${where} expects a query built by this library (a \`db.from(...)\` builder or a node ` +
      `from \`src/compile/nodes.ts\`), not ${describe(v)}. An object that merely has the right ` +
      `shape — parsed from JSON, say — is data and is refused on purpose.`,
  )
}

/** A `SelectNode`/`SetOpNode` from a select or set-operation builder, or from a real AST node. */
export function queryAstOf(q: unknown, where: string): SelectNode | SetOpNode {
  if (isBuilder(q)) {
    const n = q.toAst()
    if (n.k === 'select' || n.k === 'setop') return n
    throw new BuilderError(
      `pg-prime: ${where} takes a select or a set operation; this is an ${n.k} statement.`,
    )
  }
  if (isAstNode(q)) {
    const n = q as unknown as Statement
    if (n.k === 'select' || n.k === 'setop') return n
  }
  return reject(where, q)
}

const STATEMENTS = new Set(['select', 'setop', 'insert', 'update', 'delete'])

/** Any statement — what a CTE body may be, writable ones included (03 §2.7). */
export function statementAstOf(q: unknown, where: string): Statement {
  if (isBuilder(q)) return q.toAst()
  if (isAstNode(q)) {
    const n = q as unknown as Statement
    if (STATEMENTS.has(n.k)) return n
  }
  return reject(where, q)
}
