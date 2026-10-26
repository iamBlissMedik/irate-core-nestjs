import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module.js';

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

// Atomic fixed-window counter: INCR, start the window on the first hit, and
// report the remaining window in ms. One round trip, safe across instances.
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }
`;

/**
 * Redis-backed storage for @nestjs/throttler, so limits are shared by every
 * API instance. A caller over the limit stays blocked until the window ends.
 *
 * Fails OPEN: rate limiting protects capacity, not correctness, so a Redis
 * outage must not take the API down with it (authentication, which does
 * depend on Redis, fails closed on its own).
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async increment(key: string, ttl: number, limit: number): Promise<ThrottlerStorageRecord> {
    try {
      const [hits, ttlMs] = (await this.redis.eval(INCREMENT_SCRIPT, 1, `rl:${key}`, ttl)) as [
        number,
        number,
      ];
      const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
      const isBlocked = hits > limit;
      return {
        totalHits: hits,
        timeToExpire: seconds,
        isBlocked,
        timeToBlockExpire: isBlocked ? seconds : 0,
      };
    } catch (err) {
      this.logger.warn(`Rate limiter unavailable, allowing request: ${(err as Error).message}`);
      return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}
