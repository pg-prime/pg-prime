import { docsLoader } from '@astrojs/starlight/loaders'
import { docsSchema } from '@astrojs/starlight/schema'
import { defineCollection, z } from 'astro:content'

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        /**
         * Marks an API reference page and names the entry point it documents, as
         * `<package>#<subpath>` — e.g. `pg-prime#.` or `@pg-prime/kit#.`. `tools/docs-coverage.mjs`
         * reads it: every anchor on the page must be an exported name of that entry, and every
         * exported name of that entry must be anchored on some page that claims it.
         */
        apiEntry: z.union([z.string(), z.array(z.string())]).optional(),
      }),
    }),
  }),
}
