# Payments

How wallet funding through an external provider works, how to test it locally, how to
enable Paystack, and how to add another provider.

## Deposit flow

```mermaid
sequenceDiagram
    autonumber
    participant C as Client (BFF)
    participant API as irate-core-nest
    participant DB as PostgreSQL
    participant P as Provider

    C->>API: POST /payments/deposits {amount} + Idempotency-Key
    API->>DB: INSERT deposit PENDING (unique user + key)
    API->>P: initiateDeposit(reference, amount)   (outside any DB transaction)
    P-->>API: checkout URL
    API->>DB: save checkout_url
    API-->>C: 201 {id, reference, status: PENDING, checkoutUrl}
    C->>P: customer pays on the provider's page
    P->>API: POST /webhooks/payments/{provider} (signed)
    API->>API: verify signature (+ Paystack: GET /transaction/verify)
    API->>DB: BEGIN; INSERT webhook_event (unique provider + event_id)
    API->>DB: SELECT deposit … FOR UPDATE
    API->>DB: ledger: debit SETTLEMENT, credit wallet; deposit → SUCCEEDED; audit; COMMIT
    API-->>P: 200 (stop retrying)
```

No money moves when a deposit is created. Only a verified webhook credits the wallet,
and it does so through the same `LedgerService` as transfers.

## Guarantees

