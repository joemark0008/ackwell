import fs, { readFileSync } from 'node:fs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Logger } from 'nestjs-pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verify } from '../src/delivery/standard-webhooks.js';
import { ADMIN, signIn, TEST_ORIGIN } from './helpers.js';
import { SAMPLE_ORU, sendMllp } from './mllp-client.js';
import { ackOf, mllpReceiver, waitFor, webhookReceiver } from './qa-helpers.js';

/**
 * QA gap e: secrets, API keys and TLS private keys never appear in API responses (after the one-time
 * create/rotate response) nor in the logs, with LOG_LEVEL=debug and the pino logger wired as in main.ts.
 * Own file because the pino level is fixed when app.module is first imported. MLLP ports 6030-6039.
 */

// ---- log capture: pino writes to fd 1 through sonic-boom (fs.write / fs.writeSync), Nest via stdout ----
const captured: string[] = [];
const orig = { write: fs.write, writeSync: fs.writeSync, stdout: process.stdout.write, stderr: process.stderr.write };
const asText = (b: unknown) => (typeof b === 'string' ? b : Buffer.isBuffer(b) || b instanceof Uint8Array ? Buffer.from(b).toString('utf8') : '');
function startCapture() {
  (fs as { writeSync: unknown }).writeSync = function (fd: number, buf: unknown, ...rest: unknown[]) {
    if (fd === 1 || fd === 2) {
      const t = asText(buf);
      captured.push(t);
      return Buffer.byteLength(t);
    }
    return (orig.writeSync as (...a: unknown[]) => number).call(fs, fd, buf, ...rest);
  };
  (fs as { write: unknown }).write = function (fd: number, buf: unknown, ...rest: unknown[]) {
    if (fd === 1 || fd === 2) {
      const t = asText(buf);
      captured.push(t);
      const cb = rest.find((r) => typeof r === 'function') as ((e: null, n: number) => void) | undefined;
      if (cb) process.nextTick(() => cb(null, Buffer.byteLength(t)));
      return;
    }
    return (orig.write as (...a: unknown[]) => void).call(fs, fd, buf, ...rest);
  };
  process.stdout.write = ((chunk: unknown) => (captured.push(asText(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => (captured.push(asText(chunk)), true)) as typeof process.stderr.write;
}
function stopCapture() {
  (fs as { write: unknown }).write = orig.write;
  (fs as { writeSync: unknown }).writeSync = orig.writeSync;
  process.stdout.write = orig.stdout;
  process.stderr.write = orig.stderr;
}

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const SERVER = { cert: fx('server.pem'), key: fx('server.key') };
const CA = fx('ca.pem');
/** A line from the middle of the PEM body: unique to the key, independent of header formatting. */
const KEY_MARKER = SERVER.key.split('\n').filter((l) => l && !l.startsWith('-----'))[2]!;

let app: NestExpressApplication | undefined;
let pgc: StartedPostgreSqlContainer;
let cookie: string;
const hook = webhookReceiver();
const rx = mllpReceiver();
let hookUrl: string;
let rxPort: number;
const http = () => {
  const agent = request(app!.getHttpServer());
  const wrap = (m: 'get' | 'post' | 'patch' | 'delete') => (url: string) => agent[m](url).set('Cookie', cookie);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), delete: wrap('delete') };
};

beforeAll(async () => {
  hookUrl = await hook.start();
  rxPort = await rx.start();
  pgc = await new PostgreSqlContainer('postgres:16-alpine').start();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'debug',
    DATABASE_URL: pgc.getConnectionUri(),
    MLLP_PORT_RANGE: '6030-6039',
    RETENTION_DEFAULT_DAYS: '7',
    DELIVERY_RETRY_DELAY_SECONDS: '1',
    QUEUE_POLL_SECONDS: '0.5',
    APP_URL: TEST_ORIGIN,
    BETTER_AUTH_SECRET: 'test-secret-'.padEnd(40, 'x'),
    SEED_ADMIN_EMAIL: ADMIN.email,
    SEED_ADMIN_PASSWORD: ADMIN.password,
  });
  const { runMigrations } = await import('../src/db/db.js');
  await runMigrations(process.env.DATABASE_URL!);
  startCapture();
  // Same wiring as main.ts: buffered boot logs flushed through nestjs-pino.
  const { AppModule } = await import('../src/app.module.js');
  const { configureApp } = await import('../src/setup.js');
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication<NestExpressApplication>({ bufferLogs: true, bodyParser: false });
  app.useLogger(app.get(Logger));
  configureApp(app);
  await app.init();
  cookie = await signIn(app);
});
afterAll(async () => {
  stopCapture();
  await app?.close();
  await pgc?.stop();
  await rx.stop();
  await hook.stop();
});

