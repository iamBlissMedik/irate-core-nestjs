import { Param, ParseUUIDPipe } from '@nestjs/common';
import { AppException, ErrorCode } from '../errors/app.exception.js';

/** A path parameter that must be a UUID; anything else is a VALIDATION_ERROR (400). */
export const UuidParam = (name: string) =>
  Param(
    name,
    new ParseUUIDPipe({
      exceptionFactory: () =>
        AppException.badRequest(ErrorCode.VALIDATION_ERROR, `${name} must be a valid UUID.`),
    }),
  );
