import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AppException } from '../../../common/errors/app.exception.js';
import { PaystackProvider } from './paystack.provider.js';
import { SandboxProvider } from './sandbox.provider.js';

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as AppException).code;
  }
  return undefined;
};

describe('SandboxProvider', () => {
  const sandbox = new SandboxProvider('s'.repeat(40), 'http://localhost:8000');
  const body = JSON.stringify({
    id: 'evt_1',
    type: 'payment.succeeded',
    data: { reference: 'DEP-1', amount: 500, currency: 'NGN' },
  });

  it('accepts its own signature and normalises the event', () => {
    const { timestamp, signature } = sandbox.sign(body);
    const event = sandbox.parseWebhook(Buffer.from(body), {
      'x-sandbox-timestamp': timestamp,
      'x-sandbox-signature': signature,
    });
    expect(event).toMatchObject({
      eventId: 'evt_1',
      type: 'payment.succeeded',
      reference: 'DEP-1',
      amount: 500n,
      currency: 'NGN',
    });
  });

  it('rejects missing, wrong, malformed and stale signatures', () => {
    const { timestamp, signature } = sandbox.sign(body);
    const stale = sandbox.sign(body, Math.floor(Date.now() / 1000) - 301);
    const parse =
      (headers: Record<string, string>, raw = body) =>
      () =>
        sandbox.parseWebhook(Buffer.from(raw), headers);

    expect(codeOf(parse({}))).toBe('INVALID_SIGNATURE');
    expect(codeOf(parse({ 'x-sandbox-timestamp': timestamp, 'x-sandbox-signature': 'zz' }))).toBe(
      'INVALID_SIGNATURE',
    );
    expect(
      codeOf(
        parse(
          { 'x-sandbox-timestamp': timestamp, 'x-sandbox-signature': signature },
          body.replace('500', '900'),
        ),
      ),
    ).toBe('INVALID_SIGNATURE');
    expect(
      codeOf(
        parse({ 'x-sandbox-timestamp': stale.timestamp, 'x-sandbox-signature': stale.signature }),
      ),
    ).toBe('INVALID_SIGNATURE');
  });

  it('never trusts non-integer amounts', () => {
    const raw = JSON.stringify({
      id: 'e',
      type: 'payment.succeeded',
      data: { reference: 'R', amount: 1.5, currency: 'NGN' },
    });
    const { timestamp, signature } = sandbox.sign(raw);
    expect(
      sandbox.parseWebhook(Buffer.from(raw), {
        'x-sandbox-timestamp': timestamp,
        'x-sandbox-signature': signature,
      }).amount,
    ).toBeNull();
  });
});

describe('PaystackProvider', () => {
  beforeAll(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  const key = 'sk_test_unit_key';
  const json = (status: number, payload: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

  it('initialises with bearer auth, our reference and the amount in kobo', async () => {
    const fetchFn = vi.fn<() => Promise<Response>>(() =>
      json(200, { status: true, data: { authorization_url: 'https://checkout/x' } }),
    );
    const provider = new PaystackProvider(
      key,
      'https://api.paystack.co/',
      'https://app/cb',
      fetchFn as unknown as typeof fetch,
    );

    const result = await provider.initiateDeposit({
      reference: 'DEP-1',
      amount: 500_000n,
      currency: 'NGN',
      email: 'a@b.co',
    });

    expect(result.checkoutUrl).toBe('https://checkout/x');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.paystack.co/transaction/initialize');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${key}`);
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'a@b.co',
      amount: '500000',
      currency: 'NGN',
      reference: 'DEP-1',
      callback_url: 'https://app/cb',
    });
  });

  it('maps verification results and surfaces provider errors as 502', async () => {
    const ok = new PaystackProvider(key, 'https://x', undefined, (() =>
      json(200, {
        status: true,
        data: { status: 'success', amount: 100, currency: 'ngn' },
      })) as unknown as typeof fetch);
    expect(await ok.verify('DEP/1')).toEqual({
      status: 'succeeded',
      amount: 100n,
      currency: 'NGN',
    });

    const rejected = new PaystackProvider(key, 'https://x', undefined, (() =>
      json(400, { status: false, message: 'Invalid key' })) as unknown as typeof fetch);
    await expect(rejected.verify('DEP-1')).rejects.toMatchObject({
      status: 502,
      code: 'PAYMENT_PROVIDER_ERROR',
    });

    const down = new PaystackProvider(key, 'https://x', undefined, (() =>
      Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch);
    await expect(
      down.initiateDeposit({ reference: 'R', amount: 1n, currency: 'NGN', email: 'a@b.co' }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('verifies the HMAC-SHA512 signature and only treats successful charges as payments', () => {
    const provider = new PaystackProvider(key, 'https://x');
    const sign = (raw: string) => ({
      'x-paystack-signature': createHmac('sha512', key).update(raw).digest('hex'),
    });

    const success = JSON.stringify({
      event: 'charge.success',
      data: { id: 7, status: 'success', reference: 'DEP-1', amount: 500, currency: 'NGN' },
    });
    expect(provider.parseWebhook(Buffer.from(success), sign(success))).toMatchObject({
      eventId: 'charge.success:7',
      type: 'payment.succeeded',
      amount: 500n,
    });

    const refund = JSON.stringify({ event: 'refund.processed', data: { id: 8 } });
    expect(provider.parseWebhook(Buffer.from(refund), sign(refund)).type).toBe('ignored');

    expect(
      codeOf(() => provider.parseWebhook(Buffer.from(success), { 'x-paystack-signature': 'ab' })),
    ).toBe('INVALID_SIGNATURE');
  });
});
