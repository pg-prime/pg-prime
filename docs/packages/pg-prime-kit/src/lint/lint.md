# packages/pg-prime-kit/src/lint/lint.ts

## Purpose
`migrate lint` as a pure function: takes a `Plan` and the text of its `.sql`, merges the plan's hazards with the file-level rules from `lint/rules.ts`, applies `-- pg-prime:nolint` suppressions and acknowledgements, and returns findings plus an exit code. Called by `cli/commands/lint.ts` (which synthesizes a minimal plan for hand-written `.sql`); uses `hazardSeverity` (`plan/plan.ts`) and `lexSql` (`sql/statements.ts`).

## Public API
- `LintOptions` — `{ rules?, failOn?: "error" | "warn" | "off", style? }`; `failOn` defaults to `"error"`.
- `LintFinding` — `{ code, severity, statement, subject, message, acknowledged, suppressedBy }`; `statement` is `-1` for a plan-level finding, `suppressedBy` the directive's reason or `null`.
- `NolintDirective` — `{ code, reason, line, statement }`; `statement: null` means file-wide.
- `DirectiveError` — `{ line, text, message }` for a malformed `nolint`.
- `LintResult` — `{ findings, directives, directiveErrors, exitCode: 0 | 3 }`.
- `LintFormat` — `"text" | "json"`.
- `parseNolint(sqlText)` — `{ directives, errors }` from line comments only.
- `lintPlan(plan, sqlText, options?): LintResult` — no I/O, no clock.
- `unusedDirectives(result)` — directives that suppressed no finding in this run.
- `formatFindings(result, format)` — `json`: the whole result pretty-printed; `text`: directive errors first, then one line per finding prefixed `suppressed ` when suppressed.

## Flow
1. `parseNolint` lexes the SQL and visits each `--` comment starting `-- pg-prime:` or legacy `-- pg-orm:` (`packages/pg-prime-kit/src/lint/lint.ts:87`, `packages/pg-prime-kit/src/lint/lint.ts:122-136`).
2. A `stmt N` marker sets the current statement scope (`packages/pg-prime-kit/src/lint/lint.ts:127-129`); before any marker, scope is file-wide (`packages/pg-prime-kit/src/lint/lint.ts:115`).
3. A `nolint` body is parsed into a directive or a `DirectiveError`: code must match `NOLINT_HEAD`, reason must be one non-empty double-quoted string (`packages/pg-prime-kit/src/lint/lint.ts:143-170`).
4. Compute `selected` codes, blanket/per-subject acknowledgement from `plan.acknowledged`, and whether style rules run (`packages/pg-prime-kit/src/lint/lint.ts:199-212`).
5. Record every `plan.hazards` entry, then every `planRules` hit, skipping codes outside `selected` (`packages/pg-prime-kit/src/lint/lint.ts:232-239`).
6. Each finding re-derives severity (`warn` for style codes, else `hazardSeverity`), sets `acknowledged` from subject membership, and looks up a suppressor: per-statement first, then file-wide (`packages/pg-prime-kit/src/lint/lint.ts:180-190`, `packages/pg-prime-kit/src/lint/lint.ts:215-229`).
7. A finding fails unless suppressed; DS codes fail iff unacknowledged; other acknowledged errors never fail; the rest fail per `failOn` (`packages/pg-prime-kit/src/lint/lint.ts:241-256`).
8. `exitCode` is 3 if any directive error or failing finding, else 0 (`packages/pg-prime-kit/src/lint/lint.ts:262`).

## Gotchas
- Severity is never read from `.plan.json` (`packages/pg-prime-kit/src/lint/lint.ts:220-223`), so an edited `"severity": "warn"` cannot downgrade a DS code.
- Unacknowledged DS findings fail even at `failOn: "off"` (`packages/pg-prime-kit/src/lint/lint.ts:250`); `off` only disables the advisory threshold.
- A `nolint` suppresses before the DS check, so a reasoned `nolint DS102` does silence a DS finding (`packages/pg-prime-kit/src/lint/lint.ts:245`).
- A malformed directive forces exit 3 even with zero findings (`packages/pg-prime-kit/src/lint/lint.ts:262`).
- Directives inside string literals, dollar-quoted bodies or `/* */` comments are ignored (`packages/pg-prime-kit/src/lint/lint.ts:117-123`).
- A plan-level finding (`statement: -1`) can only be suppressed by a file-wide directive (`packages/pg-prime-kit/src/lint/lint.ts:176-178`).
- `rules` narrows both the report and the exit code, including the DS gate (`packages/pg-prime-kit/src/lint/lint.ts:216`). Naming any `ST` code in `rules` turns style on (`packages/pg-prime-kit/src/lint/lint.ts:212`).
- `LintFinding.acknowledged` comes from `plan.acknowledged` subjects, not from the hazard's own `acknowledged` flag; warn hazards show `false` unless their subject was signed off.
- `NOLINT_HEAD` accepts snake_case diagnostic codes as well as `LK101`-style codes (`packages/pg-prime-kit/src/lint/lint.ts:92-98`).

## Tests
- `packages/pg-prime-kit/test/lint/lint.test.ts` — `--fail-on` behaviour, re-derived severity, DS acknowledgement gate, per-statement vs header scope, unused directives, malformed reasons, `--rules` narrowing, `formatFindings` text/json.
- `test/lint/directives.test.ts` — marker scoping, legacy prefix, literal/dollar-quote/block-comment immunity, reason escaping.
- `test/generate/rewrites.test.ts` lints real generated plans (live).
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/lint` (no server needed).
- Uncovered: a `nolint` suppressing a DS code is not asserted either way.
