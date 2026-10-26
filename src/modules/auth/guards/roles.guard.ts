import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../../common/decorators/auth.decorators.js';
import { AppException } from '../../../common/errors/app.exception.js';
import type { AppRequest } from '../../../common/types/request.js';
import type { UserRole } from '../../../generated/prisma/enums.js';

/** Enforces `@Roles(...)`. Runs after the JwtAuthGuard. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;

    const user = context.switchToHttp().getRequest<AppRequest>().user;
    if (!user || !roles.includes(user.role)) throw AppException.forbidden();
    return true;
  }
}
