import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signIn, startApp, stopApp, type TestContext } from './helpers.js';
import { isListening, MllpClosedError, SAMPLE_ADT, SAMPLE_ORU, sendMllp } from './mllp-client.js';

// 6001-6002 belong to Coolify on the dev host; keep the test ports clear of them.
const PORT_RANGE = '6040-6050';
const P = { a: 6041, b: 6042, locked: 6043, boot: 6044 };

let ctx: TestContext;
let cookie: string;
const http = () => {
  const agent = request(ctx.app.getHttpServer());
  const wrap = (m: 'get' | 'post' | 'patch' | 'delete') => (url: string) => agent[m](url).set('Cookie', cookie);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), delete: wrap('delete') };
};

const inbound = (name: string, port: number, over: Record<string, unknown> = {}) => ({
  name,
  direction: 'inbound',
  config: { port, ...over },
  delivery: { type: 'webhook', url: 'https://example.test/hook' },
});

beforeAll(async () => {
  ctx = await startApp({ MLLP_PORT_RANGE: PORT_RANGE });
  cookie = await signIn(ctx.app);
});
afterAll(async () => {
  await stopApp(ctx);
});

describe('inbound listeners', () => {
  let chA: string;

  it('starts a channel, binds the port and reports running', async () => {
    chA = (await http().post('/api/channels').send(inbound('A', P.a)).expect(201)).body.id;
    expect(await isListening(P.a)).toBe(false);
    const r = await http().post(`/api/channels/${chA}/start`).expect(200);
    expect(r.body.status).toBe('running');
    expect(await isListening(P.a)).toBe(true);
    // idempotent
    expect((await http().post(`/api/channels/${chA}/start`).expect(200)).body.status).toBe('running');
    expect((await http().get(`/api/channels/${chA}`).expect(200)).body.status).toBe('running');
  });

  it('stores the message, ACKs AA with the control id, and parses to JSON', async () => {
    const ack = await sendMllp(P.a, SAMPLE_ORU);
    expect(ack.startsWith('MSH|^~\\&|ACKWELL|HOSP|LAB|HOSP|')).toBe(true);
    expect(ack).toContain('|ACK^R01|');
    expect(ack).toMatch(/\rMSA\|AA\|MSG00001/);

    const list = await http().get(`/api/channels/${chA}/messages`).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.nextCursor).toBeNull();
    const [m] = list.body.items;
    expect(m).toMatchObject({
      channelId: chA,
      direction: 'inbound',
      status: 'received',
      messageType: 'ORU^R01',
      controlId: 'MSG00001',
      ackCode: 'AA',
      error: null,
      remoteAddress: '127.0.0.1',
    });
    expect(m.raw).toBeUndefined();

    const detail = await http().get(`/api/messages/${m.id}`).expect(200);
    expect(detail.body.raw).toBe(SAMPLE_ORU);
    expect(detail.body.json.segments.map((s: { id: string }) => s.id)).toEqual(['MSH', 'PID', 'OBR', 'OBX']);
    expect(detail.body.json.segments[1].fields[4]).toEqual(['DOE', 'JANE', 'A']);
    expect(detail.body.attempts).toEqual([]);
  });

  it('pages newest first with a cursor and filters by status / q', async () => {
    for (let i = 0; i < 3; i++) {
      await sendMllp(P.a, SAMPLE_ADT.replace('000002', `ADT0${i}`));
    }
    const p1 = await http().get(`/api/channels/${chA}/messages?limit=2`).expect(200);
    expect(p1.body.total).toBe(4);
    expect(p1.body.items.map((m: { controlId: string }) => m.controlId)).toEqual(['ADT02', 'ADT01']);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await http().get(`/api/channels/${chA}/messages?limit=2&cursor=${p1.body.nextCursor}`).expect(200);
    expect(p2.body.items.map((m: { controlId: string }) => m.controlId)).toEqual(['ADT00', 'MSG00001']);
    expect(p2.body.nextCursor).toBeNull();

    const q = await http().get(`/api/channels/${chA}/messages?q=oru`).expect(200);
    expect(q.body.total).toBe(1);
    const st = await http().get(`/api/channels/${chA}/messages?status=failed`).expect(200);
    expect(st.body.total).toBe(0);
    await http().get(`/api/channels/${chA}/messages?limit=0`).expect(400);
    await http().get('/api/channels/00000000-0000-4000-8000-000000000000/messages').expect(404);
    await http().get('/api/messages/00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('rejects config changes and delete while running, and stops cleanly', async () => {
    expect((await http().patch(`/api/channels/${chA}`).send({ config: { port: P.b } }).expect(409)).body.code).toBe(
      'CHANNEL_RUNNING',
    );
    expect((await http().delete(`/api/channels/${chA}`).expect(409)).body.code).toBe('CHANNEL_RUNNING');

    const r = await http().post(`/api/channels/${chA}/stop`).expect(200);
    expect(r.body.status).toBe('stopped');
    expect(await isListening(P.a)).toBe(false);
    expect((await http().post(`/api/channels/${chA}/stop`).expect(200)).body.status).toBe('stopped');
    // The log survives a stop.
    expect((await http().get(`/api/channels/${chA}/messages`).expect(200)).body.total).toBe(4);
  });

  it('409 PORT_UNAVAILABLE when the port is taken, and the channel shows error', async () => {
    const net = await import('node:net');
    const blocker = net.createServer().listen(P.locked, '0.0.0.0');
    await new Promise((r) => blocker.once('listening', r));
    try {
      const id = (await http().post('/api/channels').send(inbound('Locked', P.locked)).expect(201)).body.id;
      const r = await http().post(`/api/channels/${id}/start`).expect(409);
      expect(r.body.code).toBe('PORT_UNAVAILABLE');
      expect((await http().get(`/api/channels/${id}`).expect(200)).body.status).toBe('error');
      await http().delete(`/api/channels/${id}`).expect(204);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it('closes connections from addresses outside the allowlist without an ACK', async () => {
    const id = (
      await http()
        .post('/api/channels')
        .send(inbound('Allowlisted', P.b, { allowlist: ['10.0.0.0/8', '192.168.50.1'] }))
        .expect(201)
    ).body.id;
    await http().post(`/api/channels/${id}/start`).expect(200);
    await expect(sendMllp(P.b, SAMPLE_ORU)).rejects.toBeInstanceOf(MllpClosedError);
    expect((await http().get(`/api/channels/${id}/messages`).expect(200)).body.total).toBe(0);

    await http().post(`/api/channels/${id}/stop`).expect(200);
    await http().patch(`/api/channels/${id}`).send({ config: { port: P.b, allowlist: ['127.0.0.1'] } }).expect(200);
    await http().post(`/api/channels/${id}/start`).expect(200);
    expect(await sendMllp(P.b, SAMPLE_ORU)).toMatch(/MSA\|AA\|MSG00001/);
    await http().post(`/api/channels/${id}/stop`).expect(200);
  });

  it('outbound channels can be started and stopped (status only until Phase 3)', async () => {
    const id = (
      await http().post('/api/channels').send({ name: 'Out', direction: 'outbound', config: { host: 'h', port: 1 } }).expect(201)
    ).body.id;
    expect((await http().post(`/api/channels/${id}/start`).expect(200)).body.status).toBe('running');
    expect((await http().post(`/api/channels/${id}/stop`).expect(200)).body.status).toBe('stopped');
  });

  it('restores running channels on boot and closes listeners on shutdown', async () => {
    const id = (await http().post('/api/channels').send(inbound('Boot', P.boot)).expect(201)).body.id;
    await http().post(`/api/channels/${id}/start`).expect(200);
    expect(await isListening(P.boot)).toBe(true);

    const pg = ctx.pg;
    await stopApp(ctx, { keepDb: true });
    expect(await isListening(P.boot)).toBe(false);

    ctx = await startApp({ MLLP_PORT_RANGE: PORT_RANGE }, { pg });
    cookie = await signIn(ctx.app);
    expect(await isListening(P.boot)).toBe(true);
    expect((await http().get(`/api/channels/${id}`).expect(200)).body.status).toBe('running');
    expect(await sendMllp(P.boot, SAMPLE_ADT)).toMatch(/MSA\|AA\|000002/);
    await http().post(`/api/channels/${id}/stop`).expect(200);
  });
});
