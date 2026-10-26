import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppException, ErrorCode } from '../../../common/errors/app.exception.js';
import {
  header,
  toMinor,
  type InitiateDepositInput,
  type PaymentEvent,
  type PaymentProvider,
  type WebhookHeaders,
} from './payment-provider.js';

const TOLERANCE_SECONDS = 300;

const invalidSignature = () =>
  AppException.unauthorized(ErrorCode.INVALID_SIGNATURE, 'Invalid webhook signature.');

/**
 * A local stand-in for a real provider. It signs webhooks exactly the way
 * real providers do: hex HMAC-SHA256 over `"<unix timestamp>.<raw body>"` in
 * `X-Sandbox-Signature`, with the timestamp in `X-Sandbox-Timestamp`
 * (5-minute tolerance, so a captured webhook can't be replayed later).
 *
 * Event body: `{ id, type: "payment.succeeded" | "payment.failed", data: { reference, amount, currency, failureReason? } }`.
 */
export class SandboxProvider implements PaymentProvider {
  readonly name = 'sandbox';

  constructor(
    private readonly secret: string,
    private readonly publicApiUrl: string,
  ) {}

  async initiateDeposit(input: InitiateDepositInput) {
    // There is no hosted page: settle the deposit with the simulate endpoint.
    const url = new URL('/sandbox/checkout', this.publicApiUrl);
    url.searchParams.set('reference', input.reference);
    return { checkoutUrl: url.toString() };
  }

  sign(rawBody: string, timestamp = Math.floor(Date.now() / 1000)) {
    const signature = createHmac('sha256', this.secret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
    return { timestamp: String(timestamp), signature };
  }

  parseWebhook(rawBody: Buffer, headers: WebhookHeaders): PaymentEvent {
    const timestamp = header(headers, 'x-sandbox-timestamp');
    const signature = header(headers, 'x-sandbox-signature');
    if (!timestamp || !signature || !/^\d+$/.test(timestamp)) throw invalidSignature();
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS)
      throw invalidSignature();

    const expected = createHmac('sha256', this.secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest();
    const given = Buffer.from(signature, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw invalidSignature();

    const body = parseJson(rawBody);
    const data = (body.data ?? {}) as Record<string, unknown>;
    const rawType = String(body.type ?? '');
    if (typeof body.id !== 'string' || !body.id) {
      throw AppException.badRequest(ErrorCode.BAD_REQUEST, 'Webhook event id is missing.');
    }

    return {
      eventId: body.id,
      rawType,
      type: rawType === 'payment.succeeded' || rawType === 'payment.failed' ? rawType : 'ignored',
      reference: typeof data.reference === 'string' ? data.reference : null,
      amount: toMinor(data.amount),
      currency: typeof data.currency === 'string' ? data.currency : null,
      failureReason: typeof data.failureReason === 'string' ? data.failureReason : undefined,
      payload: body,
    };
  }
}

export function parseJson(rawBody: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(rawBody.toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw AppException.badRequest(ErrorCode.BAD_REQUEST, 'Webhook body must be a JSON object.');
}
