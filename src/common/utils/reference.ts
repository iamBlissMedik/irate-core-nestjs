import { randomBase32 } from './crypto.js';

export type ReferencePrefix = 'TRF' | 'DEP' | 'ADJ';

/**
 * Human-friendly, unique transaction reference, e.g. `TRF-20261026-K3J9X2Q7M4N8P1R5`.
 * 16 base32 characters = 80 bits of randomness, so collisions are not a
 * practical concern (and the column is UNIQUE anyway).
 */
export function generateReference(prefix: ReferencePrefix, now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `${prefix}-${date}-${randomBase32(16)}`;
}
