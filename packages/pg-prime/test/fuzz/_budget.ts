/**
 * Fuzz budget knobs. The *connection* comes from the one live harness (`test/live/_harness.ts`);
 * this file only carries how many cases to generate and from which seed (R8: seeded, replayable).
 */

/** 10k per PR (design/03 Appendix B); the nightly job overrides to 1M. */
export const FUZZ_CASES = Number(process.env['PG_PRIME_FUZZ_CASES'] ?? 10_000)
export const FUZZ_SEED = Number(process.env['PG_PRIME_FUZZ_SEED'] ?? 0x5eed)

/**
 * How many generated cases reach a **server** oracle (design/09 WS7).
 *
 * The offline invariants scale with `FUZZ_CASES` for free — a million compiles is ~3 minutes. The
 * live oracles do not: `ident-oracle.test.ts`'s round trip creates one temp table per accepted
 * identifier, so a million cases would ask one backend for ~800 000 of them, and the fuzzers'
 * `planProbe` is a server round trip apiece. So the live half is sampled, and R9's rule applies:
 * **the cap is printed on every run, together with how many cases it dropped.** A silent cap is a
 * suite that quietly stops testing.
 *
 * 20 000 is the default because it is ~2x the PR case count (so a nightly still widens the live
 * coverage) and it finishes in about a minute against a real server.
 */
export const FUZZ_ORACLE_CASES = Number(process.env['PG_PRIME_FUZZ_ORACLE_CASES'] ?? 20_000)

/**
 * Say out loud that a live oracle is looking at a sample, and at how much of one.
 *
 * `process.stderr` rather than `console.log`: vitest intercepts `console.*` written during
 * collection and during a test's own output buffering, which is how design/09 §2.2's "skips
 * loudly" was silently untrue until WS6 (§3.6).
 */
export function announceSample(
  oracle: string,
  sampled: number,
  total: number,
  limiter = 'PG_PRIME_FUZZ_ORACLE_CASES',
): void {
  const dropped = total - sampled
  process.stderr.write(
    `[fuzz] ${oracle}: ${sampled.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} cases ` +
      `reach the server` +
      (dropped > 0
        ? ` — ${dropped.toLocaleString('en-US')} not sampled (${limiter})\n`
        : ' (no cap applied)\n'),
  )
}
