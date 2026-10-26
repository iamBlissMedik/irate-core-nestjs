import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { PrismaService } from '../../src/infra/prisma/prisma.service.js';
import { REDIS } from '../../src/infra/redis/redis.module.js';
import { PasswordService } from '../../src/modules/auth/password.service.js';
import { SystemWalletsService } from '../../src/modules/ledger/system-wallets.service.js';

export const API = '/api/v1';
export const PASSWORD = 'Password123!';

export interface Session {
  id: string;
  email: string;
  token: string;
  refreshCookie: string;
  walletId: string;
  accountNumber: string;
}

/**
 * Boots the REAL application (same modules, guards, filters and middleware
 * as production) against the test database and Redis.
 */
export class TestApp {
  private constructor(
    readonly app: NestExpressApplication,
    readonly prisma: PrismaService,
    readonly redis: Redis,
    private readonly baseUrl: string,
  ) {}

  static async create(): Promise<TestApp> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({
      rawBody: true,
      bufferLogs: true,
    });
    configureApp(app);
    // Listen once on a random port (supertest would otherwise re-bind per request).
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    return new TestApp(
      app,
      app.get(PrismaService),
      app.get(REDIS),
      url.replace('[::1]', '127.0.0.1'),
    );
  }

  get http(): TestAgent {
    return request(this.baseUrl);
  }

  async close(): Promise<void> {
    await this.app.close();
  }

  /** Empty every table and Redis, then recreate the system wallets. */
  async reset(): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      'TRUNCATE users, refresh_tokens, kyc_records, wallets, transactions, ledger_entries, idempotency_keys, audit_logs, deposits, webhook_events RESTART IDENTITY CASCADE',
    );
    await this.redis.flushdb();
    await this.app.get(SystemWalletsService).ensure();
  }

  /** Register + log in a customer; returns their token and wallet. */
  async customer(email = `user-${randomUUID().slice(0, 8)}@irate.dev`): Promise<Session> {
    const reg = await this.http
      .post(`${API}/auth/register`)
      .send({ email, password: PASSWORD })
      .expect(201);
    const session = await this.login(email);
    const wallet = await this.prisma.wallet.findFirstOrThrow({
      where: { userId: reg.body.data.user.id },
    });
    return { ...session, walletId: wallet.id, accountNumber: wallet.accountNumber };
  }

  /** Create an admin directly (admins can't self-register) and log in. */
  async admin(email = `admin-${randomUUID().slice(0, 8)}@irate.dev`): Promise<Session> {
    const passwordHash = await this.app.get(PasswordService).hash(PASSWORD);
    await this.prisma.user.create({ data: { email, passwordHash, role: 'ADMIN' } });
    return { ...(await this.login(email)), walletId: '', accountNumber: '' };
  }

  async login(email: string, password = PASSWORD) {
    const res = await this.http.post(`${API}/auth/login`).send({ email, password }).expect(200);
    return {
      id: res.body.data.user.id as string,
      email,
      token: res.body.data.accessToken as string,
      refreshCookie: refreshCookieFrom(res.headers['set-cookie']),
    };
  }

  /** Fund a wallet through the real admin-credit path (balanced against ADJUSTMENTS). */
  async fund(walletId: string, amount: number, admin?: Session): Promise<void> {
    const actor = admin ?? (await this.admin());
    await this.http
      .post(`${API}/admin/credit/${walletId}`)
      .set('Authorization', `Bearer ${actor.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount, reason: 'Test funding' })
      .expect(200);
  }

  async balance(walletId: string): Promise<bigint> {
    return (await this.prisma.wallet.findUniqueOrThrow({ where: { id: walletId } })).balance;
  }

  async verifyKyc(session: Session, fullName = 'Test Customer'): Promise<void> {
    await this.http
      .post(`${API}/kyc/submit`)
      .set('Authorization', `Bearer ${session.token}`)
      .send({
        fullName,
        dateOfBirth: '1990-01-01',
        address: '1 Test Street, Lagos',
        idType: 'PASSPORT',
        idNumber: 'A1234567',
      })
      .expect(201);
    await this.prisma.kycRecord.update({
      where: { userId: session.id },
      data: { status: 'VERIFIED', verifiedAt: new Date() },
    });
  }

  async reconciliation() {
    const admin = await this.admin();
    const res = await this.http
      .get(`${API}/admin/reconciliation`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    return res.body.data as { healthy: boolean };
  }
}

export function refreshCookieFrom(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = cookies.find((c) => c.startsWith('refreshToken='));
  return cookie ? cookie.split(';')[0] : '';
}

/** The Postgres error text behind a Prisma error (Prisma's own message can be misleading). */
export function dbErrorText(err: unknown): string {
  return JSON.stringify((err as { meta?: unknown }).meta ?? String(err));
}

export const bearer = (session: { token: string }) => ({
  Authorization: `Bearer ${session.token}`,
});
