# Architecture

How the API is put together and why. Start with the [README](../README.md) for the
overview; this document goes one level deeper.

- [Request lifecycle](#request-lifecycle)
- [Modules](#modules)
- [The ledger](#the-ledger)
- [Concurrency and locking](#concurrency-and-locking)
- [Idempotency](#idempotency)
- [Authentication and sessions](#authentication-and-sessions)
- [Errors](#errors)
- [Operations](#operations)
- [Design decisions](#design-decisions)
- [Known trade-offs](#known-trade-offs)

## Request lifecycle

```text
request
  → request id (X-Request-ID, reused if the caller sent a safe one)
  → helmet · cookie-parser · Cache-Control: no-store · CORS allowlist
  → body parser (100 KB, raw bytes kept for webhook signatures)
  → pino-http access log
  → JwtAuthGuard     verify JWT (HS256, iss, aud, exp) + Redis revocation check   [skipped for @Public()]
  → RolesGuard       @Roles('ADMIN')
  → AppThrottlerGuard  per user when authenticated, per IP otherwise (Redis, fails open)
  → ValidationPipe   DTO classes: whitelist + forbid unknown fields + transform
  → controller → service(s) → Prisma / LedgerService
  → EnvelopeInterceptor  { success: true, message, data }
  ↘ AllExceptionsFilter  { success: false, message, code, errors?, requestId }
```

Everything global is registered in `AppModule` (`APP_GUARD`, `APP_PIPE`, `APP_FILTER`,
`APP_INTERCEPTOR`), and the HTTP middleware lives in `configureApp()`
(`src/app.setup.ts`). `main.ts` and the e2e tests both call it, so tests run the exact
production pipeline.

## Modules

| Module | Owns | Depends on |
| --- | --- | --- |
| `auth` | register, login, refresh rotation, logout, JWT + argon2id, lockout, the global guards | `wallets` (a wallet is opened at registration) |
| `wallets` | wallet lifecycle, balances, account numbers, name enquiry | – |
| `transactions` | P2P transfers, daily limits, statements (`StatementService`) | `wallets`, `ledger`, `idempotency` |
| `users` | profiles, home-screen overview, admin directory | `wallets`, `transactions` |
| `kyc` | submission and review state machine | – |
| `payments` | provider registry (sandbox, Paystack), deposits, webhooks | `wallets`, `ledger` |
| `admin` | dashboard stats, credits, freeze, KYC review, reconciliation | `users`, `kyc`, `ledger`, `idempotency` |
| `ledger` (global) | `LedgerService` (lock + post), system wallets, reconciliation | – |
| `idempotency`, `audit` (global) | transactional idempotency keys, in-transaction audit log | – |
| `health`, `maintenance` | probes and graceful drain, hourly cleanup | – |

Rules of thumb:

- **Controllers** only translate HTTP: they read the DTO, the current user and headers, call a service, and return plain data (or set a header such as `Idempotent-Replayed`).
- **Services** hold the business rules and throw `AppException` with a stable `code`.
- **Presenters** (`*.presenter.ts`) turn Prisma rows into the public shape. Money becomes a string there, explicitly, rather than by patching `BigInt.prototype`.
- Anything that changes state **and** must be audited takes the transaction client (`tx`), so the audit row commits atomically with the change.

## The ledger

### Data model

```text
wallets          id, user_id?, kind USER|SYSTEM, system_code?, account_number, currency, balance, status
transactions     id, reference (unique), kind TRANSFER|DEPOSIT|ADMIN_CREDIT, amount, currency, description, note, initiated_by, metadata
ledger_entries   id, transaction_id, wallet_id, direction DEBIT|CREDIT, amount, balance_before, balance_after,
                 description, counterparty_wallet_id
```

A **transaction** is one business event (a journal). Its **ledger entries** are the
lines, one per wallet touched. A statement is just a wallet's ledger entries, newest
first, so every running balance is exact and the counterparty is a real foreign key.

### System accounts

Money that crosses the platform boundary needs another side:

| Event | Debit | Credit |
| --- | --- | --- |
| Transfer | sender | recipient |
| Deposit (card payment) | `SETTLEMENT` | customer |
| Admin credit | `ADJUSTMENTS` | customer |
| Payout (roadmap) | customer → `PAYOUTS_PENDING` → `SETTLEMENT` | |

System wallets may go negative: `SETTLEMENT` sits at minus the money customers
deposited, which is exactly what the provider owes the platform. Because every journal
balances, **the sum of all balances in a currency is always zero**.
`SystemWalletsService` creates the accounts idempotently at boot for every
`SUPPORTED_CURRENCIES` entry, in the `00000xxxxx` account-number range that customers
can never get.

### Invariants enforced by Postgres

See `prisma/migrations/*_ledger_invariants`. The application checks all of these
first; the database checks again so that a bug fails loudly instead of corrupting money.

| Invariant | Mechanism |
| --- | --- |
| A customer is never overdrawn | `CHECK (kind = 'SYSTEM' OR balance >= 0)` |
| Each line's arithmetic is right | `CHECK (balance_after = balance_before ± amount)` |
| Each journal balances | deferred constraint trigger, evaluated at `COMMIT` |
| History is never rewritten | `BEFORE UPDATE OR DELETE` trigger raises (corrections are new reversing journals) |
| Amounts are positive, currencies well-formed, owners match the wallet kind | `CHECK` constraints |
| Emails are normalised, `verified_at` matches the KYC status | `CHECK` constraints |

`GET /admin/reconciliation` re-derives everything from the ledger: unbalanced
journals, wallets whose balance differs from the sum of their entries, and currencies
that don't net to zero.

## Concurrency and locking

`LedgerService.lockWallets()` runs:

```sql
SET LOCAL lock_timeout = '5s';
SELECT … FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE;
```

- **Pessimistic locking**: once the rows are locked, the balance can't change underneath us, so the balance check, the daily-limit check and the before/after values are all exact. A conditional `UPDATE … WHERE balance >= amount` (what the Express version did) prevents overdrafts but still records wrong running balances when requests race.
- **Fixed lock order** (`ORDER BY id`): two transfers between the same pair of wallets in opposite directions lock them in the same order, so they queue instead of deadlocking.
- **Bounded waits**: `lock_timeout` turns a pile-up on a hot wallet into a fast, retryable `503` (`Retry-After: 1`), and the Prisma interactive transaction has its own 15s cap.
- **Isolation**: READ COMMITTED is enough because every decision is made on locked rows.

Webhooks lock the **deposit** row first (`SELECT … FOR UPDATE`), then the wallets.
Nothing else locks deposits, so the order is consistent and duplicate or concurrent
deliveries serialise on the deposit.

## Idempotency

`Idempotency-Key` is required on transfers and admin credits. `IdempotencyService`:

1. `INSERT INTO idempotency_keys (user_id, scope, key, request_hash, …) ON CONFLICT DO NOTHING`, inside the money transaction.
2. If the row already existed, the stored response is replayed (`Idempotent-Replayed: true`), or `IDEMPOTENCY_KEY_REUSED` (422) is returned when the body hash differs.
3. Otherwise the transfer runs, and the response is written to the key **before** `COMMIT`.

Why it is correct under concurrency: a second request with the same key blocks on the
primary key until the first transaction finishes. If the first commits, the second
replays its response; if it rolls back (insufficient funds, say), the key never existed
and the second request runs normally. Failures are never stored, so they're always
retryable. Keys are scoped per user (one customer can't replay another's response) and
pruned after 24 hours.

Deposits use the same idea with a unique `(user_id, idempotency_key)` on `deposits`
itself, because the provider call has to happen **outside** the transaction (see
[PAYMENTS.md](PAYMENTS.md)).

## Authentication and sessions

| Token | Format | Lifetime | Stored |
| --- | --- | --- | --- |
| Access | HS256 JWT: `sub`, `email`, `role`, `jti`, `iss`, `aud` | 15 min | nowhere (stateless) |
| Refresh | 256-bit random, base64url | 7 days, sliding | SHA-256 hash in `refresh_tokens` |

**Refresh rotation.** Each login starts a token *family* (a device session). A refresh
is a compare-and-set (`UPDATE … SET rotated_at = now() WHERE token_hash = $1 AND
rotated_at IS NULL AND revoked_at IS NULL AND expires_at > now()`): exactly one caller
wins, gets a new token in the same family, and the role is re-read from the database.
Presenting an already-rotated token:

- within `REFRESH_REUSE_GRACE_SECONDS` (two tabs racing): refused, session kept;
- after it: treated as theft. The whole family is revoked and `REFRESH_TOKEN_REUSE_DETECTED` is audited.

**Revocation of stateless access tokens.** Logout denylists the token's `jti` in Redis
until its `exp`. Logout-all stores `auth:revoked-before:<userId> = now` and rejects any
token with `iat <=` that second. Because `iat` has one-second resolution, a login in the
same second as a logout-all is also rejected; the client simply logs in again.

**Fail closed.** If Redis can't be reached, the guard can't prove a token wasn't
revoked, so it answers 503 instead of letting the request through.

## Errors

Services throw `AppException(status, code, message, errors?, headers?)`.
`AllExceptionsFilter` also maps:

| Source | Result |
| --- | --- |
| Validation (`ValidationPipe`) | 400 `VALIDATION_ERROR` with `errors: [{ field, message }]` |
| Malformed JSON / body too large | 400 `BAD_REQUEST` / 413 `PAYLOAD_TOO_LARGE` |
| Throttler | 429 `RATE_LIMITED` + `Retry-After` |
| Lock timeout, deadlock, serialization failure | 503 `SERVICE_UNAVAILABLE` + `Retry-After: 1` |
| Unhandled unique violation / missing record | 409 `CONFLICT` / 404 `NOT_FOUND` |
| Anything else | 500 `INTERNAL_ERROR`, logged with the stack. Details are never sent to the client. |

Every error body carries `requestId`, the same value as the `X-Request-ID` header and the log lines.

## Operations

- **Logging:** pino via `nestjs-pino`, JSON in production and pretty-printed in development. Authorization headers, cookies, signatures, passwords and tokens are redacted. Health probes aren't logged.
- **Probes:** `/health` (process up) and `/ready` (Postgres and Redis reachable; 503 once shutdown starts).
- **Graceful shutdown:** on SIGTERM, readiness flips to `draining`, the HTTP server stops accepting connections and finishes in-flight requests, and only then are the Postgres pool and Redis closed (`onApplicationShutdown`, not `onModuleDestroy`, which Nest runs *before* closing the server).
- **Maintenance:** an hourly `@Cron` prunes idempotency keys older than 24h and refresh tokens expired over a week ago. Every statement is an idempotent `DELETE`, so running it on several replicas at once is harmless; no leader election is needed.
- **Configuration:** zod-validated at import time with production guardrails (no dev secrets, secure cookies, no wildcard CORS, rate limiting on).

### Gotcha: pin the database session to UTC

With Prisma 7's `@prisma/adapter-pg`, if the Postgres server's `TimeZone` isn't UTC,
JS `Date`s are written as local wall-clock time and `timestamptz` values are read
without their offset. Round trips through Prisma look fine, but anything computed in SQL
(the daily limit's "start of today", dashboard windows, `DEFAULT now()`) is off by the
zone offset. `PrismaService` therefore connects with `options: '-c TimeZone=UTC'`. This
was found on a development machine whose Postgres runs in `Africa/Lagos`.

## Design decisions

1. **Double-entry ledger with database-enforced invariants.** A single `balance` column plus a free-text history can't be reconciled: there's no way to prove money wasn't created. Journals against system accounts make every naira traceable, and the triggers make the guarantees independent of application bugs.
2. **Pessimistic, ordered row locks** over optimistic concurrency. Contention on a single customer wallet is low, correctness under contention is simple to reason about, and there are no retry loops. The cost is a hot `SETTLEMENT` row under heavy deposit volume (see trade-offs).
3. **Idempotency in Postgres, in the same transaction**, over a Redis cache. Check-then-act on a cache is racy, and a crash between the commit and the cache write loses the key. Here "the money moved" and "the key is recorded" are one atomic fact.
4. **Opaque rotating refresh tokens** over long-lived JWTs. They're revocable, rotation limits a stolen token to one use, and the hash-only storage means a database leak leaks no usable tokens.
5. **Redis only for disposable state.** Losing Redis can't lose money or sessions; the worst case is a brief auth outage (fail closed) and no rate limiting (fail open).
6. **Prisma for the model, raw SQL where it matters.** Prisma gives typed queries and migrations. `FOR UPDATE`, `ON CONFLICT` claims, the timezone-aware daily sum and reconciliation are explicit SQL through `$queryRaw` (always parameterised).
7. **The official Nest 12 template**: ESM (`nodenext`), Vitest and oxlint. Vitest's Oxc transformer emits decorator metadata, so DI works in tests without SWC.

## Known trade-offs

- **Hot system wallets.** Every deposit locks `SETTLEMENT`. That's fine for an MVP; at scale, shard it into N sub-accounts or post system legs without a row lock and reconcile periodically.
- **Daily limit window.** "Today" is the calendar day in `BUSINESS_TIMEZONE`, not a rolling 24 hours, which is how most banks present limits.
- **Per-email lockout can be used to lock a victim out** for 15 minutes. That's the standard trade-off against credential stuffing; pair it with CAPTCHA or step-up at the edge if needed.
- **Client IPs behind the BFF.** `/auth/login` and `/auth/register` are limited per IP, but the BFF calls them server-to-server. `@irate/bff` therefore resolves the browser's IP through its own trusted proxies (`IRATE_TRUSTED_PROXY_HOPS`) and sends it as a single-entry `X-Forwarded-For`, so run the API with `TRUST_PROXY_HOPS=1` and reachable only from the BFF (otherwise a caller could set the header itself). If that header is missing, every customer shares the BFF's budget. The per-email lockout protects accounts either way. `/auth/refresh` and `/auth/logout` are deliberately not rate limited: refresh tokens are single-use and unguessable, and the BFF's background refreshes don't carry a browser IP.
- **Role changes** take effect on the next refresh (at most 15 minutes), because access tokens are stateless.
