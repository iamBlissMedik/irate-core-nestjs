import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Give the request an id (reusing a well-formed incoming X-Request-ID) and
 * echo it back. Installed as the FIRST middleware, so even requests rejected
 * by the body parser carry an id in their error body.
 */
export function assignRequestId(req: IncomingMessage, res: ServerResponse): string {
  if (typeof req.id === 'string' && req.id) return req.id;
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  req.id = id;
  res.setHeader('X-Request-ID', id);
  return id;
}

/**
 * Structured JSON logs (pretty in development). Every request gets an id that
 * is echoed in `X-Request-ID` and in error bodies, so a customer's error
 * report can be matched to the exact log lines. Secrets are redacted.
 */
export function loggerConfig(env: { isProduction: boolean; logLevel: string }): Params {
  return {
    pinoHttp: {
      level: env.logLevel,
      genReqId: (req: IncomingMessage, res: ServerResponse) => assignRequestId(req, res),
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-paystack-signature"]',
          'req.headers["x-sandbox-signature"]',
          'res.headers["set-cookie"]',
          '*.password',
          '*.passwordHash',
          '*.accessToken',
          '*.refreshToken',
        ],
        censor: '[REDACTED]',
      },
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
      },
      transport: env.isProduction
        ? undefined
        : { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' } },
    },
  };
}
