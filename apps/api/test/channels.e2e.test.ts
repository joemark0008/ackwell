import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signIn, startApp, stopApp, type TestContext } from './helpers.js';

let ctx: TestContext;
let cookie: string;
/** Authenticated agent: every request carries the admin session cookie. */
const http = () => {
  const server = ctx.app.getHttpServer();
  const agent = request(server);
  const wrap = (m: 'get' | 'post' | 'patch' | 'delete') => (url: string) => agent[m](url).set('Cookie', cookie);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), delete: wrap('delete') };
};

const inbound = (over: Record<string, unknown> = {}) => ({
  name: 'Lab in',
  direction: 'inbound',
  config: { port: 6001 },
  delivery: { type: 'webhook', url: 'https://example.test/hook' },
  ...over,
});
const outbound = (over: Record<string, unknown> = {}) => ({
  name: 'Orders out',
  direction: 'outbound',
  config: { host: 'lis.local', port: 2575 },
  ...over,
});

beforeAll(async () => {
  ctx = await startApp();
  cookie = await signIn(ctx.app);
});
afterAll(async () => {
  await stopApp(ctx);
});

describe('health', () => {
  it('GET /health is ok without the /api prefix', async () => {
    const r = await http().get('/health').expect(200);
    expect(r.body).toEqual({ status: 'ok', db: 'ok' });
  });
  it('serves the OpenAPI document', async () => {
    const r = await http().get('/api/docs-json').expect(200);
    expect(Object.keys(r.body.paths)).toEqual(expect.arrayContaining(['/api/channels', '/api/channels/{id}']));
  });
});

describe('channels CRUD', () => {
  let inId: string;
  let outId: string;

  it('creates an inbound channel with defaults', async () => {
    const r = await http().post('/api/channels').send(inbound()).expect(201);
    inId = r.body.id;
    expect(r.body).toMatchObject({
      name: 'Lab in',
      direction: 'inbound',
      status: 'stopped',
      hl7Version: '2.5.1',
      retentionDays: 7,
      config: { port: 6001, tls: { enabled: false }, allowlist: [] },
      delivery: { type: 'webhook', url: 'https://example.test/hook', timeoutMs: 10000, maxAttempts: 10 },
    });
  });

  it('creates an outbound channel with null delivery', async () => {
    const r = await http().post('/api/channels').send(outbound({ retentionDays: 30 })).expect(201);
    outId = r.body.id;
    expect(r.body.delivery).toBeNull();
    expect(r.body.retentionDays).toBe(30);
    expect(r.body.config.retry).toEqual({ maxAttempts: 5, backoffSeconds: 10 });
  });

  it('lists and gets channels', async () => {
    const list = await http().get('/api/channels').expect(200);
    expect(list.body.map((c: { name: string }) => c.name)).toEqual(['Lab in', 'Orders out']);
    await http().get(`/api/channels/${inId}`).expect(200);
  });

  it('400 on invalid body with issue paths', async () => {
    const r = await http().post('/api/channels').send(inbound({ config: { port: 'x' } })).expect(400);
    expect(r.body.code).toBe('VALIDATION_ERROR');
    expect(r.body.issues[0].path).toBe('config.port');
  });

  it('400 PORT_OUT_OF_RANGE for an inbound port outside MLLP_PORT_RANGE', async () => {
    const r = await http().post('/api/channels').send(inbound({ name: 'x', config: { port: 7000 } })).expect(400);
    expect(r.body.code).toBe('PORT_OUT_OF_RANGE');
  });

  it('outbound target port is not restricted to the MLLP range', async () => {
    await http().post('/api/channels').send(outbound({ name: 'o2', config: { host: 'h', port: 7000 } })).expect(201);
  });

  it('409 PORT_IN_USE and NAME_TAKEN', async () => {
    expect((await http().post('/api/channels').send(inbound({ name: 'other' })).expect(409)).body.code).toBe(
      'PORT_IN_USE',
    );
    expect(
      (await http().post('/api/channels').send(inbound({ config: { port: 6002 } })).expect(409)).body.code,
    ).toBe('NAME_TAKEN');
  });

  it('PATCH merges and re-validates', async () => {
    const r = await http()
      .patch(`/api/channels/${inId}`)
      .send({ name: 'Lab in 2', config: { port: 6003, allowlist: ['10.0.0.0/8'] } })
      .expect(200);
    expect(r.body.name).toBe('Lab in 2');
    expect(r.body.config).toEqual({ port: 6003, tls: { enabled: false }, allowlist: ['10.0.0.0/8'] });
    await http().patch(`/api/channels/${inId}`).send({ config: { port: 9999 } }).expect(400);
    await http().patch(`/api/channels/${inId}`).send({ direction: 'outbound' }).expect(400);
    await http().patch(`/api/channels/${outId}`).send({ delivery: { type: 'webhook', url: 'https://x.test' } }).expect(400);
  });

  it('404 for unknown id, 400 for non-uuid', async () => {
    const r = await http().get('/api/channels/00000000-0000-4000-8000-000000000000').expect(404);
    expect(r.body.code).toBe('CHANNEL_NOT_FOUND');
    await http().get('/api/channels/nope').expect(400);
  });

  it('DELETE removes the channel and frees its port', async () => {
    await http().delete(`/api/channels/${inId}`).expect(204);
    await http().get(`/api/channels/${inId}`).expect(404);
    await http().post('/api/channels').send(inbound({ config: { port: 6003 } })).expect(201);
  });
});
