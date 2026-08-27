# `bench/types/arms` — the frozen WS0 fork arms

Each file here is one spelling of one design decision, kept **byte-frozen** after the decision was
recorded in `design/09` §3.0. An arm that grows new features stops measuring its fork, and — for
`f1-ops-free.ts` and `f1-ops-methods.ts`, whose emitted `.d.ts` sizes are themselves a reported
number — an arm that grows a new *comment* stops reproducing the reported number. Do not edit them,
including their docblocks. (`f1-ops-free.ts`'s header still points at `./forks/f1-ops-methods.ts`,
a path that never existed; it is preserved verbatim for exactly that reason.)

| File | Fork | Role |
|---|---|---|
| `base-04.ts` | — | design/04 §2 as written; the control every arm is differenced against |
| `control-plain-refs.ts` | F1 | the ref record rebuilt with **no** operator intersection, so `f1 − plain` prices the methods and `plain − base` prices the rebuild |
| `f1-methods.ts` | F1 | the query surface reaching columns through the method-bearing ref record |
| `f1-ops-methods.ts` | F1 | arm B — the vocabulary as method tables (**4 462 B** of `.d.ts`) |
| `f1-ops-free.ts` | F1 | arm A — the vocabulary as free functions (**7 960 B** of `.d.ts`; see below) |
| `f2-bare.ts` | F2 | nested object literals allowed in a projection, without `nest()` |
| `f3-scope.ts` | F3 | relation accessors on the table scope |

## Why `f1-ops-free.ts` lives here and not in `src/`

It shipped as `packages/pgorm/src/query/ops-free.ts` while F1 was being measured, because arm A won
and the winner is the shipped surface. WS3 then *implemented* that surface — `src/query/ops.ts`,
`ops.types.ts`, `fn.ts`, `ops.manifest.ts` — and in doing so gave it class gates, exact result
codecs, `json`-vs-`jsonb` operand splitting and a dozen operators the arm never had. Weighing that
against arm B would no longer be measuring the fork: `query/ops.d.ts` is ~14 KB today, and none of
the difference is the free-function *spelling*.

So the arm moved here, unchanged, and `forks.mjs` compiles it directly.

One number moved with it and should not be read as drift: the arm emits **7 960 B**, not the
**7 853 B** recorded in `09` §3.0. The body is byte-identical — the whole +107 B is four import
specifiers getting longer when the file left `src/query/` (`'../codec/index.js'` →
`'../../../packages/pgorm/src/codec/index.js'`, ×4), and `.d.ts` keeps import specifiers verbatim.
Arm B is untouched at **4 462 B**, and the reported comparison is unchanged: **−43 %**
(−43.9 % on the new denominator, −43.2 % on the old).
