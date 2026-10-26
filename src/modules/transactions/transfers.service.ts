import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, ErrorCode } from '../../common/errors/app.exception.js';
import type { Actor, AuthUser } from '../../common/types/request.js';
import { displayName } from '../../common/utils/account.js';
import { stableHash } from '../../common/utils/crypto.js';
import { generateReference } from '../../common/utils/reference.js';
import type { Env } from '../../config/env.js';
import { MONEY_TX_OPTIONS, PrismaService, type Tx } from '../../infra/prisma/prisma.service.js';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import { IdempotencyService, type IdempotencyRequest } from '../idempotency/idempotency.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletsService } from '../wallets/wallets.service.js';
import { TransferDto } from './dto/transfer.dto.js';
import { StatementService, type StatementEntry } from './statement.service.js';

export interface TransferResult {
  replayed: boolean;
  entry: StatementEntry;
}

@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly idempotency: IdempotencyService,
    private readonly wallets: WalletsService,
    private readonly statements: StatementService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Send money from the caller's default wallet to a customer account number.
   * One database transaction: claim the idempotency key, lock both wallets,
   * check every rule against the LOCKED balances, post a balanced journal,
   * audit, store the response. Any failure rolls back all of it.
   */
  async transfer(
    user: AuthUser,
    dto: TransferDto,
    idempotencyKey: string,
    actor: Actor,
  ): Promise<TransferResult> {
    const amount = BigInt(dto.amount);
    const note = dto.note || null;
    this.assertWithinMaxAmount(amount);

    const idem: IdempotencyRequest = {
      userId: user.id,
      scope: 'transfer',
      key: idempotencyKey,
      requestHash: stableHash({ to: dto.toAccountNumber, amount: amount.toString(), note }),
    };

    return this.prisma.$transaction(async (tx) => {
      const previous = await this.idempotency.claim<StatementEntry>(tx, idem);
      if (previous) return { replayed: true, entry: previous.replay };

      const sender = await this.wallets.getDefault(user.id, tx);
      const recipient = await tx.wallet.findFirst({
        where: { accountNumber: dto.toAccountNumber, kind: 'USER' },
        include: {
          user: { select: { email: true, kyc: { select: { fullName: true, status: true } } } },
        },
      });
      if (!recipient?.user) {
        throw AppException.notFound(ErrorCode.RECIPIENT_NOT_FOUND, 'Recipient account not found.');
      }
      if (recipient.id === sender.id) {
        throw AppException.unprocessable(
          ErrorCode.SELF_TRANSFER,
          'You cannot transfer to your own account.',
        );
      }
      if (recipient.currency !== sender.currency) {
        throw AppException.unprocessable(
          ErrorCode.CURRENCY_MISMATCH,
          'The recipient account is in a different currency.',
        );
      }

      const locked = await this.ledger.lockWallets(tx, [sender.id, recipient.id]);
      const from = locked.get(sender.id)!;
      if (from.status === 'FROZEN') {
        throw AppException.unprocessable(
          ErrorCode.WALLET_FROZEN,
          'Your wallet is frozen. Please contact support.',
        );
      }
      if (from.balance < amount) {
        throw AppException.unprocessable(ErrorCode.INSUFFICIENT_FUNDS, 'Insufficient balance.');
      }
      await this.assertWithinDailyLimit(tx, user.id, sender.id, amount);

      const { transaction, entries } = await this.ledger.post(tx, locked, {
        kind: 'TRANSFER',
        reference: generateReference('TRF'),
        amount,
        currency: sender.currency,
        description: `Transfer from ${sender.accountNumber} to ${recipient.accountNumber}`,
        note,
        initiatedById: user.id,
        legs: [
          {
            walletId: sender.id,
            direction: 'DEBIT',
            description: `Transfer to ${recipient.accountNumber}`,
            counterpartyWalletId: recipient.id,
          },
          {
            walletId: recipient.id,
            direction: 'CREDIT',
            description: `Transfer from ${sender.accountNumber}`,
            counterpartyWalletId: sender.id,
          },
        ],
      });

      await this.audit.record(
        {
          action: AuditAction.TRANSFER_COMPLETED,
          actor,
          resourceType: 'transaction',
          resourceId: transaction.id,
          metadata: {
            reference: transaction.reference,
            amount: amount.toString(),
            toAccountNumber: recipient.accountNumber,
          },
        },
        tx,
      );

      const debit = entries.find((e) => e.walletId === sender.id)!;
      const entry: StatementEntry = {
        id: debit.id,
        transactionId: transaction.id,
        reference: transaction.reference,
        kind: transaction.kind,
        type: 'DEBIT',
        direction: 'out',
        amount: amount.toString(),
        currency: transaction.currency,
        description: debit.description,
        note: transaction.note,
        counterparty: {
          accountNumber: recipient.accountNumber,
          name: displayName(recipient.user.email, recipient.user.kyc),
        },
        balanceAfter: debit.balanceAfter.toString(),
        createdAt: debit.createdAt.toISOString(),
      };
      await this.idempotency.complete(tx, idem, { ...entry });
      return { replayed: false, entry };
    }, MONEY_TX_OPTIONS);
  }

  private assertWithinMaxAmount(amount: bigint): void {
    const max = BigInt(this.config.get('MAX_TRANSACTION_AMOUNT', { infer: true }));
    if (amount > max) {
      throw AppException.unprocessable(
        ErrorCode.AMOUNT_TOO_LARGE,
        `The maximum amount per transaction is ${max} minor units.`,
      );
    }
  }

  /**
   * Customers without VERIFIED KYC have a daily outgoing cap. Checked while the
   * sender's wallet is locked, so parallel transfers can't sneak past it.
   * "Today" is the calendar day in BUSINESS_TIMEZONE.
   */
  private async assertWithinDailyLimit(tx: Tx, userId: string, walletId: string, amount: bigint) {
    const limit = BigInt(this.config.get('UNVERIFIED_DAILY_TRANSFER_LIMIT', { infer: true }));
    if (limit === 0n) return;

    const kyc = await tx.kycRecord.findUnique({ where: { userId }, select: { status: true } });
    if (kyc?.status === 'VERIFIED') return;

    const tz = this.config.get('BUSINESS_TIMEZONE', { infer: true });
    const [{ spent }] = await tx.$queryRaw<{ spent: bigint }[]>`
      SELECT COALESCE(SUM(e.amount), 0)::bigint AS spent
        FROM ledger_entries e
        JOIN transactions t ON t.id = e.transaction_id
       WHERE e.wallet_id = ${walletId}::uuid
         AND e.direction = 'DEBIT'
         AND t.kind = 'TRANSFER'
         AND e.created_at >= (date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`;

    if (spent + amount > limit) {
      throw AppException.unprocessable(
        ErrorCode.DAILY_LIMIT_EXCEEDED,
        `Unverified accounts can send up to ${limit} minor units per day (${spent} used). Complete KYC to raise your limit.`,
      );
    }
  }
}
