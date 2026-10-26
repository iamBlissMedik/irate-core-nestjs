import {
  BeforeApplicationShutdown,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Logger,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { Public } from '../../common/decorators/auth.decorators.js';
import { ResponseMessage, SkipEnvelope } from '../../common/decorators/http.decorators.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { REDIS } from '../../infra/redis/redis.module.js';

type Check = 'ok' | 'unavailable';

/** Probes live outside /api/v1 and are never rate limited or authenticated. */
@ApiTags('System')
@Public()
@SkipThrottle()
@Controller()
export class HealthController implements BeforeApplicationShutdown {
  private readonly logger = new Logger('Shutdown');
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  beforeApplicationShutdown(signal?: string): void {
    // Tell the load balancer to stop sending traffic while in-flight requests finish.
    this.draining = true;
    this.logger.log(`${signal ?? 'Shutdown'} received: draining in-flight requests`);
  }

  @Get()
  @ResponseMessage('Welcome to iRate Core (NestJS)')
  @ApiOperation({ summary: 'Service info' })
  info() {
    return { version: process.env.npm_package_version ?? '1.0.0' };
  }

  @Get('health')
  @SkipEnvelope()
  @ApiOperation({ summary: 'Liveness: the process is up (never checks dependencies)' })
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @SkipEnvelope()
  @ApiOperation({ summary: 'Readiness: PostgreSQL and Redis reachable and not shutting down' })
  async ready(@Res({ passthrough: true }) res: Response) {
    if (this.draining) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'draining' };
    }
    const [database, redis] = await Promise.all([
      this.check(() => this.prisma.$queryRaw`SELECT 1`),
      this.check(() => this.redis.ping()),
    ]);
    const ready = database === 'ok' && redis === 'ok';
    if (!ready) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ready' : 'degraded', checks: { database, redis } };
  }

  private async check(probe: () => Promise<unknown>): Promise<Check> {
    try {
      await probe();
      return 'ok';
    } catch {
      return 'unavailable';
    }
  }
}
