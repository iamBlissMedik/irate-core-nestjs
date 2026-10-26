import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API, bearer, dbErrorText, TestApp, type Session } from './support/app.js';

describe('Transfers (e2e)', () => {
  let t: TestApp;
  let ada: Session;
  let bola: Session;

  beforeAll(async () => {
    t = await TestApp.create();
  });
  afterAll(() => t.close());

  beforeEach(async () => {
    await t.reset();
    ada = await t.customer('ada@irate.dev');
    bola = await t.customer('bola@irate.dev');
    await t.verifyKyc(ada, 'Ada Okafor');
    await t.verifyKyc(bola, 'Bola Adeyemi');
    await t.fund(ada.walletId, 4_800_000);
  });

  const transfer = (from: Session, body: Record<string, unknown>, key: string = randomUUID()) =>
    t.http
      .post(`${API}/transactions/transfer`)
      .set(bearer(from))
      .set('Idempotency-Key', key)
      .send(body);

  describe('happy path', () => {
    it('moves money atomically and returns the sender statement line', async () => {
      const res = await transfer(ada, {
        toAccountNumber: bola.accountNumber,
        amount: 250_000,
        note: 'Rent share',
      }).expect(200);

      expect(res.body).toMatchObject({ success: true, message: 'Transfer successful' });
      expect(res.body.data).toMatchObject({
        kind: 'TRANSFER',
        type: 'DEBIT',
        direction: 'out',
        amount: '250000',
        currency: 'NGN',
        description: `Transfer to ${bola.accountNumber}`,
        note: 'Rent share',
        counterparty: { accountNumber: bola.accountNumber, name: 'Bola Adeyemi' },
        balanceAfter: '4550000',
      });
      expect(res.body.data.reference).toMatch(/^TRF-\d{8}-[0-9A-Z]{16}$/);

      expect(await t.balance(ada.walletId)).toBe(4_550_000n);
      expect(await t.balance(bola.walletId)).toBe(250_000n);
    });

    it('shows the transfer on both statements with exact running balances', async () => {
      await transfer(ada, { toAccountNumber: bola.accountNumber, amount: 100_000 }).expect(200);

      const bolaStatement = await t.http
        .get(`${API}/transactions/me`)
        .set(bearer(bola))
        .expect(200);
      expect(bolaStatement.body.data.pagination).toMatchObject({ total: 1, page: 1 });
      expect(bolaStatement.body.data.transactions[0]).toMatchObject({
        type: 'CREDIT',
        direction: 'in',
        amount: '100000',
        balanceAfter: '100000',
        counterparty: { accountNumber: ada.accountNumber, name: 'Ada Okafor' },
      });

      const adaStatement = await t.http
        .get(`${API}/transactions/${ada.walletId}/transactions?limit=1`)
        .set(bearer(ada))
        .expect(200);
      expect(adaStatement.body.data.transactions[0]).toMatchObject({
        direction: 'out',
        balanceAfter: '4700000',
      });
      // The opening credit from ADJUSTMENTS has no customer counterparty.
      expect(adaStatement.body.data.pagination.total).toBe(2);
    });

    it('accepts the amount as an integer string', async () => {
      await transfer(ada, { toAccountNumber: bola.accountNumber, amount: '1500' }).expect(200);
      expect(await t.balance(bola.walletId)).toBe(1_500n);
    });
  });

  describe('name enquiry', () => {
    it('shows only a VERIFIED KYC name, never email or balance', async () => {
      const res = await t.http
        .get(`${API}/transactions/resolve/${bola.accountNumber}`)
        .set(bearer(ada))
        .expect(200);
      expect(res.body.data).toEqual({
        accountNumber: bola.accountNumber,
        accountName: 'Bola Adeyemi',
      });
    });

    it('falls back to the email name while KYC is unverified (no impersonation)', async () => {
      const chidi = await t.customer('chidi@irate.dev');
      await t.http
        .post(`${API}/kyc/submit`)
        .set(bearer(chidi))
        .send({
          fullName: 'Aliko Dangote',
          dateOfBirth: '1990-01-01',
          address: '1 Test Street',
          idType: 'PASSPORT',
          idNumber: 'A7654321',
        })
        .expect(201);
      const res = await t.http
        .get(`${API}/transactions/resolve/${chidi.accountNumber}`)
        .set(bearer(ada))
        .expect(200);
      expect(res.body.data.accountName).toBe('Chidi');
    });

    it('does not resolve system accounts or unknown numbers', async () => {
      await t.http.get(`${API}/transactions/resolve/0000000001`).set(bearer(ada)).expect(404);
      const res = await t.http
        .get(`${API}/transactions/resolve/9999999999`)
        .set(bearer(ada))
        .expect(404);
      expect(res.body.code).toBe('RECIPIENT_NOT_FOUND');
      await t.http.get(`${API}/transactions/resolve/12345`).set(bearer(ada)).expect(400);
    });
  });

  describe('business rules', () => {
    it.each([
      ['insufficient funds', { amount: 4_800_001 }, 422, 'INSUFFICIENT_FUNDS'],
      ['over the per-transaction cap', { amount: 1_000_000_001 }, 422, 'AMOUNT_TOO_LARGE'],
      ['a decimal amount', { amount: 10.5 }, 400, 'VALIDATION_ERROR'],
      ['a negative amount', { amount: -100 }, 400, 'VALIDATION_ERROR'],
      ['zero', { amount: 0 }, 400, 'VALIDATION_ERROR'],
      ['an exponent string', { amount: '1e5' }, 400, 'VALIDATION_ERROR'],
      // oxlint-disable-next-line no-loss-of-precision -- deliberately unsafe: the API must reject it
      ['an unsafe integer', { amount: 9_007_199_254_740_993 }, 400, 'VALIDATION_ERROR'],
      ['an unknown field', { amount: 100, ammount: 100 }, 400, 'VALIDATION_ERROR'],
    ])('rejects %s', async (_name, body, status, code) => {
      const res = await transfer(ada, { toAccountNumber: bola.accountNumber, ...body }).expect(
        status,
      );
      expect(res.body.code).toBe(code);
      expect(await t.balance(ada.walletId)).toBe(4_800_000n);
    });

    it('rejects transfers to yourself and to unknown or system accounts', async () => {
      expect(
        (await transfer(ada, { toAccountNumber: ada.accountNumber, amount: 100 }).expect(422)).body
          .code,
      ).toBe('SELF_TRANSFER');
      expect(
        (await transfer(ada, { toAccountNumber: '9999999999', amount: 100 }).expect(404)).body.code,
      ).toBe('RECIPIENT_NOT_FOUND');
      expect(
        (await transfer(ada, { toAccountNumber: '0000000001', amount: 100 }).expect(404)).body.code,
      ).toBe('RECIPIENT_NOT_FOUND');
    });

    it('rejects control characters in the note', async () => {
      const res = await transfer(ada, {
        toAccountNumber: bola.accountNumber,
        amount: 100,
        note: 'hi\u0000there',
      }).expect(400);
      expect(res.body.errors[0].field).toBe('note');
    });

    it('blocks debits from a frozen wallet but still lets it receive', async () => {
      await t.prisma.wallet.update({ where: { id: ada.walletId }, data: { status: 'FROZEN' } });
      const res = await transfer(ada, { toAccountNumber: bola.accountNumber, amount: 100 }).expect(
        422,
      );
      expect(res.body.code).toBe('WALLET_FROZEN');

      await t.fund(bola.walletId, 1_000);
      await transfer(bola, { toAccountNumber: ada.accountNumber, amount: 500 }).expect(200);
      expect(await t.balance(ada.walletId)).toBe(4_800_500n);
    });

    it('caps unverified customers per day (NGN 50,000 by default)', async () => {
      const chidi = await t.customer('chidi@irate.dev'); // no KYC
      await t.fund(chidi.walletId, 10_000_000);

      await transfer(chidi, { toAccountNumber: bola.accountNumber, amount: 3_000_000 }).expect(200);
      await transfer(chidi, { toAccountNumber: bola.accountNumber, amount: 2_000_000 }).expect(200);
      const res = await transfer(chidi, { toAccountNumber: bola.accountNumber, amount: 1 }).expect(
        422,
      );
      expect(res.body.code).toBe('DAILY_LIMIT_EXCEEDED');

      // Verified customers are not capped.
      await transfer(ada, { toAccountNumber: bola.accountNumber, amount: 4_000_000 }).expect(200);
    });

    it('requires authentication', async () => {
      const res = await t.http
        .post(`${API}/transactions/transfer`)
        .send({ toAccountNumber: bola.accountNumber, amount: 1 })
        .expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });
  });

  describe('idempotency', () => {
    it('requires a well-formed Idempotency-Key', async () => {
      const missing = await t.http
        .post(`${API}/transactions/transfer`)
        .set(bearer(ada))
        .send({ toAccountNumber: bola.accountNumber, amount: 100 })
        .expect(400);
      expect(missing.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      await transfer(ada, { toAccountNumber: bola.accountNumber, amount: 100 }, 'short').expect(
        400,
      );
    });

    it('replays a retry with the same key without moving money again', async () => {
      const key = randomUUID();
      const body = { toAccountNumber: bola.accountNumber, amount: 250_000 };
      const first = await transfer(ada, body, key).expect(200);
      const retry = await transfer(ada, body, key).expect(200);

      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(retry.body.data).toEqual(first.body.data);
      expect(await t.balance(ada.walletId)).toBe(4_550_000n);
    });

    it('rejects the same key with a different body', async () => {
      const key = randomUUID();
      await transfer(ada, { toAccountNumber: bola.accountNumber, amount: 100 }, key).expect(200);
      const res = await transfer(
        ada,
        { toAccountNumber: bola.accountNumber, amount: 200 },
        key,
      ).expect(422);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('does not store failures, so a failed request can be retried with the same key', async () => {
      const key = randomUUID();
      await transfer(ada, { toAccountNumber: bola.accountNumber, amount: 5_000_000 }, key).expect(
        422,
      );
      await t.fund(ada.walletId, 1_000_000);
      await transfer(ada, { toAccountNumber: bola.accountNumber, amount: 5_000_000 }, key).expect(
        200,
      );
    });

    it('scopes keys per user: one customer can never replay another one’s response', async () => {
      await t.fund(bola.walletId, 1_000);
      const key = randomUUID();
      await transfer(ada, { toAccountNumber: bola.accountNumber, amount: 100 }, key).expect(200);
      const res = await transfer(
        bola,
        { toAccountNumber: ada.accountNumber, amount: 100 },
        key,
      ).expect(200);
      expect(res.headers['idempotent-replayed']).toBeUndefined();
      expect(res.body.data.direction).toBe('out');
      expect(res.body.data.counterparty.accountNumber).toBe(ada.accountNumber);
    });

    it('20 concurrent requests with one key move money exactly once', async () => {
      const key = randomUUID();
      const body = { toAccountNumber: bola.accountNumber, amount: 10_000 };
      const results = await Promise.all(Array.from({ length: 20 }, () => transfer(ada, body, key)));

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
      expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(19);
      expect(await t.balance(bola.walletId)).toBe(10_000n);
    });
  });

  describe('concurrency', () => {
    it('50 concurrent transfers against a balance that covers 20: exactly 20 succeed, never overdrawn', async () => {
      await t.reset();
      ada = await t.customer('ada@irate.dev');
      bola = await t.customer('bola@irate.dev');
      await t.verifyKyc(ada);
      await t.fund(ada.walletId, 20 * 1_000);

      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          transfer(ada, { toAccountNumber: bola.accountNumber, amount: 1_000 }),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(20);
      expect(statuses.filter((s) => s === 422)).toHaveLength(30);
      expect(
        results.filter((r) => r.status === 422).every((r) => r.body.code === 'INSUFFICIENT_FUNDS'),
      ).toBe(true);

      expect(await t.balance(ada.walletId)).toBe(0n);
      expect(await t.balance(bola.walletId)).toBe(20_000n);

      // Every successful sender line has a distinct, exact running balance.
      const balances = results
        .filter((r) => r.status === 200)
        .map((r) => Number(r.body.data.balanceAfter));
      expect(balances.toSorted((a, b) => a - b)).toEqual(
        Array.from({ length: 20 }, (_, i) => i * 1_000),
      );
      expect((await t.reconciliation()).healthy).toBe(true);
    });

    it('opposite-direction transfers between the same wallets never deadlock and conserve money', async () => {
      await t.fund(bola.walletId, 4_800_000);
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          i % 2 === 0
            ? transfer(ada, { toAccountNumber: bola.accountNumber, amount: 7_000 })
            : transfer(bola, { toAccountNumber: ada.accountNumber, amount: 3_000 }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(40).fill(200));

      // 20 x 7,000 out of Ada, 20 x 3,000 back in.
      expect(await t.balance(ada.walletId)).toBe(4_800_000n - 140_000n + 60_000n);
      expect(await t.balance(bola.walletId)).toBe(4_800_000n + 140_000n - 60_000n);
      expect((await t.reconciliation()).healthy).toBe(true);
    });
  });

  describe('ledger invariants (database level)', () => {
    it('rejects edits and deletes of ledger entries', async () => {
      await transfer(ada, { toAccountNumber: bola.accountNumber, amount: 100 }).expect(200);
      const update = await t.prisma.ledgerEntry
        .updateMany({ data: { description: 'tampered' } })
        .catch((e: unknown) => e);
      const remove = await t.prisma.ledgerEntry.deleteMany({}).catch((e: unknown) => e);
      expect(dbErrorText(update)).toMatch(/append-only \(attempted UPDATE\)/);
      expect(dbErrorText(remove)).toMatch(/append-only \(attempted DELETE\)/);
    });

    it('rejects a customer balance below zero even if application code tried', async () => {
      const err = await t.prisma.wallet
        .update({ where: { id: bola.walletId }, data: { balance: -1n } })
        .catch((e: unknown) => e);
      expect(dbErrorText(err)).toMatch(/wallets_user_balance_non_negative/);
    });
  });
});
