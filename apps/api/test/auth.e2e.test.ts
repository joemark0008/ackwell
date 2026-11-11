import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, signIn, startApp, stopApp, TEST_ORIGIN, type TestContext } from './helpers.js';

let ctx: TestContext;
const http = () => request(ctx.app.getHttpServer());

beforeAll(async () => {
  ctx = await startApp();
});
afterAll(async () => {
  await stopApp(ctx);
});

describe('auth', () => {
  it('rejects API calls without a session (401 UNAUTHENTICATED)', async () => {
    const r = await http().get('/api/channels').expect(401);
    expect(r.body.code).toBe('UNAUTHENTICATED');
    await http().post('/api/channels').send({}).expect(401);
    await http().get('/api/settings').expect(401);
  });

  it('keeps /health public', async () => {
    await http().get('/health').expect(200);
  });

  it('does not need the setup wizard when the admin was seeded', async () => {
    const r = await http().get('/api/setup/status').expect(200);
    expect(r.body).toEqual({ needed: false });
    const v = await http().post('/api/setup/verify').send({ token: 'AAAAA-AAAAA-AAAAA-AAAAA' }).expect(409);
    expect(v.body.code).toBe('SETUP_DONE');
  });

  it('seeded the first admin exactly once', async () => {
    const { AdminSeedService } = await import('../src/auth/admin-seed.service.js');
    await ctx.app.get(AdminSeedService).onApplicationBootstrap(); // second run is a no-op
    const { DB } = await import('../src/db/db.js');
    const { authUser } = await import('../src/db/schema.js');
    const rows = await ctx.app.get(DB).select().from(authUser);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: ADMIN.email, emailVerified: true });
  });

  it('rejects a wrong password', async () => {
    await http()
      .post('/api/auth/sign-in/email')
      .set('Origin', TEST_ORIGIN)
      .send({ email: ADMIN.email, password: 'wrong-password-123' })
      .expect(401);
  });

  it('public sign-up is disabled', async () => {
    const r = await http()
      .post('/api/auth/sign-up/email')
      .set('Origin', TEST_ORIGIN)
      .send({ email: 'intruder@example.test', password: 'long-enough-password', name: 'x' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it('signs in, reads the session, calls the API, then signs out', async () => {
    const cookie = await signIn(ctx.app);
    expect(cookie).toContain('better-auth.session_token=');

    const s = await http().get('/api/auth/get-session').set('Cookie', cookie).expect(200);
    expect(s.body.user.email).toBe(ADMIN.email);

    await http().get('/api/channels').set('Cookie', cookie).expect(200);
    const settings = await http().get('/api/settings').set('Cookie', cookie).expect(200);
    expect(settings.body).toEqual({ mllp: { host: 'localhost', portRange: { from: 6000, to: 6050 } }, retentionDefaultDays: 7 });

    await http().post('/api/auth/sign-out').set('Origin', TEST_ORIGIN).set('Cookie', cookie).send({}).expect(200);
    await http().get('/api/channels').set('Cookie', cookie).expect(401);
  });

  it('rejects a sign-in from an untrusted origin', async () => {
    const r = await http()
      .post('/api/auth/sign-in/email')
      .set('Origin', 'https://evil.example')
      .send(ADMIN);
    expect(r.status).toBe(403);
  });
});
