import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MaintenanceService } from '../src/modules/maintenance/maintenance.service.js';
import { API, bearer, PASSWORD, refreshCookieFrom, TestApp } from './support/app.js';

describe('Auth (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await TestApp.create();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  describe('register', () => {
    it('creates a USER with a wallet and a 10-digit account number', async () => {
      const res = await t.http
        .post(`${API}/auth/register`)
        .send({ email: '  Ada@IRATE.dev ', password: PASSWORD })
        .expect(201);

      expect(res.body).toMatchObject({ success: true, message: 'User registered successfully' });
      expect(res.body.data.user).toMatchObject({ email: 'ada@irate.dev', role: 'USER' });
      expect(res.body.data.user).not.toHaveProperty('passwordHash');
      expect(res.body.data.accountNumber).toMatch(/^[1-9]\d{9}$/);

      const wallet = await t.prisma.wallet.findFirstOrThrow({
        where: { userId: res.body.data.user.id },
      });
      expect(wallet).toMatchObject({ currency: 'NGN', balance: 0n, status: 'ACTIVE' });
    });

    it('rejects a duplicate email regardless of case (409 EMAIL_TAKEN)', async () => {
      await t.http
        .post(`${API}/auth/register`)
        .send({ email: 'ada@irate.dev', password: PASSWORD })
        .expect(201);
      const res = await t.http
        .post(`${API}/auth/register`)
        .send({ email: 'ADA@irate.dev', password: PASSWORD })
        .expect(409);
      expect(res.body.code).toBe('EMAIL_TAKEN');
    });

    it('handles concurrent sign-ups with the same email: one wins, the rest get 409', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          t.http.post(`${API}/auth/register`).send({ email: 'race@irate.dev', password: PASSWORD }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await t.prisma.wallet.count({ where: { kind: 'USER' } })).toBe(1);
    });

    it.each([
      ['short', 'Ab1'],
      ['no upper-case', 'password123'],
      ['no digit', 'Passwordxx'],
    ])('enforces the password policy (%s)', async (_name, password) => {
      const res = await t.http
        .post(`${API}/auth/register`)
        .send({ email: 'ada@irate.dev', password })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('password');
    });

    it('can never create an admin', async () => {
      const res = await t.http
        .post(`${API}/auth/register`)
        .send({ email: 'evil@irate.dev', password: PASSWORD, role: 'ADMIN' })
        .expect(400);
      expect(res.body.errors[0].message).toMatch(/role should not exist/);
    });
  });

  describe('login', () => {
    beforeEach(() =>
      t.http.post(`${API}/auth/register`).send({ email: 'ada@irate.dev', password: PASSWORD }),
    );

    it('returns an access token and sets a hardened refresh cookie', async () => {
      const res = await t.http
        .post(`${API}/auth/login`)
        .send({ email: 'ada@irate.dev', password: PASSWORD })
        .expect(200);

      expect(res.body.data).toMatchObject({
        tokenType: 'Bearer',
        expiresIn: 900,
        user: { email: 'ada@irate.dev', role: 'USER' },
      });
      const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith('refreshToken='),
      )!;
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);

      // Claims the BFF reads to build the session user.
      const claims = JSON.parse(
        Buffer.from(res.body.data.accessToken.split('.')[1], 'base64url').toString(),
      );
      expect(claims).toMatchObject({
        email: 'ada@irate.dev',
        role: 'USER',
        iss: 'irate-core',
        aud: 'irate-api',
      });
      expect(claims.sub).toBe(res.body.data.user.id);
    });

    it('answers unknown emails and wrong passwords identically (no account enumeration)', async () => {
      const wrong = await t.http
        .post(`${API}/auth/login`)
        .send({ email: 'ada@irate.dev', password: 'Wrong123!' })
        .expect(401);
      const unknown = await t.http
        .post(`${API}/auth/login`)
        .send({ email: 'nobody@irate.dev', password: PASSWORD })
        .expect(401);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
      expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
      expect(wrong.body.message).toBe(unknown.body.message);
    });

    it('locks the email after 5 failures, even for the right password, then a success resets it', async () => {
      for (let i = 0; i < 5; i++) {
        await t.http
          .post(`${API}/auth/login`)
          .send({ email: 'ada@irate.dev', password: 'Wrong123!' })
          .expect(401);
      }
      const locked = await t.http
        .post(`${API}/auth/login`)
        .send({ email: 'ada@irate.dev', password: PASSWORD })
        .expect(429);
      expect(locked.body.code).toBe('ACCOUNT_LOCKED');
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);

      await t.redis.flushdb(); // the lockout window elapses
      await t.http
        .post(`${API}/auth/login`)
        .send({ email: 'ada@irate.dev', password: PASSWORD })
        .expect(200);
    });
  });

  describe('access tokens', () => {
    it('rejects tampered, forged and alg=none tokens', async () => {
      const { token } = await t.customer();
      const [header, payload] = token.split('.');
      const elevated = Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
          role: 'ADMIN',
        }),
      ).toString('base64url');

      const tampered = `${header}.${elevated}.${token.split('.')[2]}`;
      const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${elevated}.`;
      const forged = `${header}.${elevated}.${createHmac('sha256', 'guessed-secret').update(`${header}.${elevated}`).digest('base64url')}`;

      for (const bad of [tampered, none, forged, 'garbage']) {
        const res = await t.http
          .get(`${API}/admin/users`)
          .set('Authorization', `Bearer ${bad}`)
          .expect(401);
        expect(res.body.code).toBe('INVALID_ACCESS_TOKEN');
      }
    });
  });

  describe('refresh', () => {
    it('rotates the refresh token and re-reads the role from the database', async () => {
      const ada = await t.customer('ada@irate.dev');
      await t.prisma.user.update({ where: { id: ada.id }, data: { role: 'ADMIN' } });

      const res = await t.http
        .post(`${API}/auth/refresh`)
        .set('Cookie', ada.refreshCookie)
        .expect(200);
      const rotated = refreshCookieFrom(res.headers['set-cookie']);
      expect(rotated).toBeTruthy();
      expect(rotated).not.toBe(ada.refreshCookie);
      expect(res.body.data.user.role).toBe('ADMIN');

      await t.http
        .get(`${API}/admin/users`)
        .set('Authorization', `Bearer ${res.body.data.accessToken}`)
        .expect(200);
      // The rotated token keeps working.
      await t.http.post(`${API}/auth/refresh`).set('Cookie', rotated).expect(200);
    });

    it('refuses a just-rotated token (two tabs racing) without ending the session', async () => {
      const ada = await t.customer();
      const first = await t.http
        .post(`${API}/auth/refresh`)
        .set('Cookie', ada.refreshCookie)
        .expect(200);
      const raced = await t.http
        .post(`${API}/auth/refresh`)
        .set('Cookie', ada.refreshCookie)
        .expect(401);
      expect(raced.body.code).toBe('INVALID_REFRESH_TOKEN');
      await t.http
        .post(`${API}/auth/refresh`)
        .set('Cookie', refreshCookieFrom(first.headers['set-cookie']))
        .expect(200);
    });

    it('treats reuse of an old rotated token as theft and revokes the whole session', async () => {
      const ada = await t.customer();
      const first = await t.http
        .post(`${API}/auth/refresh`)
        .set('Cookie', ada.refreshCookie)
        .expect(200);
      const current = refreshCookieFrom(first.headers['set-cookie']);

      // The attacker replays the stolen original after the grace window.
      await t.prisma.refreshToken.updateMany({
        where: { rotatedAt: { not: null } },
        data: { rotatedAt: new Date(Date.now() - 60_000) },
      });
      await t.http.post(`${API}/auth/refresh`).set('Cookie', ada.refreshCookie).expect(401);

      // ...so the legitimate (latest) token is dead too, and the event is audited.
      await t.http.post(`${API}/auth/refresh`).set('Cookie', current).expect(401);
      expect(
        await t.prisma.auditLog.count({ where: { action: 'REFRESH_TOKEN_REUSE_DETECTED' } }),
      ).toBe(1);
    });

    it('fails with 401 and clears the cookie when there is no or an unknown token', async () => {
      const none = await t.http.post(`${API}/auth/refresh`).expect(401);
      expect(none.body.code).toBe('INVALID_REFRESH_TOKEN');
      const unknown = await t.http
        .post(`${API}/auth/refresh`)
        .set('Cookie', 'refreshToken=nope')
        .expect(401);
      expect(String(unknown.headers['set-cookie'])).toMatch(/refreshToken=;/);
    });

    it('supports several devices at once (one session per login)', async () => {
      const ada = await t.customer('ada@irate.dev');
      const laptop = await t.login('ada@irate.dev');
      await t.http.post(`${API}/auth/refresh`).set('Cookie', ada.refreshCookie).expect(200);
      await t.http.post(`${API}/auth/refresh`).set('Cookie', laptop.refreshCookie).expect(200);
    });
  });

  describe('logout', () => {
    it('revokes the access token and the refresh session', async () => {
      const ada = await t.customer();
      await t.http
        .post(`${API}/auth/logout`)
        .set(bearer(ada))
        .set('Cookie', ada.refreshCookie)
        .expect(200);

      const res = await t.http.get(`${API}/users/me`).set(bearer(ada)).expect(401);
      expect(res.body.code).toBe('INVALID_ACCESS_TOKEN');
      await t.http.post(`${API}/auth/refresh`).set('Cookie', ada.refreshCookie).expect(401);
    });

    it('works with only the refresh cookie (expired access token) and never fails', async () => {
      const ada = await t.customer();
      await t.http.post(`${API}/auth/logout`).set('Cookie', ada.refreshCookie).expect(200);
      await t.http.post(`${API}/auth/refresh`).set('Cookie', ada.refreshCookie).expect(401);
      await t.http.post(`${API}/auth/logout`).expect(200);
    });

    it('logout-all ends every session on every device', async () => {
      const phone = await t.customer('ada@irate.dev');
      const laptop = await t.login('ada@irate.dev');

      await t.http.post(`${API}/auth/logout-all`).set(bearer(phone)).expect(200);

      await t.http.get(`${API}/users/me`).set(bearer(laptop)).expect(401);
      await t.http.post(`${API}/auth/refresh`).set('Cookie', laptop.refreshCookie).expect(401);
      await t.http.post(`${API}/auth/refresh`).set('Cookie', phone.refreshCookie).expect(401);

      // Logging in again afterwards works (tokens are issued in a later second).
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const fresh = await t.login('ada@irate.dev');
      await t.http.get(`${API}/users/me`).set(bearer(fresh)).expect(200);
    });
  });
  describe('maintenance', () => {
    it('prunes only expired idempotency keys and long-dead refresh tokens', async () => {
      const ada = await t.customer();
      const day = 86_400_000;
      await t.prisma.idempotencyKey.createMany({
        data: [
          {
            userId: ada.id,
            scope: 'transfer',
            key: 'old-key-0001',
            requestHash: 'h',
            responseBody: {},
            createdAt: new Date(Date.now() - 2 * day),
          },
          {
            userId: ada.id,
            scope: 'transfer',
            key: 'new-key-0001',
            requestHash: 'h',
            responseBody: {},
          },
        ],
      });
      await t.prisma.refreshToken.updateMany({
        data: { expiresAt: new Date(Date.now() - 8 * day) },
      });
      await t.login(ada.email); // a live session that must survive

      await t.app.get(MaintenanceService).pruneExpiredRecords();

      expect((await t.prisma.idempotencyKey.findMany()).map((k) => k.key)).toEqual([
        'new-key-0001',
      ]);
      expect(await t.prisma.refreshToken.count()).toBe(1);
    });
  });
});
