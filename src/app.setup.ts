import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { Env } from './config/env.js';
import { assignRequestId } from './infra/logging/logger.config.js';

export const API_PREFIX = 'api/v1';

/**
 * HTTP-level setup shared by main.ts and the e2e tests, so tests exercise the
 * exact middleware stack production runs.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  // Correct client IPs (rate limits, audit logs) behind N reverse proxies.
  // Trusting X-Forwarded-For with no proxy in front would let clients spoof it.
  app.set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));

  // First: every request (even one the body parser rejects) gets an id.
  app.use(
    (
      req: Parameters<typeof assignRequestId>[0],
      res: Parameters<typeof assignRequestId>[1],
      next: () => void,
    ) => {
      assignRequestId(req, res);
      next();
    },
  );
  app.use(helmet());
  app.use(cookieParser());
  // Responses carry balances and personal data: never cache them anywhere.
  app.use(
    (_req: unknown, res: { setHeader(name: string, value: string): void }, next: () => void) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
  );

  // Exact-origin allowlist. Disallowed origins simply get no CORS headers
  // (the browser blocks them) instead of an error. The BFF calls us
  // server-to-server, so CORS only matters for direct browser clients.
  app.enableCors({
    origin: config.get('CORS_ALLOWED_ORIGINS', { infer: true }),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID', 'Idempotent-Replayed', 'Retry-After'],
  });

  app.setGlobalPrefix(API_PREFIX, { exclude: ['/', 'health', 'ready'] });

  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('iRate Core API')
        .setDescription(
          'Fintech wallet & double-entry ledger API. Money is always an integer number of minor units ' +
            '(kobo), returned as a string. Responses use `{ success, message, data }`; errors use ' +
            '`{ success: false, message, code, errors?, requestId }`.',
        )
        .setVersion('1.0.0')
        .addBearerAuth()
        .addCookieAuth('refreshToken')
        .build(),
    );
    SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/openapi.json' });
  }
}
