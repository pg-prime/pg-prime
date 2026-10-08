# packages/pg-prime-kit/src/cli/output.ts

## Purpose
The command result type and the text/JSON renderers, plus small helpers for the human-readable text form.
`render` is called by `emit` in `packages/pg-prime-kit/src/cli/main.ts:311`; every `cli/commands/*.ts` builds a `CommandOutput` with `nowIso` and formats text with `pairs`, `bullets`, `plural` and `agrees`.

## Public API
- `OutputFormat` — `"text" | "json"`.
- `CommandOutput` — `{ envelope, text, exitCode }`: the JSON envelope object, the text rendering, and the process exit code.
- `render(out, format)` — JSON: `JSON.stringify(envelope, null, 2)` plus newline; text: `text` with a trailing newline ensured.
- `nowIso()` — `new Date().toISOString()`; the `at` timestamp used in every envelope.
- `pairs(rows)` — aligned `  key  value` lines from `[key, value]` tuples.
- `bullets(title, items)` — `\n<title>` followed by `  - item` lines; `""` when `items` is empty.
- `plural(n, one, many?)` — `"<n> <word>"` with the singular for `n === 1`; `many` defaults to `one + "s"`.
- `agrees(n, one, many)` — the word form agreeing with `n`, without the number (used for verbs such as `is`/`are`).

## Flow
1. A command returns a `CommandOutput` whose envelope is an object literal with keys in fixed order.
2. `main` picks the format and calls `render` (`packages/pg-prime-kit/src/cli/output.ts:21`); it writes the result to stdout or stderr.

## Gotchas
- JSON key order is the object's insertion order; envelopes are built as literals so goldens stay stable.
- The JSON envelope is the stable contract (goldened in `packages/pg-prime-kit/test/cli/golden/`); the text form is not pinned byte-for-byte.
- `render` does not set or check `exitCode`; it is carried alongside so `main` can choose the stream and return code.
- `bullets` starts with a newline, so callers concatenate it directly after preceding text.

## Tests
- No direct unit tests. `render` and the envelope shape are covered through the binary by `packages/pg-prime-kit/test/cli/envelope.test.ts`, `authoring.test.ts` and `usage.test.ts`; `plural`/`agrees` wording is asserted in `envelope.test.ts:249` and `authoring.test.ts:150`.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli` (envelope/authoring need a server).
- Uncovered: `pairs` and `bullets` layout, which only appears in unpinned text output.
