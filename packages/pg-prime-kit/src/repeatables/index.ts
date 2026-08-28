/**
 * Tier R (design/06 §3.8): the repeatables pass, as one import surface.
 *
 * The package barrel (`src/index.ts`) is not touched from here — the runner and `generate`
 * import this directory directly, and whichever of them ships first decides what the public
 * API re-exports.
 */

export { applyRepeatables, loadRepeatables, RepeatableApplyError } from "./apply.js";
export type { AppliedRepeatable, RepeatableClient } from "./apply.js";
export { checkIdempotence } from "./idempotence.js";
export type { IdempotenceResult, IdempotenceViolation } from "./idempotence.js";
export { createRepeatablesPass, planRepeatables } from "./plan.js";
export type { RepeatablesPass, RepeatablesPlan } from "./plan.js";
export { parseDirectives, scanRepeatables } from "./scan.js";
export type { Directive, RepeatableFile, ScanOptions } from "./scan.js";
