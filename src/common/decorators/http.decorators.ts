import {
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { AppException, ErrorCode } from '../errors/app.exception.js';
import type { AppRequest } from '../types/request.js';

export const RESPONSE_MESSAGE_KEY = 'http:responseMessage';
export const SKIP_ENVELOPE_KEY = 'http:skipEnvelope';

/** The `message` of the success envelope `{ success, message, data }`. */
export const ResponseMessage = (message: string) => SetMetadata(RESPONSE_MESSAGE_KEY, message);

/** Return the handler's value as-is instead of wrapping it in the envelope (health probes). */
export const SkipEnvelope = () => SetMetadata(SKIP_ENVELOPE_KEY, true);

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

/**
 * The validated `Idempotency-Key` header (required). Use together with
 * `@ApiIdempotencyKey()` so it shows up in the OpenAPI docs.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const value = ctx.switchToHttp().getRequest<AppRequest>().header('idempotency-key')?.trim();
    if (!value) {
      throw AppException.badRequest(
        ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        'The Idempotency-Key header is required for this operation.',
      );
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
      throw AppException.badRequest(
        ErrorCode.VALIDATION_ERROR,
        'Idempotency-Key must be 8-128 characters of letters, digits, "-", "_", ":" or ".". A UUID is recommended.',
      );
    }
    return value;
  },
);

export const ApiIdempotencyKey = () =>
  applyDecorators(
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description:
        'A fresh UUID per operation. Retrying with the same key and body replays the original response (header `Idempotent-Replayed: true`) without moving money twice.',
    }),
  );
