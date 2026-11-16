import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verify } from '../src/delivery/standard-webhooks.js';
import { signIn, startApp, stopApp, type TestContext } from './helpers.js';
import { isListening, SAMPLE_ADT, sendMllp } from './mllp-client.js';
import { ackOf, mllpReceiver, mshField, waitFor, webhookReceiver } from './qa-helpers.js';

/**
 * QA gap coverage (Phase 8): fixture inbound flow, failing insert → no AA, ordering with a retry in the
 * middle, AR acks, webhook-id stability across retries, start/stop/start, graceful shutdown.
 * MLLP ports 6010-6039 (other files use 6040-6050; 6001/6002 are Coolify's on the dev host).
 */
const PORT_RANGE = '6010-6039';
const P = { fixtures: 6010, trigger: 6011, shutdown: 6012, restart: 6013, hook: 6014, slow: 6015 };
const CR = '\r';

const FIXTURE_DIR = new URL('../../../fixtures/hl7/', import.meta.url);
const FIXTURES = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.hl7'))
  .sort()
  .map((name) => ({ name, raw: readFileSync(new URL(name, FIXTURE_DIR), 'utf8') }));

let ctx: TestContext;
let cookie: string;
const http = () => {
  const agent = request(ctx.app.getHttpServer());
  const wrap = (m: 'get' | 'post' | 'patch' | 'delete') => (url: string) => agent[m](url).set('Cookie', cookie);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), delete: wrap('delete') };
};
const hook = webhookReceiver();
const rx = mllpReceiver();
let hookUrl: string;
let rxPort: number;

beforeAll(async () => {
  hookUrl = await hook.start();
  rxPort = await rx.start();
  ctx = await startApp({ MLLP_PORT_RANGE: PORT_RANGE });
  cookie = await signIn(ctx.app);
});
afterAll(async () => {
  await stopApp(ctx);
  await rx.stop();
  await hook.stop();
});

const inbound = (name: string, port: number, delivery: Record<string, unknown> = {}) => ({
  name,
  direction: 'inbound',
  config: { port },
  delivery: { type: 'webhook', url: hookUrl, ...delivery },
});

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: ctx.pg.getConnectionUri() });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

const detail = async (id: string) => (await http().get(`/api/messages/${id}`).expect(200)).body;
const listAll = async (chId: string) => (await http().get(`/api/channels/${chId}/messages?limit=200`).expect(200)).body;

describe('a. fixture inbound flow', () => {
  let chId: string;

  it('every fixture → AA with MSA-2 = MSH-10, stored raw byte for byte, JSON present, webhook delivered', async () => {
    chId = (await http().post('/api/channels').send(inbound('Fixtures in', P.fixtures)).expect(201)).body.id;
    await http().post(`/api/channels/${chId}/start`).expect(200);
    expect(FIXTURES.length).toBeGreaterThanOrEqual(5);

    for (const fx of FIXTURES) {
      const ctrl = mshField(fx.raw, 10);
      const ack = await sendMllp(P.fixtures, fx.raw);
      expect(ackOf(ack), fx.name).toEqual({ code: 'AA', controlId: ctrl });

      const list = await http().get(`/api/channels/${chId}/messages?q=${encodeURIComponent(ctrl)}`).expect(200);
      expect(list.body.total, fx.name).toBe(1);
      const m = await detail(list.body.items[0].id);
      expect(m.raw, fx.name).toBe(fx.raw);
      expect(m.controlId, fx.name).toBe(ctrl);
      expect(m.messageType, fx.name).toBe(mshField(fx.raw, 9).split(fx.raw[4]!).slice(0, 2).join('^'));
      expect(m.ackCode).toBe('AA');
      expect(m.json?.segments?.length, fx.name).toBe(fx.raw.split(CR).length);
      expect(m.json.segments.map((s: { id: string }) => s.id), fx.name).toEqual(fx.raw.split(CR).map((l) => l.slice(0, 3)));

      const hit = await waitFor(() => hook.hits.find((h) => JSON.parse(h.body).controlId === ctrl));
      expect(JSON.parse(hit.body).raw, fx.name).toBe(fx.raw);
    }
    expect((await listAll(chId)).total).toBe(FIXTURES.length);
  });

  it('webhook payload carries typed flat JSON only for 2.3 / 2.5.1 / 2.7', () => {
    for (const fx of FIXTURES) {
      const ctrl = mshField(fx.raw, 10);
      const payload = JSON.parse(hook.hits.find((h) => JSON.parse(h.body).controlId === ctrl)!.body);
      const v = mshField(fx.raw, 12);
      if (['2.3', '2.5.1', '2.7'].includes(v)) expect(payload.flat?.msh_12, fx.name).toBe(v);
      else expect(payload.flat, fx.name).toBeNull();
    }
  });

  it('stops the channel', async () => {
    await http().post(`/api/channels/${chId}/stop`).expect(200);
  });
});

