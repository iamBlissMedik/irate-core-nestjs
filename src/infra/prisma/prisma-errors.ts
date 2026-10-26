import { Prisma } from '../../generated/prisma/client.js';

/**
 * Helpers for recognising database errors.
 *
 * With Prisma 7 driver adapters the Postgres details live under
 * `meta.driverAdapterError.cause` (or `cause` for errors raised at COMMIT,
 * such as the deferred balanced-journal trigger), e.g.
 * `{ originalCode: '23505', constraint: { index: 'users_email_key' } }`.
 */

interface DriverCause {
  originalCode?: string;
  code?: string;
  constraint?: { index?: string; fields?: string[] };
}

function driverCause(error: unknown): DriverCause | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const meta = (error as { meta?: { driverAdapterError?: { cause?: DriverCause } } }).meta;
  return meta?.driverAdapterError?.cause ?? (error as { cause?: DriverCause }).cause ?? undefined;
}

/** The Postgres SQLSTATE behind an error, if any (e.g. `23505`, `55P03`). */
export function sqlState(error: unknown): string | undefined {
  const cause = driverCause(error);
  return cause?.originalCode ?? cause?.code;
}

/**
 * True when the error is a unique-constraint violation. Pass the index name
 * (e.g. `users_email_key`) to only match that constraint.
 */
export function isUniqueViolation(error: unknown, index?: string): boolean {
  const isUnique =
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') ||
    sqlState(error) === '23505';
  if (!isUnique || !index) return isUnique;
  return driverCause(error)?.constraint?.index === index;
}

/** Lock wait exceeded `lock_timeout`, or Postgres broke a deadlock. Safe to retry. */
export function isLockContention(error: unknown): boolean {
  const state = sqlState(error);
  return state === '55P03' || state === '40P01' || state === '40001';
}
