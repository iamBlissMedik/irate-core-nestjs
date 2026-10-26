import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, ErrorCode } from '../../common/errors/app.exception.js';
import type {
  EntryDirection,
  TransactionKind,
  WalletKind,
  WalletStatus,
} from '../../generated/prisma/enums.js';
import type { LedgerEntry, Transaction } from '../../generated/prisma/client.js';
import { applyLockTimeout, type Tx } from '../../infra/prisma/prisma.service.js';

export interface LockedWallet {
  id: string;
  userId: string | null;
  kind: WalletKind;
  systemCode: string | null;
  status: WalletStatus;
  accountNumber: string;
  currency: string;
  balance: bigint;
}

export interface PostingLeg {
  walletId: string;
  direction: EntryDirection;
  /** Statement text from this wallet's point of view ("Transfer to 1000000002"). */
  description: string;
  counterpartyWalletId?: string | null;
}

export interface PostingInput {
  kind: TransactionKind;
  reference: string;
  /** Minor units moved by EACH leg (two-legged journals). */
  amount: bigint;
  currency: string;
  description: string;
  note?: string | null;
  initiatedById?: string | null;
  metadata?: Record<string, string>;
  legs: PostingLeg[];
}

export interface Posting {
  transaction: Transaction;
  entries: LedgerEntry[];
}

/**
 * The ONLY place money moves.
 *
 * Usage, always inside one database transaction:
 *   1. `lockWallets(tx, ids)`: `SELECT ... FOR UPDATE` in a fixed (id) order, so
 *      concurrent postings serialise per wallet and can never deadlock.
 *   2. Check business rules against the LOCKED balances (they cannot change
 *      underneath you now).
 *   3. `post(tx, locked, input)`: writes the journal header, updates balances
 *      and appends one ledger entry per leg with exact before/after balances.
 *
 * Postgres re-checks the result: user balances can't go negative, every entry's
 * balance math must hold, entries are append-only, and each journal must net to
 * zero at COMMIT (see the ledger_invariants migration).
 */
/** A programming error in a caller (never a client error): surfaces as a 500. */
const invalidPosting = (why: string) =>
  new AppException(
    HttpStatus.INTERNAL_SERVER_ERROR,
    ErrorCode.INTERNAL_ERROR,
    `Invalid posting: ${why}`,
  );

@Injectable()
export class LedgerService {
  async lockWallets(tx: Tx, walletIds: string[]): Promise<Map<string, LockedWallet>> {
    const ids = [...new Set(walletIds)];
    await applyLockTimeout(tx);

    const rows = await tx.$queryRaw<LockedWallet[]>`
      SELECT id, user_id AS "userId", kind, system_code AS "systemCode", status,
             account_number AS "accountNumber", currency, balance
        FROM wallets
       WHERE id = ANY(${ids}::uuid[])
       ORDER BY id
         FOR UPDATE`;

    if (rows.length !== ids.length) {
      throw AppException.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet not found.');
    }
    return new Map(rows.map((row) => [row.id, row]));
  }

  async post(tx: Tx, locked: Map<string, LockedWallet>, input: PostingInput): Promise<Posting> {
    this.assertValid(locked, input);

    const transaction = await tx.transaction.create({
      data: {
        reference: input.reference,
        kind: input.kind,
        amount: input.amount,
        currency: input.currency,
        description: input.description,
        note: input.note ?? null,
        initiatedById: input.initiatedById ?? null,
        metadata: input.metadata ?? {},
      },
    });

    const rows = [];
    for (const leg of input.legs) {
      const wallet = locked.get(leg.walletId)!;
      const balanceBefore = wallet.balance;
      const balanceAfter =
        leg.direction === 'CREDIT' ? balanceBefore + input.amount : balanceBefore - input.amount;

      if (wallet.kind === 'USER' && balanceAfter < 0n) {
        // Callers check this first with a friendlier message; this is the safety net.
        throw AppException.unprocessable(ErrorCode.INSUFFICIENT_FUNDS, 'Insufficient balance.');
      }

      await tx.wallet.update({ where: { id: wallet.id }, data: { balance: balanceAfter } });
      wallet.balance = balanceAfter; // keep the caller's view in sync

      rows.push({
        transactionId: transaction.id,
        walletId: wallet.id,
        direction: leg.direction,
        amount: input.amount,
        balanceBefore,
        balanceAfter,
        description: leg.description,
        counterpartyWalletId: leg.counterpartyWalletId ?? null,
      });
    }

    const entries = await tx.ledgerEntry.createManyAndReturn({ data: rows });
    return { transaction, entries };
  }

  private assertValid(locked: Map<string, LockedWallet>, input: PostingInput): void {
    if (input.amount <= 0n) throw invalidPosting('amount must be positive');
    if (input.legs.length < 2) throw invalidPosting('a journal needs at least two legs');

    let net = 0n;
    for (const leg of input.legs) {
      const wallet = locked.get(leg.walletId);
      if (!wallet) throw invalidPosting(`wallet ${leg.walletId} is not locked`);
      if (wallet.currency !== input.currency)
        throw invalidPosting('currency mismatch between legs');
      net += leg.direction === 'CREDIT' ? input.amount : -input.amount;
    }
    if (net !== 0n) throw invalidPosting('debits and credits do not balance');
  }
}
