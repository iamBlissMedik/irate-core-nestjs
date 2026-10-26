import { HttpStatus } from '@nestjs/common';

/**
 * Machine-readable error codes. Clients branch on `code`, never on `message`.
 * Kept in sync with the API reference (README) and @irate/contracts.
 */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCESS_TOKEN_EXPIRED: 'ACCESS_TOKEN_EXPIRED',
  INVALID_ACCESS_TOKEN: 'INVALID_ACCESS_TOKEN',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  EMAIL_TAKEN: 'EMAIL_TAKEN',
  WALLET_EXISTS: 'WALLET_EXISTS',
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  WALLET_FROZEN: 'WALLET_FROZEN',
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  AMOUNT_TOO_LARGE: 'AMOUNT_TOO_LARGE',
  DAILY_LIMIT_EXCEEDED: 'DAILY_LIMIT_EXCEEDED',
  SELF_TRANSFER: 'SELF_TRANSFER',
  RECIPIENT_NOT_FOUND: 'RECIPIENT_NOT_FOUND',

  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENCY_KEY_IN_PROGRESS: 'IDEMPOTENCY_KEY_IN_PROGRESS',

  KYC_PENDING: 'KYC_PENDING',
  KYC_ALREADY_VERIFIED: 'KYC_ALREADY_VERIFIED',
  KYC_NOT_FOUND: 'KYC_NOT_FOUND',
  KYC_ALREADY_REVIEWED: 'KYC_ALREADY_REVIEWED',

  PAYMENT_PROVIDER_ERROR: 'PAYMENT_PROVIDER_ERROR',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface FieldError {
  field: string;
  message: string;
}

/**
 * The single exception type services throw for expected, client-facing
 * failures. The global filter turns it into the error envelope:
 * `{ success: false, message, code, errors?, requestId }`.
 */
export class AppException extends Error {
  constructor(
    readonly status: HttpStatus,
    readonly code: ErrorCode,
    message: string,
    readonly errors?: FieldError[],
    /** Extra response headers, e.g. Retry-After. */
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppException';
  }

  static badRequest(code: ErrorCode, message: string) {
    return new AppException(HttpStatus.BAD_REQUEST, code, message);
  }

  static unauthorized(code: ErrorCode, message: string) {
    return new AppException(HttpStatus.UNAUTHORIZED, code, message);
  }

  static forbidden(message = 'You do not have permission to perform this action.') {
    return new AppException(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, message);
  }

  static notFound(code: ErrorCode, message: string) {
    return new AppException(HttpStatus.NOT_FOUND, code, message);
  }

  static conflict(code: ErrorCode, message: string) {
    return new AppException(HttpStatus.CONFLICT, code, message);
  }

  /** A well-formed request that breaks a business rule (insufficient funds, limits...). */
  static unprocessable(code: ErrorCode, message: string) {
    return new AppException(HttpStatus.UNPROCESSABLE_ENTITY, code, message);
  }

  static unavailable(message = 'The service is temporarily unavailable. Please retry.') {
    return new AppException(HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.SERVICE_UNAVAILABLE, message);
  }
}