| Situation | Outcome |
| --- | --- |
| Client retries "start deposit" with the same key | Same deposit and reference (200 + `Idempotent-Replayed`) |
| Same key, different amount | 422 `IDEMPOTENCY_KEY_REUSED` |
| Provider down while starting | 502 `PAYMENT_PROVIDER_ERROR`. The deposit stays PENDING without a URL; a retry with the same key calls the provider again |
| Webhook redelivered (same event id) | No-op (unique `(provider, event_id)`) |
| Two different success events for one deposit | First credits, second is a no-op (row lock + SUCCEEDED is terminal) |
| 20 concurrent deliveries | Serialised on the deposit row; credited once (e2e tested) |
| Failure event after success | Ignored: success is terminal |
| Success after failure (late capture) | Credited: the money really arrived |
| Collected amount/currency ≠ requested | Deposit marked FAILED (`amount_mismatch: …`), audited `DEPOSIT_AMOUNT_MISMATCH`, **not credited**. Needs manual review |
| Unknown reference | 200 (retrying won't help); the raw event stays in `webhook_events` for investigation |
| Bad signature, stale timestamp (sandbox), tampered body | 401 `INVALID_SIGNATURE` |
| Paystack success the verify API doesn't confirm (yet) | 502, nothing recorded, so Paystack redelivers; credited once verified, using the verified amount |
| Transient error (database down, lock timeout) | 5xx, so the provider retries later |
| Wallet frozen | Still credited (freeze is "post no debit") |

## Local testing with the sandbox provider

The sandbox signs webhooks the way real providers do: hex HMAC-SHA256 over
`"<unix timestamp>.<raw body>"`, sent in `X-Sandbox-Timestamp` and
`X-Sandbox-Signature`, with a 5-minute tolerance (so a captured webhook can't be
replayed later). It has no hosted payment page; the `checkoutUrl` it returns is
informational only.

**Easiest:** the simulate endpoint (outside production only) builds a correctly signed
event for one of your deposits and sends it through the real webhook path:

```bash
DEP=$(curl -s localhost:8000/api/v1/payments/deposits -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" -d '{"amount":500000}' | jq -r .data.id)

curl -s localhost:8000/api/v1/payments/sandbox/deposits/$DEP/simulate \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"outcome":"success"}'
```

**Manual webhook** (what the provider would send):

```bash
BODY='{"id":"evt_123","type":"payment.succeeded","data":{"reference":"DEP-…","amount":500000,"currency":"NGN"}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SANDBOX_WEBHOOK_SECRET" -hex | awk '{print $NF}')
curl -s localhost:8000/api/v1/webhooks/payments/sandbox -H 'Content-Type: application/json' \
  -H "X-Sandbox-Timestamp: $TS" -H "X-Sandbox-Signature: $SIG" -d "$BODY"
```

## Paystack

`src/modules/payments/providers/paystack.provider.ts`:

| Step | Paystack API | Notes |
| --- | --- | --- |
| Start deposit | `POST /transaction/initialize` `{ email, amount, currency, reference, callback_url }` | The amount is already in kobo; our `DEP-…` reference is Paystack's reference; returns `authorization_url` as `checkoutUrl` |
| Webhook auth | `X-Paystack-Signature` = hex HMAC-SHA512(secret key, raw body) | Constant-time comparison over the **raw** bytes (`rawBody: true`) |
| Confirm | `GET /transaction/verify/:reference` | Called for every `charge.success` **before** crediting, outside any DB transaction; the verified amount and currency are authoritative |
| Events | `charge.success` with `data.status = success` credits | Everything else (transfers, refunds, disputes) is acknowledged and ignored; an abandoned checkout sends nothing, so the deposit stays PENDING |

**Why verify?** Paystack webhooks carry no timestamp, so a captured, validly signed
webhook could be replayed, and a leaked secret key could forge one. With verification,
money moves only when Paystack itself confirms the charge.

### Enabling it

```bash
PAYMENTS_PROVIDER=paystack
PAYSTACK_SECRET_KEY=sk_test_...            # sk_live_... in production
PAYSTACK_CALLBACK_URL=https://app.example.com/deposits/complete   # optional
```

In the Paystack dashboard (Settings → API Keys & Webhooks), set the webhook URL to
`https://<host>/api/v1/webhooks/payments/paystack`. You can also allowlist Paystack's
webhook IPs at your edge.

Outside production the sandbox stays registered, so the simulate endpoint keeps
working alongside Paystack. In production, only the active provider is registered.

**Tested** by unit tests (request shape, auth header, error mapping, signature checks,
event mapping) and by `test/paystack.e2e-spec.ts`. That suite boots the full app with
`PAYMENTS_PROVIDER=paystack` against a local Paystack API stub: unconfirmed webhook →
502 and nothing recorded; confirmed → credited once even when redelivered; verified
amount differs from the webhook → flagged, not credited; forged signature → 401.

Known edge: Paystack refuses to re-initialise an existing reference. If the first
`initialize` call reached Paystack but its response was lost, a retry with the same
Idempotency-Key gets a 502; the customer can start a new deposit with a new key.

## Adding another provider (Flutterwave, Stripe…)

1. Implement `PaymentProvider` (`name`, `initiateDeposit`, `parseWebhook`) and, if the provider has a verify/retrieve endpoint, the optional `verify`. Use a request timeout and treat non-2xx as `PAYMENT_PROVIDER_ERROR`.
2. Add its configuration to `src/config/env.ts` and register it in `PaymentProvidersRegistry`.
3. Point the provider's webhook at `https://<host>/api/v1/webhooks/payments/<name>`.
4. Add unit tests against a mocked `fetch`, and an e2e suite like `paystack.e2e-spec.ts`.

Settlement, idempotency, de-duplication, auditing and ledger postings are
provider-agnostic, so nothing else changes. In production, also reconcile daily against
the provider's settlement report.

## Roadmap: payouts

Payouts (withdrawals to a bank account) are asynchronous and can fail after money is
reserved, so they need a **hold**:

1. **Request:** lock the wallet, check the balance, post *debit customer → credit `PAYOUTS_PENDING`* (a new system account), create the payout as PENDING with an idempotency key.
2. **Call** the provider's transfer API outside the transaction.
3. **Webhook success:** post *debit `PAYOUTS_PENDING` → credit `SETTLEMENT`* and mark it SUCCEEDED.
4. **Webhook failure or timeout:** post the reversal *debit `PAYOUTS_PENDING` → credit customer* and mark it FAILED.

The customer's balance drops immediately (no double spending while the payout is in
flight), and the books balance at every step.
