import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, ErrorCode } from '../../common/errors/app.exception.js';
import type { Actor, AuthUser } from '../../common/types/request.js';
import type { Env } from '../../config/env.js';
import { isUniqueViolation } from '../../infra/prisma/prisma-errors.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import { toAuthUserView } from '../users/user.presenter.js';
import { WalletsService } from '../wallets/wallets.service.js';
import type { LoginDto, RegisterDto } from './dto/auth.dto.js';
import { LoginLockoutService } from './login-lockout.service.js';
import { PasswordService } from './password.service.js';
import { RefreshTokenService, type SessionMeta } from './refresh-token.service.js';
import { TokenService } from './token.service.js';

const emailTaken = () =>
  AppException.conflict(ErrorCode.EMAIL_TAKEN, 'An account with this email already exists.');

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly lockout: LoginLockoutService,
    private readonly wallets: WalletsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Creates a USER and their default wallet atomically. Self sign-up can never create an admin. */
  async register(dto: RegisterDto, actor: Actor) {
    if (await this.prisma.user.findUnique({ where: { email: dto.email }, select: { id: true } })) {
      throw emailTaken();
    }
    // Hash outside the transaction: argon2 is deliberately slow.
    const passwordHash = await this.passwords.hash(dto.password);
    const currency = this.config.get('DEFAULT_CURRENCY', { infer: true });

    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email: dto.email, passwordHash, role: 'USER' },
        });
        const wallet = await this.wallets.createForUser(tx, user.id, currency);
        await this.audit.record(
          {
            action: AuditAction.USER_REGISTERED,
            actor: { ...actor, userId: user.id },
            resourceType: 'user',
            resourceId: user.id,
          },
          tx,
        );
        return { user: toAuthUserView(user), accountNumber: wallet.accountNumber };
      });
    } catch (err) {
      // Two sign-ups with the same email raced past the pre-check.
      if (isUniqueViolation(err, 'users_email_key')) throw emailTaken();
      throw err;
    }
  }

  async login(dto: LoginDto, meta: SessionMeta) {
    await this.lockout.assertNotLocked(dto.email);

    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    // Always run argon2 (against a dummy hash for unknown emails) so the
    // response time doesn't reveal whether the account exists.
    const valid = await this.passwords.verify(user?.passwordHash, dto.password);
    if (!user || !valid) {
      await this.lockout.recordFailure(dto.email);
      throw AppException.unauthorized(ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password.');
    }
    await this.lockout.reset(dto.email);

    if (this.passwords.needsRehash(user.passwordHash)) {
      const passwordHash = await this.passwords.hash(dto.password);
      await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    }

    const refreshToken = await this.refreshTokens.issue(this.prisma, user.id, meta);
    const access = await this.tokens.signAccessToken(user);
    return { session: { ...access, user: toAuthUserView(user) }, refreshToken };
  }

  /** Rotates the refresh token. The role is re-read from the database, never copied from the old token. */
  async refresh(rawToken: string | undefined, meta: SessionMeta) {
    if (!rawToken) {
      throw AppException.unauthorized(
        ErrorCode.INVALID_REFRESH_TOKEN,
        'No session to refresh. Please log in.',
      );
    }
    const { user, token } = await this.refreshTokens.rotate(rawToken, meta);
    const access = await this.tokens.signAccessToken(user);
    return { session: { ...access, user: toAuthUserView(user) }, refreshToken: token };
  }

  /**
   * Ends the current session with whatever credentials are presented, so it
   * also works when the access token has already expired. Never fails.
   */
  async logout(bearer: string | undefined, rawRefreshToken: string | undefined): Promise<void> {
    const tasks: Promise<void>[] = [];
    if (bearer) {
      tasks.push(this.tokens.verifyAccessToken(bearer).then((user) => this.tokens.revoke(user)));
    }
    if (rawRefreshToken) tasks.push(this.refreshTokens.revokeFamilyOf(rawRefreshToken));

    for (const result of await Promise.allSettled(tasks)) {
      if (result.status === 'rejected' && !(result.reason instanceof AppException)) {
        this.logger.warn(`Logout cleanup failed: ${(result.reason as Error).message}`);
      }
    }
  }

  /** Ends every session on every device: refresh tokens revoked, outstanding access tokens rejected. */
  async logoutAll(user: AuthUser, actor: Actor): Promise<void> {
    await this.refreshTokens.revokeAllFor(user.id, actor);
    await this.tokens.revokeAllFor(user.id);
  }
}
