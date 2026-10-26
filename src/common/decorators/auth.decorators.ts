import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import type { UserRole } from '../../generated/prisma/enums.js';
import type { AppRequest, AuthUser } from '../types/request.js';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const ROLES_KEY = 'auth:roles';

/** Opt a route out of the global JwtAuthGuard. Everything is private by default. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restrict a route (or a whole controller) to the given roles. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** The authenticated caller. Only valid on routes behind the JwtAuthGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const user = ctx.switchToHttp().getRequest<AppRequest>().user;
    // Unreachable unless a route is wrongly marked @Public().
    if (!user) throw new UnauthorizedException();
    return user;
  },
);
