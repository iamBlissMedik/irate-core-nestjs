import { HttpStatus, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppException, ErrorCode } from '../../../common/errors/app.exception.js';
import {
  header,
  toMinor,
  type InitiateDepositInput,
  type PaymentEvent,
  type PaymentProvider,
  type VerifiedPayment,
  type WebhookHeaders,
} from './payment-provider.js';
import { parseJson } from './sandbox.provider.js';

const TIMEOUT_MS = 10_000;

export const providerError = (message: string) =>
  new AppException(HttpStatus.BAD_GATEWAY, ErrorCode.PAYMENT_PROVIDER_ERROR, message);

interface PaystackEnvelope<T> {
  status?: boolean;
  message?: string;
  data?: T;
}

/**
 * Paystack (https://paystack.com/docs/api):
 * - deposits: `POST /transaction/initialize`; our `DEP-...` reference is used
 *   as Paystack's reference and the amount is already in kobo;
 * - webhooks: `X-Paystack-Signature` = hex HMAC-SHA512(secret key, raw body);
 * - before crediting: `GET /transaction/verify/:reference`. Paystack webhooks
 *   carry no timestamp, so a captured one could be replayed; verifying means
 *   money only moves when Paystack itself confirms the charge.
 */
export class PaystackProvider implements PaymentProvider {
  readonly name = 'paystack';
  private readonly logger = new Logger(PaystackProvider.name);

  constructor(
    private readonly secretKey: string,
    private readonly baseUrl: string,
    private readonly callbackUrl?: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async initiateDeposit(input: InitiateDepositInput) {
    const data = await this.request<{ authorization_url?: string }>('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email: input.email,
        amount: input.amount.toString(),
        currency: input.currency,
        reference: input.reference,
        ...(this.callbackUrl ? { callback_url: this.callbackUrl } : {}),
      }),
    });
    if (!data.authorization_url) throw providerError('Paystack did not return a checkout URL.');
    return { checkoutUrl: data.authorization_url };
  }

  async verify(reference: string): Promise<VerifiedPayment> {
    const data = await this.request<{ status?: string; amount?: number; currency?: string }>(
      `/transaction/verify/${encodeURIComponent(reference)}`,
      { method: 'GET' },
    );
    const amount = toMinor(data.amount);
    if (amount === null || typeof data.currency !== 'string') {
      throw providerError('Paystack returned an unexpected verification payload.');
    }
    const status =
      data.status === 'success' ? 'succeeded' : data.status === 'failed' ? 'failed' : 'pending';
    return { status, amount, currency: data.currency.toUpperCase() };
  }

  parseWebhook(rawBody: Buffer, headers: WebhookHeaders): PaymentEvent {
    const signature = header(headers, 'x-paystack-signature') ?? '';
    const expected = createHmac('sha512', this.secretKey).update(rawBody).digest();
    const given = Buffer.from(signature, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw AppException.unauthorized(ErrorCode.INVALID_SIGNATURE, 'Invalid webhook signature.');
    }

    const body = parseJson(rawBody);
    const rawType = String(body.event ?? '');
    const data = (body.data ?? {}) as Record<string, unknown>;
    const reference = typeof data.reference === 'string' ? data.reference : null;
    const succeeded = rawType === 'charge.success' && data.status === 'success';

    return {
      // Paystack has no event id: event name + its transaction id is unique per delivery subject.
      eventId: `${rawType}:${String(data.id ?? reference ?? 'unknown')}`,
      rawType,
      // Abandoned checkouts send nothing; other events (refunds, transfers...) are acknowledged and ignored.
      type: succeeded ? 'payment.succeeded' : 'ignored',
      reference,
      amount: toMinor(data.amount),
      currency: typeof data.currency === 'string' ? data.currency.toUpperCase() : null,
      payload: body,
    };
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn(`Paystack ${path} unreachable: ${(err as Error).message}`);
      throw providerError('The payment provider is unreachable. Please try again.');
    }

    const body = (await response.json().catch(() => ({}))) as PaystackEnvelope<T>;
    if (!response.ok || !body.status || !body.data) {
      this.logger.warn(`Paystack ${path} failed: ${response.status} ${body.message ?? ''}`);
      throw providerError(
        body.message
          ? `Payment provider: ${body.message}`
          : 'The payment provider rejected the request.',
      );
    }
    return body.data;
  }
}
