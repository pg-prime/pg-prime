import { defineConfig } from '@pg-prime/kit'

export default defineConfig({
  schema: './schema.ts',
  migrations: './migrations',
  url: process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/app',
  // 'createdb' or a postgres:// URL: a shadow database. 'temp-schema': shadow schemas in this one.
  // 'auto' takes a database when the role may create one.
  shadow: 'auto',
})
