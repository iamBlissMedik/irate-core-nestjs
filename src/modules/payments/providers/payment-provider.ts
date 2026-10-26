/**
 * The contract every payment provider adapter implements. Settlement,
 * idempotency, auditing and ledger postings are provider-agnostic, so adding
 * Flutterwave or Stripe means writing one class like PaystackProvider.
 */

export interface InitiateDepositInput {
  /** Our unique reference; providers echo it back in webhooks. */
  reference: string;
  /** Minor units. */
  amount: bigint;
  currency: string;
  email: string;
}

export type PaymentEventType = 'payment.succeeded' | 'payment.failed' | 'ignored';

/** A webhook, verified and normalised. */
export interface PaymentEvent {
  /** Unique per provider event: the de-duplication key for redeliveries. */
  eventId: string;
  type: PaymentEventType;
  /** Provider's raw event name, stored for investigation. */
  rawType: string;
  reference: string | null;
  /** Minor units the provider says were collected. */
  amount: bigint | null;
  currency: string | null;
  failureReason?: string;
  payload: Record<string, unknown>;
}

export interface VerifiedPayment {
  status: 'succeeded' | 'failed' | 'pending';
  amount: bigint;
  currency: string;
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface PaymentProvider {
  readonly name: string;

  /** Ask the provider for a hosted checkout page. Called OUTSIDE any DB transaction. */
  initiateDeposit(input: InitiateDepositInput): Promise<{ checkoutUrl: string }>;

  /** Verify the signature and normalise the event. Throws INVALID_SIGNATURE on a bad signature. */
  parseWebhook(rawBody: Buffer, headers: WebhookHeaders): PaymentEvent;

  /**
   * Optional server-to-server confirmation. When present it is called before
   * every credit and its amount/currency are authoritative, so a replayed or
   * forged webhook can never create money on its own.
   */
  verify?(reference: string): Promise<VerifiedPayment>;
}

export function header(headers: WebhookHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Parse a JSON integer amount strictly into BigInt (null when missing or not a safe integer). */
export function toMinor(value: unknown): bigint | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? BigInt(value)
    : null;
}
