import { defineConfig } from 'vitest/config';

/**
 * End-to-end tests: boot the real Nest application against a real PostgreSQL
 * database and Redis (see test/setup/*). Files run one at a time because they
 * share the database; tests inside a file run sequentially too.
 */
export default defineConfig({
  test: {
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    environment: 'node',
    globalSetup: ['./test/setup/global-setup.ts'],
    setupFiles: ['./test/setup/env.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
