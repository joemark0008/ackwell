import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signIn, startApp, stopApp, type TestContext } from './helpers.js';
import { SAMPLE_ADT, SAMPLE_ORU, sendMllp } from './mllp-client.js';

let ctx: TestContext;
let cookie: string;
const http = () => {
  const agent = request(ctx.app.getHttpServer());
  return { get: (u: string) => agent.get(u).set('Cookie', cookie), post: (u: string) => agent.post(u).set('Cookie', cookie) };
};
const inbound = (name: string, port: number) => ({
  name,
  direction: 'inbound',
  config: { port },
  delivery: { type: 'webhook', url: 'http://127.0.0.1:9/hook', maxAttempts: 1 },
});

let chA: string;
let chB: string;
let chOut: string;

beforeAll(async () => {
  ctx = await startApp({ MLLP_PORT_RANGE: '6040-6050' });
  cookie = await signIn(ctx.app);
  chA = (await http().post('/api/channels').send(inbound('A', 6041)).expect(201)).body.id;
  chB = (await http().post('/api/channels').send(inbound('B', 6042)).expect(201)).body.id;
  chOut = (
    await http()
      .post('/api/channels')
      .send({ name: 'Out', direction: 'outbound', config: { host: '127.0.0.1', port: 9, ackTimeoutMs: 1000, retry: { maxAttempts: 1, backoffSeconds: 1 } } })
      .expect(201)
  ).body.id;
  await http().post(`/api/channels/${chA}/start`).expect(200);
  await http().post(`/api/channels/${chB}/start`).expect(200);
  await http().post(`/api/channels/${chOut}/start`).expect(200);
  for (let i = 0; i < 3; i++) {
    await sendMllp(6041, SAMPLE_ORU.replace('MSG00001', `A${i}`));
    await new Promise((r) => setTimeout(r, 5));
  }
  await sendMllp(6042, SAMPLE_ADT);
  await http()
    .post(`/api/channels/${chOut}/send`)
    .send({ hl7: 'MSH|^~\\&|ACKWELL|H|X|Y|20261111120000||ORM^O01|OUT1|P|2.5.1\rPID|1' })
    .expect(201);
  // The receiver does not exist: one attempt, then the outbound message is `failed`.
  const until = Date.now() + 30_000;
  for (;;) {
    const r = await http().get(`/api/messages?channelId=${chOut}&status=failed`).expect(200);
    if (r.body.total === 1) break;
    if (Date.now() > until) throw new Error('outbound message never failed');
    await new Promise((res) => setTimeout(res, 300));
  }
});
afterAll(async () => {
  await stopApp(ctx);
});

describe('GET /api/messages', () => {
  it('requires a session', async () => {
    await request(ctx.app.getHttpServer()).get('/api/messages').expect(401);
  });

  it('lists across channels newest first with total', async () => {
    const r = await http().get('/api/messages').expect(200);
    expect(r.body.total).toBe(5);
    expect(r.body.items).toHaveLength(5);
    const times = r.body.items.map((m: any) => m.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(new Set(r.body.items.map((m: any) => m.channelId))).toEqual(new Set([chA, chB, chOut]));
  });

  it('filters by channelId, direction, status and q', async () => {
    expect((await http().get(`/api/messages?channelId=${chA}`).expect(200)).body.total).toBe(3);
    expect((await http().get('/api/messages?direction=outbound').expect(200)).body.total).toBe(1);
    expect((await http().get('/api/messages?direction=inbound').expect(200)).body.total).toBe(4);
    expect((await http().get('/api/messages?status=failed&direction=outbound').expect(200)).body.items[0].channelId).toBe(chOut);
    expect((await http().get('/api/messages?q=ADT').expect(200)).body.total).toBe(1);
    expect((await http().get(`/api/messages?channelId=${chB}&direction=outbound`).expect(200)).body.total).toBe(0);
    // the channel-scoped route still works and matches the global one
    const scoped = await http().get(`/api/channels/${chA}/messages`).expect(200);
    const global = await http().get(`/api/messages?channelId=${chA}`).expect(200);
    expect(scoped.body).toEqual(global.body);
  });

  it('pages with a cursor without gaps or duplicates', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: request.Response = await http().get(`/api/messages?limit=2${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
      expect(r.body.total).toBe(5);
      seen.push(...r.body.items.map((m: any) => m.id));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3) // 5 messages, 2 per page;
    expect(new Set(seen).size).toBe(5);
  });

  it('validates query parameters', async () => {
    await http().get('/api/messages?channelId=nope').expect(400);
    await http().get('/api/messages?direction=sideways').expect(400);
    await http().get('/api/messages?limit=0').expect(400);
  });
});
