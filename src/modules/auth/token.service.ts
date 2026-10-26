import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { AppException, ErrorCode } from '../../common/errors/app.exception.js';
import type { AuthUser } from '../../common/types/request.js';
import type { Env } from '../../config/env.js';
import type { UserRole } from '../../generated/prisma/enums.js';
import { REDIS } from '../../infra/redis/redis.module.js';

interface AccessClaims {
  sub: string;
  email: string;
  role: UserRole;
  jti: string;
  iat: number;
  exp: number;
}

const denylistKey = (jti: string) => `auth:denylist:${jti}`;
const revokedBeforeKey = (userId: string) => `auth:revoked-before:${userId}`;

/**
 * Short-lived (15 min) HS256 access tokens.
 *
 * Revocation without a DB lookup per request:
 *  - logout denylists the token's `jti` in Redis until it would expire anyway;
 *  - logout-all stores a "revoked before" timestamp per user, rejecting every
 *    token issued up to that second.
 * If Redis is unreachable, authentication fails CLOSED (503): we can't prove
 * the token wasn't revoked.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly ttlSeconds: number;

  constructor(
    private readonly jwt: JwtService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.ttlSeconds = config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
  }

  async signAccessToken(user: { id: string; email: string; role: UserRole }) {
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
      jti: randomUUID(),
    });
    return { accessToken, tokenType: 'Bearer' as const, expiresIn: this.ttlSeconds };
  }

  /** Verifies signature, algorithm, issuer, audience and expiry. */
  async verifyAccessToken(token: string): Promise<AuthUser> {
    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessClaims>(token);
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        throw AppException.unauthorized(
          ErrorCode.ACCESS_TOKEN_EXPIRED,
          'Your access token has expired.',
        );
      }
      throw AppException.unauthorized(ErrorCode.INVALID_ACCESS_TOKEN, 'Invalid access token.');
    }
    if (!claims.sub || !claims.jti || (claims.role !== 'USER' && claims.role !== 'ADMIN')) {
      throw AppException.unauthorized(ErrorCode.INVALID_ACCESS_TOKEN, 'Invalid access token.');
    }
    return {
      id: claims.sub,
      email: claims.email,
      role: claims.role,
      jti: claims.jti,
      iat: claims.iat,
      exp: claims.exp,
    };
  }

  async assertNotRevoked(user: AuthUser): Promise<void> {
    let denied: string | null;
    let revokedBefore: string | null;
    try {
      [denied, revokedBefore] = await this.redis.mget(
        denylistKey(user.jti),
        revokedBeforeKey(user.id),
      );
    } catch (err) {
      this.logger.error(`Cannot check token revocation: ${(err as Error).message}`);
      throw AppException.unavailable();
    }
    if (denied || (revokedBefore && user.iat <= Number(revokedBefore))) {
      throw AppException.unauthorized(
        ErrorCode.INVALID_ACCESS_TOKEN,
        'This session has ended. Please log in again.',
      );
    }
  }

  /** Denylist one token until its natural expiry. */
  async revoke(user: AuthUser): Promise<void> {
    const remaining = user.exp - Math.floor(Date.now() / 1000);
    if (remaining > 0) await this.redis.set(denylistKey(user.jti), '1', 'EX', remaining);
  }

  /** Reject every access token issued to this user up to now. */
  async revokeAllFor(userId: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.redis.set(revokedBeforeKey(userId), String(now), 'EX', this.ttlSeconds + 60);
  }
}
