import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AppRequest } from '../types/request.js';

/**
 * Rate limits per USER on authenticated routes and per IP otherwise.
 *
 * Per-user matters behind the Next.js BFF: every browser request reaches the
 * API from the same server IP, so a per-IP limit would make all customers
 * share one budget. Runs after the JwtAuthGuard, so `req.user` is populated.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as AppRequest;
    return request.user ? `user:${request.user.id}` : `ip:${request.ip ?? 'unknown'}`;
  }
}
