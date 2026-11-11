import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signIn, startApp, stopApp, type TestContext } from './helpers.js';
import { SAMPLE_ORU } from './mllp-client.js';

// TEST-ONLY certificates, see fixtures/README.md
const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const CA = fx('ca.pem');
const WRONG_CA = fx('wrong-ca.pem');
const SERVER = { cert: fx('server.pem'), key: fx('server.key') };
const CLIENT = { cert: fx('client.pem'), key: fx('client.key') };

const VT = '\x0b';
const FS = '\x1c';
const CR = '\r';

/** MLLP over TLS: resolves with the un-framed ACK, rejects on handshake failure / close / timeout. */
function sendTls(port: number, message: string, opts: tls.ConnectionOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, ca: CA, ...opts });
    let buf = '';
    const timer = setTimeout(() => done(() => reject(new Error('timeout'))), 4000);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    socket.setEncoding('utf8');
    socket.on('secureConnect', () => socket.write(VT + message + FS + CR));
    socket.on('data', (c: string) => {
      buf += c;
      const end = buf.indexOf(FS + CR);
      if (end >= 0) done(() => resolve(buf.slice(buf.indexOf(VT) + 1, end)));
    });
    socket.on('error', (e) => done(() => reject(e)));
    socket.on('close', () => done(() => reject(new Error('closed'))));
  });
}

/** MLLP receiver over TLS that always answers AA. */
function tlsReceiver() {
  const received: string[] = [];
  const server = tls.createServer(SERVER, (sock) => {
    let buf = '';
    sock.on('error', () => undefined);
    sock.on('data', (d) => {
      buf += d.toString();
      const end = buf.indexOf(FS + CR);
      if (end < 0) return;
      const msg = buf.slice(buf.indexOf(VT) + 1, end);
      buf = '';
      received.push(msg);
      const ctrl = msg.split(CR)[0]!.split('|')[9] ?? '';
      sock.write(VT + `MSH|^~\\&|LIS|LAB|ACKWELL|HOSP|20260101000000||ACK|${ctrl}R|P|2.5` + CR + `MSA|AA|${ctrl}` + FS + CR);
    });
  });
  server.on('tlsClientError', () => undefined);
  return {
    received,
    start: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port))),
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let ctx: TestContext;
let cookie: string;
const http = () => {
  const agent = request(ctx.app.getHttpServer());
  return {
    get: (u: string) => agent.get(u).set('Cookie', cookie),
    post: (u: string) => agent.post(u).set('Cookie', cookie),
    patch: (u: string) => agent.patch(u).set('Cookie', cookie),
  };
};
const inbound = (name: string, port: number, tlsCfg: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  name,
  direction: 'inbound',
  config: { port, tls: tlsCfg, ...extra },
  delivery: { type: 'webhook', url: 'http://127.0.0.1:9/hook', maxAttempts: 1 },
});

beforeAll(async () => {
  ctx = await startApp({ MLLP_PORT_RANGE: '6040-6050' });
  cookie = await signIn(ctx.app);
});
afterAll(async () => {
  await stopApp(ctx);
});

describe('inbound TLS listener', () => {
  let id: string;

  it('validates the tls config', async () => {
    const noKey = await http().post('/api/channels').send(inbound('bad1', 6041, { enabled: true, cert: SERVER.cert })).expect(400);
    expect(noKey.body.issues.map((i: any) => i.path)).toContain('config.tls.key');
    await http().post('/api/channels').send(inbound('bad2', 6041, { enabled: true, cert: 'nope', key: 'nope' })).expect(400);
    await http().post('/api/channels').send(inbound('bad3', 6041, { enabled: true, ...SERVER, requestCert: true })).expect(400); // needs ca
    // disabled TLS needs no material
    await http().post('/api/channels').send(inbound('plain', 6049, { enabled: false })).expect(201);
  });

  it('never returns the private key, only hasKey', async () => {
    const r = await http().post('/api/channels').send(inbound('tls-in', 6041, { enabled: true, ...SERVER })).expect(201);
    id = r.body.id;
    expect(r.body.config.tls).toEqual({ enabled: true, cert: SERVER.cert, requestCert: false, hasKey: true });
    for (const url of ['/api/channels', `/api/channels/${id}`]) {
      const body = JSON.stringify((await http().get(url).expect(200)).body);
      expect(body).not.toContain('PRIVATE KEY');
    }
    // key is stored (needed to start the listener)
    const { DB } = await import('../src/db/db.js');
    const rows: any = await ctx.app.get(DB).execute(`select config from channels where id = '${id}'` as any);
    expect(JSON.stringify(rows.rows ?? rows)).toContain('PRIVATE KEY');
  });

  it('keeps the stored key when an update omits it', async () => {
    const got = (await http().get(`/api/channels/${id}`).expect(200)).body;
    // echo the response config back (it carries hasKey and no key)
    const r = await http().patch(`/api/channels/${id}`).send({ config: { ...got.config, allowlist: ['127.0.0.1'] } }).expect(200);
    expect(r.body.config.tls.hasKey).toBe(true);
    expect(r.body.config.allowlist).toEqual(['127.0.0.1']);
  });

  it('accepts MLLP over TLS and persists before the ACK', async () => {
    await http().post(`/api/channels/${id}/start`).expect(200);
    const ack = await sendTls(6041, SAMPLE_ORU);
    expect(ack).toMatch(/\rMSA\|AA\|MSG00001/);
    const list = await http().get(`/api/channels/${id}/messages`).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ status: expect.stringMatching(/received|processing|failed/), ackCode: 'AA', remoteAddress: '127.0.0.1' });
  });

  it('rejects a client that does not trust the certificate', async () => {
    await expect(sendTls(6041, SAMPLE_ORU, { ca: WRONG_CA })).rejects.toThrow();
    expect((await http().get(`/api/channels/${id}/messages`).expect(200)).body.total).toBe(1);
  });

  it('does not answer plain TCP MLLP on a TLS port', async () => {
    const { sendMllp } = await import('./mllp-client.js');
    await expect(sendMllp(6041, SAMPLE_ORU, { timeoutMs: 1500 })).rejects.toThrow();
    expect((await http().get(`/api/channels/${id}/messages`).expect(200)).body.total).toBe(1);
  });

  it('enforces the IP allowlist over TLS', async () => {
    await http().post(`/api/channels/${id}/stop`).expect(200);
    const got = (await http().get(`/api/channels/${id}`).expect(200)).body;
    await http().patch(`/api/channels/${id}`).send({ config: { ...got.config, allowlist: ['10.9.9.9'] } }).expect(200);
    await http().post(`/api/channels/${id}/start`).expect(200);
    await expect(sendTls(6041, SAMPLE_ORU)).rejects.toThrow();
    expect((await http().get(`/api/channels/${id}/messages`).expect(200)).body.total).toBe(1);
    await http().post(`/api/channels/${id}/stop`).expect(200);
  });

  it('verifies client certificates when requestCert + ca are set', async () => {
    const ch = (await http().post('/api/channels').send(inbound('mtls', 6042, { enabled: true, ...SERVER, ca: CA, requestCert: true })).expect(201)).body.id;
    await http().post(`/api/channels/${ch}/start`).expect(200);
    await expect(sendTls(6042, SAMPLE_ORU)).rejects.toThrow(); // no client cert
    const ack = await sendTls(6042, SAMPLE_ORU, CLIENT);
    expect(ack).toMatch(/MSA\|AA\|/);
    await http().post(`/api/channels/${ch}/stop`).expect(200);
  });
});

