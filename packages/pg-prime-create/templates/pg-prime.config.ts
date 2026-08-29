import { defineConfig } from '@pg-prime/kit'

export default defineConfig({
  schema: './schema.ts',
  migrations: './migrations',
  url: process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/app',
})
