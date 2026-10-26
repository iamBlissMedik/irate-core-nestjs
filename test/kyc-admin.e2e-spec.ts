import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API, bearer, TestApp, type Session } from './support/app.js';

const KYC = {
  fullName: 'Ada Okafor',
  dateOfBirth: '1994-05-17',
  address: '12 Admiralty Way, Lekki, Lagos',
  idType: 'NIN',
  idNumber: '12345678901',
};

describe('KYC & admin (e2e)', () => {
  let t: TestApp;
  let admin: Session;
  let ada: Session;

  beforeAll(async () => {
    t = await TestApp.create();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    admin = await t.admin('admin@irate.dev');
    ada = await t.customer('ada@irate.dev');
  });

  const submit = (who: Session, body: Record<string, unknown> = KYC) =>
    t.http.post(`${API}/kyc/submit`).set(bearer(who)).send(body);
  const review = (kycId: string, body: Record<string, unknown>, who: Session = admin) =>
    t.http.patch(`${API}/admin/kyc/${kycId}/review`).set(bearer(who)).send(body);

  describe('KYC', () => {
    it('submits, shows status, and is approved by an admin', async () => {
      const submitted = await submit(ada).expect(201);
      expect(submitted.body.data).toMatchObject({
        status: 'PENDING',
        dateOfBirth: '1994-05-17',
        verifiedAt: null,
      });

      await t.http.get(`${API}/kyc/status`).set(bearer(ada)).expect(200);
      const approved = await review(submitted.body.data.id, { action: 'APPROVE' }).expect(200);
      expect(approved.body.data.status).toBe('VERIFIED');
      expect(approved.body.data.verifiedAt).toBeTruthy();

      const me = await t.http.get(`${API}/users/me`).set(bearer(ada)).expect(200);
      expect(me.body.data.kycStatus).toBe('VERIFIED');
    });

    it('returns 404 KYC_NOT_FOUND before anything is submitted', async () => {
      const res = await t.http.get(`${API}/kyc/status`).set(bearer(ada)).expect(404);
      expect(res.body.code).toBe('KYC_NOT_FOUND');
    });

    it.each([
      [
        'an under-18 applicant',
        { dateOfBirth: new Date().toISOString().slice(0, 10) },
        'dateOfBirth',
      ],
      ['an impossible date', { dateOfBirth: '2001-02-30' }, 'dateOfBirth'],
      ['a NIN that is not 11 digits', { idNumber: '1234' }, 'idNumber'],
      ['an unknown id type', { idType: 'LIBRARY_CARD' }, 'idType'],
      ['a non-http document URL', { documentUrl: 'javascript:alert(1)' }, 'documentUrl'],
    ])('rejects %s', async (_name, override, field) => {
      const res = await submit(ada, { ...KYC, ...override }).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(field);
    });

    it('enforces the state machine: no resubmission while pending or verified, resubmission after rejection', async () => {
      const { body } = await submit(ada).expect(201);
      expect((await submit(ada).expect(409)).body.code).toBe('KYC_PENDING');

      const rejected = await review(body.data.id, {
        action: 'REJECT',
        reason: 'Document unreadable',
      }).expect(200);
      expect(rejected.body.data).toMatchObject({
        status: 'REJECTED',
        rejectionReason: 'Document unreadable',
      });

      const resubmitted = await submit(ada, { ...KYC, idNumber: '10987654321' }).expect(201);
      expect(resubmitted.body.data).toMatchObject({
        id: body.data.id,
        status: 'PENDING',
        rejectionReason: null,
      });

      await review(body.data.id, { action: 'APPROVE' }).expect(200);
      expect((await submit(ada).expect(409)).body.code).toBe('KYC_ALREADY_VERIFIED');
    });

    it('makes decisions final: re-reviews and concurrent reviews cannot flip the outcome', async () => {
      const { body } = await submit(ada).expect(201);
      const second = await t.admin();
      const results = await Promise.all([
        review(body.data.id, { action: 'APPROVE' }),
        review(body.data.id, { action: 'REJECT' }, second),
      ]);
      expect(results.map((r) => r.status).toSorted()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)!.body.code).toBe('KYC_ALREADY_REVIEWED');
    });

    it('stops admins reviewing their own KYC', async () => {
      const res = await submit(admin).expect(201);
      await review(res.body.data.id, { action: 'APPROVE' }).expect(403);
    });

    it('lists the queue with filtering and the user summary', async () => {
      await submit(ada).expect(201);
      const res = await t.http
        .get(`${API}/admin/kyc?status=PENDING`)
        .set(bearer(admin))
        .expect(200);
      expect(res.body.data.pagination).toMatchObject({
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      });
      expect(res.body.data.kycs[0].user).toEqual({
        id: ada.id,
        email: 'ada@irate.dev',
        role: 'USER',
      });
      await t.http.get(`${API}/admin/kyc?status=NOPE`).set(bearer(admin)).expect(400);
    });
  });

  describe('authorization', () => {
    it('keeps customers out of every admin route (403)', async () => {
      for (const path of [
        'dashboard/overview',
        'users',
        'users/stats',
        'wallets/balance',
        'kyc',
        'reconciliation',
        'me',
      ]) {
        const res = await t.http.get(`${API}/admin/${path}`).set(bearer(ada)).expect(403);
        expect(res.body.code).toBe('FORBIDDEN');
      }
    });

    it("prevents reading other customers' data (IDOR)", async () => {
      const bola = await t.customer('bola@irate.dev');
      // Someone else's wallet looks exactly like a missing one: no existence oracle.
      const balance = await t.http
        .get(`${API}/wallets/${bola.walletId}/balance`)
        .set(bearer(ada))
        .expect(404);
      expect(balance.body.code).toBe('WALLET_NOT_FOUND');
      await t.http
        .get(`${API}/transactions/${bola.walletId}/transactions`)
        .set(bearer(ada))
        .expect(404);
      await t.http.get(`${API}/users/${bola.id}`).set(bearer(ada)).expect(403);
      // Admins may read any profile; malformed ids are a validation error.
      await t.http.get(`${API}/users/${bola.id}`).set(bearer(admin)).expect(200);
      await t.http.get(`${API}/users/not-a-uuid`).set(bearer(admin)).expect(400);
    });
  });

  describe('admin credit', () => {
    const credit = (
      walletId: string,
      body: Record<string, unknown>,
      key: string = randomUUID(),
      who: Session = admin,
    ) =>
      t.http
        .post(`${API}/admin/credit/${walletId}`)
        .set(bearer(who))
        .set('Idempotency-Key', key)
        .send(body);

    it('credits through ADJUSTMENTS, appears on the statement, and keeps the books balanced', async () => {
      const res = await credit(ada.walletId, {
        amount: 500_000,
        reason: 'Goodwill: failed card refund',
      }).expect(200);
      expect(res.body.data).toMatchObject({
        walletId: ada.walletId,
        accountNumber: ada.accountNumber,
        amount: '500000',
        balance: '500000',
        currency: 'NGN',
      });
      expect(res.body.data.reference).toMatch(/^ADJ-/);

      const statement = await t.http.get(`${API}/transactions/me`).set(bearer(ada)).expect(200);
      expect(statement.body.data.transactions[0]).toMatchObject({
        kind: 'ADMIN_CREDIT',
        description: 'Goodwill: failed card refund',
        counterparty: null,
      });

      const adjustments = await t.prisma.wallet.findFirstOrThrow({
        where: { systemCode: 'ADJUSTMENTS' },
      });
      expect(adjustments.balance).toBe(-500_000n);
      expect((await t.reconciliation()).healthy).toBe(true);
      expect(
        await t.prisma.auditLog.count({ where: { action: 'ADMIN_CREDIT', actorId: admin.id } }),
      ).toBe(1);
    });

    it('is idempotent and requires a reason', async () => {
      const key = randomUUID();
      await credit(ada.walletId, { amount: 1_000, reason: 'Refund' }, key).expect(200);
      const replay = await credit(ada.walletId, { amount: 1_000, reason: 'Refund' }, key).expect(
        200,
      );
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(await t.balance(ada.walletId)).toBe(1_000n);

      await credit(ada.walletId, { amount: 1_000 }).expect(400);
      await credit(ada.walletId, { amount: 1_000, reason: '   ' }).expect(400);
    });

    it('refuses system wallets, unknown wallets and self-credit', async () => {
      const settlement = await t.prisma.wallet.findFirstOrThrow({
        where: { systemCode: 'SETTLEMENT' },
      });
      await credit(settlement.id, { amount: 1, reason: 'x' }).expect(404);
      await credit(randomUUID(), { amount: 1, reason: 'x' }).expect(404);

      const adminWallet = await t.http
        .post(`${API}/wallets`)
        .set(bearer(admin))
        .send({})
        .expect(201);
      await credit(adminWallet.body.data.id, { amount: 1, reason: 'x' }).expect(403);
    });
  });

  describe('wallet freeze', () => {
    it('freezes and unfreezes, auditing each change', async () => {
      const frozen = await t.http
        .patch(`${API}/admin/wallets/${ada.walletId}/status`)
        .set(bearer(admin))
        .send({ status: 'FROZEN', reason: 'Suspicious activity under review' })
        .expect(200);
      expect(frozen.body.data.status).toBe('FROZEN');

      const overview = await t.http.get(`${API}/users/me/overview`).set(bearer(ada)).expect(200);
      expect(overview.body.data.walletStatus).toBe('FROZEN');

      await t.http
        .patch(`${API}/admin/wallets/${ada.walletId}/status`)
        .set(bearer(admin))
        .send({ status: 'ACTIVE', reason: 'Cleared' })
        .expect(200);
      expect(await t.prisma.auditLog.count({ where: { action: 'WALLET_STATUS_CHANGED' } })).toBe(2);
    });
  });

  describe('directory & dashboard', () => {
    it('paginates and searches users, matching wildcards literally', async () => {
      await t.customer('bola@irate.dev');
      await t.customer('chi_di@irate.dev');

      const page = await t.http
        .get(`${API}/admin/users?page=1&limit=2`)
        .set(bearer(admin))
        .expect(200);
      expect(page.body.data.users).toHaveLength(2);
      expect(page.body.data.pagination).toMatchObject({
        total: 4,
        totalPages: 2,
        hasNextPage: true,
        hasPrevPage: false,
      });
      expect(page.body.data.users[0].wallets[0].balance).toBe('0');

      const bola = await t.http
        .get(`${API}/admin/users?search=BOLA`)
        .set(bearer(admin))
        .expect(200);
      expect(bola.body.data.users.map((u: { email: string }) => u.email)).toEqual([
        'bola@irate.dev',
      ]);

      // "%" and "_" are not wildcards.
      const percent = await t.http
        .get(`${API}/admin/users?search=%25`)
        .set(bearer(admin))
        .expect(200);
      expect(percent.body.data.users).toHaveLength(0);
      const underscore = await t.http
        .get(`${API}/admin/users?search=_`)
        .set(bearer(admin))
        .expect(200);
      expect(underscore.body.data.users.map((u: { email: string }) => u.email)).toEqual([
        'chi_di@irate.dev',
      ]);

      await t.http.get(`${API}/admin/users?limit=101`).set(bearer(admin)).expect(400);
    });

    it('returns the stat cards the admin app renders', async () => {
      const bola = await t.customer('bola@irate.dev');
      await t.verifyKyc(ada);
      await t.fund(ada.walletId, 1_000_000, admin);
      await t.http
        .post(`${API}/transactions/transfer`)
        .set(bearer(ada))
        .set('Idempotency-Key', randomUUID())
        .send({ toAccountNumber: bola.accountNumber, amount: 250_000 })
        .expect(200);

      const res = await t.http
        .get(`${API}/admin/dashboard/overview`)
        .set(bearer(admin))
        .expect(200);
      expect(res.body.data).toEqual({
        usersStats: { title: 'Total Users', value: 2, trend: 100, trendType: 'up' },
        walletsBalance: {
          title: 'Total Wallet Balance',
          value: '1000000',
          currency: 'NGN',
          wallets: 2,
          trend: 100,
          trendType: 'up',
        },
        // The credit and the transfer: each counted ONCE.
        transactionStats: { title: 'Total Transactions', value: 2, trend: 100, trendType: 'up' },
        totalCashflow: {
          title: 'Total Cashflow',
          value: '1000000',
          credit: '1000000',
          debit: '0',
          currency: 'NGN',
        },
        transactionVolume: {
          title: 'Transaction Volume',
          value: '1250000',
          currency: 'NGN',
          trend: 100,
          trendType: 'up',
        },
      });

      const me = await t.http.get(`${API}/admin/me`).set(bearer(admin)).expect(200);
      expect(me.body.data).toMatchObject({ email: 'admin@irate.dev', role: 'ADMIN', wallets: [] });
    });
  });
});