describe('outbound TLS', () => {
  const rx = tlsReceiver();
  let rxPort: number;
  beforeAll(async () => {
    rxPort = await rx.start();
  });
  afterAll(async () => {
    await rx.stop();
  });

  const raw = (ctrl: string) => `MSH|^~\\&|ACKWELL|HOSP|LIS|LAB|20261111120000||ORM^O01|${ctrl}|P|2.5.1\rPID|1||123^^^H^MR||DOE^J`;
  const params = (over: Record<string, unknown>) => ({
    host: '127.0.0.1',
    port: rxPort,
    tls: true,
    version: '2.5.1' as const,
    raw: raw('T1'),
    ackTimeoutMs: 3000,
    ...over,
  });

  it('sendHl7 verifies the receiver with a CA when rejectUnauthorized is on', async () => {
    const { sendHl7 } = await import('../src/outbound/mllp-sender.js');
    expect((await sendHl7(params({ ca: CA, rejectUnauthorized: true }))).ackCode).toBe('AA');
    await expect(sendHl7(params({ ca: WRONG_CA, rejectUnauthorized: true }))).rejects.toThrow(/Connection error|closed/);
    await expect(sendHl7(params({ rejectUnauthorized: true }))).rejects.toThrow(); // default CAs do not know the test CA
    // default (rejectUnauthorized false) keeps the old behaviour
    expect((await sendHl7(params({ ca: WRONG_CA }))).ackCode).toBe('AA');
    expect((await sendHl7(params({}))).ackCode).toBe('AA');
  });

  it('the channel config drives the send (ca + rejectUnauthorized)', async () => {
    const mk = async (name: string, tlsCfg: Record<string, unknown>) => {
      const id = (
        await http()
          .post('/api/channels')
          .send({ name, direction: 'outbound', config: { host: '127.0.0.1', port: rxPort, tls: tlsCfg, ackTimeoutMs: 2000, retry: { maxAttempts: 1, backoffSeconds: 1 } } })
          .expect(201)
      ).body;
      await http().post(`/api/channels/${id.id}/start`).expect(200);
      return id;
    };
    const good = await mk('out-good', { enabled: true, ca: CA, rejectUnauthorized: true });
    expect(good.config.tls).toEqual({ enabled: true, ca: CA, rejectUnauthorized: true });
    const bad = await mk('out-bad', { enabled: true, ca: WRONG_CA, rejectUnauthorized: true });
    const wait = async (id: string) => {
      const until = Date.now() + 30_000;
      for (;;) {
        const m = (await http().get(`/api/messages/${id}`).expect(200)).body;
        if (['sent', 'rejected', 'failed'].includes(m.status)) return m;
        if (Date.now() > until) throw new Error('not settled');
        await new Promise((r) => setTimeout(r, 300));
      }
    };
    const ok = (await http().post(`/api/channels/${good.id}/send`).send({ hl7: raw('G1') }).expect(201)).body;
    expect((await wait(ok.id)).status).toBe('sent');
    const ko = (await http().post(`/api/channels/${bad.id}/send`).send({ hl7: raw('B1') }).expect(201)).body;
    const failed = await wait(ko.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/Connection error|closed/);
    expect(rx.received.some((m) => m.includes('|B1|'))).toBe(false);
  });
});
