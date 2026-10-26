import { Transform } from 'class-transformer';
import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * A positive amount in integer minor units (kobo), sent as a JSON integer
 * (`150000`) or an integer string (`"150000"`).
 *
 * Rejects decimals, exponents, signs, empty strings and anything beyond
 * Number.MAX_SAFE_INTEGER (where JSON numbers silently lose precision). The
 * per-transaction business cap (MAX_TRANSACTION_AMOUNT) is applied by the
 * services, which turn the value into a BigInt.
 */
export function IsMinorAmount(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => {
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value,
    )(target, propertyKey);

    registerDecorator({
      name: 'isMinorAmount',
      target: target.constructor,
      propertyName: propertyKey as string,
      options: {
        message: `${String(propertyKey)} must be a positive whole number of minor units, e.g. 150000 for 1,500.00`,
        ...options,
      },
      validator: {
        validate: (value: unknown) =>
          typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
      },
    });
  };
}

// C0/C1 control characters (newlines, NUL, escape sequences...). Free text that
// ends up on statements and in logs must not contain them.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** Rejects control characters in free text (names, notes, reasons). */
export function HasNoControlChars(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) =>
    registerDecorator({
      name: 'hasNoControlChars',
      target: target.constructor,
      propertyName: propertyKey as string,
      options: {
        message: `${String(propertyKey)} must not contain control characters`,
        ...options,
      },
      validator: {
        validate: (value: unknown) => typeof value !== 'string' || !CONTROL_CHARS.test(value),
      },
    });
}

/** Trims strings; leaves other values untouched (so type validation still runs). */
export const Trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/** Trims and lower-cases emails, so "Ada@X.dev " and "ada@x.dev" are the same account. */
export const NormalizeEmail = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );
