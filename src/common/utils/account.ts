import { randomInt } from 'node:crypto';

/**
 * A random 10-digit NUBAN-style account number. The first digit is 1-9, so
 * customer numbers never collide with system accounts (`00000000xx`).
 * Uniqueness is guaranteed by the database; callers retry on the rare clash.
 */
export function generateAccountNumber(): string {
  let digits = String(randomInt(1, 10));
  for (let i = 0; i < 9; i++) digits += String(randomInt(0, 10));
  return digits;
}

/**
 * The name shown to a sender during name enquiry and on statements.
 *
 * Only a VERIFIED KYC name is trusted: otherwise anyone could submit KYC as
 * "Aliko Dangote" and be displayed that way while the review is pending.
 * Without one we fall back to the capitalised email local part.
 */
export function displayName(
  email: string,
  kyc?: { fullName: string; status: string } | null,
): string {
  if (kyc?.status === 'VERIFIED' && kyc.fullName.trim()) return kyc.fullName.trim();
  const local = email.split('@')[0] || 'Customer';
  return local.charAt(0).toUpperCase() + local.slice(1);
}
