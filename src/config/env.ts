import { z } from 'zod';

const DEV_JWT_SECRET = 'dev-only-access-secret-change-me-0123456789';
const DEV_SANDBOX_SECRET = 'dev-only-sandbox-webhook-secret-0123456789';

const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const int = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max);

/**
 * Every environment variable the API reads, validated once at startup.
 * Invalid configuration fails fast with ALL problems listed together.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: int(1, 65_535).default(8000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }).default('redis://127.0.0.1:6379/0'),

    JWT_ACCESS_SECRET: z.string().min(32).default(DEV_JWT_SECRET),
    JWT_ACCESS_TTL_SECONDS: int(60, 3_600).default(900),
    JWT_ISSUER: z.string().min(1).default('irate-core'),
    JWT_AUDIENCE: z.string().min(1).default('irate-api'),
    REFRESH_TOKEN_TTL_DAYS: int(1, 90).default(7),
    /** A rotated refresh token re-presented within this window is a benign race (two tabs), not theft. */
    REFRESH_REUSE_GRACE_SECONDS: int(0, 300).default(20),
    COOKIE_SECURE: bool.optional(),

    LOGIN_MAX_ATTEMPTS: int(1, 100).default(5),
    LOGIN_LOCKOUT_SECONDS: int(1, 86_400).default(900),

    CORS_ALLOWED_ORIGINS: csv.default(['http://localhost:3000', 'http://localhost:9000']),
    /** Number of reverse-proxy hops in front of the API (0 = clients connect directly). */
    TRUST_PROXY_HOPS: int(0, 10).default(0),
    SWAGGER_ENABLED: bool.optional(),
    /** Turn rate limiting off (load tests, the e2e suite). Never disable it in production. */
    RATE_LIMIT_ENABLED: bool.default(true),

    DEFAULT_CURRENCY: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default('NGN'),
    SUPPORTED_CURRENCIES: csv.pipe(z.array(z.string().regex(/^[A-Z]{3}$/)).min(1)).default(['NGN']),
    /** Largest single transfer/credit/deposit, in minor units (default NGN 10,000,000). */
    MAX_TRANSACTION_AMOUNT: int(1).default(1_000_000_000),
    /** Daily outgoing-transfer cap for customers without VERIFIED KYC (default NGN 50,000). 0 disables. */
    UNVERIFIED_DAILY_TRANSFER_LIMIT: int(0).default(5_000_000),
    /** Defines "today" for daily limits and dashboard stats. */
    BUSINESS_TIMEZONE: z
      .string()
      .refine(isValidTimeZone, 'must be an IANA time zone, e.g. Africa/Lagos')
      .default('Africa/Lagos'),

    PAYMENTS_PROVIDER: z.enum(['sandbox', 'paystack']).default('sandbox'),
    PUBLIC_API_URL: z.url().default('http://localhost:8000'),
    SANDBOX_WEBHOOK_SECRET: z.string().min(32).default(DEV_SANDBOX_SECRET),
    PAYSTACK_SECRET_KEY: z
      .string()
      .regex(/^sk_(test|live)_\w+$/, 'must look like sk_test_... or sk_live_...')
      .optional(),
    PAYSTACK_BASE_URL: z.url().default('https://api.paystack.co'),
    PAYSTACK_CALLBACK_URL: z.url().optional(),
  })
  .superRefine((env, ctx) => {
    if (!env.SUPPORTED_CURRENCIES.includes(env.DEFAULT_CURRENCY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEFAULT_CURRENCY'],
        message: 'must be one of SUPPORTED_CURRENCIES',
      });
    }
    if (env.PAYMENTS_PROVIDER === 'paystack' && !env.PAYSTACK_SECRET_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYSTACK_SECRET_KEY'],
        message: 'is required when PAYMENTS_PROVIDER=paystack',
      });
    }

    if (env.NODE_ENV !== 'production') return;

    // Production guardrails: refuse to boot with development defaults.
    if (env.JWT_ACCESS_SECRET === DEV_JWT_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_ACCESS_SECRET'],
        message: 'must be set in production',
      });
    }
    if (env.PAYMENTS_PROVIDER === 'sandbox' && env.SANDBOX_WEBHOOK_SECRET === DEV_SANDBOX_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['SANDBOX_WEBHOOK_SECRET'],
        message: 'must be set in production when the sandbox provider is active',
      });
    }
    if (env.COOKIE_SECURE === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'cannot be false in production',
      });
    }
    if (!env.RATE_LIMIT_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['RATE_LIMIT_ENABLED'],
        message: 'cannot be false in production',
      });
    }
    if (env.CORS_ALLOWED_ORIGINS.includes('*')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'cannot contain * in production',
      });
    }
  })
  .transform((env) => ({
    ...env,
    isProduction: env.NODE_ENV === 'production',
    COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
    SWAGGER_ENABLED: env.SWAGGER_ENABLED ?? env.NODE_ENV !== 'production',
    LOG_LEVEL: env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : 'debug'),
  }));

export type Env = z.output<typeof envSchema>;

/** Used by ConfigModule.forRoot({ validate }). Throws one error listing every problem. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (result.success) return result.data;

  const problems = result.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${problems}`);
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    return Boolean(new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone);
  } catch {
    return false;
  }
}
