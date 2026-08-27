/**
 * Per-test-file setup for the `live` and `pg` projects.
 *
 * On PGlite this boots the file its own backend (see `_pglite.ts` for why per file) and tears it
 * down after the file's last test. Against `PGORM_TEST_URL` it does nothing: the server is shared
 * and files are kept apart by schema namespaces (R6).
 */

import { afterAll } from 'vitest'
import { setFileTarget } from './_harness.js'
import { startPglite } from './_pglite.js'

if (!process.env['PGORM_TEST_URL']) {
  const server = await startPglite()
  setFileTarget({
    url: server.url,
    kind: 'pglite',
    versionNum: server.versionNum,
    version: server.version,
  })
  afterAll(async () => {
    await server.stop()
  })
}
