import { Throttle } from '@nestjs/throttler';

const MINUTE = 60_000;

/**
 * Named limits used across controllers (the global default is 120/min).
 * Keeping them in one place makes the API's abuse budget easy to review.
 */
export const ThrottlePolicy = {
  /**
   * Credential endpoints (per IP): slows password spraying and sign-up abuse.
   * Behind the Next.js BFF this keys on the browser's IP: @irate/bff forwards
   * it as X-Forwarded-For, and the API runs with TRUST_PROXY_HOPS=1. Account-level
   * protection (the per-email lockout) works either way.
   */
  credentials: () => Throttle({ default: { limit: 10, ttl: MINUTE } }),
  /** Money movement (per user). */
  moneyMovement: () => Throttle({ default: { limit: 20, ttl: MINUTE } }),
  /** Name enquiry (per user): stops scraping account numbers for names. */
  nameEnquiry: () => Throttle({ default: { limit: 30, ttl: MINUTE } }),
};
