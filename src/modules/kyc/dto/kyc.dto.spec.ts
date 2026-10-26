import { describe, expect, it } from 'vitest';
import { parseDateOnly } from './kyc.dto.js';

describe('parseDateOnly', () => {
  it('parses real dates (date part only) as UTC midnight', () => {
    expect(parseDateOnly('1994-05-17')?.toISOString()).toBe('1994-05-17T00:00:00.000Z');
    expect(parseDateOnly('1994-05-17T23:59:00+01:00')?.toISOString()).toBe(
      '1994-05-17T00:00:00.000Z',
    );
    expect(parseDateOnly('2000-02-29')).not.toBeNull();
  });

  it.each(['2001-02-29', '2001-02-30', '1994-13-01', '17/05/1994', '', 42])(
    'rejects %s',
    (value) => {
      expect(parseDateOnly(value)).toBeNull();
    },
  );
});
