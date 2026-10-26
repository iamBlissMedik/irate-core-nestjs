import {
  ArgumentsHost,
  BadRequestException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AppException, ErrorCode } from '../errors/app.exception.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

function run(exception: unknown) {
  const res = {
    headersSent: false,
    set: vi.fn<(headers: Record<string, string>) => void>(),
    status: vi.fn<(code: number) => unknown>(),
    json: vi.fn<(body: unknown) => void>(),
  };
  res.status.mockReturnValue(res);
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ id: 'req-1', method: 'GET', originalUrl: '/x' }),
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return {
    status: res.status.mock.calls[0][0] as number,
    body: res.json.mock.calls[0][0] as Record<string, unknown>,
    headers: res.set.mock.calls[0]?.[0],
  };
}

describe('AllExceptionsFilter', () => {
  beforeAll(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('renders AppExceptions as the error envelope', () => {
    const out = run(
      new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        ErrorCode.ACCOUNT_LOCKED,
        'Locked',
        undefined,
        { 'Retry-After': '60' },
      ),
    );
    expect(out.status).toBe(429);
    expect(out.body).toEqual({
      success: false,
      message: 'Locked',
      code: 'ACCOUNT_LOCKED',
      requestId: 'req-1',
    });
    expect(out.headers).toEqual({ 'Retry-After': '60' });
  });

  it('maps framework exceptions to stable codes', () => {
    expect(run(new ThrottlerException()).body.code).toBe('RATE_LIMITED');
    expect(run(new NotFoundException('Cannot GET /x')).body).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Cannot GET /x',
    });
    expect(run(new BadRequestException('Unexpected token')).body.code).toBe('BAD_REQUEST');
    expect(run({ status: 413, type: 'entity.too.large' }).body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('turns lock contention into a retryable 503', () => {
    const out = run({ meta: { driverAdapterError: { cause: { originalCode: '55P03' } } } });
    expect(out.status).toBe(503);
    expect(out.headers).toEqual({ 'Retry-After': '1' });
  });

  it('hides internal errors behind a generic 500', () => {
    const out = run(new Error('connection string postgres://secret@db'));
    expect(out.status).toBe(500);
    expect(out.body).toEqual({
      success: false,
      message: 'Something went wrong on our side. Please try again.',
      code: 'INTERNAL_ERROR',
      requestId: 'req-1',
    });
  });
});