describe('e. secrets never leak into responses or logs', () => {
  const secrets: Record<string, string> = {};
  let inId: string;
  let outId: string;
  let tlsInId: string;
  let tlsOutId: string;
  const responses: string[] = [];
  const keep = (label: string, body: unknown) => responses.push(`${label}: ${JSON.stringify(body)}`);

  it('creates, rotates, sends and delivers with secrets in play', async () => {
    const r = await http()
      .post('/api/channels')
      .send({ name: 'Leak in', direction: 'inbound', config: { port: 6030 }, delivery: { type: 'webhook', url: hookUrl } })
      .expect(201);
    inId = r.body.id;
    secrets.webhook1 = r.body.webhookSecret.secret;
    const rot = await http().post(`/api/channels/${inId}/webhook-secrets/rotate`).expect(201);
    secrets.webhook2 = rot.body.secret;
    expect(secrets.webhook2).not.toBe(secrets.webhook1);

    outId = (
      await http()
        .post('/api/channels')
        .send({ name: 'Leak out', direction: 'outbound', config: { host: '127.0.0.1', port: rxPort, ackTimeoutMs: 1500, retry: { maxAttempts: 1, backoffSeconds: 1 } } })
        .expect(201)
    ).body.id;
    await http().post(`/api/channels/${outId}/start`).expect(200);
    const k = await http().post(`/api/channels/${outId}/api-keys`).send({ label: 'leak test' }).expect(201);
    secrets.apiKey = k.body.key;
    expect(secrets.apiKey).toMatch(/^ak_/);

    tlsInId = (
      await http()
        .post('/api/channels')
        .send({ name: 'Leak TLS in', direction: 'inbound', config: { port: 6031, tls: { enabled: true, ...SERVER } }, delivery: { type: 'webhook', url: hookUrl } })
        .expect(201)
    ).body.id;
    tlsOutId = (
      await http()
        .post('/api/channels')
        .send({ name: 'Leak TLS out', direction: 'outbound', config: { host: '127.0.0.1', port: 1, tls: { enabled: true, ca: CA } } })
        .expect(201)
    ).body.id;

    // Machine send with the API key (Authorization header must be redacted in the request log).
    const s = await request(app!.getHttpServer())
      .post(`/api/channels/${outId}/send`)
      .set('Authorization', `Bearer ${secrets.apiKey}`)
      .send({ hl7: SAMPLE_ORU.replace('MSG00001', 'LEAK0001') })
      .expect(201);
    await waitFor(async () => (await http().get(`/api/messages/${s.body.id}`).expect(200)).body.status === 'sent');
    // A wrong bearer (the key plus one char) must not be echoed into logs either.
    await request(app!.getHttpServer()).post(`/api/channels/${outId}/send`).set('Authorization', `Bearer ${secrets.apiKey}x`).send({ hl7: SAMPLE_ORU }).expect(401);

    // Inbound → signed webhook (both secrets sign during the rotation).
    await http().post(`/api/channels/${inId}/start`).expect(200);
    expect(ackOf(await sendMllp(6030, SAMPLE_ORU.replace('MSG00001', 'LEAK0002'))).code).toBe('AA');
    const hit = await waitFor(() => hook.hits.find((h) => JSON.parse(h.body).controlId === 'LEAK0002'));
    expect(String(hit.headers['webhook-signature']).split(' ')).toHaveLength(2);
    expect(verify(hit.headers, hit.body, [secrets.webhook1!])).toEqual({ ok: true });
    expect(verify(hit.headers, hit.body, [secrets.webhook2!])).toEqual({ ok: true });
    // The webhook body itself must not carry the secret either.
    for (const v of Object.values(secrets)) expect(hit.body).not.toContain(v);
  });

  it('no secret in any read response (hint / prefix / hasKey only)', async () => {
    const get = async (url: string) => {
      const b = (await http().get(url).expect(200)).body;
      keep(url, b);
      return b;
    };
    await get('/api/channels');
    for (const id of [inId, outId, tlsInId, tlsOutId]) await get(`/api/channels/${id}`);
    const sec = await get(`/api/channels/${inId}/webhook-secrets`);
    expect(sec).toHaveLength(2);
    expect(sec.map((s: { hint: string }) => s.hint).sort()).toEqual([secrets.webhook1!.slice(-4), secrets.webhook2!.slice(-4)].sort());
    const keys = await get(`/api/channels/${outId}/api-keys`);
    expect(keys[0].prefix).toBe(secrets.apiKey!.slice(0, 11));
    await get('/api/messages');
    for (const m of (await get('/api/messages')).items) await get(`/api/messages/${m.id}`);

    const tlsIn = (await http().get(`/api/channels/${tlsInId}`).expect(200)).body;
    expect(tlsIn.config.tls).toEqual({ enabled: true, cert: SERVER.cert, requestCert: false, hasKey: true });
    const tlsOut = (await http().get(`/api/channels/${tlsOutId}`).expect(200)).body;
    expect(tlsOut.config.tls).toMatchObject({ enabled: true, ca: CA });
    expect(tlsOut.config.tls.key).toBeUndefined();

    const all = responses.join('\n');
    for (const [name, v] of Object.entries(secrets)) expect(all.includes(v), `${name} in a response`).toBe(false);
    expect(all).not.toContain('PRIVATE KEY');
    expect(all).not.toContain(KEY_MARKER);
  });

  it('no secret in the debug logs', async () => {
    // Shut down so every buffered log line is flushed, then inspect.
    await app!.close();
    app = undefined;
    stopCapture();
    const logs = captured.join('');
    // The capture works: request + service lines are there.
    expect(logs).toMatch(/"level":20|"level":30/);
    expect(logs).toContain('LEAK0002');
    expect(logs).toContain('/webhook-secrets/rotate');
    expect(logs).toContain('/api-keys');
    for (const [name, v] of Object.entries(secrets)) {
      expect(logs.includes(v), `${name} in logs`).toBe(false);
      // Not even the secret body without its prefix.
      expect(logs.includes(v.replace(/^(whsec_|ak_)/, '')), `${name} body in logs`).toBe(false);
    }
    expect(logs).not.toContain('PRIVATE KEY');
    expect(logs).not.toContain(KEY_MARKER);
    expect(logs).not.toContain(ADMIN.password);
  });

  it('no session token in the debug logs', () => {
    const logs = captured.join('');
    expect(logs.includes(sessionToken()), 'session token (Set-Cookie of sign-in) in logs').toBe(false);
  });
});

/** Value of the better-auth session cookie obtained by signIn (before the signature dot). */
function sessionToken(): string {
  const pair = cookie.split('; ').find((c) => c.includes('session_token='))!;
  return decodeURIComponent(pair.slice(pair.indexOf('=') + 1)).split('.')[0]!;
}
