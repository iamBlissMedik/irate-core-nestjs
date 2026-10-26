import { TEST_DATABASE_URL, TEST_REDIS_URL } from './test-env.js';

// Runs in every test worker BEFORE the app module is imported (ConfigModule
// validates the environment at import time).
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: TEST_REDIS_URL,
  JWT_ACCESS_SECRET: 'e2e-test-access-secret-0123456789-abcdefghijkl',
  SANDBOX_WEBHOOK_SECRET: 'e2e-test-sandbox-secret-0123456789-abcdefghij',
  PAYMENTS_PROVIDER: process.env.PAYMENTS_PROVIDER ?? 'sandbox',
  PUBLIC_API_URL: 'http://localhost:8000',
  RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED ?? 'false',
  SWAGGER_ENABLED: 'false',
  BUSINESS_TIMEZONE: 'Africa/Lagos',
});
