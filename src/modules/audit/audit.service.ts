import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/types/request.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service.js';

export const AuditAction = {
  USER_REGISTERED: 'USER_REGISTERED',
  REFRESH_TOKEN_REUSE_DETECTED: 'REFRESH_TOKEN_REUSE_DETECTED',
  LOGOUT_ALL: 'LOGOUT_ALL',
  WALLET_CREATED: 'WALLET_CREATED',
  WALLET_STATUS_CHANGED: 'WALLET_STATUS_CHANGED',
  TRANSFER_COMPLETED: 'TRANSFER_COMPLETED',
  ADMIN_CREDIT: 'ADMIN_CREDIT',
  KYC_SUBMITTED: 'KYC_SUBMITTED',
  KYC_REVIEWED: 'KYC_REVIEWED',
  DEPOSIT_INITIATED: 'DEPOSIT_INITIATED',
  DEPOSIT_SUCCEEDED: 'DEPOSIT_SUCCEEDED',
  DEPOSIT_FAILED: 'DEPOSIT_FAILED',
  DEPOSIT_AMOUNT_MISMATCH: 'DEPOSIT_AMOUNT_MISMATCH',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  action: AuditAction;
  actor: Actor;
  resourceType?: string;
  resourceId?: string;
  /** Free-form context. Money must already be a string (JSON has no BigInt). */
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

/**
 * Append-only audit trail. Pass the transaction client (`tx`) for actions that
 * change state, so the audit row commits or rolls back together with them.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, db: Tx = this.prisma): Promise<void> {
    await db.auditLog.create({
      data: {
        action: entry.action,
        actorId: entry.actor.userId,
        ipAddress: entry.actor.ip ?? null,
        requestId: entry.actor.requestId ?? null,
        resourceType: entry.resourceType ?? null,
        resourceId: entry.resourceId ?? null,
        metadata: (entry.metadata ?? {}) as Prisma.InputJsonObject,
      },
    });
  }
}
