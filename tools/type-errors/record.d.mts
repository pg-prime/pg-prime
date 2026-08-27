/**
 * Hand-written declarations for `record.mjs`.
 *
 * The recorder is plain ESM so it can be run as `node tools/type-errors/record.mjs` with no build
 * step, but `test/query/type-errors.test.ts` must call the *same* functions — a checker that does
 * not share the recorder's diagnostic parsing and normalisation would compare against a golden
 * that can never match.
 */
export declare const COMPILERS: Record<string, string>
export declare function caseNames(): string[]
/** One compile of the whole `cases/` project, split per case file. */
export declare function collect(bin: string): Record<string, string[]>
export declare function budgetOf(lines: readonly string[]): { lines: number; chars: number }
export declare function readGolden(name: string, version: string): string | null
