import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp as TestAppType } from './support/app.js';

/** Rate limiting, probes, headers and error envelopes, with rate limiting ON. */
describe('Platform (e2e)', () => {
  let t: TestAppType;
  let API: string;
  let PASSWORD: string;

  beforeAll(async () => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    const support = await import('./support/app.js');
    ({ API, PASSWORD } = support);
    t = await support.TestApp.create();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  describe('rate limiting', () => {
    it('limits credential endpoints per IP (10/min) with standard headers', async () => {
      const attempts = [];
      for (let i = 0; i < 11; i++) {
        attempts.push(
          await t.http
            .post(`${API}/auth/login`)
            .send({ email: `x${i}@irate.dev`, password: 'Wrong123!' }),
        );
      }
      expect(attempts.slice(0, 10).every((r) => r.status === 401)).toBe(true);
      expect(attempts[0].headers['x-ratelimit-limit']).toBe('10');

      const blocked = attempts[10];
      expect(blocked.status).toBe(429);
      expect(blocked.body.code).toBe('RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('never throttles token refresh (all BFF customers share one IP)', async () => {
      let cookie = (await t.customer()).refreshCookie;
      for (let i = 0; i < 15; i++) {
        const res = await t.http.post(`${API}/auth/refresh`).set('Cookie', cookie);
        expect(res.status).toBe(200);
        cookie = res.headers['set-cookie'][0].split(';')[0];
      }
    });

    it('limits money movement per USER, so customers behind the BFF do not share one budget', async () => {
      const ada = await t.customer('ada@irate.dev');
      const bola = await t.customer('bola@irate.dev');
      const send = (who: { token: string }, to: string) =>
        t.http
          .post(`${API}/transactions/transfer`)
          .set('Authorization', `Bearer ${who.token}`)
          .set('Idempotency-Key', randomUUID())
          .send({ toAccountNumber: to, amount: 1 });

      const adaResults = [];
      for (let i = 0; i < 21; i++) adaResults.push((await send(ada, bola.accountNumber)).status);
      expect(adaResults.slice(0, 20).every((s) => s === 422)).toBe(true); // unfunded: business error, but counted
      expect(adaResults[20]).toBe(429);

      // Same IP, different user: unaffected.
      expect((await send(bola, ada.accountNumber)).status).toBe(422);
    });
  });

  describe('probes', () => {
    it('serves liveness and readiness outside /api/v1, unauthenticated and unenveloped', async () => {
      const health = await t.http.get('/health').expect(200);
      expect(health.body.status).toBe('ok');
      const ready = await t.http.get('/ready').expect(200);
      expect(ready.body).toEqual({ status: 'ready', checks: { database: 'ok', redis: 'ok' } });
      const info = await t.http.get('/').expect(200);
      expect(info.body.success).toBe(true);
    });
  });

  describe('HTTP hygiene', () => {
    it('sends security and no-store headers and a request id on every response', async () => {
      const res = await t.http.get('/health').set('X-Request-ID', 'trace-abc_123');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-request-id']).toBe('trace-abc_123');

      const unsafe = await t.http.get('/health').set('X-Request-ID', 'bad id with spaces');
      expect(unsafe.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('allows only configured CORS origins (and never errors on others)', async () => {
      const allowed = await t.http.get('/health').set('Origin', 'http://localhost:3000');
      expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      const denied = await t.http.get('/health').set('Origin', 'https://evil.example').expect(200);
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('wraps every error in the envelope with a request id', async () => {
      const notFound = await t.http.get(`${API}/does-not-exist`).expect(404);
      expect(notFound.body).toMatchObject({ success: false, code: 'NOT_FOUND' });
      expect(notFound.body.requestId).toBe(notFound.headers['x-request-id']);

      const malformed = await t.http
        .post(`${API}/auth/login`)
        .set('Content-Type', 'application/json')
        .send('{"email":')
        .expect(400);
      expect(malformed.body).toMatchObject({ success: false, code: 'BAD_REQUEST' });
      expect(malformed.body.requestId).toBeTruthy();

      const tooLarge = await t.http
        .post(`${API}/auth/login`)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(200_000) }))
        .expect(413);
      expect(tooLarge.body.code).toBe('PAYLOAD_TOO_LARGE');
      expect(tooLarge.body).not.toHaveProperty('stack');
    });

    it('never leaks secrets in responses', async () => {
      await t.customer('ada@irate.dev');
      const res = await t.http
        .post(`${API}/auth/login`)
        .send({ email: 'ada@irate.dev', password: PASSWORD })
        .expect(200);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$argon2/);
    });
  });
});