describe('b. persist before ACK with a failing insert', () => {
  it('no AA while inserts fail; nothing stored; AA and exactly one row after recovery', async () => {
    const chId = (await http().post('/api/channels').send(inbound('Trigger', P.trigger)).expect(201)).body.id;
    await http().post(`/api/channels/${chId}/start`).expect(200);
    const msg = SAMPLE_ADT.replace('000002', 'QATRIG01');

    await sql(`CREATE OR REPLACE FUNCTION qa_block_insert() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'qa: insert disabled'; END $$ LANGUAGE plpgsql`);
    await sql('CREATE TRIGGER qa_block_insert BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION qa_block_insert()');
    try {
      let outcome: string;
      try {
        outcome = ackOf(await sendMllp(P.trigger, msg)).code;
      } catch (e) {
        outcome = `closed (${(e as Error).name})`;
      }
      expect(outcome).not.toBe('AA');
      // Observed behaviour (recorded in the QA report): the listener answers AR.
      expect(outcome).toBe('AR');
      const rows = await sql<{ n: number }>('select count(*)::int as n from messages where channel_id = $1', [chId]);
      expect(rows[0]!.n).toBe(0);
    } finally {
      await sql('DROP TRIGGER IF EXISTS qa_block_insert ON messages');
      await sql('DROP FUNCTION IF EXISTS qa_block_insert()');
    }

    // The sender retries the same message after recovery.
    expect(ackOf(await sendMllp(P.trigger, msg))).toEqual({ code: 'AA', controlId: 'QATRIG01' });
    const rows = await sql<{ raw: string }>('select raw from messages where channel_id = $1', [chId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.raw).toBe(msg);
    await http().post(`/api/channels/${chId}/stop`).expect(200);
  });
});

describe('outbound (c ordering with a retry, f AR)', () => {
  let chId: string;
  const RAW = (ctrl: string) =>
    [`MSH|^~\\&|ACKWELL|HOSP|LIS|LAB|20261116120000||ORM^O01|${ctrl}|P|2.5.1`, 'PID|1||123456^^^HOSP^MR||DOE^JANE', 'ORC|NW|ORD1'].join(CR);
  const settled = (id: string, statuses = ['sent', 'rejected', 'failed']) =>
    waitFor(async () => {
      const d = await detail(id);
      return statuses.includes(d.status) ? d : undefined;
    }, 45_000);

  beforeAll(async () => {
    chId = (
      await http()
        .post('/api/channels')
        .send({
          name: 'QA out',
          direction: 'outbound',
          hl7Version: '2.5.1',
          config: { host: '127.0.0.1', port: rxPort, ackTimeoutMs: 1000, retry: { maxAttempts: 3, backoffSeconds: 1 } },
        })
        .expect(201)
    ).body.id;
    await http().post(`/api/channels/${chId}/start`).expect(200);
  });

  it('c. keeps send order when message #3 needs a retry', async () => {
    const ctrls = ['QORD1', 'QORD2', 'FLAKY3', 'QORD4', 'QORD5'];
    const before = rx.frames.length;
    const ids: string[] = [];
    for (const c of ctrls) ids.push((await http().post(`/api/channels/${chId}/send`).send({ hl7: RAW(c) }).expect(201)).body.id);
    const done = [];
    for (const id of ids) done.push(await settled(id));
    expect(done.map((m) => m.status)).toEqual(['sent', 'sent', 'sent', 'sent', 'sent']);
    expect(done.map((m) => m.ackCode)).toEqual(['AA', 'AA', 'AA', 'AA', 'AA']);
    expect(done[2].attempts.map((a: { attempt: number; result: string }) => [a.attempt, a.result])).toEqual([
      [1, 'failure'],
      [2, 'success'],
    ]);
    expect(done[2].attempts[0].error).toMatch(/No ACK/);

    const frames = rx.frames.slice(before);
    // Every frame the receiver saw, in arrival order: #3 twice, nothing of #4 before #3's retry.
    expect(frames.map((f) => f.controlId)).toEqual(['QORD1', 'QORD2', 'FLAKY3', 'FLAKY3', 'QORD4', 'QORD5']);
    const delivered = frames.filter((f) => f.answered === 'AA');
    expect(delivered.map((f) => f.controlId)).toEqual(ctrls);
    const ok3 = delivered.find((f) => f.controlId === 'FLAKY3')!;
    const first4 = frames.find((f) => f.controlId === 'QORD4')!;
    expect(first4.at).toBeGreaterThanOrEqual(ok3.at);
  });

  it('f. AR → rejected, ackCode AR, one attempt, no retry', async () => {
    const before = rx.frames.length;
    const r = await http().post(`/api/channels/${chId}/send`).send({ hl7: RAW('AR001') }).expect(201);
    const m = await settled(r.body.id);
    expect(m.status).toBe('rejected');
    expect(m.ackCode).toBe('AR');
    expect(m.error).toBe('Receiver answered AR');
    expect(m.attempts).toHaveLength(1);
    expect(m.attempts[0]).toMatchObject({ attempt: 1, result: 'failure' });
    expect(m.attempts[0].response).toMatch(/MSA\|AR\|AR001/);
    // A later message proves the queue moved on and nothing re-sent AR001.
    const r2 = await http().post(`/api/channels/${chId}/send`).send({ hl7: RAW('QAFTER') }).expect(201);
    await settled(r2.body.id, ['sent']);
    expect(rx.frames.slice(before).map((f) => f.controlId)).toEqual(['AR001', 'QAFTER']);
    expect((await detail(r.body.id)).attempts).toHaveLength(1);
  });

  afterAll(async () => {
    await http().post(`/api/channels/${chId}/stop`).expect(200);
  });
});

describe('g. webhook-id is stable across retries', () => {
  it('500 then 200 → same webhook-id and body id, signatures verify, timestamps non-decreasing', async () => {
    const r = await http().post('/api/channels').send(inbound('Hook retry', P.hook, { maxAttempts: 3 })).expect(201);
    const chId = r.body.id;
    const secret: string = r.body.webhookSecret.secret;
    await http().post(`/api/channels/${chId}/start`).expect(200);
    hook.setPlan([500, 200]);
    try {
      const msg = SAMPLE_ADT.replace('000002', 'QAHOOK01');
      expect(ackOf(await sendMllp(P.hook, msg)).code).toBe('AA');
      const hits = await waitFor(() => {
        const h = hook.hits.filter((x) => JSON.parse(x.body).controlId === 'QAHOOK01');
        return h.length >= 2 ? h : undefined;
      }, 30_000);
      expect(hits).toHaveLength(2);
      const [a, b] = hits as [(typeof hits)[0], (typeof hits)[0]];
      expect(a.headers['webhook-id']).toBeTruthy();
      expect(b.headers['webhook-id']).toBe(a.headers['webhook-id']);
      expect(JSON.parse(b.body).id).toBe(JSON.parse(a.body).id);
      expect(JSON.parse(a.body).id).toBe(a.headers['webhook-id']);
      expect(Number(b.headers['webhook-timestamp'])).toBeGreaterThanOrEqual(Number(a.headers['webhook-timestamp']));
      expect(verify(a.headers, a.body, [secret])).toEqual({ ok: true });
      expect(verify(b.headers, b.body, [secret])).toEqual({ ok: true });

      const m = await waitFor(async () => {
        const d = await detail(JSON.parse(a.body).id);
        return d.status === 'delivered' ? d : undefined;
      });
      expect(m.attempts.map((x: { attempt: number; result: string }) => [x.attempt, x.result])).toEqual([
        [1, 'failure'],
        [2, 'success'],
      ]);
    } finally {
      hook.setPlan([200]);
      await http().post(`/api/channels/${chId}/stop`).expect(200);
    }
  });
});

describe('h. channel manager start → stop → start from the API', () => {
  it('port answers after each start and refuses after stop; status follows', async () => {
    const chId = (await http().post('/api/channels').send(inbound('Restart', P.restart)).expect(201)).body.id;
    const status = async () => (await http().get(`/api/channels/${chId}`).expect(200)).body.status;
    expect(await status()).toBe('stopped');
    expect(await isListening(P.restart)).toBe(false);

    for (const round of [1, 2, 3]) {
      expect((await http().post(`/api/channels/${chId}/start`).expect(200)).body.status).toBe('running');
      expect(await status()).toBe('running');
      expect(await isListening(P.restart)).toBe(true);
      expect(ackOf(await sendMllp(P.restart, SAMPLE_ADT.replace('000002', `QARS${round}`)))).toEqual({ code: 'AA', controlId: `QARS${round}` });

      expect((await http().post(`/api/channels/${chId}/stop`).expect(200)).body.status).toBe('stopped');
      expect(await status()).toBe('stopped');
      expect(await isListening(P.restart)).toBe(false);
      await expect(sendMllp(P.restart, SAMPLE_ADT, { timeoutMs: 1000 })).rejects.toThrow();
    }
    expect((await listAll(chId)).total).toBe(3);
  });
});

describe('d. graceful shutdown with messages in flight', () => {
  it('every AA is stored exactly once, no duplicates, listener restored after reboot', async () => {
    const chId = (await http().post('/api/channels').send(inbound('Shutdown', P.shutdown)).expect(201)).body.id;
    await http().post(`/api/channels/${chId}/start`).expect(200);

    const N = 20;
    const ctrl = (i: number) => `QASD${String(i).padStart(3, '0')}`;
    const outcome = new Map<string, string>();
    const send = (i: number) =>
      sendMllp(P.shutdown, SAMPLE_ADT.replace('000002', ctrl(i)), { timeoutMs: 10_000 }).then(
        (ack) => {
          const a = ackOf(ack);
          outcome.set(ctrl(i), a.controlId === ctrl(i) ? a.code : `${a.code}(MSA-2 ${a.controlId})`);
        },
        (e: Error) => outcome.set(ctrl(i), `error:${e.name}:${e.message}`),
      );
    // First half: make sure traffic is really in flight, then fire the rest and close at once.
    const first = Array.from({ length: N / 2 }, (_, i) => send(i));
    await Promise.race(first);
    const second = Array.from({ length: N / 2 }, (_, i) => send(N / 2 + i));
    const closing = stopApp(ctx, { keepDb: true });
    await Promise.all([...first, ...second]);
    await closing;

    const aa = [...outcome].filter(([, o]) => o === 'AA').map(([c]) => c).sort();
    const counts = new Map<string, number>();
    for (const r of await sql<{ control_id: string; n: number }>(
      'select control_id, count(*)::int as n from messages where channel_id = $1 group by control_id',
      [chId],
    ))
      counts.set(r.control_id, r.n);
    const stored = [...counts.keys()].sort();
    // Visible in the test output; summarised in the QA report.
    console.info('[qa shutdown]', JSON.stringify({ outcomes: Object.fromEntries([...outcome].sort()), stored }));

    expect(outcome.size).toBe(N);
    expect(aa.length).toBeGreaterThan(0);
    for (const [c, n] of counts) expect(n, c).toBe(1); // no duplicates
    for (const c of aa) expect(counts.get(c), `${c} got AA but is not stored`).toBe(1); // AA'd ⊆ stored
    for (const [c, o] of outcome) if (o !== 'AA') expect(o, c).not.toMatch(/^AA/);
    // stored ⊆ AA'd does NOT hold today: messages committed while the listener was closing never get their
    // ACK (BUG QA-1, reproduced deterministically in the next test). Logged above for the report.
    const storedWithoutAck = stored.filter((c) => outcome.get(c) !== 'AA');
    console.info('[qa shutdown] stored without AA:', storedWithoutAck.join(',') || '(none)');

    // Reboot on the same database: the channel comes back running and answers.
    ctx = await startApp({ MLLP_PORT_RANGE: PORT_RANGE }, { pg: ctx.pg });
    cookie = await signIn(ctx.app);
    await waitFor(async () => (await http().get(`/api/channels/${chId}`).expect(200)).body.status === 'running');
    expect(ackOf(await sendMllp(P.shutdown, SAMPLE_ADT.replace('000002', 'QASDAFTER')))).toEqual({ code: 'AA', controlId: 'QASDAFTER' });
    expect((await sql<{ n: number }>('select count(*)::int as n from messages where channel_id = $1', [chId]))[0]!.n).toBe(stored.length + 1);
  });
  // BUG QA-1: Inbound.close() (node-hl7-server) destroys client sockets at once, so a message whose insert
  // is still running when the app shuts down is committed (ackCode AA in the row) but the sender never
  // receives the ACK and will resend it → duplicate. Expected: stop accepting, let in-flight handlers
  // finish and write their ACK, then close. Remove `.fails` once fixed.
  it('d2. in-flight messages get their ACK before the listener closes (was BUG QA-1)', async () => {
    const chId = (await http().post('/api/channels').send(inbound('Slow insert', P.slow)).expect(201)).body.id;
    await http().post(`/api/channels/${chId}/start`).expect(200);
    await sql(`CREATE OR REPLACE FUNCTION qa_slow_insert() RETURNS trigger AS $$
      BEGIN IF NEW.control_id LIKE 'QASLOW%' THEN PERFORM pg_sleep(1.5); END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await sql('CREATE TRIGGER qa_slow_insert BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION qa_slow_insert()');

    const outcome = new Map<string, string>();
    const ctrls = ['QASLOW1', 'QASLOW2', 'QASLOW3'];
    const sends = ctrls.map((c) =>
      sendMllp(P.slow, SAMPLE_ADT.replace('000002', c), { timeoutMs: 10_000 }).then(
        (ack) => outcome.set(c, ackOf(ack).code),
        (e: Error) => outcome.set(c, `error:${e.name}`),
      ),
    );
    let stored: string[] = [];
    try {
      // All three inserts are sleeping inside the trigger → in flight.
      await waitFor(async () => {
        const r = await sql<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity where state = 'active' and query ilike 'insert into "messages"%'`,
        );
        return r[0]!.n >= 3;
      });
      await stopApp(ctx, { keepDb: true });
      await Promise.all(sends);
    } finally {
      await sql('DROP TRIGGER IF EXISTS qa_slow_insert ON messages');
      await sql('DROP FUNCTION IF EXISTS qa_slow_insert()');
      stored = (await sql<{ control_id: string }>('select control_id from messages where channel_id = $1 order by control_id', [chId])).map(
        (r) => r.control_id,
      );
      console.info('[qa shutdown slow]', JSON.stringify({ outcomes: Object.fromEntries(outcome), stored }));
      // Reboot so the file's afterAll can close a live app.
      ctx = await startApp({ MLLP_PORT_RANGE: PORT_RANGE }, { pg: ctx.pg });
      cookie = await signIn(ctx.app);
    }
    // None lost (holds today): every in-flight message was committed.
    expect(stored).toEqual(ctrls);
    // Fails today: the senders got a closed connection instead of AA.
    expect(Object.fromEntries(outcome)).toEqual({ QASLOW1: 'AA', QASLOW2: 'AA', QASLOW3: 'AA' });
  });
});
