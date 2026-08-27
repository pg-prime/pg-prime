/**
 * Fuzz budget knobs. The *connection* comes from the one live harness (`test/live/_harness.ts`);
 * this file only carries how many cases to generate and from which seed (R8: seeded, replayable).
 */

/** 10k per PR (design/03 Appendix B); the nightly job overrides to 1M. */
export const FUZZ_CASES = Number(process.env['PGORM_FUZZ_CASES'] ?? 10_000)
export const FUZZ_SEED = Number(process.env['PGORM_FUZZ_SEED'] ?? 0x5eed)
