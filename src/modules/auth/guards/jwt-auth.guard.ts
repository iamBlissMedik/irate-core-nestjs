import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../../common/decorators/auth.decorators.js';
import { AppException, ErrorCode } from '../../../common/errors/app.exception.js';
import type { AppRequest } from '../../../common/types/request.js';
import { TokenService } from '../token.service.js';

/** Extracts the token from `Authorization: Bearer <token>`. */
export function bearerToken(req: AppRequest): string | undefined {
  const [scheme, token] = (req.header('authorization') ?? '').split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

/**
 * Global guard: every route requires a valid, unrevoked access token unless
 * it is marked `@Public()`. Secure by default.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AppRequest>();
    const token = bearerToken(req);
    if (!token) throw AppException.unauthorized(ErrorCode.UNAUTHORIZED, 'Authentication required.');

    const user = await this.tokens.verifyAccessToken(token);
    await this.tokens.assertNotRevoked(user);
    req.user = user;
    return true;
  }
}
