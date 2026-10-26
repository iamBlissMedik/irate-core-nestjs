import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, ErrorCode } from '../../common/errors/app.exception.js';
import type { Actor, AuthUser } from '../../common/types/request.js';
import { stableHash } from '../../common/utils/crypto.js';
import { generateReference } from '../../common/utils/reference.js';
import type { Env } from '../../config/env.js';
import { MONEY_TX_OPTIONS, PrismaService } from '../../infra/prisma/prisma.service.js';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import { IdempotencyService, type IdempotencyRequest } from '../idempotency/idempotency.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { SystemWalletCode, SystemWalletsService } from '../ledger/system-wallets.service.js';
import { toWalletView } from '../wallets/wallet.presenter.js';
import type { CreditWalletDto, WalletStatusDto } from './dto/admin.dto.js';

export interface CreditResult {
  walletId: string;
  accountNumber: string;
  amount: string;
  balance: string;
  currency: string;
  transactionId: string;
  reference: string;
  createdAt: string;
}

const walletNotFound = () => AppException.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet not found.');

@Injectable()
export class AdminWalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly systemWallets: SystemWalletsService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Manual credit (goodwill, corrections). Double-entry against the ADJUSTMENTS
   * system account, so the books still balance and every naira an admin adds
   * is accounted for. Admins can't credit their own wallet. Frozen wallets can
   * still be credited (freeze only blocks debits).
   */
  async credit(
    admin: AuthUser,
    walletId: string,
    dto: CreditWalletDto,
    idempotencyKey: string,
    actor: Actor,
  ) {
    const amount = BigInt(dto.amount);
    const max = BigInt(this.config.get('MAX_TRANSACTION_AMOUNT', { infer: true }));
    if (amount > max) {
      throw AppException.unprocessable(
        ErrorCode.AMOUNT_TOO_LARGE,
        `The maximum credit is ${max} minor units.`,
      );
    }
    const idem: IdempotencyRequest = {
      userId: admin.id,
      scope: 'admin_credit',
      key: idempotencyKey,
      requestHash: stableHash({ walletId, amount: amount.toString(), reason: dto.reason }),
    };

    return this.prisma.$transaction(async (tx) => {
      const previous = await this.idempotency.claim<CreditResult>(tx, idem);
      if (previous) return { replayed: true, result: previous.replay };

      const wallet = await tx.wallet.findUnique({ where: { id: walletId } });
      if (!wallet || wallet.kind !== 'USER') throw walletNotFound();
      if (wallet.userId === admin.id)
        throw AppException.forbidden('You cannot credit your own wallet.');

      const adjustmentsId = await this.systemWallets.idFor(
        tx,
        SystemWalletCode.ADJUSTMENTS,
        wallet.currency,
      );
      const locked = await this.ledger.lockWallets(tx, [adjustmentsId, wallet.id]);
      const { transaction, entries } = await this.ledger.post(tx, locked, {
        kind: 'ADMIN_CREDIT',
        reference: generateReference('ADJ'),
        amount,
        currency: wallet.currency,
        description: `Admin credit to ${wallet.accountNumber}`,
        note: dto.reason,
        initiatedById: admin.id,
        legs: [
          {
            walletId: adjustmentsId,
            direction: 'DEBIT',
            description: `Admin credit to ${wallet.accountNumber}`,
          },
          {
            walletId: wallet.id,
            direction: 'CREDIT',
            description: dto.reason,
            counterpartyWalletId: adjustmentsId,
          },
        ],
      });

      await this.audit.record(
        {
          action: AuditAction.ADMIN_CREDIT,
          actor,
          resourceType: 'wallet',
          resourceId: wallet.id,
          metadata: {
            amount: amount.toString(),
            reason: dto.reason,
            reference: transaction.reference,
          },
        },
        tx,
      );

      const credit = entries.find((e) => e.walletId === wallet.id)!;
      const result: CreditResult = {
        walletId: wallet.id,
        accountNumber: wallet.accountNumber,
        amount: amount.toString(),
        balance: credit.balanceAfter.toString(),
        currency: wallet.currency,
        transactionId: transaction.id,
        reference: transaction.reference,
        createdAt: transaction.createdAt.toISOString(),
      };
      await this.idempotency.complete(tx, idem, { ...result });
      return { replayed: false, result };
    }, MONEY_TX_OPTIONS);
  }

  /** Freeze ("post no debit") or unfreeze a customer wallet. */
  async setStatus(walletId: string, dto: WalletStatusDto, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { id: walletId } });
      if (!wallet || wallet.kind !== 'USER') throw walletNotFound();

      // UPDATE takes the row lock, so it waits for any in-flight transfer to finish.
      const updated = await tx.wallet.update({
        where: { id: walletId },
        data: { status: dto.status },
      });
      if (wallet.status !== dto.status) {
        await this.audit.record(
          {
            action: AuditAction.WALLET_STATUS_CHANGED,
            actor,
            resourceType: 'wallet',
            resourceId: walletId,
            metadata: { from: wallet.status, to: dto.status, reason: dto.reason },
          },
          tx,
        );
      }
      return toWalletView(updated);
    });
  }
}
