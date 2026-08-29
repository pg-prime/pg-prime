#!/usr/bin/env node
/**
 * The `create-pg-prime` binary — what `npm create @pg-prime@latest my-app` runs.
 *
 * tsc preserves this shebang into `dist/cli.js` and `tools/build-package.mjs` sets the mode bit;
 * `tools/create-smoke.mjs` proves both by running the command out of an installed tarball.
 *
 * This is the ONLY file that touches a stream or a terminal, and it exports nothing — so nothing
 * in the package's published declarations names a module outside the package (see `PromptIo`).
 *
 * `process.exitCode` rather than `process.exit()`: `exit()` truncates a pipe that has not drained.
 */
import { createInterface } from 'node:readline/promises'
import { main } from './main.js'

// A non-TTY stdin is a CI job, a pipe or an editor task runner: nobody will answer a question, so
// no interface is opened and `main` takes every default (design/13 decision 8).
const terminal = process.stdin.isTTY === true
const rl = terminal ? createInterface({ input: process.stdin, output: process.stdout }) : undefined

try {
  process.exitCode = await main(process.argv.slice(2), {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    ask: rl === undefined ? undefined : (question) => rl.question(question),
    cwd: process.cwd(),
    env: process.env,
  })
} finally {
  // Leaving it open holds stdin, and the process would never exit.
  rl?.close()
}
