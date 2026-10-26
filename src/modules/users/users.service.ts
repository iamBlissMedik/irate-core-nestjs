import { Injectable } from '@nestjs/common';
import { AppException, ErrorCode } from '../../common/errors/app.exception.js';
import { pageMeta, skipTake } from '../../common/dto/pagination.dto.js';
import type { AuthUser } from '../../common/types/request.js';
import { escapeLike } from '../../common/utils/sql.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { toKycView } from '../kyc/kyc.presenter.js';
import { StatementService } from '../transactions/statement.service.js';
import { toWalletView } from '../wallets/wallet.presenter.js';
import { WalletsService } from '../wallets/wallets.service.js';
import type { ListUsersQueryDto } from './dto/list-users.dto.js';

const RECENT_TRANSACTIONS = 5;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: WalletsService,
    private readonly statements: StatementService,
  ) {}

  /**
   * Customers may read only their own profile; admins may read anyone's. The
   * permission check runs BEFORE the lookup, so a 403 never reveals whether
   * an id exists.
   */
  async getProfile(viewer: AuthUser, userId: string) {
    if (viewer.id !== userId && viewer.role !== 'ADMIN') {
      throw AppException.forbidden('You can only view your own profile.');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        kyc: true,
        wallets: { where: { kind: 'USER' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!user) throw AppException.notFound(ErrorCode.NOT_FOUND, 'User not found.');

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      ...(user.kyc ? { kycStatus: user.kyc.status } : {}),
      kyc: user.kyc ? toKycView(user.kyc) : null,
      wallets: user.wallets.map(toWalletView),
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  /** The customer home screen: default wallet, balance, KYC status, lifetime stats, latest activity. */
  async getOverview(userId: string) {
    const wallet = await this.wallets.getDefault(userId);
    const [kyc, stats, recent] = await Promise.all([
      this.prisma.kycRecord.findUnique({ where: { userId }, select: { status: true } }),
      this.statements.summary(wallet.id),
      this.statements.page([wallet.id], { page: 1, limit: RECENT_TRANSACTIONS }),
    ]);
    return {
      walletId: wallet.id,
      accountNumber: wallet.accountNumber,
      balance: wallet.balance.toString(),
      currency: wallet.currency,
      walletStatus: wallet.status,
      kycStatus: kyc?.status ?? null,
      stats,
      recentTransactions: recent.transactions,
    };
  }

  /** Admin directory, newest first, with search over email and KYC name. */
  async listForAdmin(query: ListUsersQueryDto) {
    const term = query.search ? escapeLike(query.search) : undefined;
    const where: Prisma.UserWhereInput = term
      ? {
          OR: [
            { email: { contains: term, mode: 'insensitive' } },
            { kyc: { fullName: { contains: term, mode: 'insensitive' } } },
          ],
        }
      : {};

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: {
          kyc: { select: { id: true, status: true, verifiedAt: true } },
          wallets: { where: { kind: 'USER' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...skipTake(query),
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt.toISOString(),
        kyc: user.kyc
          ? {
              id: user.kyc.id,
              status: user.kyc.status,
              verifiedAt: user.kyc.verifiedAt?.toISOString() ?? null,
            }
          : null,
        wallets: user.wallets.map(toWalletView),
      })),
      pagination: pageMeta(total, query),
    };
  }
}
