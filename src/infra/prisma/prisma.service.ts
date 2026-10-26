import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Env } from '../../config/env.js';
import { Prisma, PrismaClient } from '../../generated/prisma/client.js';

/** The client handed to callbacks of `prisma.$transaction(async (tx) => ...)`. */
export type Tx = Prisma.TransactionClient;

/** Options for every money-moving transaction. */
export const MONEY_TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  // How long to wait for a pooled connection, and the hard cap on the whole
  // transaction. Row-lock waits are bounded separately (applyLockTimeout).
  maxWait: 5_000,
  timeout: 15_000,
} as const;

/** How long a money transaction waits for a row lock before failing with a retryable 503. */
const LOCK_TIMEOUT = '5s';

/**
 * Bound row-lock waits for the rest of the current transaction (SET LOCAL),
 * so a hot wallet fails fast instead of piling up connections.
 */
export async function applyLockTimeout(tx: Tx): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  constructor(config: ConfigService<Env, true>) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
        max: 20,
        // Pin the session to UTC. With any other server TimeZone the pg driver
        // adapter writes JS Dates as local wall-clock time and reads timestamptz
        // values without their offset, which silently shifts every timestamp
        // compared in SQL (daily limits, "today" stats) by the zone offset.
        options: '-c TimeZone=UTC',
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  // Not onModuleDestroy: Nest runs that BEFORE closing the HTTP server, which
  // would cut off requests still in flight during a graceful shutdown.
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
    new Logger('Shutdown').log('Database connections closed');
  }
}
