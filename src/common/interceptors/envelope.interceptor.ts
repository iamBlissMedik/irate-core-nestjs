import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, Observable } from 'rxjs';
import { RESPONSE_MESSAGE_KEY, SKIP_ENVELOPE_KEY } from '../decorators/http.decorators.js';

export interface SuccessEnvelope<T> {
  success: true;
  message: string;
  data: T | null;
}

/**
 * Wraps every handler result in `{ success: true, message, data }` (the shape
 * @irate/contracts expects). Controllers just return data; the message comes
 * from `@ResponseMessage()`.
 */
@Injectable()
export class EnvelopeInterceptor<T> implements NestInterceptor<T, SuccessEnvelope<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<SuccessEnvelope<T> | T> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_ENVELOPE_KEY, targets)) {
      return next.handle();
    }
    const message = this.reflector.getAllAndOverride<string>(RESPONSE_MESSAGE_KEY, targets) ?? 'OK';
    return next.handle().pipe(map((data) => ({ success: true, message, data: data ?? null })));
  }
}
