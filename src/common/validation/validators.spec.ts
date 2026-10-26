import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { HasNoControlChars, IsMinorAmount, NormalizeEmail } from './validators.js';

class AmountDto {
  @IsMinorAmount()
  amount: unknown;
}

class TextDto {
  @HasNoControlChars()
  note: unknown;

  @NormalizeEmail()
  email: unknown;
}

const amount = (value: unknown) => {
  const dto = plainToInstance(AmountDto, { amount: value });
  return { errors: validateSync(dto).length, value: dto.amount };
};

describe('IsMinorAmount', () => {
  it.each([1, 150_000, '150000', Number.MAX_SAFE_INTEGER])('accepts %s', (value) => {
    expect(amount(value).errors).toBe(0);
    expect(typeof amount(value).value).toBe('number');
  });

  it.each([
    0,
    -1,
    1.5,
    '1.5',
    '1e5',
    '+5',
    '',
    ' 5',
    null,
    true,
    // oxlint-disable-next-line no-loss-of-precision -- deliberately unsafe: the API must reject it
    9_007_199_254_740_993,
    '99999999999999999',
    Infinity,
  ])('rejects %s', (value) => expect(amount(value).errors).toBe(1));
});

describe('text validators', () => {
  it('rejects control characters and normalises emails', () => {
    const ok = plainToInstance(TextDto, { note: 'Rent — June', email: '  Ada@IRATE.dev ' });
    expect(validateSync(ok)).toHaveLength(0);
    expect(ok.email).toBe('ada@irate.dev');
    expect(
      validateSync(plainToInstance(TextDto, { note: 'line\nbreak', email: 'a@b.c' })),
    ).toHaveLength(1);
  });
});
