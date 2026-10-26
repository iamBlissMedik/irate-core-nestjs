import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '../../infra/prisma/prisma.service.js';
import { LedgerService, type LockedWallet, type PostingInput } from './ledger.service.js';

const wallet = (id: string, balance: bigint, kind: 'USER' | 'SYSTEM' = 'USER'): LockedWallet => ({
  id,
  userId: kind === 'USER' ? `u-${id}` : null,
  kind,
  systemCode: kind === 'SYSTEM' ? 'SETTLEMENT' : null,
  status: 'ACTIVE',
  accountNumber: '1000000001',
  currency: 'NGN',
  balance,
});

function fakeTx() {
  const tx = {
    transaction: {
      create: vi.fn<(args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>>(
        async ({ data }) => ({ id: 'tx-1', ...data }),
      ),
    },
    wallet: { update: vi.fn<(args: unknown) => Promise<unknown>>(async () => ({})) },
    ledgerEntry: {
      createManyAndReturn: vi.fn<
        (args: { data: Record<string, unknown>[] }) => Promise<Record<string, unknown>[]>
      >(async ({ data }) => data),
    },
  };
  return tx;
}

const input = (overrides: Partial<PostingInput> = {}): PostingInput => ({
  kind: 'TRANSFER',
  reference: 'TRF-1',
  amount: 300n,
  currency: 'NGN',
  description: 'test',
  legs: [
    { walletId: 'a', direction: 'DEBIT', description: 'out' },
    { walletId: 'b', direction: 'CREDIT', description: 'in' },
  ],
  ...overrides,
});

describe('LedgerService.post', () => {
  const ledger = new LedgerService();

  it('records exact before/after balances and updates the locked view', async () => {
    const tx = fakeTx();
    const locked = new Map([
      ['a', wallet('a', 1_000n)],
      ['b', wallet('b', 50n)],
    ]);
    const { entries } = await ledger.post(tx as unknown as Tx, locked, input());

    expect(entries).toMatchObject([
      { walletId: 'a', direction: 'DEBIT', balanceBefore: 1_000n, balanceAfter: 700n },
      { walletId: 'b', direction: 'CREDIT', balanceBefore: 50n, balanceAfter: 350n },
    ]);
    expect(locked.get('a')!.balance).toBe(700n);
    expect(tx.wallet.update).toHaveBeenCalledWith({ where: { id: 'a' }, data: { balance: 700n } });
  });

  it('lets SYSTEM accounts go negative but never a customer', async () => {
    const system = new Map([
      ['a', wallet('a', 0n, 'SYSTEM')],
      ['b', wallet('b', 0n)],
    ]);
    await expect(ledger.post(fakeTx() as unknown as Tx, system, input())).resolves.toBeDefined();

    const customer = new Map([
      ['a', wallet('a', 299n)],
      ['b', wallet('b', 0n)],
    ]);
    await expect(ledger.post(fakeTx() as unknown as Tx, customer, input())).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
    });
  });

  it.each([
    [
      'unbalanced legs',
      input({
        legs: [
          { walletId: 'a', direction: 'DEBIT', description: '' },
          { walletId: 'b', direction: 'DEBIT', description: '' },
        ],
      }),
    ],
    ['a single leg', input({ legs: [{ walletId: 'a', direction: 'DEBIT', description: '' }] })],
    ['a non-positive amount', input({ amount: 0n })],
    [
      'an unlocked wallet',
      input({
        legs: [
          { walletId: 'a', direction: 'DEBIT', description: '' },
          { walletId: 'zzz', direction: 'CREDIT', description: '' },
        ],
      }),
    ],
    ['a currency mismatch', input({ currency: 'USD' })],
  ])('refuses %s before touching the database', async (_name, bad) => {
    const tx = fakeTx();
    const locked = new Map([
      ['a', wallet('a', 1_000n)],
      ['b', wallet('b', 0n)],
    ]);
    await expect(ledger.post(tx as unknown as Tx, locked, bad)).rejects.toThrow(/Invalid posting/);
    expect(tx.transaction.create).not.toHaveBeenCalled();
  });
});
