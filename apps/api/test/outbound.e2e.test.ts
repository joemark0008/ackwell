import net from 'node:net';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signIn, startApp, stopApp, type TestContext } from './helpers.js';

const VT = '\x0b';
const FS = '\x1c';
const CR = '\r';

/**
 * Raw MLLP receiver for tests. Replies per control id prefix: `AE…` → AE, `SILENT…` → no reply,
 * otherwise AA. `delayMs` makes overlapping sends observable for the ordering test.
 */
function receiver() {
  const received: string[] = [];
  let delayMs = 0;
  let server: net.Server | null = null;
  const sockets = new Set<net.Socket>();
  const handle = (sock: net.Socket) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      const end = buf.indexOf(FS + CR);
      if (end < 0) return;
      const msg = buf.slice(buf.indexOf(VT) + 1, end);
      buf = '';
      received.push(msg);
      const ctrl = msg.split(CR)[0]!.split('|')[9] ?? '';
      if (ctrl.startsWith('SILENT')) return;
      const code = ctrl.startsWith('AE') ? 'AE' : 'AA';
      setTimeout(() => {
        sock.write(VT + `MSH|^~\\&|LIS|LAB|ACKWELL|HOSP|20260101000000||ACK|${ctrl}R|P|2.5` + CR + `MSA|${code}|${ctrl}` + FS + CR);
      }, delayMs);
    });
  };
  return {
    received,
    setDelay: (ms: number) => (delayMs = ms),
    start: (port?: number) =>
      new Promise<number>((r) => {
        server = net.createServer(handle);
        server.listen(port ?? 0, '127.0.0.1', () => r((server!.address() as AddressInfo).port));
      }),
    stop: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        if (!server) return r();
        server.close(() => r());
        server = null;
      }),
  };
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 150));
  }
}

const RAW = (ctrl: string) =>
  [
    `MSH|^~\\&|ACKWELL|HOSP|LIS|LAB|20261111120000||ORM^O01|${ctrl}|P|2.5.1`,
    'PID|1||123456^^^HOSP^MR||DOE^JANE^A||19800101|F',
    'ORC|NW|ORD1',
  ].join(CR);

let ctx: TestContext;
let cookie: string;
const http = () => {
  const agent = request(ctx.app.getHttpServer());
  const wrap = (m: 'get' | 'post' | 'patch' | 'delete') => (url: string) => agent[m](url).set('Cookie', cookie);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), delete: wrap('delete') };
};
const raw = () => request(ctx.app.getHttpServer());
const rx = receiver();
let rxPort: number;

beforeAll(async () => {
  rxPort = await rx.start();
  ctx = await startApp({ MLLP_PORT_RANGE: '6045-6050' });
  cookie = await signIn(ctx.app);
});
afterAll(async () => {
  await stopApp(ctx);
  await rx.stop();
});

const detail = async (id: string) => (await http().get(`/api/messages/${id}`).expect(200)).body;
const settled = (id: string, statuses: string[]) =>
  waitFor(async () => {
    const d = await detail(id);
    return statuses.includes(d.status) ? d : undefined;
  }, 30_000);

