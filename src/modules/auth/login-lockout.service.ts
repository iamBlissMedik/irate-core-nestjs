import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { AppException, ErrorCode } from '../../common/errors/app.exception.js';
import { sha256Hex } from '../../common/utils/crypto.js';
import type { Env } from '../../config/env.js';
import { REDIS } from '../../infra/redis/redis.module.js';

/**
 * Per-email brute-force protection: after N consecutive failures the email is
 * locked for a while (429 ACCOUNT_LOCKED + Retry-After). Only failures count,
 * and a successful login resets the counter. Emails are hashed in Redis keys.
 *
 * Fails closed: if Redis is down we can't enforce the limit, so login is 503.
 */
@Injectable()
export class LoginLockoutService {
  private readonly logger = new Logger(LoginLockoutService.name);
  private readonly maxAttempts: number;
  private readonly lockoutSeconds: number;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.maxAttempts = config.get('LOGIN_MAX_ATTEMPTS', { infer: true });
    this.lockoutSeconds = config.get('LOGIN_LOCKOUT_SECONDS', { infer: true });
  }

  async assertNotLocked(email: string): Promise<void> {
    const key = this.key(email);
    const [failures, ttl] = await this.guard(() =>
      Promise.all([this.redis.get(key), this.redis.ttl(key)]),
    );
    if (Number(failures ?? 0) >= this.maxAttempts) {
      const retryAfter = Math.max(1, ttl);
      throw new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        ErrorCode.ACCOUNT_LOCKED,
        `Too many failed login attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
        undefined,
        { 'Retry-After': String(retryAfter) },
      );
    }
  }

  async recordFailure(email: string): Promise<void> {
    const key = this.key(email);
    await this.guard(async () => {
      const failures = await this.redis.incr(key);
      // Start the window on the first failure; restart it in full on lockout.
      if (failures === 1 || failures >= this.maxAttempts) {
        await this.redis.expire(key, this.lockoutSeconds);
      }
    });
  }

  async reset(email: string): Promise<void> {
    await this.guard(() => this.redis.del(this.key(email)));
  }

  private key(email: string): string {
    return `auth:login-failures:${sha256Hex(email)}`;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.logger.error(`Login lockout store unavailable: ${(err as Error).message}`);
      throw AppException.unavailable();
    }
  }
}
