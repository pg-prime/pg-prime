// The CI `bun` job sets PG_PRIME_EXPECT_BUN so a worker silently running on Node fails instead of passing.
if (process.env['PG_PRIME_EXPECT_BUN'] && !('Bun' in globalThis)) {
  throw new Error('PG_PRIME_EXPECT_BUN is set, but this vitest worker is not running on Bun')
}
