import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer loads .env automatically. Use Node's built-in loader
// (variables already set in the environment win, so CI/Docker are unaffected).
if (existsSync('.env')) process.loadEnvFile('.env');

const url = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node dist/scripts/seed.js',
  },
  // `prisma generate` needs no database (e.g. in the Docker build stage), so
  // only configure the datasource when a URL is available. Commands that do
  // connect (migrate, db seed) fail clearly without it.
  ...(url ? { datasource: { url } } : {}),
});
