/**
 * Decides *what kind of* live target this run has, once, before any worker starts
 * (design/09 §2.2).
 *
 *   `PG_PRIME_TEST_URL` set   → that server: probe `server_version_num` here and hand the whole
 *                            target to the workers, so every file shares one database and the
 *                            per-file schema namespaces (R6) keep them apart.
 *   `PG_PRIME_TEST_URL` unset → PGlite, and then the *url* is per test file, not per run — see
 *                            `_pglite.ts` for why. All this hands over is the kind.
 *
 * The value reaches tests through vitest's `provide`/`inject` rather than `process.env`, because
 * a url that is only known after a socket server picked a port cannot be in the config.
 */

import type { Vitest } from 'vitest/node'
import type { LivePlan } from './_harness.js'
import { probe } from './_pglite.js'

export async function setup(vitest: Vitest): Promise<void> {
  const url = process.env['PG_PRIME_TEST_URL']

  if (!url) {
    vitest.provide('pgPrimeLivePlan', { kind: 'pglite' })
    console.info(
      `[live] target: PGlite, one instance per test file (no Docker).\n` +
        `[live] one backend per file: anything needing a second session is skipped by ` +
        `requiresConcurrency() and runs in \`pnpm test:pg\` (design/08 §4.2).`,
    )
    return
  }

  const { versionNum, version } = await probe(url).catch((e: unknown) => {
    throw new Error(
      `PG_PRIME_TEST_URL is set to ${url} but nothing answered there. Unset it to run against ` +
        `PGlite instead. Original error: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    )
  })
  const plan: LivePlan = { kind: 'pg', url, versionNum, version }
  vitest.provide('pgPrimeLivePlan', plan)
  console.info(
    `[live] target: ${version.split(',')[0]} (server_version_num ${versionNum}) — ${url}`,
  )
}
