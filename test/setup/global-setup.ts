import { execSync } from 'node:child_process';
import { Redis } from 'ioredis';
import { TEST_DATABASE_URL, TEST_REDIS_URL } from './test-env.js';

/** Runs once before the e2e suite: bring the test database schema up to date. */
export default async function globalSetup(): Promise<void> {
  if (!/test/i.test(TEST_DATABASE_URL)) {
    throw new Error(`Refusing to run e2e tests against a non-test database: ${TEST_DATABASE_URL}`);
  }
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
  const redis = new Redis(TEST_REDIS_URL);
  await redis.flushdb();
  await redis.quit();
}
