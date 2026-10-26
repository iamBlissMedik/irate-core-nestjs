import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API, bearer, TestApp, type Session } from './support/app.js';

const SECRET = 'e2e-test-sandbox-secret-0123456789-abcdefghij';

/** Sign a sandbox webhook the way the provider would. */
function signed(
  body: unknown,
  { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {},
) {
  const raw = JSON.stringify(body);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return {
    raw,
    headers: { 'X-Sandbox-Timestamp': String(timestamp), 'X-Sandbox-Signature': signature },
  };
}

describe('Payments (e2e)', () => {
  let t: TestApp;
  let ada: Session;

  beforeAll(async () => {
    t = await TestApp.create();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    ada = await t.customer('ada@irate.dev');
  });

  const deposit = (amount: unknown, key: string = randomUUID()) =>
    t.http
      .post(`${API}/payments/deposits`)
      .set(bearer(ada))
      .set('Idempotency-Key', key)
      .send({ amount });

  const webhook = (body: unknown, opts?: Parameters<typeof signed>[1]) => {
    const { raw, headers } = signed(body, opts);
    return t.http
      .post(`${API}/webhooks/payments/sandbox`)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(raw);
  };

  const succeeded = (reference: string, amount = 500_000, id = `evt_${randomUUID()}`) => ({
    id,
    type: 'payment.succeeded',
    data: { reference, amount, currency: 'NGN' },
  });

  it('initiates a PENDING deposit with a checkout URL; no money moves yet', async () => {
    const res = await deposit(500_000).expect(201);
    expect(res.body.data).toMatchObject({
      provider: 'sandbox',
      amount: '500000',
      currency: 'NGN',
      status: 'PENDING',
      transactionId: null,
      completedAt: null,
    });
    expect(res.body.data.reference).toMatch(/^DEP-/);
    expect(res.body.data.checkoutUrl).toContain(res.body.data.reference);
    expect(await t.balance(ada.walletId)).toBe(0n);
  });

  it('maps one Idempotency-Key to one deposit', async () => {
    const key = randomUUID();
    const first = await deposit(500_000, key).expect(201);
    const retry = await deposit(500_000, key).expect(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.data.id).toBe(first.body.data.id);

    const reused = await deposit(600_000, key).expect(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('credits the wallet once on a verified success webhook, balanced against SETTLEMENT', async () => {
    const { body } = await deposit(500_000).expect(201);
    const res = await webhook(succeeded(body.data.reference)).expect(200);
    expect(res.body).toEqual({ success: true, message: 'Webhook processed', data: null });

    expect(await t.balance(ada.walletId)).toBe(500_000n);
    const settlement = await t.prisma.wallet.findFirstOrThrow({
      where: { systemCode: 'SETTLEMENT' },
    });
    expect(settlement.balance).toBe(-500_000n);

    const status = await t.http
      .get(`${API}/payments/deposits/${body.data.id}`)
      .set(bearer(ada))
      .expect(200);
    expect(status.body.data.status).toBe('SUCCEEDED');
    expect(status.body.data.transactionId).toBeTruthy();

    const statement = await t.http.get(`${API}/transactions/me`).set(bearer(ada)).expect(200);
    expect(statement.body.data.transactions[0]).toMatchObject({
      kind: 'DEPOSIT',
      direction: 'in',
      reference: body.data.reference,
    });
    expect((await t.reconciliation()).healthy).toBe(true);
  });

  it('ignores redelivery of the same event and duplicate success events', async () => {
    const { body } = await deposit(500_000).expect(201);
    const event = succeeded(body.data.reference);
    await webhook(event).expect(200);
    await webhook(event).expect(200); // same event id
    await webhook(succeeded(body.data.reference)).expect(200); // different event, same deposit
    expect(await t.balance(ada.walletId)).toBe(500_000n);
    expect(await t.prisma.webhookEvent.count()).toBe(2);
  });

  it('credits once under 20 concurrent deliveries', async () => {
    const { body } = await deposit(500_000).expect(201);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => webhook(succeeded(body.data.reference))),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await t.balance(ada.walletId)).toBe(500_000n);
    expect(await t.prisma.transaction.count({ where: { kind: 'DEPOSIT' } })).toBe(1);
  });

  it('flags an amount mismatch instead of crediting', async () => {
    const { body } = await deposit(500_000).expect(201);
    await webhook(succeeded(body.data.reference, 100)).expect(200);

    const row = await t.prisma.deposit.findUniqueOrThrow({ where: { id: body.data.id } });
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toMatch(/^amount_mismatch/);
    expect(await t.balance(ada.walletId)).toBe(0n);
    expect(await t.prisma.auditLog.count({ where: { action: 'DEPOSIT_AMOUNT_MISMATCH' } })).toBe(1);
  });

  it('marks failures, and still credits a late success (the money really arrived)', async () => {
    const { body } = await deposit(500_000).expect(201);
    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'payment.failed',
      data: { reference: body.data.reference, failureReason: 'Insufficient funds' },
    }).expect(200);
    expect((await t.prisma.deposit.findUniqueOrThrow({ where: { id: body.data.id } })).status).toBe(
      'FAILED',
    );

    await webhook(succeeded(body.data.reference)).expect(200);
    expect(await t.balance(ada.walletId)).toBe(500_000n);

    // ...but success is terminal: a later failure changes nothing.
    await webhook({
      id: `evt_${randomUUID()}`,
      type: 'payment.failed',
      data: { reference: body.data.reference },
    }).expect(200);
    expect((await t.prisma.deposit.findUniqueOrThrow({ where: { id: body.data.id } })).status).toBe(
      'SUCCEEDED',
    );
  });

  it.each([
    ['a wrong secret', { secret: 'not-the-real-secret-not-the-real-secret' }],
    ['a stale timestamp (replay)', { timestamp: Math.floor(Date.now() / 1000) - 3_600 }],
  ])('rejects %s with 401 INVALID_SIGNATURE', async (_name, opts) => {
    const { body } = await deposit(500_000).expect(201);
    const res = await webhook(succeeded(body.data.reference), opts).expect(401);
    expect(res.body.code).toBe('INVALID_SIGNATURE');
    expect(await t.balance(ada.walletId)).toBe(0n);
  });

  it('rejects a body altered after signing', async () => {
    const { body } = await deposit(500_000).expect(201);
    const { raw, headers } = signed(succeeded(body.data.reference));
    await t.http
      .post(`${API}/webhooks/payments/sandbox`)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(raw.replace('500000', '900000'))
      .expect(401);
  });

  it('acknowledges unknown references and event types, and 404s unknown providers', async () => {
    await webhook(succeeded('DEP-UNKNOWN')).expect(200);
    await webhook({ id: `evt_${randomUUID()}`, type: 'customer.updated', data: {} }).expect(200);
    await t.http.post(`${API}/webhooks/payments/stripe`).send({}).expect(404);
  });

  it('runs the simulate endpoint through the real webhook path', async () => {
    const { body } = await deposit(250_000).expect(201);
    const res = await t.http
      .post(`${API}/payments/sandbox/deposits/${body.data.id}/simulate`)
      .set(bearer(ada))
      .send({ outcome: 'success' })
      .expect(200);
    expect(res.body.data.status).toBe('SUCCEEDED');
    expect(await t.balance(ada.walletId)).toBe(250_000n);

    const list = await t.http.get(`${API}/payments/deposits`).set(bearer(ada)).expect(200);
    expect(list.body.data.pagination.total).toBe(1);

    // Another customer can't see or settle it.
    const bola = await t.customer('bola@irate.dev');
    await t.http.get(`${API}/payments/deposits/${body.data.id}`).set(bearer(bola)).expect(404);
    await t.http
      .post(`${API}/payments/sandbox/deposits/${body.data.id}/simulate`)
      .set(bearer(bola))
      .send({ outcome: 'success' })
      .expect(404);
  });

  it('lets deposited money be spent', async () => {
    const bola = await t.customer('bola@irate.dev');
    await t.verifyKyc(ada);
    const { body } = await deposit(500_000).expect(201);
    await webhook(succeeded(body.data.reference)).expect(200);
    await t.http
      .post(`${API}/transactions/transfer`)
      .set(bearer(ada))
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountNumber: bola.accountNumber, amount: 500_000 })
      .expect(200);
    expect((await t.reconciliation()).healthy).toBe(true);
  });
});
