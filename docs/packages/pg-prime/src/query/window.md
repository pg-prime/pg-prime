# packages/pg-prime/src/query/window.ts

## Purpose
Window functions: the free function `over(expr, window)`, the immutable window-definition builder, normalisation of the three window spellings, and the closed-set keyword guard `oneOf`. `over` and the window types are exported from `src/index.ts`; `toWindowDef` is used by `SelectBuilder.window` in `select.ts`; `oneOf` is reused by `select.ts` (`forUpdate`) and `update.ts` (`fromValues` strategy). Builds nodes via `lit` / `over` in `src/compile/nodes.ts` and expression lists via `scope.ts`.

## Public API
- `Bound` — `'unbounded preceding' | 'current row' | 'unbounded following' | { preceding: n } | { following: n }`.
- `FrameOpts` — `{ from: Bound, to?: Bound, exclude?: 'current row'|'group'|'ties'|'no others' }`.
- `WindowSpec` — immutable builder: `partitionBy(...xs)`, `orderBy(o)`, `rows(f)`, `range(f)`, `groups(f)`.
- `WindowFn` — `(w: WindowSpec) => WindowSpec`.
- `WindowLiteral` — `{ partitionBy?, orderBy?, frame?: FrameOpts & { mode } }`, the object form for named windows.
- `oneOf(v, legal, where)` — returns `v` if it is a string in `legal`; else throws `BuilderError`.
- `buildWindow(f)` — runs `f` on an empty spec; throws unless it returns a spec; returns the `WindowDef`.
- `toWindowDef(v)` — accepts a spec, a `WindowFn`, or a `WindowLiteral`; returns a `WindowDef`.
- `over(e, w)` — `agg(...) over (...)` for a callback `w`, or `over "name"` for a string.

## Flow
1. `over` rejects any node whose `k` is not `agg` or `fn` (`packages/pg-prime/src/query/window.ts:214`).
2. A string window becomes `{ ref: name }`; a callback goes through `buildWindow` (`packages/pg-prime/src/query/window.ts:220`).
3. Each `Spec` method returns a new frozen `Spec` with one field patched (`packages/pg-prime/src/query/window.ts:144`).
4. `frame()` validates mode, bounds and exclusion against `FRAME_MODES`, `BOUND_KEYWORDS`, `EXCLUSIONS` (`packages/pg-prime/src/query/window.ts:129`).
5. Numeric bounds go through `litOffset`, emitting an `int4` literal (`packages/pg-prime/src/query/window.ts:81`).
6. `toWindowDef` dispatches: `Spec` → its def, function → `buildWindow`, object → literal fields, refusing an all-empty literal (`packages/pg-prime/src/query/window.ts:184`).

## Gotchas
- `over` is a free function, not a method on expressions; expressions are frozen AST nodes with no methods (`packages/pg-prime/src/query/window.ts:4`).
- Frame offsets are literals, never parameters, and must be non-negative safe integers (`1e21` is rejected) (`packages/pg-prime/src/query/window.ts:85`).
- Every keyword reaches SQL verbatim, so all are checked at runtime, not only by the TS union (`packages/pg-prime/src/query/window.ts:93`).
- Only the literal form refuses an empty definition (`packages/pg-prime/src/query/window.ts:200`); a callback returning the untouched spec (`w => w`) emits `over ()`, or `as ()` for a named window.
- `over`'s guard is by node kind, so any function call (`k: 'fn'`) passes; PostgreSQL decides whether it is a window-capable function.
- `buildWindow` uses `instanceof Spec`; a hand-made object implementing `WindowSpec` is refused (`packages/pg-prime/src/query/window.ts:167`).

## Tests
- `packages/pg-prime/test/query/window.test.ts` — the full inline/named window example, window clause placement, every frame spelling, range/groups, literal offsets, `over` on a non-function, callback vs literal forms, empty and duplicate windows.
- `packages/pg-prime/test/query/guards.test.ts` — unknown mode/bound/exclusion, safe-integer offsets, `forUpdate` keyword checks via `oneOf`.
- Live: `packages/pg-prime/test/live-query/setop-window.test.ts` (row_number, running total, named window, numeric offset frame).
- Run: `pnpm --filter pg-prime exec vitest run test/query/window.test.ts`; live: `pnpm --filter pg-prime exec vitest run test/live-query/setop-window.test.ts`.
