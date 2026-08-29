#!/usr/bin/env node
/**
 * The `create-pg-prime` binary — what `npm create @pg-prime@latest my-app` runs.
 *
 * tsc preserves this shebang into `dist/cli.js` and `tools/build-package.mjs` sets the mode bit;
 * `tools/create-smoke.mjs` proves both by running the command out of an installed tarball.
 *
 * `process.exitCode` rather than `process.exit()`: `exit()` truncates a pipe that has not drained.
 */
import { main } from './main.js'

process.exitCode = await main(process.argv.slice(2), {
  input: process.stdin,
  output: process.stdout,
  stderr: process.stderr,
  cwd: process.cwd(),
  env: process.env,
})
