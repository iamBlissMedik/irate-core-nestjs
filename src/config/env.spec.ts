import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.js';

const base = { DATABASE_URL: 'postgresql://u@localhost:5432/db' };

describe('validateEnv', () => {
  it('applies safe development defaults', () => {
    const env = validateEnv(base);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 8000,
      DEFAULT_CURRENCY: 'NGN',
      SUPPORTED_CURRENCIES: ['NGN'],
      COOKIE_SECURE: false,
      SWAGGER_ENABLED: true,
      RATE_LIMIT_ENABLED: true,
      isProduction: false,
    });
  });

  it('parses lists and booleans', () => {
    const env = validateEnv({
      ...base,
      CORS_ALLOWED_ORIGINS: 'https://a.dev, https://b.dev',
      COOKIE_SECURE: 'true',
    });
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['https://a.dev', 'https://b.dev']);
    expect(env.COOKIE_SECURE).toBe(true);
  });

  it('lists every problem at once', () => {
    const error = (() => {
      try {
        validateEnv({ PORT: 'abc', JWT_ACCESS_SECRET: 'short' });
      } catch (err) {
        return (err as Error).message;
      }
    })();
    for (const key of ['DATABASE_URL', 'PORT', 'JWT_ACCESS_SECRET'])
      expect(error).toContain(`- ${key}:`);
  });

  it('refuses development defaults and unsafe flags in production', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'false',
        CORS_ALLOWED_ORIGINS: '*',
        RATE_LIMIT_ENABLED: 'false',
      }),
    ).toThrow(
      /JWT_ACCESS_SECRET[\s\S]*SANDBOX_WEBHOOK_SECRET[\s\S]*COOKIE_SECURE[\s\S]*RATE_LIMIT_ENABLED[\s\S]*CORS_ALLOWED_ORIGINS/,
    );
  });

  it('requires a Paystack key when Paystack is the provider, and a supported default currency', () => {
    expect(() => validateEnv({ ...base, PAYMENTS_PROVIDER: 'paystack' })).toThrow(
      /PAYSTACK_SECRET_KEY/,
    );
    expect(() => validateEnv({ ...base, DEFAULT_CURRENCY: 'USD' })).toThrow(/DEFAULT_CURRENCY/);
    expect(() => validateEnv({ ...base, BUSINESS_TIMEZONE: 'Mars/Olympus' })).toThrow(
      /BUSINESS_TIMEZONE/,
    );
  });
});
