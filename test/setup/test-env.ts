/** Connection settings for the e2e suite. Override with TEST_DATABASE_URL / TEST_REDIS_URL. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://blizz@localhost:5432/irate_core_nest_test?host=/tmp';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/14';
