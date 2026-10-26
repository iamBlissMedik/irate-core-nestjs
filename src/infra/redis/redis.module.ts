import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../../config/env.js';

/** Injection token for the shared ioredis client. */
export const REDIS = Symbol('REDIS');

/**
 * Redis holds ONLY short-lived, rebuildable state: rate-limit counters, login
 * lockouts and the access-token denylist. Balances, sessions and idempotency
 * records live in Postgres, so losing Redis never loses or duplicates money.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const logger = new Logger('Redis');
        const client = new Redis(config.get('REDIS_URL', { infer: true }), {
          // Fail fast instead of queueing forever when Redis is down: callers
          // decide whether to fail open (rate limits) or closed (auth).
          maxRetriesPerRequest: 1,
          commandTimeout: 2_000,
          connectTimeout: 5_000,
        });
        client.on('error', (err: Error) => logger.warn(`Redis error: ${err.message}`));
        return client;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
