import type { Request } from 'express';
import type { UserRole } from '../../generated/prisma/enums.js';

/** The authenticated caller, taken from a verified access token. */
export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  /** Token id, used to denylist this exact token on logout. */
  jti: string;
  /** Issued-at / expiry, seconds since epoch. */
  iat: number;
  exp: number;
}

export interface AppRequest extends Request {
  /** Request id assigned by pino-http (echoed in X-Request-ID and error bodies). */
  id: string;
  user?: AuthUser;
  /** Raw body bytes (enabled with `rawBody: true`); needed to verify webhook signatures. */
  rawBody?: Buffer;
}

/** Who did something, for audit logs. */
export interface Actor {
  userId: string | null;
  ip?: string;
  requestId?: string;
}

export function actorFrom(req: AppRequest): Actor {
  return { userId: req.user?.id ?? null, ip: req.ip, requestId: req.id };
}
