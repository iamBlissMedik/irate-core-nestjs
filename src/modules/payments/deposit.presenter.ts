import type { Deposit } from '../../generated/prisma/client.js';

export function toDepositView(deposit: Deposit) {
  return {
    id: deposit.id,
    reference: deposit.reference,
    provider: deposit.provider,
    amount: deposit.amount.toString(),
    currency: deposit.currency,
    status: deposit.status,
    checkoutUrl: deposit.checkoutUrl,
    failureReason: deposit.failureReason,
    transactionId: deposit.transactionId,
    createdAt: deposit.createdAt.toISOString(),
    completedAt: deposit.completedAt?.toISOString() ?? null,
  };
}

export type DepositView = ReturnType<typeof toDepositView>;
