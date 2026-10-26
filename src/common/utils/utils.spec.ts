import { describe, expect, it } from 'vitest';
import { displayName, generateAccountNumber } from './account.js';
import { randomToken, sha256Hex, stableHash } from './crypto.js';
import { generateReference } from './reference.js';
import { escapeLike } from './sql.js';

describe('account numbers', () => {
  it('are 10 digits and never start with 0 (reserved for system accounts)', () => {
    for (let i = 0; i < 1_000; i++) expect(generateAccountNumber()).toMatch(/^[1-9]\d{9}$/);
  });
});

describe('displayName', () => {
  it('uses only a VERIFIED KYC name', () => {
    expect(displayName('ada@irate.dev', { fullName: ' Ada Okafor ', status: 'VERIFIED' })).toBe(
      'Ada Okafor',
    );
    expect(displayName('ada@irate.dev', { fullName: 'Aliko Dangote', status: 'PENDING' })).toBe(
      'Ada',
    );
    expect(displayName('ada@irate.dev', null)).toBe('Ada');
  });
});

describe('crypto helpers', () => {
  it('hashes request bodies independent of key order, including BigInt', () => {
    expect(stableHash({ a: 1, b: { c: 2n, d: [1, 2] } })).toBe(
      stableHash({ b: { d: [1, 2], c: 2n }, a: 1 }),
    );
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });

  it('generates 256-bit url-safe tokens and hex digests', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256Hex('x')).toHaveLength(64);
  });
});

describe('references', () => {
  it('are prefixed, dated and random', () => {
    const ref = generateReference('TRF', new Date('2026-10-26T12:00:00Z'));
    expect(ref).toMatch(/^TRF-20261026-[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(generateReference('TRF')).not.toBe(generateReference('TRF'));
  });
});

describe('escapeLike', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});