describe('outbound send', () => {
  let chId: string;

  it('creates the channel; send is refused while it is stopped and for inbound channels', async () => {
    const r = await http()
      .post('/api/channels')
      .send({
        name: 'To LIS',
        direction: 'outbound',
        hl7Version: '2.5.1',
        config: { host: '127.0.0.1', port: rxPort, ackTimeoutMs: 1500, retry: { maxAttempts: 2, backoffSeconds: 1 } },
      })
      .expect(201);
    chId = r.body.id;
    expect((await http().post(`/api/channels/${chId}/send`).send({ hl7: RAW('X1') }).expect(409)).body.code).toBe('CHANNEL_STOPPED');
    await http().post(`/api/channels/${chId}/start`).expect(200);

    const inb = (
      await http().post('/api/channels').send({ name: 'In', direction: 'inbound', config: { port: 6046 }, delivery: { type: 'webhook', url: 'https://x.test/h' } }).expect(201)
    ).body.id;
    expect((await http().post(`/api/channels/${inb}/send`).send({ hl7: RAW('X2') }).expect(400)).body.code).toBe('NOT_OUTBOUND');
  });

  it('validates the body', async () => {
    expect((await http().post(`/api/channels/${chId}/send`).send({}).expect(400)).body.code).toBe('VALIDATION_ERROR');
    expect((await http().post(`/api/channels/${chId}/send`).send({ hl7: 'PID|1||not-a-message' }).expect(400)).body.code).toBe('INVALID_HL7');
    await http().post(`/api/channels/${chId}/send`).send({ segments: [{ id: 'PID', fields: [] }] }).expect(400);
  });

  it('sends raw HL7 over MLLP and records the AA ack', async () => {
    const r = await http().post(`/api/channels/${chId}/send`).send({ hl7: RAW('OUT001') }).expect(201);
    expect(r.body).toMatchObject({ channelId: chId, direction: 'outbound', status: 'queued', messageType: 'ORM^O01', controlId: 'OUT001' });
    const m = await settled(r.body.id, ['sent', 'rejected', 'failed']);
    expect(m.status).toBe('sent');
    expect(m.ackCode).toBe('AA');
    expect(m.error).toBeNull();
    expect(m.raw).toBe(RAW('OUT001'));
    expect(m.attempts).toHaveLength(1);
    expect(m.attempts[0]).toMatchObject({ attempt: 1, result: 'success', error: null });
    expect(m.attempts[0].response).toMatch(/MSA\|AA\|OUT001/);
    expect(rx.received.at(-1)).toBe(RAW('OUT001'));
  });

  it('accepts the generic JSON form and completes MSH-7 / MSH-10 / MSH-12', async () => {
    const body = {
      segments: [
        { id: 'MSH', fields: ['|', '^~\\&', 'ACKWELL', 'HOSP', 'LIS', 'LAB', '', '', ['ADT', 'A01']] },
        { id: 'PID', fields: ['1', '', 'MRN9', '', ['DOE', 'JOHN']] },
      ],
    };
    const r = await http().post(`/api/channels/${chId}/send`).send(body).expect(201);
    expect(r.body.messageType).toBe('ADT^A01');
    expect(r.body.controlId).toMatch(/^AW[0-9A-Z]+$/);
    const m = await settled(r.body.id, ['sent', 'rejected', 'failed']);
    expect(m.status).toBe('sent');
    const msh = m.raw.split(CR)[0].split('|');
    expect(msh[6]).toMatch(/^\d{14}$/); // MSH-7 timestamp
    expect(msh[9]).toBe(r.body.controlId); // MSH-10
    expect(msh[11]).toBe('2.5.1'); // MSH-12 from the channel
    expect(m.json.segments[1].fields[4]).toEqual(['DOE', 'JOHN']);
  });

  it('accepts the typed flat JSON form and rejects bad keys with their path', async () => {
    const flat = {
      msh_3_1: 'ACKWELL',
      msh_4_1: 'HOSP',
      msh_9_1: 'ADT',
      msh_9_2: 'A01',
      msh_11_1: 'P',
      msh_12: '2.5.1',
      segments: [
        { segment: 'PID', pid_1: '1', pid_3: [{ pid_3_1: 'MRN7', pid_3_5: 'MR' }], pid_5: [{ pid_5_1_1: 'ROE', pid_5_2: 'ANN' }] },
        { segment: 'ZXX', fields: ['custom'] },
      ],
    };
    const r = await http().post(`/api/channels/${chId}/send`).send({ flat }).expect(201);
    expect(r.body.messageType).toBe('ADT^A01');
    const m = await settled(r.body.id, ['sent', 'rejected', 'failed']);
    expect(m.status).toBe('sent');
    const [msh, pid, zxx] = m.raw.split(CR);
    expect(msh).toMatch(/^MSH\|\^~\\&\|ACKWELL\|HOSP\|\|\|\d{14}\|\|ADT\^A01\|AW[0-9A-Z]+\|P\|2\.5\.1$/);
    expect(pid).toBe('PID|1||MRN7^^^^MR||ROE^ANN');
    expect(zxx).toBe('ZXX|custom');

    const bad = await http()
      .post(`/api/channels/${chId}/send`)
      .send({ flat: { ...flat, segments: [{ segment: 'PID', pid_5_1_1: 'ROE' }] } })
      .expect(400);
    expect(JSON.stringify(bad.body)).toContain('pid_5_1_1');
  });

  it('marks AE as rejected without retrying', async () => {
    const r = await http().post(`/api/channels/${chId}/send`).send({ hl7: RAW('AE001') }).expect(201);
    const m = await settled(r.body.id, ['sent', 'rejected', 'failed']);
    expect(m.status).toBe('rejected');
    expect(m.ackCode).toBe('AE');
    expect(m.error).toBe('Receiver answered AE');
    expect(m.attempts).toHaveLength(1);
    expect(m.attempts[0].result).toBe('failure');
  });

  it('retries on ACK timeout, fails after maxAttempts, and resend works later', async () => {
    const r = await http().post(`/api/channels/${chId}/send`).send({ hl7: RAW('SILENT1') }).expect(201);
    const m = await settled(r.body.id, ['sent', 'rejected', 'failed']);
    expect(m.status).toBe('failed');
    expect(m.attempts.map((a: { attempt: number; result: string }) => [a.attempt, a.result])).toEqual([
      [1, 'failure'],
      [2, 'failure'],
    ]);
    expect(m.attempts[0].error).toMatch(/No ACK within 1500 ms/);
    expect(m.error).toMatch(/No ACK/);

    // The receiver now answers (control id no longer SILENT is not possible: resend keeps the raw), so
    // simulate recovery by resending a different failed case: receiver down → up.
    await rx.stop();
    const r2 = await http().post(`/api/channels/${chId}/send`).send({ hl7: RAW('DOWN1') }).expect(201);
    const m2 = await settled(r2.body.id, ['sent', 'rejected', 'failed']);
    expect(m2.status).toBe('failed');
    expect(m2.attempts[0].error).toMatch(/ECONNREFUSED|Connection/);
    await rx.start(rxPort);
    const rs = await http().post(`/api/messages/${r2.body.id}/resend`).expect(200);
    expect(rs.body.status).toBe('queued');
    const m3 = await settled(r2.body.id, ['sent']);
    expect(m3.ackCode).toBe('AA');
    expect(m3.attempts.map((a: { attempt: number }) => a.attempt)).toEqual([1, 2, 3]);
  });

  it('keeps strict order per channel', async () => {
    rx.setDelay(120);
    const before = rx.received.length;
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push((await http().post(`/api/channels/${chId}/send`).send({ hl7: RAW(`ORD${i}`) }).expect(201)).body.id);
    }
    for (const id of ids) await settled(id, ['sent']);
    const ctrls = rx.received.slice(before).map((m) => m.split(CR)[0]!.split('|')[9]);
    expect(ctrls).toEqual(['ORD0', 'ORD1', 'ORD2', 'ORD3']);
    rx.setDelay(0);
  });

  it('authenticates machines with per-channel API keys', async () => {
    const created = await http().post(`/api/channels/${chId}/api-keys`).send({ label: 'LIS integration' }).expect(201);
    const key: string = created.body.key;
    expect(key).toMatch(/^ak_[A-Za-z0-9_-]{40,}$/);
    expect(created.body.prefix).toBe(key.slice(0, 11));
    const list = await http().get(`/api/channels/${chId}/api-keys`).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(key);
    expect(list.body[0]).toMatchObject({ label: 'LIS integration', prefix: key.slice(0, 11), lastUsedAt: null, revokedAt: null });

    // No cookie, bearer key → accepted.
    const r = await raw().post(`/api/channels/${chId}/send`).set('Authorization', `Bearer ${key}`).send({ hl7: RAW('KEY001') }).expect(201);
    await settled(r.body.id, ['sent']);
    const after = await http().get(`/api/channels/${chId}/api-keys`).expect(200);
    expect(after.body[0].lastUsedAt).not.toBeNull();

    // Wrong key, no auth, key of another channel → 401.
    expect((await raw().post(`/api/channels/${chId}/send`).set('Authorization', 'Bearer ak_nope').send({ hl7: RAW('K2') }).expect(401)).body.code).toBe('INVALID_API_KEY');
    expect((await raw().post(`/api/channels/${chId}/send`).send({ hl7: RAW('K3') }).expect(401)).body.code).toBe('UNAUTHENTICATED');
    const other = (await http().post('/api/channels').send({ name: 'Other out', direction: 'outbound', config: { host: 'h', port: 1 } }).expect(201)).body.id;
    const otherKey = (await http().post(`/api/channels/${other}/api-keys`).send({ label: 'x' }).expect(201)).body.key;
    await raw().post(`/api/channels/${chId}/send`).set('Authorization', `Bearer ${otherKey}`).send({ hl7: RAW('K4') }).expect(401);

    // Revoke → 401; revoking again → 404.
    await http().delete(`/api/channels/${chId}/api-keys/${created.body.id}`).expect(200);
    await raw().post(`/api/channels/${chId}/send`).set('Authorization', `Bearer ${key}`).send({ hl7: RAW('K5') }).expect(401);
    await http().delete(`/api/channels/${chId}/api-keys/${created.body.id}`).expect(404);
    await http().post(`/api/channels/${chId}/api-keys`).send({ label: '' }).expect(400);
  });

  it('lists outbound messages in the channel log with ACK codes', async () => {
    const l = await http().get(`/api/channels/${chId}/messages?status=sent`).expect(200);
    expect(l.body.total).toBeGreaterThanOrEqual(6);
    expect(l.body.items.every((m: { ackCode: string; direction: string }) => m.ackCode === 'AA' && m.direction === 'outbound')).toBe(true);
    await http().post(`/api/channels/${chId}/stop`).expect(200);
  });
});
