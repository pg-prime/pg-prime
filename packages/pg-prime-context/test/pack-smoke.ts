// The consumer body tools/pack-smoke.mjs compiles and runs in a project holding only the
// tarballs, so every import here goes through the published export maps.
import * as api from '@pg-prime/context'
import * as testing from '@pg-prime/context/testing'

if (typeof api !== 'object' || typeof testing !== 'object') {
  throw new Error('pack-smoke: @pg-prime/context did not load')
}
console.log('pack-smoke @pg-prime/context consumer OK')
