import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';
import { isLockContention, isUniqueViolation } from '../../infra/prisma/prisma-errors.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AppException, ErrorCode, FieldError } from '../errors/app.exception.js';
import type { AppRequest } from '../types/request.js';

interface ErrorResponse {
  status: number;
  code: ErrorCode;
  message: string;
  errors?: FieldError[];
  headers?: Record<string, string>;
}

/**
 * Turns every error into the error envelope:
 * `{ success: false, message, code, errors?, requestId }`.
 *
 * Expected failures (4xx) are already logged by the HTTP access log; only
 * unexpected ones (5xx) are logged here, with the stack. Internal details are
 * never sent to clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<AppRequest>();
    const res = http.getResponse<Response>();
    const error = this.toErrorResponse(exception);

    if (error.status >= 500) {
      this.logger.error(
        { err: exception, requestId: req.id, method: req.method, url: req.originalUrl },
        'Unhandled error',
      );
    }

    if (res.headersSent) return;
    if (error.headers) res.set(error.headers);
    res.status(error.status).json({
      success: false,
      message: error.message,
      code: error.code,
      ...(error.errors?.length ? { errors: error.errors } : {}),
      requestId: req.id,
    });
  }

  private toErrorResponse(exception: unknown): ErrorResponse {
    if (exception instanceof AppException) {
      return {
        status: exception.status,
        code: exception.code,
        message: exception.message,
        errors: exception.errors,
        headers: exception.headers,
      };
    }

    if (exception instanceof ThrottlerException) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: ErrorCode.RATE_LIMITED,
        message: 'Too many requests. Please slow down and try again shortly.',
      };
    }

    if (exception instanceof HttpException) {
      return fromHttpStatus(exception.getStatus(), exception.message);
    }

    // Two requests raced on the same rows and one gave up waiting: retryable.
    if (isLockContention(exception)) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: ErrorCode.SERVICE_UNAVAILABLE,
        message: 'The account is busy processing another request. Please retry.',
        headers: { 'Retry-After': '1' },
      };
    }
    if (isUniqueViolation(exception)) {
      return {
        status: HttpStatus.CONFLICT,
        code: ErrorCode.CONFLICT,
        message: 'The request conflicts with the current state of the resource.',
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2025') {
      return {
        status: HttpStatus.NOT_FOUND,
        code: ErrorCode.NOT_FOUND,
        message: 'Resource not found.',
      };
    }

    // Errors raised by Express middleware (body-parser) carry an HTTP status.
    const status = httpStatusOf(exception);
    if (status && status < 500) return fromHttpStatus(status);

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Something went wrong on our side. Please try again.',
    };
  }
}

/**
 * Maps a bare HTTP status (from Nest's HttpExceptions or Express middleware
 * such as body-parser) to the envelope. 4xx messages from HttpExceptions are
 * client-facing by design and are kept; 5xx details never leave the server.
 */
function fromHttpStatus(status: number, message?: string): ErrorResponse {
  const codes: Record<number, ErrorCode> = {
    [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHORIZED,
    [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
    [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
    [HttpStatus.PAYLOAD_TOO_LARGE]: ErrorCode.PAYLOAD_TOO_LARGE,
    [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
    [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.SERVICE_UNAVAILABLE,
  };
  if (status >= 500 && status !== HttpStatus.SERVICE_UNAVAILABLE) {
    return {
      status,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Something went wrong on our side. Please try again.',
    };
  }
  return {
    status,
    code: codes[status] ?? ErrorCode.BAD_REQUEST,
    message: message ?? defaultMessage(status),
  };
}

function defaultMessage(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'The request body is malformed.';
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return 'The request body is too large.';
    case HttpStatus.SERVICE_UNAVAILABLE:
      return 'The service is temporarily unavailable. Please retry.';
    default:
      return 'The request could not be processed.';
  }
}

function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  const value = typeof status === 'number' ? status : statusCode;
  return typeof value === 'number' && value >= 400 && value < 600 ? value : undefined;
}
