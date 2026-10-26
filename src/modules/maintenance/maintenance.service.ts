import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../infra/prisma/prisma.service.js';

const DAY_MS = 86_400_000;

/**
 * Hourly housekeeping. Every statement is an idempotent DELETE, so it is safe
 * when several API instances run it at the same time (no leader election needed).
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'prune-expired-records' })
  async pruneExpiredRecords(): Promise<void> {
    const now = Date.now();
    try {
      const [keys, tokens] = await Promise.all([
        // Idempotency keys are honoured for 24 hours.
        this.prisma.idempotencyKey.deleteMany({
          where: { createdAt: { lt: new Date(now - DAY_MS) } },
        }),
        // Dead refresh tokens are kept a week for reuse detection and forensics.
        this.prisma.refreshToken.deleteMany({
          where: { expiresAt: { lt: new Date(now - 7 * DAY_MS) } },
        }),
      ]);
      this.logger.log(`Pruned ${keys.count} idempotency keys and ${tokens.count} refresh tokens`);
    } catch (err) {
      this.logger.error(`Pruning failed: ${(err as Error).message}`);
    }
  }
}
