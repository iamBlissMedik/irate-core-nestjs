import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import type { TransactionKind } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';

type TrendType = 'up' | 'down' | 'neutral';

/** Money that enters the platform from outside (the other side is a system account). */
const INFLOW_KINDS: TransactionKind[] = ['DEPOSIT', 'ADMIN_CREDIT'];
/** Money that leaves the platform. Empty until payouts ship (see roadmap). */
const OUTFLOW_KINDS: TransactionKind[] = [];

/**
 * Headline cards for the admin dashboard, in the `{ title, value, trend,
 * trendType }` shape the admin app renders. Counts are numbers; money is a
 * minor-unit string in the default currency. "Today" uses BUSINESS_TIMEZONE.
 *
 * Unlike the Express version, a transfer counts ONCE (it is one journal, not
 * two per-wallet rows), and admins are excluded from user counts consistently.
 */
@Injectable()
export class AdminStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async overview() {
    const [usersStats, walletsBalance, transactionStats, totalCashflow, transactionVolume] =
      await Promise.all([
        this.usersStats(),
        this.walletsBalance(),
        this.transactionStats(),
        this.totalCashflow(),
        this.transactionVolume(),
      ]);
    return { usersStats, walletsBalance, transactionStats, totalCashflow, transactionVolume };
  }

  async usersStats() {
    const { todayStart, yesterdayStart } = await this.dayBoundaries();
    const [total, today, yesterday] = await Promise.all([
      this.prisma.user.count({ where: { role: 'USER' } }),
      this.prisma.user.count({ where: { role: 'USER', createdAt: { gte: todayStart } } }),
      this.prisma.user.count({
        where: { role: 'USER', createdAt: { gte: yesterdayStart, lt: todayStart } },
      }),
    ]);
    return { title: 'Total Users', value: total, ...trend(BigInt(today), BigInt(yesterday)) };
  }

  async walletsBalance() {
    const currency = this.currency();
    const { todayStart, yesterdayStart } = await this.dayBoundaries();
    const [balance, wallets, inToday, inYesterday] = await Promise.all([
      this.prisma.wallet.aggregate({ _sum: { balance: true }, where: { kind: 'USER', currency } }),
      this.prisma.wallet.count({ where: { kind: 'USER', currency } }),
      this.sumTransactions({ kinds: INFLOW_KINDS, from: todayStart }),
      this.sumTransactions({ kinds: INFLOW_KINDS, from: yesterdayStart, to: todayStart }),
    ]);
    return {
      title: 'Total Wallet Balance',
      value: (balance._sum.balance ?? 0n).toString(),
      currency,
      wallets,
      ...trend(inToday, inYesterday),
    };
  }

  async transactionStats() {
    const now = Date.now();
    const last24h = new Date(now - 86_400_000);
    const prev24h = new Date(now - 2 * 86_400_000);
    const [total, recent, previous] = await Promise.all([
      this.prisma.transaction.count(),
      this.prisma.transaction.count({ where: { createdAt: { gte: last24h } } }),
      this.prisma.transaction.count({ where: { createdAt: { gte: prev24h, lt: last24h } } }),
    ]);
    return {
      title: 'Total Transactions',
      value: total,
      ...trend(BigInt(recent), BigInt(previous)),
    };
  }

  async totalCashflow() {
    const [credit, debit] = await Promise.all([
      this.sumTransactions({ kinds: INFLOW_KINDS }),
      this.sumTransactions({ kinds: OUTFLOW_KINDS }),
    ]);
    return {
      title: 'Total Cashflow',
      value: (credit - debit).toString(),
      credit: credit.toString(),
      debit: debit.toString(),
      currency: this.currency(),
    };
  }

  async transactionVolume() {
    const now = Date.now();
    const last24h = new Date(now - 86_400_000);
    const prev24h = new Date(now - 2 * 86_400_000);
    const [recent, previous] = await Promise.all([
      this.sumTransactions({ from: last24h }),
      this.sumTransactions({ from: prev24h, to: last24h }),
    ]);
    return {
      title: 'Transaction Volume',
      value: recent.toString(),
      currency: this.currency(),
      ...trend(recent, previous),
    };
  }

  private async sumTransactions(filter: {
    kinds?: TransactionKind[];
    from?: Date;
    to?: Date;
  }): Promise<bigint> {
    if (filter.kinds && filter.kinds.length === 0) return 0n;
    const result = await this.prisma.transaction.aggregate({
      _sum: { amount: true },
      where: {
        currency: this.currency(),
        status: 'COMPLETED',
        ...(filter.kinds ? { kind: { in: filter.kinds } } : {}),
        ...(filter.from || filter.to ? { createdAt: { gte: filter.from, lt: filter.to } } : {}),
      },
    });
    return result._sum.amount ?? 0n;
  }

  private async dayBoundaries() {
    const tz = this.config.get('BUSINESS_TIMEZONE', { infer: true });
    const [row] = await this.prisma.$queryRaw<{ todayStart: Date; yesterdayStart: Date }[]>`
      SELECT (date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}) AS "todayStart",
             (date_trunc('day', now() AT TIME ZONE ${tz}) - interval '1 day') AT TIME ZONE ${tz} AS "yesterdayStart"`;
    return row;
  }

  private currency(): string {
    return this.config.get('DEFAULT_CURRENCY', { infer: true });
  }
}

/** Percent change with one decimal; growth from zero counts as +100%. */
export function trend(current: bigint, previous: bigint): { trend: number; trendType: TrendType } {
  const trendType: TrendType = current > previous ? 'up' : current < previous ? 'down' : 'neutral';
  if (previous === 0n) return { trend: current > 0n ? 100 : 0, trendType };
  // Scale in BigInt first so huge sums don't lose precision before the division.
  const tenthsOfPercent = ((current - previous) * 1000n) / previous;
  return { trend: Number(tenthsOfPercent) / 10, trendType };
}
