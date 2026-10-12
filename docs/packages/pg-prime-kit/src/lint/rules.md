# packages/pg-prime-kit/src/lint/rules.ts

## Purpose
The lint rules that are properties of the assembled file rather than of a delta: TX101/TX102/TX201, LK103, LK111, DS105, and the opt-in ST101–ST106 style family. Computed from a `Plan` and its statement text, so `diff/ddl.ts` never attaches them. Called by `lintPlan` (`packages/pg-prime-kit/src/lint/lint.ts:237`); uses `codeMask` (`sql/statements.ts`) and `utf8ByteLength`/`MAX_IDENT_BYTES` (`sql/ident.ts`).

## Public API
- `RuleHit` — `{ code, statement, subject, message }`, before suppression and acknowledgement.
- `STYLE_CODES` — `["ST101", …, "ST106"]`; kept out of `plan/plan.ts`'s severity table.
- `isStyleCode(code)` — membership in `STYLE_CODES`; `lintPlan` gives these `warn`.
- `planRules(plan, { style }): RuleHit[]` — hits for every statement, in statement order; never throws.

## Flow
1. Map statement index → segment from `plan.segments`; a statement is "in a transaction" if its segment is transactional, or, when it has none, if `txmode !== "none"` (`packages/pg-prime-kit/src/lint/rules.ts:88-94`).
2. TX101: `nonTransactional` statement in a `txmode: "transactional"` plan (`packages/pg-prime-kit/src/lint/rules.ts:96-103`).
3. TX102: `nonTransactional` statement inside a transactional segment (`packages/pg-prime-kit/src/lint/rules.ts:104-111`).
4. TX201: non-idempotent statement in a `txmode: "none"` plan (`packages/pg-prime-kit/src/lint/rules.ts:112-119`).
5. LK103: `CONCURRENTLY` in code text inside a transaction (`packages/pg-prime-kit/src/lint/rules.ts:120-127`).
6. LK111: `CREATE [OR REPLACE] [CONSTRAINT] TRIGGER`; DS105: `DROP MATERIALIZED VIEW` (`packages/pg-prime-kit/src/lint/rules.ts:128-143`).
7. With `style`, on code-only text: ST101 `serial`, ST102 `char(n)`, ST103 bare `timestamp`, ST104 int4 `PRIMARY KEY`; ST105 any double-quoted identifier over 63 UTF-8 bytes; ST106 each unqualified relation after `ALTER/CREATE/DROP TABLE` or `ON` (`packages/pg-prime-kit/src/lint/rules.ts:145-193`).

## Gotchas
- Pattern matching runs on `codeOnly` text, where string literals, comments and double-quoted identifiers are blanked to spaces (`packages/pg-prime-kit/src/lint/rules.ts:48-53`); a keyword inside a literal never fires.
- ST105 scans the raw SQL (`packages/pg-prime-kit/src/lint/rules.ts:174`), so a `"…"` sequence inside a string literal is also measured.
- ST106's capture can backtrack to a prefix of an unquoted qualified name (`public.users` yields `publi`), and `ON CONFLICT` captures `CONFLICT` (`packages/pg-prime-kit/src/lint/rules.ts:73-74`). Quoted names are blanked, so the kit's own always-quoted DDL never triggers it.
- Every hit's subject is the statement's first `destroys`, else `produces`, else `consumes` id (`packages/pg-prime-kit/src/lint/rules.ts:85`), the same rule `buildPlan` uses, so DS105 acknowledgement matches by that id.
- LK111 and DS105 concern Tier R objects the differ never models; they fire only on hand-written SQL or repeatables linted through `cli/commands/lint.ts`.
- ST findings are `warn` regardless of `failOn: "error"`; `hazardSeverity` would have called them `error` (`packages/pg-prime-kit/src/lint/rules.ts:36-45`).

## Tests
- `packages/pg-prime-kit/test/lint/rules.test.ts` — TX101/TX102/LK103 with negative control, TX201 in bare vs transactional files, LK111 vs `CREATE INDEX`, DS105 vs `DROP VIEW`, literal immunity, style opt-in and `warn` severity, and one firing plus one fixed case per ST rule.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/lint/rules.test.ts` (no server needed).
- Uncovered: ST106 is only tested against an unqualified name and a quoted qualified name, so the unquoted-qualified false positive is not caught.
