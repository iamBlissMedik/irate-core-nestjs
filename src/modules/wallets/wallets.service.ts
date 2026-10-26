import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, ErrorCode } from '../../common/errors/app.exception.js';
import { pageMeta, PaginationQueryDto, skipTake } from '../../common/dto/pagination.dto.js';
import type { Actor } from '../../common/types/request.js';
import { displayName, generateAccountNumber } from '../../common/utils/account.js';
import type { Env } from '../../config/env.js';
import type { Wallet } from '../../generated/prisma/client.js';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service.js';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import { toWalletView } from './wallet.presenter.js';

const ACCOUNT_NUMBER_ATTEMPTS = 5;

@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Open a customer wallet with a fresh account number. Runs inside the
   * caller's transaction (registration creates user + wallet atomically).
   *
   * A unique violation would abort the whole Postgres transaction, so instead
   * of catching one we insert with ON CONFLICT DO NOTHING and retry with a new
   * number when nothing was inserted.
   */
  async createForUser(tx: Tx, userId: string, currency: string): Promise<Wallet> {
    this.assertSupportedCurrency(currency);

    for (let attempt = 0; attempt < ACCOUNT_NUMBER_ATTEMPTS; attempt++) {
      const [wallet] = await tx.wallet.createManyAndReturn({
        data: [{ userId, currency, kind: 'USER', accountNumber: generateAccountNumber() }],
        skipDuplicates: true,
      });
      if (wallet) return wallet;

      // Nothing inserted: either the account number clashed (retry) or this
      // user already has a wallet in this currency (a concurrent request won).
      const existing = await tx.wallet.findUnique({
        where: { userId_currency: { userId, currency } },
        select: { id: true },
      });
      if (existing) {
        throw AppException.conflict(
          ErrorCode.WALLET_EXISTS,
          `You already have a ${currency} wallet.`,
        );
      }
    }
    throw new Error('Could not allocate a unique account number');
  }

  async create(userId: string, actor: Actor, currency?: string) {
    const code = currency ?? this.config.get('DEFAULT_CURRENCY', { infer: true });
    const existing = await this.prisma.wallet.findUnique({
      where: { userId_currency: { userId, currency: code } },
      select: { id: true },
    });
    if (existing) {
      throw AppException.conflict(ErrorCode.WALLET_EXISTS, `You already have a ${code} wallet.`);
    }

    const wallet = await this.prisma.$transaction(async (tx) => {
      const created = await this.createForUser(tx, userId, code);
      await this.audit.record(
        {
          action: AuditAction.WALLET_CREATED,
          actor,
          resourceType: 'wallet',
          resourceId: created.id,
          metadata: { currency: code },
        },
        tx,
      );
      return created;
    });
    return toWalletView(wallet);
  }

  async listMine(userId: string, query: PaginationQueryDto) {
    const where = { userId, kind: 'USER' as const };
    const [wallets, total] = await Promise.all([
      this.prisma.wallet.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        ...skipTake(query),
      }),
      this.prisma.wallet.count({ where }),
    ]);
    return { wallets: wallets.map(toWalletView), pagination: pageMeta(total, query) };
  }

  /** Ownership is checked in the query itself: someone else's wallet is a plain 404. */
  async getOwned(userId: string, walletId: string): Promise<Wallet> {
    const wallet = await this.prisma.wallet.findFirst({
      where: { id: walletId, userId, kind: 'USER' },
    });
    if (!wallet) throw AppException.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet not found.');
    return wallet;
  }

  async getBalance(userId: string, walletId: string) {
    const wallet = await this.getOwned(userId, walletId);
    return { walletId: wallet.id, balance: wallet.balance.toString(), currency: wallet.currency };
  }

  /** The customer's wallet in the platform's default currency (used for transfers and overview). */
  async getDefault(userId: string, db: Tx = this.prisma): Promise<Wallet> {
    const currency = this.config.get('DEFAULT_CURRENCY', { infer: true });
    const wallet = await db.wallet.findUnique({ where: { userId_currency: { userId, currency } } });
    if (!wallet) {
      throw AppException.notFound(ErrorCode.WALLET_NOT_FOUND, "You don't have a wallet yet.");
    }
    return wallet;
  }

  /**
   * Name enquiry: resolve an account number to the holder's display name so a
   * sender can confirm the recipient. Never exposes email, balance or ids, and
   * system accounts are not resolvable.
   */
  async resolve(accountNumber: string) {
    const wallet = await this.prisma.wallet.findFirst({
      where: { accountNumber, kind: 'USER' },
      select: {
        accountNumber: true,
        user: { select: { email: true, kyc: { select: { fullName: true, status: true } } } },
      },
    });
    if (!wallet?.user) {
      throw AppException.notFound(ErrorCode.RECIPIENT_NOT_FOUND, 'Account not found.');
    }
    return {
      accountNumber: wallet.accountNumber,
      accountName: displayName(wallet.user.email, wallet.user.kyc),
    };
  }

  assertSupportedCurrency(currency: string): void {
    if (!this.config.get('SUPPORTED_CURRENCIES', { infer: true }).includes(currency)) {
      throw AppException.unprocessable(
        ErrorCode.UNSUPPORTED_CURRENCY,
        `${currency} is not supported.`,
      );
    }
  }
}
