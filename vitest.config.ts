import { defineConfig } from 'vitest/config';

/** Unit tests: fast, no infrastructure (Postgres/Redis are mocked or not needed). */
export default defineConfig({
  test: {
    root: './',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/**/*.spec.ts', 'src/main.ts'],
    },
  },
});
