import { createHash, randomBytes, randomInt } from 'node:crypto';

/** Hex SHA-256 of a string (used to store refresh tokens and hash request bodies). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A URL-safe random token with `bytes` bytes of entropy (default 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Deterministic hash of a JSON-like value: object keys are sorted, so
 * `{a:1,b:2}` and `{b:2,a:1}` hash the same. Used to detect an Idempotency-Key
 * being reused with a different request body.
 */
export function stableHash(value: unknown): string {
  return sha256Hex(JSON.stringify(sortKeys(value)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .toSorted()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Random Crockford base32 string (no I, L, O, U: easy to read out over the phone). */
export function randomBase32(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CROCKFORD[randomInt(CROCKFORD.length)];
  return out;
}
