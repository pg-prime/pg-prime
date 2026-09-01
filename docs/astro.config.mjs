// @ts-check
/**
 * The pg-prime documentation site — design/08 §6.4, built by design/12 §4 D.
 *
 * Three things about this config are load-bearing rather than cosmetic:
 *
 *  - **`passthroughImageService`.** The site ships no raster assets, and the default image service
 *    pulls `sharp` (a native module with a post-install script) into every CI install for nothing.
 *  - **`base`.** GitHub Pages serves this repository's site under `/pg-prime/`. `site` + `base` are
 *    what make Pagefind's index and every internal link resolve there; `PG_PRIME_DOCS_BASE=/`
 *    overrides both for a custom domain without editing this file.
 *  - **Pagefind is Starlight's own** (`pagefind: true` is its default) and runs at `astro build`,
 *    which is why `docs:build` is the gate that proves search exists.
 */

import starlight from '@astrojs/starlight'
import { defineConfig, passthroughImageService } from 'astro/config'

const base = process.env.PG_PRIME_DOCS_BASE ?? '/pg-prime'
const site = process.env.PG_PRIME_DOCS_SITE ?? 'https://pg-prime.github.io'

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: 'pg-prime',
      description:
        'PostgreSQL-only, type-safe TypeScript ORM and migration engine. Zero dependencies, ESM-only.',
      editLink: { baseUrl: 'https://github.com/pg-prime/pg-prime/edit/main/docs/' },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/pg-prime/pg-prime' }],
      credits: false,
      lastUpdated: false,
      customCss: ['./src/styles/docs.css'],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Getting started', slug: 'guides/getting-started' },
            { label: 'Why not X', slug: 'compare/why-not' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Handles: Db, Tx, Session', slug: 'concepts/handles' },
            { label: 'Codecs and decode defaults', slug: 'concepts/codecs' },
            { label: 'Relations', slug: 'concepts/relations' },
            { label: 'The migration model', slug: 'concepts/migration-model' },
            { label: 'The shadow ladder', slug: 'concepts/shadow-ladder' },
            { label: 'Proof and witness', slug: 'concepts/proof' },
            { label: 'Tier M / R / O / U', slug: 'concepts/tiers' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'The schema DSL', slug: 'guides/schema' },
            { label: 'Queries', slug: 'guides/queries' },
            { label: 'The sql tag', slug: 'guides/sql-tag' },
            { label: 'Transactions and sessions', slug: 'guides/transactions' },
            { label: 'Errors', slug: 'guides/errors' },
            { label: 'Cancellation and timeouts', slug: 'guides/cancellation' },
            { label: 'LISTEN / NOTIFY', slug: 'guides/listen-notify' },
            { label: 'COPY and bulk loading', slug: 'guides/copy' },
            { label: 'pgvector and extension types', slug: 'guides/pgvector' },
            { label: 'Views and materialized views', slug: 'guides/views' },
            { label: 'Observability', slug: 'guides/observability' },
            { label: 'Testing', slug: 'guides/testing' },
            { label: 'Migrations end to end', slug: 'guides/migrations' },
            { label: 'Data migrations and seeding', slug: 'guides/data-migrations' },
            { label: 'Checkpoints', slug: 'guides/checkpoints' },
            { label: 'Adopting an existing database', slug: 'guides/adopting' },
          ],
        },
        {
          label: 'Operations',
          items: [
            { label: 'Locks and CREATE INDEX CONCURRENTLY', slug: 'operations/locks' },
            { label: 'Zero-downtime patterns', slug: 'operations/zero-downtime' },
            { label: 'Poolers', slug: 'operations/poolers' },
            { label: 'Timeouts', slug: 'operations/timeouts' },
            { label: 'Migrations in CI/CD', slug: 'operations/ci-cd' },
            { label: 'Troubleshooting', slug: 'operations/troubleshooting' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'pg-prime', slug: 'reference/pg-prime' },
            { label: 'The query builder', slug: 'reference/query' },
            { label: 'pg-prime/schema', slug: 'reference/schema' },
            { label: 'pg-prime/sql', slug: 'reference/sql' },
            { label: 'pg-prime/codecs', slug: 'reference/codecs' },
            { label: 'pg-prime/driver', slug: 'reference/driver' },
            { label: '@pg-prime/kit', slug: 'reference/kit' },
            { label: '@pg-prime/testing', slug: 'reference/testing' },
            { label: '@pg-prime/create', slug: 'reference/create' },
            { label: 'Errors', slug: 'reference/errors' },
            { label: 'CLI', slug: 'reference/cli' },
            { label: 'Config file', slug: 'reference/config' },
            { label: 'Hazard codes', slug: 'reference/hazard-codes' },
          ],
        },
        {
          label: 'Compare',
          items: [
            { label: 'Why not X', slug: 'compare/why-not' },
            { label: 'Drizzle', slug: 'compare/drizzle' },
            { label: 'Prisma', slug: 'compare/prisma' },
            { label: 'Kysely', slug: 'compare/kysely' },
            { label: 'MikroORM', slug: 'compare/mikroorm' },
          ],
        },
      ],
    }),
  ],
})
