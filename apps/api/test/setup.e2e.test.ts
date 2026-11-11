import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, stopApp, TEST_ORIGIN, type TestContext } from './helpers.js';

let ctx: TestContext;
const http = () => request(ctx.app.getHttpServer());
const TOKEN_RE = /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/;

async function service() {
  const { SetupService } = await import('../src/auth/setup.service.js');
  return ctx.app.get(SetupService);
}

beforeAll(async () => {
  // No SEED_ADMIN_* → the user table is empty and the wizard takes over.
  ctx = await startApp({ SEED_ADMIN_EMAIL: '', SEED_ADMIN_PASSWORD: '' });
});
afterAll(async () => {
  await stopApp(ctx);
});

describe('first-run setup wizard', () => {
  it('reports that setup is needed and holds a printable token', async () => {
    const r = await http().get('/api/setup/status').expect(200);
    expect(r.body).toEqual({ needed: true });
    expect((await service()).currentToken()).toMatch(TOKEN_RE);
  });

  it('keeps every other route locked meanwhile', async () => {
    await http().get('/api/channels').expect(401);
  });

  it('rejects a wrong token and rotates it after five misses', async () => {
    const svc = await service();
    const before = svc.currentToken();
    for (let i = 0; i < 4; i++) {
      const r = await http().post('/api/setup/verify').send({ token: 'AAAAA-AAAAA-AAAAA-AAAAA' }).expect(401);
      expect(r.body.code).toBe('SETUP_TOKEN_INVALID');
    }
    expect(svc.currentToken()).toBe(before);
    await http().post('/api/setup/verify').send({ token: 'AAAAA-AAAAA-AAAAA-AAAAA' }).expect(401);
    expect(svc.currentToken()).toMatch(TOKEN_RE);
    expect(svc.currentToken()).not.toBe(before);
  });

  it('accepts the token typed in lower case with other separators', async () => {
    const token = (await service()).currentToken()!;
    await http()
      .post('/api/setup/verify')
      .send({ token: token.toLowerCase().replace(/-/g, ' ') })
      .expect(204);
  });

  it('validates the admin fields', async () => {
    const token = (await service()).currentToken()!;
    const r = await http()
      .post('/api/setup/complete')
      .send({ token, email: 'not-an-email', password: 'short' })
      .expect(400);
    expect(r.body.code).toBe('VALIDATION_ERROR');
    expect(r.body.issues.map((i: { path: string }) => i.path).sort()).toEqual(['email', 'password']);
    expect((await http().get('/api/setup/status')).body.needed).toBe(true);
  });

  it('refuses to create the admin with a wrong token', async () => {
    const r = await http()
      .post('/api/setup/complete')
      .send({ token: 'BBBBB-BBBBB-BBBBB-BBBBB', email: 'admin@ackwell.test', password: 'correct-horse-battery' })
      .expect(401);
    expect(r.body.code).toBe('SETUP_TOKEN_INVALID');
  });

  it('creates the first admin, signs them in, and then closes the wizard for good', async () => {
    const token = (await service()).currentToken()!;
    const r = await http()
      .post('/api/setup/complete')
      .set('Origin', TEST_ORIGIN)
      .send({ token, name: 'Ops', email: 'ops@ackwell.test', password: 'correct-horse-battery' })
      .expect(201);
    expect(r.body).toMatchObject({ signedIn: true, user: { email: 'ops@ackwell.test', name: 'Ops' } });
    const cookies = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
    const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
    expect(cookie).toContain('better-auth.session_token=');

    // The cookie is a real session and the API is open to it.
    const s = await http().get('/api/auth/get-session').set('Cookie', cookie).expect(200);
    expect(s.body.user.email).toBe('ops@ackwell.test');
    await http().get('/api/channels').set('Cookie', cookie).expect(200);

    // The wizard is over: status flips, the token is gone, and every setup call is a 409.
    expect((await http().get('/api/setup/status').expect(200)).body).toEqual({ needed: false });
    expect((await service()).currentToken()).toBeNull();
    const again = await http()
      .post('/api/setup/complete')
      .send({ token, email: 'intruder@ackwell.test', password: 'correct-horse-battery' })
      .expect(409);
    expect(again.body.code).toBe('SETUP_DONE');
    await http().post('/api/setup/verify').send({ token }).expect(409);

    // Exactly one user exists, and the normal password sign-in works for it.
    const { DB } = await import('../src/db/db.js');
    const { authUser } = await import('../src/db/schema.js');
    expect(await ctx.app.get(DB).select().from(authUser)).toHaveLength(1);
    await http()
      .post('/api/auth/sign-in/email')
      .set('Origin', TEST_ORIGIN)
      .send({ email: 'ops@ackwell.test', password: 'correct-horse-battery' })
      .expect(200);
  });
});
