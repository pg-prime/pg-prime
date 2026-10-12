---
'@pg-prime/kit': patch
'@pg-prime/create': patch
---

**`shadow` config: shadow database or shadow schemas, and where temp schemas go wrong.**

- `migrate verify` replays into the `shadow` URL from `pg-prime.config.ts` when there is one, and uses `CREATE DATABASE` otherwise. It resets the `pgprime` history schema along with the managed schemas, so the same shadow URL can be verified again.
- A tier-1 shadow keeps each schema's comment when it is reset, so a replay into a URL no longer reports drift on `public`.
- The tier-3 proof keeps `index().concurrently(false)`; before this it re-derived a different plan and failed.
- The scaffolded `pg-prime.config.ts` sets `shadow: 'auto'`, with a comment listing the choices.
- Docs: a new section, "When temp schemas get it wrong", covers policy expressions, view bodies, `sql/` files and casts to your own types, which are not renamed and read the live schema.
