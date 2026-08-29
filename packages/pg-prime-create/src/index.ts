/**
 * `@pg-prime/create` — `npm create @pg-prime`.
 *
 * The package exists for its `bin`; this entry is the same scaffolder as a library, so that a
 * template repository, a monorepo generator or a test can write the project without spawning a
 * process. It has zero dependencies and imports nothing from the rest of the workspace.
 */

export { parseArgs } from './args.js'
export { scaffold } from './scaffold.js'
export { VERSIONS } from './versions.js'
export type {
  CliOptions,
  PackageManager,
  ParseResult,
  ScaffoldOptions,
  ScaffoldResult,
  Versions,
} from './types.js'
