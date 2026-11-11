import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verify } from '../src/delivery/standard-webhooks.js';
import { signIn, startApp, stopApp, type TestContext } from './helpers.js';
import { SAMPLE_ADT, SAMPLE_ORU, sendMllp } from './mllp-client.js';

const PORT_RANGE = '6045-6050';
const P = { ok: 6046, flaky: 6047, dead: 6048 };

interface Hit {
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Local webhook receiver. `plan` = HTTP statuses to answer in order (last one repeats). */
function receiver() {
  const hits: Hit[] = [];
  let plan: number[] = [200];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ headers: req.headers, body });
      const status = plan.length > 1 ? plan.shift()! : plan[0]!;
      res.writeHead(status, { 'content-type': 'text/plain' }).end(status >= 500 ? 'boom' : 'thanks');
    });
  });
  return {
    hits,
    setPlan: (p: number[]) => (plan = p),
    start: () =>
      new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`))),
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

let ctx: TestContext;
let cookie: string;
const http_ = () => {
  const agent = request(ctx.app.getHttpServer());
  const wrap = (m: 'get' | 'post' | 'patch' | 'delete') => (url: string) => agent[m](url).set('Cookie', cookie);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), delete: wrap('delete') };
};
const rx = receiver();
let hookUrl: string;

beforeAll(async () => {
  hookUrl = await rx.start();
  ctx = await startApp({ MLLP_PORT_RANGE: PORT_RANGE });
  cookie = await signIn(ctx.app);
});
afterAll(async () => {
  await stopApp(ctx);
  await rx.stop();
});

const inbound = (name: string, port: number, delivery: Record<string, unknown> = {}) => ({
  name,
  direction: 'inbound',
  config: { port },
  delivery: { type: 'webhook', url: hookUrl, ...delivery },
});

describe('webhook delivery', () => {
  let chId: string;
  let secret: string;

  it('creates an inbound channel with a one-time webhook secret', async () => {
    const r = await http_().post('/api/channels').send(inbound('Hooked', P.ok)).expect(201);
    chId = r.body.id;
    expect(r.body.webhookSecret.secret).toMatch(/^whsec_[A-Za-z0-9+/=]{40,}$/);
    expect(r.body.webhookSecret.hint).toBe(r.body.webhookSecret.secret.slice(-4));
    secret = r.body.webhookSecret.secret;
    // Outbound channels get none.
    const o = await http_().post('/api/channels').send({ name: 'Out', direction: 'outbound', config: { host: 'h', port: 1 } }).expect(201);
    expect(o.body.webhookSecret).toBeUndefined();
    // The list never returns the value.
    const list = await http_().get(`/api/channels/${chId}/webhook-secrets`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect(list.body[0]).toMatchObject({ channelId: chId, hint: secret.slice(-4), revokedAt: null });
  });

  it('delivers a received message as a signed JSON webhook', async () => {
    await http_().post(`/api/channels/${chId}/start`).expect(200);
    expect(await sendMllp(P.ok, SAMPLE_ORU)).toMatch(/MSA\|AA\|MSG00001/);

    const hit = await waitFor(async () => rx.hits[0]);
    expect(hit.headers['content-type']).toBe('application/json');
    expect(hit.headers['user-agent']).toMatch(/^Ackwell-Webhook/);
    expect(verify(hit.headers, hit.body, [secret])).toEqual({ ok: true });
    expect(verify(hit.headers, hit.body + 'x', [secret])).toEqual({ ok: false, reason: 'signature' });
    const payload = JSON.parse(hit.body);
    expect(payload).toMatchObject({
      channelId: chId,
      channelName: 'Hooked',
      direction: 'inbound',
      messageType: 'ORU^R01',
      controlId: 'MSG00001',
      remoteAddress: '127.0.0.1',
      raw: SAMPLE_ORU,
    });
    expect(hit.headers['webhook-id']).toBe(payload.id);
    expect(payload.json.segments[0].id).toBe('MSH');
    expect(payload.flat).toMatchObject({ msh_9_1: 'ORU', msh_9_2: 'R01', msh_10: 'MSG00001', msh_12: '2.5.1' });
    expect(payload.flat.segments[0]).toMatchObject({
      segment: 'PID',
      pid_3: [{ pid_3_1: '123456', pid_3_4_1: 'HOSP', pid_3_5: 'MR' }],
      pid_5: [{ pid_5_1_1: 'DOE', pid_5_2: 'JANE', pid_5_3: 'A' }],
    });

    const m = await waitFor(async () => {
      const d = (await http_().get(`/api/messages/${payload.id}`).expect(200)).body;
      return d.status === 'delivered' ? d : undefined;
    });
    expect(m.attempts).toHaveLength(1);
    expect(m.attempts[0]).toMatchObject({ attempt: 1, result: 'success', error: null });
    expect(m.attempts[0].response).toMatch(/^200/);
    expect(m.error).toBeNull();
  });

  it('retries with backoff on 5xx and records every attempt', async () => {
    rx.setPlan([503, 500, 200]);
    const before = rx.hits.length;
    expect(await sendMllp(P.ok, SAMPLE_ADT)).toMatch(/MSA\|AA\|000002/);
    const m = await waitFor(async () => {
      const l = (await http_().get(`/api/channels/${chId}/messages?q=ADT`).expect(200)).body;
      const row = l.items[0];
      if (!row) return undefined;
      const d = (await http_().get(`/api/messages/${row.id}`).expect(200)).body;
      return d.status === 'delivered' ? d : undefined;
    }, 30_000);
    expect(rx.hits.length - before).toBe(3);
    expect(m.attempts.map((a: { attempt: number; result: string }) => [a.attempt, a.result])).toEqual([
      [1, 'failure'],
      [2, 'failure'],
      [3, 'success'],
    ]);
    expect(m.attempts[0].error).toBe('HTTP 503');
    rx.setPlan([200]);
  });

  it('gives up after maxAttempts and marks the message failed; resend tries again', async () => {
    const id = (await http_().post('/api/channels').send(inbound('Dead', P.dead, { maxAttempts: 2 })).expect(201)).body.id;
    await http_().post(`/api/channels/${id}/start`).expect(200);
    rx.setPlan([500]);
    const before = rx.hits.length;
    await sendMllp(P.dead, SAMPLE_ORU);
    const m = await waitFor(async () => {
      const l = (await http_().get(`/api/channels/${id}/messages`).expect(200)).body;
      const row = l.items[0];
      if (!row) return undefined;
      const d = (await http_().get(`/api/messages/${row.id}`).expect(200)).body;
      return d.status === 'failed' ? d : undefined;
    }, 30_000);
    expect(m.attempts).toHaveLength(2);
    expect(m.error).toBe('HTTP 500');
    expect(rx.hits.length - before).toBe(2);

    rx.setPlan([200]);
    const r = await http_().post(`/api/messages/${m.id}/resend`).expect(200);
    expect(r.body.status).toBe('received');
    const again = await waitFor(async () => {
      const d = (await http_().get(`/api/messages/${m.id}`).expect(200)).body;
      return d.status === 'delivered' ? d : undefined;
    });
    expect(again.attempts.map((a: { attempt: number }) => a.attempt)).toEqual([1, 2, 3]);
    await http_().post(`/api/channels/${id}/stop`).expect(200);
  });

  it('does not retry 4xx responses', async () => {
    rx.setPlan([404]);
    const before = rx.hits.length;
    await sendMllp(P.ok, SAMPLE_ADT.replace('000002', 'NF404'));
    const m = await waitFor(async () => {
      const l = (await http_().get(`/api/channels/${chId}/messages?q=NF404`).expect(200)).body;
      return l.items[0]?.status === 'failed' ? l.items[0] : undefined;
    });
    expect(m.error).toBe('HTTP 404');
    expect(rx.hits.length - before).toBe(1);
    rx.setPlan([200]);
  });

  it('rotates secrets: both verify during rotation, revoked one stops', async () => {
    const rot = await http_().post(`/api/channels/${chId}/webhook-secrets/rotate`).expect(201);
    const secret2: string = rot.body.secret;
    expect(secret2).not.toBe(secret);
    let list = (await http_().get(`/api/channels/${chId}/webhook-secrets`).expect(200)).body;
    expect(list.filter((s: { revokedAt: string | null }) => !s.revokedAt)).toHaveLength(2);

    const before = rx.hits.length;
    await sendMllp(P.ok, SAMPLE_ADT.replace('000002', 'ROT1'));
    const hit = await waitFor(async () => rx.hits[before]);
    expect(String(hit.headers['webhook-signature']).split(' ')).toHaveLength(2);
    expect(verify(hit.headers, hit.body, [secret])).toEqual({ ok: true });
    expect(verify(hit.headers, hit.body, [secret2])).toEqual({ ok: true });

    // A third rotation revokes the oldest automatically; explicit revoke works too.
    const rot3 = await http_().post(`/api/channels/${chId}/webhook-secrets/rotate`).expect(201);
    list = (await http_().get(`/api/channels/${chId}/webhook-secrets`).expect(200)).body;
    const active = list.filter((s: { revokedAt: string | null }) => !s.revokedAt);
    expect(active.map((s: { hint: string }) => s.hint)).toEqual([rot3.body.hint, secret2.slice(-4)]);
    await http_().delete(`/api/channels/${chId}/webhook-secrets/${rot.body.id}`).expect(200);
    await http_().delete(`/api/channels/${chId}/webhook-secrets/${rot.body.id}`).expect(404);

    const b2 = rx.hits.length;
    await sendMllp(P.ok, SAMPLE_ADT.replace('000002', 'ROT2'));
    const hit2 = await waitFor(async () => rx.hits[b2]);
    expect(String(hit2.headers['webhook-signature']).split(' ')).toHaveLength(1);
    expect(verify(hit2.headers, hit2.body, [secret2])).toEqual({ ok: false, reason: 'signature' });
    expect(verify(hit2.headers, hit2.body, [rot3.body.secret])).toEqual({ ok: true });
  });

  it('fails clearly when a channel has no active secret', async () => {
    const list = (await http_().get(`/api/channels/${chId}/webhook-secrets`).expect(200)).body;
    for (const s of list.filter((s: { revokedAt: string | null }) => !s.revokedAt)) {
      await http_().delete(`/api/channels/${chId}/webhook-secrets/${s.id}`).expect(200);
    }
    const before = rx.hits.length;
    await sendMllp(P.ok, SAMPLE_ADT.replace('000002', 'NOSEC'));
    const m = await waitFor(async () => {
      const l = (await http_().get(`/api/channels/${chId}/messages?q=NOSEC`).expect(200)).body;
      return l.items[0]?.status === 'failed' ? l.items[0] : undefined;
    });
    expect(m.error).toMatch(/No active webhook secret/);
    expect(rx.hits.length).toBe(before);
    await http_().post(`/api/channels/${chId}/stop`).expect(200);
  });

  it('resend rejects messages of channels without delivery', async () => {
    await http_().post('/api/messages/00000000-0000-4000-8000-000000000000/resend').expect(404);
  });
});
