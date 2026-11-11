import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signIn, startApp, stopApp, type TestContext } from './helpers.js';
import { SAMPLE_ADT, SAMPLE_ORU, sendMllp } from './mllp-client.js';
import { openSse } from './sse-client.js';

const P = { a: 6041, b: 6042 };
let ctx: TestContext;
let cookie: string;
let port: number;
const http = () => {
  const agent = request(ctx.app.getHttpServer());
  return { get: (u: string) => agent.get(u).set('Cookie', cookie), post: (u: string) => agent.post(u).set('Cookie', cookie) };
};
const inbound = (name: string, p: number) => ({
  name,
  direction: 'inbound',
  config: { port: p },
  delivery: { type: 'webhook', url: 'http://127.0.0.1:9/hook', maxAttempts: 1 },
});

beforeAll(async () => {
  ctx = await startApp({ MLLP_PORT_RANGE: '6040-6050' });
  cookie = await signIn(ctx.app);
  await ctx.app.listen(0, '127.0.0.1');
  port = (ctx.app.getHttpServer().address() as AddressInfo).port;
});
afterAll(async () => {
  await stopApp(ctx);
});

describe('GET /api/events', () => {
  let chA: string;
  let chB: string;

  it('rejects a request without a session (401 JSON, no stream)', async () => {
    const c = await openSse(port, '/api/events');
    expect(c.status).toBe(401);
    expect(c.headers['content-type']).toMatch(/json/);
    c.close();
  });

  it('rejects a bad channelId filter', async () => {
    const c = await openSse(port, '/api/events?channelId=nope', cookie);
    expect(c.status).toBe(400);
    c.close();
  });

  it('streams channel.status and message events with SSE headers', async () => {
    chA = (await http().post('/api/channels').send(inbound('A', P.a)).expect(201)).body.id;
    chB = (await http().post('/api/channels').send(inbound('B', P.b)).expect(201)).body.id;

    const c = await openSse(port, '/api/events', cookie);
    expect(c.status).toBe(200);
    expect(c.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(c.headers['cache-control']).toMatch(/no-cache/);
    expect(c.headers['x-accel-buffering']).toBe('no');
    expect(c.headers['content-encoding']).toBeUndefined();

    await http().post(`/api/channels/${chA}/start`).expect(200);
    await http().post(`/api/channels/${chB}/start`).expect(200);
    const st = await c.waitFor((e) => e.event === 'channel.status' && (e.data as any).channelId === chA);
    expect(st.data).toEqual({ channelId: chA, status: 'running' });

    await sendMllp(P.a, SAMPLE_ORU);
    const m = await c.waitFor((e) => e.event === 'message' && (e.data as any).channelId === chA);
    expect(m.data).toMatchObject({ channelId: chA, direction: 'inbound', status: 'received', messageType: 'ORU^R01', controlId: 'MSG00001' });
    c.close();
  });

  it('filters message events by channelId but always sends channel.status', async () => {
    const c = await openSse(port, `/api/events?channelId=${chB}`, cookie);
    await sendMllp(P.a, SAMPLE_ORU); // channel A: filtered out
    await sendMllp(P.b, SAMPLE_ADT); // channel B: delivered
    await http().post(`/api/channels/${chA}/stop`).expect(200);
    await c.waitFor((e) => e.event === 'channel.status' && (e.data as any).channelId === chA && (e.data as any).status === 'stopped');
    await c.waitFor((e) => e.event === 'message' && (e.data as any).channelId === chB);
    const messageChannels = c.events.filter((e) => e.event === 'message').map((e) => (e.data as any).channelId);
    expect(messageChannels.length).toBeGreaterThan(0);
    expect(new Set(messageChannels)).toEqual(new Set([chB]));
    c.close();
  });

  it('removes its listeners when the client disconnects', async () => {
    const { AppEvents } = await import('../src/common/events.js');
    const events = ctx.app.get(AppEvents);
    await new Promise((r) => setTimeout(r, 500)); // let earlier streams finish closing
    const before = events.listenerCount('message');
    const beforeStatus = events.listenerCount('channel.status');
    const c = await openSse(port, '/api/events', cookie);
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(events.listenerCount('message')).toBe(before + 1);
      expect(events.listenerCount('channel.status')).toBe(beforeStatus + 1);
    } finally {
      c.close();
    }
    const until = Date.now() + 5000;
    while (events.listenerCount('message') > before && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    expect(events.listenerCount('message')).toBe(before);
    expect(events.listenerCount('channel.status')).toBe(beforeStatus);
  });
});
