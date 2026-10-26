import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { AppException, ErrorCode } from '../../common/errors/app.exception.js';
import type { Actor } from '../../common/types/request.js';
import { randomToken, sha256Hex } from '../../common/utils/crypto.js';
import type { Env } from '../../config/env.js';
import type { User } from '../../generated/prisma/client.js';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service.js';
import { AuditAction, AuditService } from '../audit/audit.service.js';

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
  requestId?: string;
}

const invalid = () =>
  AppException.unauthorized(
    ErrorCode.INVALID_REFRESH_TOKEN,
    'Your session has expired. Please log in again.',
  );

/**
 * Opaque refresh tokens with rotation and reuse detection.
 *
 * - Only the SHA-256 hash is stored, so a database leak leaks no usable tokens.
 * - Each login starts a token FAMILY (one per device/session); many devices can
 *   be logged in at once.
 * - Every refresh rotates: the presented token is marked rotated and a new one
 *   joins the family. Rotation is a compare-and-set, so two concurrent refreshes
 *   with the same token can't both succeed.
 * - A rotated token presented again AFTER the grace window means it was copied
 *   (stolen): the whole family is revoked. Within the window it's treated as a
 *   benign race (two tabs refreshing at once) and simply refused.
 */
@Injectable()
export class RefreshTokenService {
  private readonly ttlMs: number;
  private readonly graceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlMs = config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }) * 86_400_000;
    this.graceMs = config.get('REFRESH_REUSE_GRACE_SECONDS', { infer: true }) * 1000;
  }

  get maxAgeMs(): number {
    return this.ttlMs;
  }

  /** Create a refresh token. Omit `familyId` to start a new session. */
  async issue(
    db: Tx,
    userId: string,
    meta: SessionMeta,
    familyId: string = randomUUID(),
  ): Promise<string> {
    const token = randomToken();
    await db.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(Date.now() + this.ttlMs),
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
        ipAddress: meta.ip ?? null,
      },
    });
    return token;
  }

  async rotate(rawToken: string, meta: SessionMeta): Promise<{ user: User; token: string }> {
    const tokenHash = sha256Hex(rawToken);
    const now = new Date();

    const rotated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshToken.updateMany({
        where: { tokenHash, rotatedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { rotatedAt: now },
      });
      if (claimed.count !== 1) return null;

      const row = await tx.refreshToken.findUniqueOrThrow({
        where: { tokenHash },
        include: { user: true },
      });
      const token = await this.issue(tx, row.userId, meta, row.familyId);
      return { user: row.user, token };
    });
    if (rotated) return rotated;

    // Not rotatable: unknown, expired, revoked, or ALREADY rotated.
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!row || row.revokedAt || !row.rotatedAt) throw invalid();
    if (now.getTime() - row.rotatedAt.getTime() <= this.graceMs) throw invalid();

    // Reuse outside the grace window: assume theft, end the whole session.
    await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.updateMany({
        where: { familyId: row.familyId, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.audit.record(
        {
          action: AuditAction.REFRESH_TOKEN_REUSE_DETECTED,
          actor: { userId: row.userId, ip: meta.ip, requestId: meta.requestId },
          resourceType: 'session',
          resourceId: row.familyId,
        },
        tx,
      );
    });
    throw invalid();
  }

  /** Revoke the session (family) a token belongs to. Unknown tokens are ignored. */
  async revokeFamilyOf(rawToken: string): Promise<void> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256Hex(rawToken) },
      select: { familyId: true },
    });
    if (!row) return;
    await this.prisma.refreshToken.updateMany({
      where: { familyId: row.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllFor(userId: string, actor: Actor): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record(
        { action: AuditAction.LOGOUT_ALL, actor, resourceType: 'user', resourceId: userId },
        tx,
      );
    });
  }
}
