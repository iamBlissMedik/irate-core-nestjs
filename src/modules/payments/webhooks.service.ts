import { Injectable, Logger } from '@nestjs/common';
import { AppException, ErrorCode } from '../../common/errors/app.exception.js';
import { Prisma, type Deposit } from '../../generated/prisma/client.js';
import { MONEY_TX_OPTIONS, PrismaService, type Tx } from '../../infra/prisma/prisma.service.js';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { SystemWalletCode, SystemWalletsService } from '../ledger/system-wallets.service.js';
import type { PaymentEvent, WebhookHeaders } from './providers/payment-provider.js';
import { PaymentProvidersRegistry } from './providers/payment-providers.registry.js';
import { providerError } from './providers/paystack.provider.js';

type LockedDeposit = Pick<
  Deposit,
  'id' | 'userId' | 'walletId' | 'reference' | 'amount' | 'currency' | 'status'
>;

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored' | 'unknown_reference';

/**
 * Turns verified provider webhooks into ledger postings, exactly once.
 *
 *  - Redelivery of the same event: unique (provider, event_id) makes it a no-op.
 *  - Different events for one deposit, or concurrent deliveries: the deposit row
 *    is locked (FOR UPDATE) and SUCCEEDED is terminal, so it is credited once.
 *  - Amount/currency differing from what was requested: flagged FAILED, never
 *    credited (needs manual review).
 *  - Any error (DB down, provider can't confirm yet): non-2xx, nothing is
 *    recorded, and the provider retries later.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: PaymentProvidersRegistry,
    private readonly ledger: LedgerService,
    private readonly systemWallets: SystemWalletsService,
    private readonly audit: AuditService,
  ) {}

  async handle(
    providerName: string,
    rawBody: Buffer | undefined,
    headers: WebhookHeaders,
  ): Promise<WebhookOutcome> {
    const provider = this.providers.get(providerName);
    if (!rawBody?.length)
      throw AppException.badRequest(ErrorCode.BAD_REQUEST, 'Empty webhook body.');
    const event = provider.parseWebhook(rawBody, headers);

    if (event.type === 'payment.succeeded' && provider.verify) {
      if (!event.reference)
        throw AppException.badRequest(ErrorCode.BAD_REQUEST, 'Webhook has no reference.');
      // Outside the transaction: never hold row locks across a network call.
      const verified = await provider.verify(event.reference);
      if (verified.status !== 'succeeded') {
        throw providerError('Payment not confirmed by the provider yet; retry later.');
      }
      event.amount = verified.amount;
      event.currency = verified.currency;
    }

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.webhookEvent.createMany({
        data: [
          {
            provider: provider.name,
            eventId: event.eventId,
            eventType: event.rawType,
            payload: event.payload as Prisma.InputJsonObject,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) return 'duplicate';

      const outcome = await this.apply(tx, provider.name, event);
      await tx.webhookEvent.update({
        where: { provider_eventId: { provider: provider.name, eventId: event.eventId } },
        data: { processedAt: new Date() },
      });
      return outcome;
    }, MONEY_TX_OPTIONS);
  }

  private async apply(tx: Tx, providerName: string, event: PaymentEvent): Promise<WebhookOutcome> {
    if (event.type === 'ignored') return 'ignored';
    if (!event.reference) return 'unknown_reference';

    const [deposit] = await tx.$queryRaw<LockedDeposit[]>`
      SELECT id, user_id AS "userId", wallet_id AS "walletId", reference, amount, currency, status
        FROM deposits
       WHERE provider = ${providerName} AND reference = ${event.reference}
         FOR UPDATE`;
    if (!deposit) {
      // Retrying won't help; the raw event is kept in webhook_events for investigation.
      this.logger.warn(
        `Webhook for unknown deposit reference ${event.reference} (${providerName})`,
      );
      return 'unknown_reference';
    }
    if (deposit.status === 'SUCCEEDED') return 'processed'; // terminal: never credit twice

    const actor = { userId: null };

    if (event.type === 'payment.failed') {
      if (deposit.status === 'PENDING') {
        await tx.deposit.update({
          where: { id: deposit.id },
          data: {
            status: 'FAILED',
            failureReason: event.failureReason ?? 'Payment failed',
            completedAt: new Date(),
          },
        });
        await this.audit.record(
          {
            action: AuditAction.DEPOSIT_FAILED,
            actor,
            resourceType: 'deposit',
            resourceId: deposit.id,
          },
          tx,
        );
      }
      return 'processed';
    }

    // payment.succeeded (a late success after a failure still credits: the money arrived).
    if (event.amount !== deposit.amount || event.currency !== deposit.currency) {
      const reason = `amount_mismatch: expected ${deposit.amount} ${deposit.currency}, got ${event.amount ?? '?'} ${event.currency ?? '?'}`;
      await tx.deposit.update({
        where: { id: deposit.id },
        data: { status: 'FAILED', failureReason: reason, completedAt: new Date() },
      });
      await this.audit.record(
        {
          action: AuditAction.DEPOSIT_AMOUNT_MISMATCH,
          actor,
          resourceType: 'deposit',
          resourceId: deposit.id,
          metadata: { reason },
        },
        tx,
      );
      this.logger.error(`Deposit ${deposit.reference} ${reason}; NOT credited, needs review`);
      return 'processed';
    }

    const settlementId = await this.systemWallets.idFor(
      tx,
      SystemWalletCode.SETTLEMENT,
      deposit.currency,
    );
    const locked = await this.ledger.lockWallets(tx, [settlementId, deposit.walletId]);
    const { transaction } = await this.ledger.post(tx, locked, {
      kind: 'DEPOSIT',
      reference: deposit.reference,
      amount: deposit.amount,
      currency: deposit.currency,
      description: `Deposit via ${providerName}`,
      initiatedById: deposit.userId,
      metadata: { provider: providerName, depositId: deposit.id },
      legs: [
        { walletId: settlementId, direction: 'DEBIT', description: `Deposit ${deposit.reference}` },
        {
          walletId: deposit.walletId,
          direction: 'CREDIT',
          description: `Wallet top-up via ${providerName}`,
          counterpartyWalletId: settlementId,
        },
      ],
    });

    await tx.deposit.update({
      where: { id: deposit.id },
      data: {
        status: 'SUCCEEDED',
        transactionId: transaction.id,
        failureReason: null,
        completedAt: new Date(),
      },
    });
    await this.audit.record(
      {
        action: AuditAction.DEPOSIT_SUCCEEDED,
        actor,
        resourceType: 'deposit',
        resourceId: deposit.id,
        metadata: { amount: deposit.amount.toString(), reference: deposit.reference },
      },
      tx,
    );
    return 'processed';
  }
}
