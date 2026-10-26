# Migrating from the Express backend

`irate-core-nest` replaces the Express backend
([iamBlissMedik/irate-core](https://github.com/iamBlissMedik/irate-core): Express 5 + Prisma + Redis). This
document records what changed for API clients, and the defects in the original that the
rewrite fixes. Each defect was confirmed by reading the original source, and each fix is
covered by a test.

## Compatibility with the web apps

The HTTP contract in `@irate/contracts` is preserved: same paths, the same
`{ success, message, data }` envelope, money as minor-unit strings, the same list shapes
(`{ users | kycs | wallets | transactions, pagination }`), the same admin stat cards,
and the refresh token in a cookie named `refreshToken`. This was checked by validating
live responses from every endpoint the user and admin apps call against the real
`@irate/contracts` zod schemas, and by decoding access tokens with the BFF's own
`sessionUserFromToken`.

Differences a client may notice:

| Area | Express | NestJS |
| --- | --- | --- |
| Login response | `accessToken` at the top level | `data.accessToken` (the BFF reads both) plus `tokenType`, `expiresIn`, `user` |
| Register response | `{ id, email, accountNumber }` | `{ user: { id, email, role, createdAt }, accountNumber }`, the shape in `registerResultSchema` |
| Error body | `{ success, message, stack? }` | `{ success, message, code, errors?, requestId }`; stack traces are never sent |
| Status codes | Most failures were 400 | 409 conflicts, 422 business rules, 401 bad credentials, 429 lockout/rate limit, 503 retryable |
| Wrong email at login | 404 "Email not found" | 401 `INVALID_CREDENTIALS` (identical to a wrong password) |
| Statement line | `id` = per-wallet transaction row | `id` = ledger entry; adds `transactionId`, `reference`, `kind`, `currency`, `note` |
| `GET /users/:id` | Nested paginated wallets → transactions | Profile with `kyc`, `kycStatus`, `wallets`; history lives in the statement endpoints |
| IDs | cuid | UUIDv7 (time-ordered) |
| Password policy | ≥ 6 chars | 8–128, upper + lower + digit (matches the frontend schema) |
| KYC input | Any strings | `idType` enum, 11-digit NIN/BVN, age 18–120, `documentUrl` must be http(s) |
| Transfers | No KYC rule | Unverified customers have a daily cap (₦50,000, configurable) |
| Idempotency-Key | Transfers only | Transfers, admin credits and deposits (the web client already sends one on every mutation) |
| Unknown JSON fields | Ignored | Rejected (catches typos like `ammount`) |

New endpoints: `POST /auth/logout-all`, `/payments/*`, `/webhooks/payments/:provider`,
`PATCH /admin/wallets/:walletId/status`, `GET /admin/reconciliation`, `GET /ready`, `/docs`.

## Defects fixed

### Money

1. **Concurrent duplicate transfers.** Idempotency was check-cache → transfer → write-cache in Redis, so two simultaneous requests with the same key both moved money, and a crash between the commit and the cache write lost the key. *Fix:* the key is claimed inside the same database transaction.
2. **Cross-user idempotency replay.** Cache keys were `idem:<key>` with no user, so user B reusing a key received user A's transfer result. *Fix:* keys are scoped per user.
3. **Wrong running balances.** The transfer read `from.balance` before the conditional debit and wrote `balanceBefore`/`balanceAfter` from that stale read, so concurrent transfers recorded incorrect statement balances. Admin credits read the balance without a lock. *Fix:* `FOR UPDATE` locks and exact per-entry balances.
4. **Money created from nothing.** Admin credits and seed balances had no counter-entry, so the books could never be reconciled. *Fix:* double-entry against system accounts.
5. **Mutable ledger.** Nothing stopped updates or deletes of ledger rows. *Fix:* an append-only trigger, a balance-math `CHECK`, and a balanced-journal trigger.
6. **Precision loss.** `z.coerce.number()` silently turned `"9007199254740993"` into `9007199254740992` before `BigInt()`. *Fix:* amounts beyond `Number.MAX_SAFE_INTEGER`, decimals and exponents are rejected.
7. **Fragile counterparties.** Statement counterparties were recovered by regex-matching a 10-digit number in the description text. *Fix:* a `counterparty_wallet_id` foreign key.
8. **Dashboard double counting.** Volume and transaction counts summed both legs of every transfer; "users today" counted admins while "total users" excluded them. *Fix:* a transfer is one journal; admins are excluded consistently.

### Security

9. **Wallet balance IDOR.** `getBalance` returned a Redis-cached balance **before** checking ownership, so any user could read any wallet's cached balance. *Fix:* no balance cache; ownership is part of the query, and someone else's wallet is a plain 404.
10. **Account enumeration.** Login answered 404 "Email not found" vs 401 "Invalid password". *Fix:* one generic 401, plus a dummy hash for unknown emails so response timing matches.
11. **Name-enquiry impersonation.** The display name came from the KYC `fullName` regardless of status, so anyone could appear as "Aliko Dangote" while their KYC was pending. *Fix:* only VERIFIED names are shown.
12. **Refresh tokens.** One per user (a second device logged out the first), never rotated (a stolen token lasted 7 days), the role was copied from the old token forever, logout needed a valid access token, and raw access tokens were used as Redis keys. *Fix:* hashed, rotating, per-device refresh tokens with reuse detection; `jti` denylist; role re-read on refresh.
13. **Rate limiting behind the BFF.** 30 requests/minute **per IP**, and every BFF request comes from the same server IP, so all customers shared one budget. *Fix:* per-user limits for authenticated routes; refresh/logout aren't throttled.
14. **CORS rejection crashed to 500.** A disallowed origin raised an error into the global handler. *Fix:* no CORS headers, so the browser blocks the request.
15. **Unbounded pagination.** `limit=1000000` was honoured. *Fix:* capped at 100.
16. **LIKE wildcard injection** in the admin search (`%` matched everything; Prisma's `contains` doesn't escape). *Fix:* wildcards are escaped.

### Workflow correctness

17. **KYC review had no state guard.** A VERIFIED record could be re-reviewed and flipped to REJECTED, and two admins could both "win". *Fix:* compare-and-set on PENDING; decisions are final.
18. **Concurrent KYC submissions** hit the unique index and returned 500. *Fix:* 409 `KYC_PENDING`.
19. **Response typo:** rejecting answered "KYC rejectd".
20. **Best-effort audit logging after the fact:** a committed transfer could lack its audit row. *Fix:* audit rows are written in the same transaction.
21. **Timestamps without a time zone** (`TIMESTAMP(3)`). *Fix:* `timestamptz`, with the session pinned to UTC (see the Prisma adapter gotcha in [ARCHITECTURE.md](ARCHITECTURE.md#gotcha-pin-the-database-session-to-utc)).
22. **No readiness probe:** `/health` always answered 200, even with the database down or during shutdown. *Fix:* `/ready` checks Postgres and Redis and reports `draining` once SIGTERM arrives (the HTTP server still closes before the database, as it did in Express).

## Moving existing data

The new service uses its own schema, so existing data needs a one-off ETL rather than an
in-place migration:

1. `users`: map cuid → new UUID (keep a mapping table) and lower-case emails. Carry bcrypt hashes in a `legacy_bcrypt_hash` column and re-hash to argon2id at the next successful login (a small branch in `PasswordService.verify`), or force a password reset.
2. `kyc_records`: copy, mapping the free-text `idType` onto the enum; flag misfits for re-submission.
3. `wallets`: keep the account numbers.
4. **Balances:** for each wallet, post one `ADMIN_CREDIT` journal *ADJUSTMENTS → wallet* for the current balance ("Opening balance (migrated)"). Keep the old `Ledger` table read-only in an archive schema. It can't be replayed faithfully because its running balances were unreliable (defect 3).
5. Run `GET /admin/reconciliation` and compare every wallet's balance and the totals with the old system before switching traffic.
