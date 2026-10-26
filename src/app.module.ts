import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { LoggerModule } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { EnvelopeInterceptor } from './common/interceptors/envelope.interceptor.js';
import { AppThrottlerGuard } from './common/throttling/app-throttler.guard.js';
import { RedisThrottlerStorage } from './common/throttling/redis-throttler.storage.js';
import { createValidationPipe } from './common/validation/validation.pipe.js';
import { validateEnv, type Env } from './config/env.js';
import { loggerConfig } from './infra/logging/logger.config.js';
import { PrismaModule } from './infra/prisma/prisma.module.js';
import { REDIS, RedisModule } from './infra/redis/redis.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard.js';
import { RolesGuard } from './modules/auth/guards/roles.guard.js';
import { HealthModule } from './modules/health/health.module.js';
import { IdempotencyModule } from './modules/idempotency/idempotency.module.js';
import { KycModule } from './modules/kyc/kyc.module.js';
import { LedgerModule } from './modules/ledger/ledger.module.js';
import { MaintenanceModule } from './modules/maintenance/maintenance.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { TransactionsModule } from './modules/transactions/transactions.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { WalletsModule } from './modules/wallets/wallets.module.js';

const isTest = process.env.NODE_ENV === 'test';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      // Tests configure everything explicitly (test/setup/env.ts).
      ignoreEnvFile: isTest,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        loggerConfig({
          isProduction: config.get('isProduction', { infer: true }),
          logLevel: config.get('LOG_LEVEL', { infer: true }),
        }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [REDIS, ConfigService],
      useFactory: (redis: Redis, config: ConfigService<Env, true>) => {
        const enabled = config.get('RATE_LIMIT_ENABLED', { infer: true });
        return {
          throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
          storage: new RedisThrottlerStorage(redis),
          skipIf: () => !enabled,
        };
      },
    }),
    // Background jobs are off in tests so they can't interfere with assertions.
    ...(isTest ? [] : [ScheduleModule.forRoot()]),

    // Infrastructure (global)
    PrismaModule,
    RedisModule,
    AuditModule,
    LedgerModule,
    IdempotencyModule,

    // Features
    AuthModule,
    UsersModule,
    WalletsModule,
    TransactionsModule,
    KycModule,
    PaymentsModule,
    AdminModule,
    HealthModule,
    MaintenanceModule,
  ],
  providers: [
    // Guards run in this order: authenticate → authorise → rate limit (per user once known).
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useExisting: RolesGuard },
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_PIPE, useFactory: createValidationPipe },
  ],
})
export class AppModule {}
