// Lets plain `node` run the TypeScript sources (Node strips the types): `pg-prime` resolves to its
// source and a relative `./x.js` to the `./x.ts` beside it.
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const pgPrime = new URL('../../../../pg-prime/src/index.ts', import.meta.url).href

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'pg-prime') return next(pgPrime, ctx)
    if (spec.startsWith('.') && spec.endsWith('.js') && ctx.parentURL?.endsWith('.ts')) {
      const ts = new URL(spec.replace(/\.js$/, '.ts'), ctx.parentURL)
      if (existsSync(fileURLToPath(ts))) return next(ts.href, ctx)
    }
    return next(spec, ctx)
  },
})
