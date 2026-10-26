import { Injectable } from '@nestjs/common';
import { AppException, ErrorCode } from '../../common/errors/app.exception.js';
import { Prisma } from '../../generated/prisma/client.js';
import { applyLockTimeout, type Tx } from '../../infra/prisma/prisma.service.js';

export type IdempotencyScope = 'transfer' | 'admin_credit';

export interface IdempotencyRequest {
  userId: string;
  scope: IdempotencyScope;
  key: string;
  /** Hash of the request body, to detect a key reused for a different request. */
  requestHash: string;
}

/**
 * Database-backed idempotency for money movement.
 *
 * `claim()` inserts the key INSIDE the caller's transaction:
 *  - first use: the insert succeeds; the caller does the work and `complete()`s
 *    with the response, which commits atomically with the money movement;
 *  - concurrent duplicate: Postgres makes the second insert wait on the first
 *    transaction. If it commits, the second request replays its response; if it
 *    rolls back (e.g. insufficient funds), the second request runs normally;
 *  - later retry: replays the stored response;
 *  - same key, different body: rejected (IDEMPOTENCY_KEY_REUSED).
 *
 * Failed requests store nothing, so they can be retried with the same key.
 * Keys are scoped per user (one customer can never replay another's response)
 * and pruned after 24 hours by the maintenance job.
 */
@Injectable()
export class IdempotencyService {
  async claim<T>(tx: Tx, req: IdempotencyRequest): Promise<{ replay: T } | null> {
    await applyLockTimeout(tx);
    const inserted = await tx.$executeRaw`
      INSERT INTO idempotency_keys (user_id, scope, key, request_hash, response_body)
      VALUES (${req.userId}::uuid, ${req.scope}, ${req.key}, ${req.requestHash}, 'null'::jsonb)
      ON CONFLICT DO NOTHING`;
    if (inserted === 1) return null;

    const existing = await tx.idempotencyKey.findUnique({
      where: { userId_scope_key: { userId: req.userId, scope: req.scope, key: req.key } },
    });
    if (!existing || existing.responseBody === null) {
      // Pruned between the insert and the read: practically impossible, but retryable.
      throw AppException.conflict(
        ErrorCode.IDEMPOTENCY_KEY_IN_PROGRESS,
        'A request with this Idempotency-Key is still being processed. Retry shortly.',
      );
    }
    if (existing.requestHash !== req.requestHash) {
      throw AppException.unprocessable(
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        'This Idempotency-Key was already used for a different request. Use a new key.',
      );
    }
    return { replay: existing.responseBody as T };
  }

  async complete(tx: Tx, req: IdempotencyRequest, response: Prisma.InputJsonValue): Promise<void> {
    await tx.idempotencyKey.update({
      where: { userId_scope_key: { userId: req.userId, scope: req.scope, key: req.key } },
      data: { responseBody: response },
    });
  }
}
