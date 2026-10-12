/**
 * Picks the live target once, before any worker starts. `PG_PRIME_TEST_URL` set: that server, probed
 * here and shared by every file. Unset: PGlite, booted per file by `_setup.ts`.
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

  const shown = url.replace(/(\/\/[^:/@]*):[^/]*@/, '$1:***@')
  const { versionNum, version } = await probe(url).catch((e: unknown) => {
    throw new Error(
      `PG_PRIME_TEST_URL is set to ${shown} but nothing answered there. Unset it to run against ` +
        `PGlite instead. Original error: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    )
  })
  const plan: LivePlan = { kind: 'pg', url, versionNum, version }
  vitest.provide('pgPrimeLivePlan', plan)
  console.info(
    `[live] target: ${version.split(',')[0]} (server_version_num ${versionNum}) — ${shown}`,
  )
}
