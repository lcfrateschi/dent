import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './lib/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    // Só necessário para migrate/push/studio. `generate` funciona sem conexão.
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/facilident',
  },
  verbose: true,
  strict: true,
})
