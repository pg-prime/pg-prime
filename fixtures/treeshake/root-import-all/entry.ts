// design/08 §1.2's "full root import" line — the ceiling. Nothing is tree-shaken away, because
// `Object.keys()` over a namespace import references every export, so this is what a consumer pays
// who imports the whole surface. It is the number the README's size claim has to survive, and it is
// the one that moves when a new subsystem is added to the root barrel.
//
// The four subpaths are imported too, so that a bundler that resolves `pg-prime/schema` to a second
// copy of the same modules (a real class of export-map bug: two `dist/schema/index.js` instances,
// two `unique symbol`s, silently broken `instanceof`) shows up as a bundle that is bigger than the
// root alone and as extra entries in `expected-modules.json`.
import * as root from 'pg-prime'
import * as codecs from 'pg-prime/codecs'
import * as driver from 'pg-prime/driver'
import * as schema from 'pg-prime/schema'
import * as sql from 'pg-prime/sql'

export const surface: readonly string[] = [
  ...Object.keys(root),
  ...Object.keys(schema),
  ...Object.keys(sql),
  ...Object.keys(codecs),
  ...Object.keys(driver),
]
