import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service.js';

/**
 * The platform's own ledger accounts, one per code per currency:
 * - SETTLEMENT: the other side of money arriving from a payment provider.
 *   Its balance is minus the money customers have deposited.
 * - ADJUSTMENTS: the other side of manual admin credits (goodwill, corrections).
 *
 * Because every posting has one of these (or another customer) on the other
 * side, all wallet balances in a currency always sum to exactly zero.
 */
export const SystemWalletCode = {
  SETTLEMENT: 'SETTLEMENT',
  ADJUSTMENTS: 'ADJUSTMENTS',
} as const;

export type SystemWalletCode = (typeof SystemWalletCode)[keyof typeof SystemWalletCode];

const CODES = Object.values(SystemWalletCode);

@Injectable()
export class SystemWalletsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SystemWalletsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensure();
  }

  /**
   * Create any missing system wallets. Idempotent and safe to run from several
   * instances at once (INSERT ... ON CONFLICT DO NOTHING). System account
   * numbers live in the 00000xxxxx range, which customers can never get.
   */
  async ensure(): Promise<void> {
    const currencies = this.config.get('SUPPORTED_CURRENCIES', { infer: true });
    const data = currencies.flatMap((currency, currencyIndex) =>
      CODES.map((systemCode, codeIndex) => ({
        kind: 'SYSTEM' as const,
        systemCode,
        currency,
        accountNumber: String(currencyIndex * 100 + codeIndex + 1).padStart(10, '0'),
      })),
    );
    await this.prisma.wallet.createMany({ data, skipDuplicates: true });

    // skipDuplicates also swallows an account-number clash (e.g. after the
    // currency list was reordered), so verify every account really exists.
    const found = await this.prisma.wallet.count({
      where: { kind: 'SYSTEM', systemCode: { in: CODES }, currency: { in: currencies } },
    });
    if (found !== data.length) {
      throw new Error(
        `Expected ${data.length} system wallets but found ${found}. Check SUPPORTED_CURRENCIES ordering.`,
      );
    }
    this.logger.log(`System wallets ready for ${currencies.join(', ')}`);
  }

  async idFor(tx: Tx, code: SystemWalletCode, currency: string): Promise<string> {
    const wallet = await tx.wallet.findUnique({
      where: { systemCode_currency: { systemCode: code, currency } },
      select: { id: true },
    });
    if (!wallet) throw new Error(`System wallet ${code}/${currency} is missing`);
    return wallet.id;
  }
}
