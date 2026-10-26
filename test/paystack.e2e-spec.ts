import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Session, TestApp as TestAppType } from './support/app.js';

const SECRET_KEY = 'sk_test_e2e_stub_secret_key';

/** A tiny stand-in for api.paystack.co. Tests decide what "verify" answers. */
class PaystackStub {
  readonly requests: { method: string; url: string; auth?: string; body: unknown }[] = [];
  readonly verifications = new Map<string, { status: string; amount: number; currency: string }>();
  private server!: Server;

  async start(): Promise<string> {
    this.server = createServer(async (req, res) => {
      const body = await readJson(req);
      this.requests.push({
        method: req.method!,
        url: req.url!,
        auth: req.headers.authorization,
        body,
      });
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'POST' && req.url === '/transaction/initialize') {
        const { reference } = body as { reference: string };
        res.end(
          JSON.stringify({
            status: true,
            data: { authorization_url: `https://checkout.paystack.com/${reference}`, reference },
          }),
        );
        return;
      }
      const verify = /^\/transaction\/verify\/(.+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && verify) {
        const result = this.verifications.get(decodeURIComponent(verify[1]));
        res.statusCode = result ? 200 : 404;
        res.end(
          JSON.stringify(
            result
              ? { status: true, data: result }
              : { status: false, message: 'Transaction reference not found' },
          ),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    return new Promise((resolve) => this.server.close(resolve));
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => resolve(raw ? JSON.parse(raw) : undefined));
  });
}

describe('Paystack provider (e2e against a Paystack stub)', () => {
  const stub = new PaystackStub();
  let t: TestAppType;
  let ada: Session;
  let API: string;

  beforeAll(async () => {
    // Configuration is validated when the app module is imported, so set it first.
    process.env.PAYMENTS_PROVIDER = 'paystack';
    process.env.PAYSTACK_SECRET_KEY = SECRET_KEY;
    process.env.PAYSTACK_BASE_URL = await stub.start();
    const support = await import('./support/app.js');
    API = support.API;
    t = await support.TestApp.create();
    await t.reset();
    ada = await t.customer('ada@irate.dev');
  });
  afterAll(async () => {
    await t.close();
    await stub.stop();
  });

  const webhook = (body: unknown, secret = SECRET_KEY) => {
    const raw = JSON.stringify(body);
    return t.http
      .post(`${API}/webhooks/payments/paystack`)
      .set('X-Paystack-Signature', createHmac('sha512', secret).update(raw).digest('hex'))
      .set('Content-Type', 'application/json')
      .send(raw);
  };
  const chargeSuccess = (reference: string, amount = 500_000) => ({
    event: 'charge.success',
    data: {
      id: Math.floor(Math.random() * 1e9),
      status: 'success',
      reference,
      amount,
      currency: 'NGN',
    },
  });

  it('initialises the transaction with our reference and the amount in kobo', async () => {
    const res = await t.http
      .post(`${API}/payments/deposits`)
      .set('Authorization', `Bearer ${ada.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: 500_000 })
      .expect(201);

    expect(res.body.data.provider).toBe('paystack');
    expect(res.body.data.checkoutUrl).toBe(
      `https://checkout.paystack.com/${res.body.data.reference}`,
    );
    const init = stub.requests.find((r) => r.url === '/transaction/initialize')!;
    expect(init.auth).toBe(`Bearer ${SECRET_KEY}`);
    expect(init.body).toMatchObject({
      email: 'ada@irate.dev',
      amount: '500000',
      currency: 'NGN',
      reference: res.body.data.reference,
    });
  });

  it('credits only after Paystack confirms the charge, using the verified amount', async () => {
    const { body } = await t.http
      .post(`${API}/payments/deposits`)
      .set('Authorization', `Bearer ${ada.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: 300_000 })
      .expect(201);
    const reference: string = body.data.reference;
    const before = await t.balance(ada.walletId);

    // 1. A validly signed webhook Paystack can't confirm yet: 502, nothing recorded, Paystack retries.
    const unconfirmed = await webhook(chargeSuccess(reference, 300_000)).expect(502);
    expect(unconfirmed.body.code).toBe('PAYMENT_PROVIDER_ERROR');
    stub.verifications.set(reference, { status: 'abandoned', amount: 300_000, currency: 'NGN' });
    await webhook(chargeSuccess(reference, 300_000)).expect(502);
    expect(await t.balance(ada.walletId)).toBe(before);
    expect(await t.prisma.webhookEvent.count({ where: { provider: 'paystack' } })).toBe(0);

    // 2. Confirmed: credited exactly once, even when redelivered.
    stub.verifications.set(reference, { status: 'success', amount: 300_000, currency: 'NGN' });
    const event = chargeSuccess(reference, 300_000);
    await webhook(event).expect(200);
    await webhook(event).expect(200);
    expect(await t.balance(ada.walletId)).toBe(before + 300_000n);
  });

  it('trusts the VERIFIED amount over the webhook body', async () => {
    const { body } = await t.http
      .post(`${API}/payments/deposits`)
      .set('Authorization', `Bearer ${ada.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: 400_000 })
      .expect(201);
    const before = await t.balance(ada.walletId);
    // Paystack actually collected less than requested; the webhook body claims the full amount.
    stub.verifications.set(body.data.reference, {
      status: 'success',
      amount: 100,
      currency: 'NGN',
    });
    await webhook(chargeSuccess(body.data.reference, 400_000)).expect(200);

    const row = await t.prisma.deposit.findUniqueOrThrow({ where: { id: body.data.id } });
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toMatch(/amount_mismatch/);
    expect(await t.balance(ada.walletId)).toBe(before);
  });

  it('rejects forged signatures and acknowledges unrelated events', async () => {
    const forged = await webhook(chargeSuccess('DEP-ANY'), 'sk_test_wrong_key').expect(401);
    expect(forged.body.code).toBe('INVALID_SIGNATURE');
    await webhook({ event: 'transfer.success', data: { id: 1, reference: 'TRF-1' } }).expect(200);
    expect((await t.reconciliation()).healthy).toBe(true);
  });
});
