import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service.js';

export interface ReconciliationReport {
  healthy: boolean;
  unbalancedTransactions: number;
  walletMismatches: {
    walletId: string;
    accountNumber: string;
    kind: string;
    currency: string;
    balance: string;
    ledgerBalance: string;
  }[];
  nonZeroCurrencies: { currency: string; net: string }[];
  checkedAt: string;
}

/**
 * Proves the books are consistent:
 *  1. every journal's entries net to zero,
 *  2. every wallet's stored balance equals the sum of its ledger entries,
 *  3. across ALL wallets (system included) each currency nets to zero,
 *     i.e. money was never created or destroyed, only moved.
 *
 * A full scan: fine on demand for an admin, run off-peak at scale.
 */
@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async run(): Promise<ReconciliationReport> {
    const [unbalanced, mismatches, currencies] = await Promise.all([
      this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM (
          SELECT transaction_id
            FROM ledger_entries
           GROUP BY transaction_id
          HAVING SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) <> 0
        ) AS unbalanced`,
      this.prisma.$queryRaw<
        {
          walletId: string;
          accountNumber: string;
          kind: string;
          currency: string;
          balance: bigint;
          ledgerBalance: bigint;
        }[]
      >`
        SELECT w.id AS "walletId", w.account_number AS "accountNumber", w.kind::text AS kind,
               w.currency, w.balance,
               COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::bigint
                 AS "ledgerBalance"
          FROM wallets w
          LEFT JOIN ledger_entries e ON e.wallet_id = w.id
         GROUP BY w.id
        HAVING w.balance <> COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0)`,
      this.prisma.$queryRaw<{ currency: string; net: bigint }[]>`
        SELECT currency, SUM(balance)::bigint AS net
          FROM wallets
         GROUP BY currency
        HAVING SUM(balance) <> 0`,
    ]);

    const unbalancedTransactions = Number(unbalanced[0]?.count ?? 0n);
    return {
      healthy: unbalancedTransactions === 0 && mismatches.length === 0 && currencies.length === 0,
      unbalancedTransactions,
      walletMismatches: mismatches.map((m) => ({
        ...m,
        balance: m.balance.toString(),
        ledgerBalance: m.ledgerBalance.toString(),
      })),
      nonZeroCurrencies: currencies.map((c) => ({ currency: c.currency, net: c.net.toString() })),
      checkedAt: new Date().toISOString(),
    };
  }
}
