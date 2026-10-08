// The consumer body tools/pack-smoke.mjs compiles and runs in a project holding only the
// tarballs, so every import here goes through the published export maps.
import * as api from '@pg-prime/events'

if (typeof api !== 'object') throw new Error('pack-smoke: @pg-prime/events did not load')
console.log('pack-smoke @pg-prime/events consumer OK')
