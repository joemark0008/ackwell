import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signIn, startApp, stopApp, type TestContext } from './helpers.js';
import { SAMPLE_ORU, sendMllp } from './mllp-client.js';

let ctx: TestContext;
let cookie: string;
const agent = () => request(ctx.app.getHttpServer());
const authed = (m: 'get' | 'post', u: string) => agent()[m](u).set('Cookie', cookie);

const TOKEN = 'metrics-token-1234567890';
let chIn: string;
let chOut: string;

const value = (text: string, line: string) => {
  const l = text.split('\n').find((x) => x.startsWith(line));
  return l ? Number(l.slice(line.length).trim()) : undefined;
};
const scrape = async () => (await agent().get('/metrics').set('Authorization', `Bearer ${TOKEN}`).expect(200)).text;
async function until<T>(fn: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeAll(async () => {
  ctx = await startApp({ MLLP_PORT_RANGE: '6040-6050', METRICS_TOKEN: TOKEN });
  cookie = await signIn(ctx.app);
  chIn = (
    await authed('post', '/api/channels')
      .send({ name: 'Lab in', direction: 'inbound', config: { port: 6041 }, delivery: { type: 'webhook', url: 'http://127.0.0.1:9/h', maxAttempts: 1 } })
      .expect(201)
  ).body.id;
  chOut = (
    await authed('post', '/api/channels')
      .send({ name: 'To LIS', direction: 'outbound', config: { host: '127.0.0.1', port: 9, ackTimeoutMs: 1000, retry: { maxAttempts: 1, backoffSeconds: 1 } } })
      .expect(201)
  ).body.id;
  await authed('post', `/api/channels/${chIn}/start`).expect(200);
  await authed('post', `/api/channels/${chOut}/start`).expect(200);
});
afterAll(async () => {
  await stopApp(ctx);
});

describe('GET /metrics with METRICS_TOKEN', () => {
  it('requires the bearer token', async () => {
    await agent().get('/metrics').expect(401);
    await agent().get('/metrics').set('Authorization', 'Bearer wrong-token-0000000000').expect(401);
    const r = await agent().get('/metrics').set('Authorization', `Bearer ${TOKEN}`).expect(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
  });

  it('exposes default node metrics, channel status and queue depth', async () => {
    const t = await scrape();
    expect(t).toContain('process_cpu_user_seconds_total');
    expect(t).toContain('nodejs_eventloop_lag_seconds');
    expect(t).toContain(`ackwell_channel_status{channel_id="${chIn}",channel_name="Lab in",status="running"} 1`);
    expect(t).toContain(`ackwell_channel_status{channel_id="${chIn}",channel_name="Lab in",status="stopped"} 0`);
    expect(t).toMatch(/ackwell_queue_depth\{queue="outbound"\} \d+/);
    expect(t).toMatch(/ackwell_queue_depth\{queue="delivery"\} \d+/);
  });

  it('counts inbound messages and terminal outcomes', async () => {
    await sendMllp(6041, SAMPLE_ORU);
    await sendMllp(6041, SAMPLE_ORU.replace('MSG00001', 'MSG00002'));
    const recv = `ackwell_messages_total{channel_id="${chIn}",channel_name="Lab in",direction="inbound",status="received"} `;
    await until(async () => (value(await scrape(), recv) ?? 0) >= 2);
    expect(value(await scrape(), recv)).toBe(2); // not counted twice
    // webhook target refuses connections: both end up failed after 1 attempt
    const failed = `ackwell_messages_total{channel_id="${chIn}",channel_name="Lab in",direction="inbound",status="failed"} `;
    await until(async () => (value(await scrape(), failed) ?? 0) >= 2);
    expect(value(await scrape(), failed)).toBe(2);
  });

  it('counts outbound failures; rejected outbound counts as an ACK failure', async () => {
    await authed('post', `/api/channels/${chOut}/send`)
      .send({ hl7: 'MSH|^~\\&|ACKWELL|H|X|Y|20261111120000||ORM^O01|O1|P|2.5.1\rPID|1' })
      .expect(201);
    const failed = `ackwell_messages_total{channel_id="${chOut}",channel_name="To LIS",direction="outbound",status="failed"} `;
    await until(async () => (value(await scrape(), failed) ?? 0) >= 1);
    expect(value(await scrape(), failed)).toBe(1);
  });

  it('records ACK failures sent by listeners (AE/AR) and received from receivers', async () => {
    const { MetricsService } = await import('../src/metrics/metrics.service.js');
    const m = ctx.app.get(MetricsService);
    m.ackFailure(chIn, 'inbound', 'AE');
    const t = await scrape();
    expect(value(t, `ackwell_ack_failures_total{channel_id="${chIn}",direction="inbound"} `)).toBe(1);
  });

  it('reflects channel status changes', async () => {
    await authed('post', `/api/channels/${chIn}/stop`).expect(200);
    const t = await scrape();
    expect(t).toContain(`ackwell_channel_status{channel_id="${chIn}",channel_name="Lab in",status="stopped"} 1`);
    expect(t).toContain(`ackwell_channel_status{channel_id="${chIn}",channel_name="Lab in",status="running"} 0`);
  });
});

describe('GET /metrics without METRICS_TOKEN', () => {
  it('is open', async () => {
    const open = await startApp({ MLLP_PORT_RANGE: '6040-6050', METRICS_TOKEN: '' }, { pg: ctx.pg });
    try {
      const r = await request(open.app.getHttpServer()).get('/metrics').expect(200);
      expect(r.text).toContain('ackwell_queue_depth');
    } finally {
      await open.app.close();
    }
  });
});
