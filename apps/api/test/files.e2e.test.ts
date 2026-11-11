import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signIn, startApp, stopApp, type TestContext } from './helpers.js';
import { SAMPLE_ORU, sendMllp } from './mllp-client.js';

const CR = '\r';
const MLLP_PORT = 6049; // regression check that MLLP still works next to file channels

/** Local webhook receiver that records every POST body. */
function receiver() {
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      res.writeHead(200).end('ok');
    });
  });
  return {
    bodies,
    start: () =>
      new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`))),
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function waitFor<T>(fn: () => Promise<T | undefined | false | null>, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 150));
  }
}

const ls = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort();

const ORU = (ctrl: string) =>
  [
    `MSH|^~\\&|LIS|LAB|HIS|HOSP|20261111120000||ORU^R01^ORU_R01|${ctrl}|P|2.5.1`,
    'PID|1||MRN1^^^HOSP^MR||DOE^JANE',
    'OBR|1|ORD1|FIL1|CBC^CBC^L',
    'OBX|1|NM|WBC^WBC^L||5.5|10*3/uL|4.0-11.0|N|||F',
  ].join(CR);

let ctx: TestContext;
let cookie: string;
let root: string;
const rx = receiver();
let hookUrl: string;
const api = () => {
  const agent = request(ctx.app.getHttpServer());
  const wrap = (m: 'get' | 'post' | 'patch' | 'delete') => (url: string) => agent[m](url).set('Cookie', cookie);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), delete: wrap('delete') };
};
const fast = { stableMs: 300, pollIntervalMs: 200 };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ackwell-files-'));
  hookUrl = await rx.start();
  ctx = await startApp({ FILE_ROOT: root, MLLP_PORT_RANGE: '6049-6050' });
  cookie = await signIn(ctx.app);
});
afterAll(async () => {
  await stopApp(ctx);
  await rx.stop();
  await rm(root, { recursive: true, force: true });
});

describe('file channels: config', () => {
  it('reports file support in settings and validates file configs', async () => {
    expect((await api().get('/api/settings').expect(200)).body.files).toEqual({ enabled: true });
    const bad = await api()
      .post('/api/channels')
      .send({ name: 'bad', direction: 'outbound', transport: 'file', config: { directory: '../etc' } })
      .expect(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
    const badName = await api()
      .post('/api/channels')
      .send({ name: 'bad2', direction: 'outbound', transport: 'file', config: { fileName: '{oops}.hl7' } })
      .expect(400);
    expect(JSON.stringify(badName.body)).toContain('Unknown token');
  });

  it('checks a folder without creating it', async () => {
    const missing = await api().post('/api/channels/check-folder').send({ directory: 'NOPE' }).expect(200);
    expect(missing.body).toMatchObject({ exists: false, error: expect.stringMatching(/created when the channel starts/) });
    await mkdir(join(root, 'HERE'));
    await writeFile(join(root, 'HERE', 'a.hl7'), 'x');
    const ok = await api().post('/api/channels/check-folder').send({ directory: 'HERE' }).expect(200);
    expect(ok.body).toMatchObject({ exists: true, readable: true, writable: true, entries: 1, error: null });
    await api().post('/api/channels/check-folder').send({ directory: '/etc' }).expect(400);
  });

  it('refuses to start when the folder is not usable and shows the channel as error', async () => {
    await writeFile(join(root, 'AFILE'), 'not a folder');
    const r = await api().post('/api/channels').send({ name: 'Broken', direction: 'outbound', transport: 'file', config: { directory: 'AFILE' } }).expect(201);
    const start = await api().post(`/api/channels/${r.body.id}/start`).expect(409);
    expect(start.body.code).toBe('FOLDER_UNAVAILABLE');
    expect((await api().get(`/api/channels/${r.body.id}`).expect(200)).body.status).toBe('error');
    await api().delete(`/api/channels/${r.body.id}`).expect(204);
  });
});

describe('outbound file channel (orders)', () => {
  let chId: string;

  it('creates with defaults and starts (creates ORDER)', async () => {
    const r = await api().post('/api/channels').send({ name: 'Orders', direction: 'outbound', transport: 'file', config: {} }).expect(201);
    chId = r.body.id;
    expect(r.body).toMatchObject({ transport: 'file', config: { directory: 'ORDER', fileName: '{messageType}_{controlId}.hl7', segmentSeparator: 'CR' } });
    await api().post(`/api/channels/${chId}/start`).expect(200);
    expect((await stat(join(root, 'ORDER'))).isDirectory()).toBe(true);
  });

  it('writes a finished .hl7 file named by the pattern, nothing else in ORDER', async () => {
    const send = await api()
      .post(`/api/channels/${chId}/send`)
      .send({ flat: { msh_3_1: 'HIS', msh_9_1: 'ORM', msh_9_2: 'O01', msh_10: 'ORD0001', msh_11_1: 'P', msh_12: '2.5.1', segments: [{ segment: 'PID', pid_3: [{ pid_3_1: 'MRN1' }] }] } })
      .expect(201);
    const m = await waitFor(async () => {
      const d = (await api().get(`/api/messages/${send.body.id}`).expect(200)).body;
      return d.status === 'sent' ? d : null;
    });
    expect(m.sourceFile).toBe('ORDER/ORM_ORD0001.hl7');
    expect(m.ackCode).toBeNull();
    expect(m.attempts[0].response).toMatch(/^Wrote ORDER\/ORM_ORD0001\.hl7 \(\d+ bytes\)$/);
    expect(await ls(join(root, 'ORDER'))).toEqual(['ORM_ORD0001.hl7']);
    expect(await ls(join(root, '.ackwell-tmp'))).toEqual([]); // staging cleaned up
    const text = await readFile(join(root, 'ORDER', 'ORM_ORD0001.hl7'), 'utf8');
    expect(text).toMatch(/^MSH\|\^~\\&\|HIS\|/);
    expect(text.endsWith('\r')).toBe(true); // every segment terminated
    expect(text.split('\r')).toHaveLength(3); // MSH, PID, trailing ''
  });

  it('never overwrites: the same name gets a _1 suffix', async () => {
    const send = await api().post(`/api/channels/${chId}/send`).send({ hl7: 'MSH|^~\\&|HIS|H|||||ORM^O01|ORD0001|P|2.5.1\rPID|1' }).expect(201);
    await waitFor(async () => (await api().get(`/api/messages/${send.body.id}`)).body.status === 'sent');
    expect(await ls(join(root, 'ORDER'))).toEqual(['ORM_ORD0001.hl7', 'ORM_ORD0001_1.hl7']);
  });

  it('uses the configured separator (CRLF) and pattern', async () => {
    const r = await api()
      .post('/api/channels')
      .send({ name: 'Orders CRLF', direction: 'outbound', transport: 'file', config: { directory: 'ORDER2', fileName: '{date}_{seq}.txt', segmentSeparator: 'CRLF' } })
      .expect(201);
    await api().post(`/api/channels/${r.body.id}/start`).expect(200);
    const send = await api().post(`/api/channels/${r.body.id}/send`).send({ hl7: 'MSH|^~\\&|A|B|||||ORM^O01|X1|P|2.5.1\rPID|1' }).expect(201);
    await waitFor(async () => (await api().get(`/api/messages/${send.body.id}`)).body.status === 'sent');
    const [name] = await ls(join(root, 'ORDER2'));
    expect(name).toMatch(/^\d{8}_000001\.txt$/);
    // MSH-7 (timestamp) is filled in by the server; every segment ends with CRLF and there is no bare CR.
    expect(await readFile(join(root, 'ORDER2', name!), 'utf8')).toMatch(/^MSH\|\^~\\&\|A\|B\|\|\|\d{14}\|\|ORM\^O01\|X1\|P\|2\.5\.1\r\nPID\|1\r\n$/);
  });
});

describe('inbound file channel (results)', () => {
  let chId: string;
  const RESULT = () => join(root, 'RESULT');
  const PROCESSED = () => join(root, 'PROCESSED');
  const ERROR = () => join(root, 'ERROR');

  it('imports files already waiting at start, delivers json + flat, moves them to PROCESSED', async () => {
    await mkdir(RESULT(), { recursive: true });
    const old = join(RESULT(), 'early.hl7');
    await writeFile(old, ORU('EARLY1'));
    await utimes(old, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    const r = await api()
      .post('/api/channels')
      .send({ name: 'Results', direction: 'inbound', transport: 'file', config: fast, delivery: { type: 'webhook', url: hookUrl } })
      .expect(201);
    chId = r.body.id;
    expect(r.body.config).toMatchObject({ directory: 'RESULT', processedDirectory: 'PROCESSED', errorDirectory: 'ERROR', include: ['*.hl7'] });
    await api().post(`/api/channels/${chId}/start`).expect(200);

    const hook = await waitFor(async () => rx.bodies.find((b) => b.controlId === 'EARLY1'));
    expect(hook).toMatchObject({ messageType: 'ORU^R01', flat: { msh_9_1: 'ORU', msh_12: '2.5.1' } });
    await waitFor(async () => (await ls(PROCESSED())).includes('early.hl7'));
    expect(await ls(RESULT())).toEqual([]);

    const list = (await api().get(`/api/channels/${chId}/messages`).expect(200)).body;
    expect(list.items[0]).toMatchObject({ controlId: 'EARLY1', status: expect.stringMatching(/received|delivered/), sourceFile: 'RESULT/early.hl7', remoteAddress: null });
  });

  it('accepts CRLF files and waits until a slowly written file is finished', async () => {
    const p = join(RESULT(), 'slow.hl7');
    const lines = ORU('SLOW1').split(CR);
    await writeFile(p, lines[0] + '\r\n');
    for (const l of lines.slice(1)) {
      await new Promise((r) => setTimeout(r, 120));
      await appendFile(p, l + '\r\n');
    }
    const hook = await waitFor(async () => rx.bodies.find((b) => b.controlId === 'SLOW1'));
    // Stored with \r between segments and complete (all four segments).
    expect((hook.raw as string).split(CR)).toHaveLength(4);
    await waitFor(async () => (await ls(PROCESSED())).includes('slow.hl7'));
  });

  it('ignores other extensions and hidden files', async () => {
    await writeFile(join(RESULT(), 'notes.txt'), 'hello');
    await writeFile(join(RESULT(), '.partial.hl7'), ORU('HIDDEN'));
    await new Promise((r) => setTimeout(r, 1500));
    expect(await ls(RESULT())).toEqual(['.partial.hl7', 'notes.txt']);
    expect(rx.bodies.find((b) => b.controlId === 'HIDDEN')).toBeUndefined();
  });

  it('moves invalid files to ERROR with a reason, lists them, and Retry re-imports a fixed file', async () => {
    await writeFile(join(RESULT(), 'two.hl7'), ORU('TWO1') + CR + ORU('TWO2'));
    await writeFile(join(RESULT(), 'junk.hl7'), 'hello world');
    await waitFor(async () => (await ls(ERROR())).length === 4);
    expect(await ls(ERROR())).toEqual(['junk.hl7', 'junk.hl7.error.txt', 'two.hl7', 'two.hl7.error.txt']);
    expect(await readFile(join(ERROR(), 'two.hl7.error.txt'), 'utf8')).toMatch(/Reason: The file holds 2 messages/);

    const errors = (await api().get(`/api/channels/${chId}/files/errors`).expect(200)).body;
    expect(errors.map((e: { name: string }) => e.name).sort()).toEqual(['junk.hl7', 'two.hl7']);
    expect(errors.find((e: { name: string }) => e.name === 'junk.hl7').reason).toMatch(/No MSH segment/);

    // Fix the file in place, then retry.
    await writeFile(join(ERROR(), 'junk.hl7'), ORU('FIXED1'));
    const retry = await api().post(`/api/channels/${chId}/files/errors/junk.hl7/retry`).expect(200);
    expect(retry.body.movedTo).toBe('RESULT/junk.hl7');
    await waitFor(async () => rx.bodies.find((b) => b.controlId === 'FIXED1'));
    expect(await ls(ERROR())).toEqual(['two.hl7', 'two.hl7.error.txt']);
    await api().post(`/api/channels/${chId}/files/errors/..%2Fx/retry`).expect(400);
  });

  it('does not import the same content twice', async () => {
    const before = rx.bodies.filter((b) => b.controlId === 'EARLY1').length;
    await writeFile(join(RESULT(), 'again.hl7'), ORU('EARLY1'));
    await waitFor(async () => (await ls(PROCESSED())).includes('again.hl7'));
    await new Promise((r) => setTimeout(r, 500));
    expect(rx.bodies.filter((b) => b.controlId === 'EARLY1').length).toBe(before);
  });

  it('keeps file names unique in PROCESSED', async () => {
    await writeFile(join(RESULT(), 'early.hl7'), ORU('EARLY2'));
    await waitFor(async () => (await ls(PROCESSED())).includes('early_1.hl7'));
  });

  it('refuses a second channel on the same folder and stops cleanly', async () => {
    const dup = await api()
      .post('/api/channels')
      .send({ name: 'Results 2', direction: 'inbound', transport: 'file', config: { directory: 'result' }, delivery: { type: 'webhook', url: hookUrl } })
      .expect(409);
    expect(dup.body.code).toBe('FOLDER_IN_USE');

    await api().post(`/api/channels/${chId}/stop`).expect(200);
    await writeFile(join(RESULT(), 'stopped.hl7'), ORU('STOPPED1'));
    await new Promise((r) => setTimeout(r, 1200));
    expect(await ls(RESULT())).toContain('stopped.hl7');
    // Starting again picks up what arrived meanwhile.
    await api().post(`/api/channels/${chId}/start`).expect(200);
    await waitFor(async () => rx.bodies.find((b) => b.controlId === 'STOPPED1'));
  });

  it('deletes processed files with the retention job, keeps error files', async () => {
    const processedBefore = (await ls(PROCESSED())).length;
    expect(processedBefore).toBeGreaterThan(0);
    // Make every import look 30 days old.
    const { DB } = await import('../src/db/db.js');
    const db = ctx.app.get(DB);
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`update file_imports set created_at = now() - interval '30 days'`);
    const run = (await api().post('/api/retention/run').expect(200)).body;
    expect(run.filesDeleted).toBe(processedBefore);
    expect(await ls(PROCESSED())).toEqual([]);
    expect(await ls(ERROR())).toEqual(['two.hl7', 'two.hl7.error.txt']);
  });
});

describe('MLLP is unchanged', () => {
  it('still receives over MLLP next to file channels', async () => {
    const r = await api()
      .post('/api/channels')
      .send({ name: 'MLLP in', direction: 'inbound', config: { port: MLLP_PORT }, delivery: { type: 'webhook', url: hookUrl } })
      .expect(201);
    expect(r.body.transport).toBe('mllp');
    await api().post(`/api/channels/${r.body.id}/start`).expect(200);
    expect(await sendMllp(MLLP_PORT, SAMPLE_ORU)).toMatch(/MSA\|AA\|MSG00001/);
    await api().post(`/api/channels/${r.body.id}/stop`).expect(200);
  });
});
