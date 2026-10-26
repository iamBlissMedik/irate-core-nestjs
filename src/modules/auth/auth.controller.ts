import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { CookieOptions, Response } from 'express';
import { CurrentUser, Public } from '../../common/decorators/auth.decorators.js';
import { ResponseMessage } from '../../common/decorators/http.decorators.js';
import { ThrottlePolicy } from '../../common/throttling/throttle-policies.js';
import { actorFrom, type AppRequest, type AuthUser } from '../../common/types/request.js';
import type { Env } from '../../config/env.js';
import { AuthService } from './auth.service.js';
import { LoginDto, RegisterDto } from './dto/auth.dto.js';
import { bearerToken } from './guards/jwt-auth.guard.js';
import { RefreshTokenService, type SessionMeta } from './refresh-token.service.js';

/** Cookie name the BFF (@irate/bff) reads and sends back on /auth/refresh. */
export const REFRESH_COOKIE = 'refreshToken';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  private readonly cookieOptions: CookieOptions;

  constructor(
    private readonly auth: AuthService,
    refreshTokens: RefreshTokenService,
    config: ConfigService<Env, true>,
  ) {
    this.cookieOptions = {
      httpOnly: true,
      secure: config.get('COOKIE_SECURE', { infer: true }),
      sameSite: 'strict',
      // The refresh token is only ever sent to the auth endpoints.
      path: '/api/v1/auth',
      maxAge: refreshTokens.maxAgeMs,
    };
  }

  @Public()
  @ThrottlePolicy.credentials()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ResponseMessage('User registered successfully')
  @ApiOperation({ summary: 'Register a customer (creates the user and their wallet)' })
  register(@Body() dto: RegisterDto, @Req() req: AppRequest) {
    return this.auth.register(dto, actorFrom(req));
  }

  @Public()
  @ThrottlePolicy.credentials()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Login successful')
  @ApiOperation({
    summary: 'Log in: access token in the body, refresh token in an httpOnly cookie',
  })
  async login(
    @Body() dto: LoginDto,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { session, refreshToken } = await this.auth.login(dto, sessionMeta(req));
    res.cookie(REFRESH_COOKIE, refreshToken, this.cookieOptions);
    return session;
  }

  // Not rate limited: refresh tokens are single-use 256-bit random values, so
  // there is nothing to brute-force, and behind the BFF every customer shares
  // one IP, so a per-IP limit here would log everyone out under load.
  @Public()
  @SkipThrottle()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Access token refreshed')
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiOperation({ summary: 'Rotate the refresh token and get a new access token' })
  async refresh(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    try {
      const { session, refreshToken } = await this.auth.refresh(
        readRefreshCookie(req),
        sessionMeta(req),
      );
      res.cookie(REFRESH_COOKIE, refreshToken, this.cookieOptions);
      return session;
    } catch (err) {
      res.clearCookie(REFRESH_COOKIE, { ...this.cookieOptions, maxAge: undefined });
      throw err;
    }
  }

  @Public()
  @SkipThrottle()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Logged out successfully')
  @ApiOperation({
    summary: 'End this session (works with the access token, the refresh cookie, or both)',
  })
  async logout(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(bearerToken(req), readRefreshCookie(req));
    res.clearCookie(REFRESH_COOKIE, { ...this.cookieOptions, maxAge: undefined });
    return null;
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Logged out of all sessions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'End every session on every device' })
  async logoutAll(
    @CurrentUser() user: AuthUser,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logoutAll(user, actorFrom(req));
    res.clearCookie(REFRESH_COOKIE, { ...this.cookieOptions, maxAge: undefined });
    return null;
  }
}

function readRefreshCookie(req: AppRequest): string | undefined {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
}

function sessionMeta(req: AppRequest): SessionMeta {
  return { userAgent: req.header('user-agent'), ip: req.ip, requestId: req.id };
}
