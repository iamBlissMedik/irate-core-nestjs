import { HttpStatus, ValidationError, ValidationPipe } from '@nestjs/common';
import { AppException, ErrorCode, FieldError } from '../errors/app.exception.js';

/**
 * Global validation: unknown fields are rejected (catches typos like
 * `ammount`), values are transformed into DTO instances, and failures become
 * `VALIDATION_ERROR` with one `{ field, message }` per problem.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    stopAtFirstError: true,
    validationError: { target: false, value: false },
    exceptionFactory: (errors) => {
      const fieldErrors = flatten(errors);
      return new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        fieldErrors.map((e) => e.message).join('; ') || 'Invalid request.',
        fieldErrors,
      );
    },
  });
}

function flatten(errors: ValidationError[], parent?: string): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => ({ field, message }));
    return [...own, ...flatten(error.children ?? [], field)];
  });
}
