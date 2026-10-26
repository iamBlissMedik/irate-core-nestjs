import type { Wallet } from '../../generated/prisma/client.js';

/** Public wallet shape. Money is a minor-unit STRING (JSON has no BigInt). */
export interface WalletView {
  id: string;
  userId: string;
  accountNumber: string;
  balance: string;
  currency: string;
  status: Wallet['status'];
  createdAt: string;
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    userId: wallet.userId ?? '',
    accountNumber: wallet.accountNumber,
    balance: wallet.balance.toString(),
    currency: wallet.currency,
    status: wallet.status,
    createdAt: wallet.createdAt.toISOString(),
  };
}
