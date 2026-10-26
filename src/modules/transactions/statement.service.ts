import { Injectable } from '@nestjs/common';
import { pageMeta, PaginationQueryDto, skipTake } from '../../common/dto/pagination.dto.js';
import { displayName } from '../../common/utils/account.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service.js';

const ENTRY_INCLUDE = {
  transaction: { select: { reference: true, kind: true, note: true, currency: true } },
  counterpartyWallet: {
    select: {
      accountNumber: true,
      kind: true,
      user: { select: { email: true, kyc: { select: { fullName: true, status: true } } } },
    },
  },
} satisfies Prisma.LedgerEntryInclude;

type EntryWithRelations = Prisma.LedgerEntryGetPayload<{ include: typeof ENTRY_INCLUDE }>;

/** One bank-statement line, from the viewing wallet's point of view. */
export interface StatementEntry {
  id: string;
  transactionId: string;
  reference: string;
  kind: string;
  type: 'CREDIT' | 'DEBIT';
  direction: 'in' | 'out';
  amount: string;
  currency: string;
  description: string;
  note: string | null;
  /** The other customer; null for movements against system accounts (deposits, admin credits). */
  counterparty: { accountNumber: string; name: string } | null;
  balanceAfter: string;
  createdAt: string;
}

/**
 * Read model over the ledger: statements are ledger entries, so the running
 * balance on every line is exact (recorded under the wallet lock), and the
 * counterparty is a real foreign key, not a number parsed out of text.
 */
@Injectable()
export class StatementService {
  constructor(private readonly prisma: PrismaService) {}

  async page(walletIds: string[], query: PaginationQueryDto) {
    const where = { walletId: { in: walletIds } };
    const [entries, total] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where,
        include: ENTRY_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...skipTake(query),
      }),
      this.prisma.ledgerEntry.count({ where }),
    ]);
    return { transactions: entries.map(toStatementEntry), pagination: pageMeta(total, query) };
  }

  async entry(id: string, db: Tx = this.prisma): Promise<StatementEntry> {
    const entry = await db.ledgerEntry.findUniqueOrThrow({ where: { id }, include: ENTRY_INCLUDE });
    return toStatementEntry(entry);
  }

  /** Lifetime money in / out and number of statement lines for one wallet. */
  async summary(walletId: string) {
    const totals = await this.prisma.ledgerEntry.groupBy({
      by: ['direction'],
      where: { walletId },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const of = (direction: 'CREDIT' | 'DEBIT') => totals.find((t) => t.direction === direction);
    return {
      totalIn: (of('CREDIT')?._sum.amount ?? 0n).toString(),
      totalOut: (of('DEBIT')?._sum.amount ?? 0n).toString(),
      transactionCount: (of('CREDIT')?._count._all ?? 0) + (of('DEBIT')?._count._all ?? 0),
    };
  }
}

export function toStatementEntry(entry: EntryWithRelations): StatementEntry {
  const counterparty = entry.counterpartyWallet;
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    reference: entry.transaction.reference,
    kind: entry.transaction.kind,
    type: entry.direction,
    direction: entry.direction === 'CREDIT' ? 'in' : 'out',
    amount: entry.amount.toString(),
    currency: entry.transaction.currency,
    description: entry.description,
    note: entry.transaction.note,
    counterparty:
      counterparty?.kind === 'USER' && counterparty.user
        ? {
            accountNumber: counterparty.accountNumber,
            name: displayName(counterparty.user.email, counterparty.user.kyc),
          }
        : null,
    balanceAfter: entry.balanceAfter.toString(),
    createdAt: entry.createdAt.toISOString(),
  };
}
